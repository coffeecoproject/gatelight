// modwall migrate、modwall db bootstrap：生成交给 psql 的脚本。不连数据库、不装客户端库，和 db check 一样由项目给执行 SQL 的命令；
// 线上没有 gatelight 也没有仓库，打包时用 --print 生成脚本带上去，只用 psql 跑。脚本可以重复执行，要跑哪些由脚本在库里判断。
// 要 Postgres 16 以上：成员关系按条设 INHERIT FALSE、SET TRUE，建角色的账号只能管自己建的角色（别人建的同名角色会被拒，不会被借用）。

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apiOf, type Database, groupOf, internalOf, runtimeOf, SHARED_SCHEMA } from './database.ts'
import type { Module } from './layout.ts'

export const LEDGER = `${SHARED_SCHEMA}.modwall_migrations`
const MIN_VERSION = 160000

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`
const literal = (text: string): string => `'${text.replace(/'/g, "''")}'`

/** 不出现在 text 里的 dollar 引号。 */
function dollarTag(text: string, seed: string): string {
  for (let i = 0; ; i++) {
    const tag = `$modwall_${seed}${i || ''}$`
    if (!text.includes(tag)) return tag
  }
}
const dollar = (text: string, seed: string): string => {
  const tag = dollarTag(text, seed)
  return `${tag}${text}${tag}`
}

/** 一段 DO：正文里有错就 RAISE，psql 带 ON_ERROR_STOP 停下、退出码非零。 */
const doBlock = (body: string): string => `DO ${dollar(body, 'do')};`

const HEADER = String.raw`\set ON_ERROR_STOP on
\set QUIET on
\pset pager off
\encoding UTF8
SET client_min_messages = warning;`

const versionCheck = (command: string): string =>
  `IF current_setting('server_version_num')::int < ${MIN_VERSION} THEN
    RAISE EXCEPTION '${command} 要 Postgres 16 以上，这个库是 %', current_setting('server_version');
  END IF;`

const modulesOf = (database: Database): Module[] => [...database.schemas.values()].flatMap(owner => (owner.kind === 'internal' ? [owner.module] : []))

interface Planned {
  path: string
  name: string
  checksum: string
  owner: string
  script: string
}

/** 迁移按文件名统一排序（文件名以时间戳开头）；记录按文件名认，文件跟着目录挪了不会再跑。 */
function planned(database: Database, read: (path: string) => string): Planned[] {
  return database.migrations
    .map(({ path, module }) => {
      const script = read(path)
      return {
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        checksum: createHash('sha256').update(script).digest('hex'),
        owner: module ? internalOf(module) : SHARED_SCHEMA,
        script,
      }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** modwall migrate 的脚本：用跑迁移的账号执行。 */
export function migrateScript(database: Database, read: (path: string) => string): string {
  const config = database.app.database
  if (!config) throw new Error('这个应用没有写 database')
  const modules = modulesOf(database)
  const group = groupOf(config.login)
  const runtimes = config.runtime === undefined ? [] : modules.map(module => runtimeOf(module, config.runtime as string))
  const owners = [SHARED_SCHEMA, ...modules.map(internalOf)]
  const roles = [...owners, group, ...runtimes]
  const migrations = planned(database, read)
  const migrator = config.migrator
  const out: string[] = [`-- modwall migrate 生成${database.app.name === undefined ? '' : `（${database.app.name} 应用）`}：用跑迁移的账号 ${migrator} 执行，可以重复执行。`, HEADER]

  out.push(
    doBlock(`
BEGIN
  ${versionCheck('modwall migrate')}
  IF current_user <> ${literal(migrator)} THEN
    RAISE EXCEPTION 'modwall migrate 要用跑迁移的账号 ${migrator} 连库（.modwall/config.json 的 database.migrator），现在连的是 %', current_user;
  END IF;
  IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) OR NOT has_database_privilege(current_database(), 'CREATE') THEN
    RAISE EXCEPTION '跑迁移的账号 ${migrator} 要能建角色、能在库里建 schema：先用超级用户跑 modwall db bootstrap';
  END IF;
END`),
  )
  // 同一个库同时跑两次时排队；锁到 psql 退出为止
  out.push(`SELECT pg_advisory_lock(hashtext('modwall migrate')) AS modwall_locked \\gset`)

  out.push('BEGIN;')
  out.push(
    doBlock(`
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[${roles.map(literal).join(', ')}] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    ELSIF NOT EXISTS (
      SELECT FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
      WHERE g.rolname = r AND u.rolname = current_user AND m.admin_option
    ) THEN
      RAISE EXCEPTION '角色 % 已经有了，但不是跑迁移的账号 % 建的：角色整个实例共用，同一个实例上别的项目或别人建了同名的角色。换个模块名，或者用单独的实例', r, current_user;
    END IF;
  END LOOP;
END`),
  )
  for (const owner of owners) out.push(`GRANT ${ident(owner)} TO ${ident(migrator)} WITH INHERIT FALSE, SET TRUE;`)
  const loginRoles = config.runtime === undefined ? owners.filter(owner => owner !== SHARED_SCHEMA) : runtimes
  for (const role of loginRoles) out.push(`GRANT ${ident(role)} TO ${ident(config.login)} WITH INHERIT FALSE, SET TRUE;`)
  // 后来才写 runtime 的，登录账号原来是模块角色的成员：收回，程序只能切成运行角色
  if (config.runtime !== undefined && modules.length) {
    out.push(
      doBlock(`
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[${modules.map(module => literal(internalOf(module))).join(', ')}] LOOP
    IF EXISTS (
      SELECT FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
      WHERE g.rolname = r AND u.rolname = ${literal(config.login)}
    ) THEN
      EXECUTE format('REVOKE %I FROM %I', r, ${literal(config.login)});
    END IF;
  END LOOP;
END`),
    )
  }
  for (const role of [...owners.filter(owner => owner !== SHARED_SCHEMA), ...runtimes]) out.push(`GRANT ${ident(group)} TO ${ident(role)} WITH INHERIT TRUE, SET FALSE;`)

  out.push(`CREATE SCHEMA IF NOT EXISTS ${ident(SHARED_SCHEMA)} AUTHORIZATION ${ident(SHARED_SCHEMA)};`)
  for (const module of modules) {
    out.push(`CREATE SCHEMA IF NOT EXISTS ${ident(internalOf(module))} AUTHORIZATION ${ident(internalOf(module))};`)
    out.push(`CREATE SCHEMA IF NOT EXISTS ${ident(apiOf(module))} AUTHORIZATION ${ident(internalOf(module))};`)
  }
  // 迁移全文交给各自的 run_migration 执行：SECURITY DEFINER 的函数里切不了身份，迁移里写了切身份由库拒绝
  for (const owner of owners) {
    out.push(
      `SET LOCAL ROLE ${ident(owner)};`,
      `CREATE OR REPLACE FUNCTION ${ident(owner)}.run_migration(script text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${ident(owner)}, pg_temp AS ${dollar('BEGIN EXECUTE script; END', 'fn')};`,
      `REVOKE ALL ON FUNCTION ${ident(owner)}.run_migration(text) FROM PUBLIC;`,
    )
    if (owner === SHARED_SCHEMA) {
      out.push(
        `GRANT USAGE ON SCHEMA ${ident(SHARED_SCHEMA)} TO ${ident(group)};`,
        `CREATE TABLE IF NOT EXISTS ${LEDGER} (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());`,
      )
    } else {
      const api = ident(`${owner}_api`)
      out.push(`GRANT USAGE ON SCHEMA ${api} TO ${ident(group)};`, `ALTER DEFAULT PRIVILEGES IN SCHEMA ${api} GRANT SELECT ON TABLES TO ${ident(group)};`)
    }
    out.push('RESET ROLE;')
  }
  out.push('COMMIT;')

  // 跑过的迁移改了、删了，库和文件就对不上了：先查，有一个就一个都不跑
  const files = migrations.length
    ? `(VALUES ${migrations.map(m => `(${literal(m.name)}, ${literal(m.checksum)})`).join(', ')}) AS f(name, checksum)`
    : '(SELECT NULL::text AS name, NULL::text AS checksum WHERE false) AS f'
  out.push(
    'BEGIN;',
    `SET LOCAL ROLE ${ident(SHARED_SCHEMA)};`,
    doBlock(`
DECLARE
  changed text;
  missing text;
BEGIN
  SELECT string_agg(l.name, '、' ORDER BY l.name) INTO changed FROM ${LEDGER} l JOIN ${files} USING (name) WHERE l.checksum <> f.checksum;
  SELECT string_agg(l.name, '、' ORDER BY l.name) INTO missing FROM ${LEDGER} l WHERE NOT EXISTS (SELECT FROM ${files} WHERE f.name = l.name);
  IF changed IS NOT NULL OR missing IS NOT NULL THEN
    RAISE EXCEPTION '跑过的迁移%，一个都没跑。迁移只加不改：已合进默认分支的改回原样，要改的写成新的迁移；分支上自己新写的，把开发库重置了再跑',
      concat_ws('；', '改了内容：' || changed, '文件不见了：' || missing);
  END IF;
END`),
    'COMMIT;',
    '\\set modwall_ran 0',
  )

  for (const m of migrations) {
    out.push(
      '',
      `-- ${m.path}`,
      'BEGIN;',
      `SET LOCAL ROLE ${ident(SHARED_SCHEMA)};`,
      `SELECT NOT EXISTS (SELECT FROM ${LEDGER} WHERE name = ${literal(m.name)}) AS modwall_pending \\gset`,
      'COMMIT;',
      '\\if :modwall_pending',
      `\\echo modwall migrate：执行 ${m.path}`,
      'BEGIN;',
      `SET LOCAL ROLE ${ident(m.owner)};`,
      `SELECT ${ident(m.owner)}.run_migration(${dollar(m.script, m.checksum.slice(0, 8))}) AS modwall_done \\gset`,
      `SET LOCAL ROLE ${ident(SHARED_SCHEMA)};`,
      `INSERT INTO ${LEDGER} (name, checksum) VALUES (${literal(m.name)}, ${literal(m.checksum)});`,
      'COMMIT;',
      '\\set modwall_ran 1',
      '\\endif',
    )
  }
  out.push('', '\\if :modwall_ran', '\\echo modwall migrate：完成', '\\else', '\\echo modwall migrate：没有要跑的迁移，库已是最新', '\\endif', '')
  return out.join('\n')
}

/** modwall db bootstrap 的脚本：用超级用户（或能建角色、拥有这个库的账号）执行。不设密码。 */
export function bootstrapScript(database: Database): string {
  const config = database.app.database
  if (!config) throw new Error('这个应用没有写 database')
  const { login, migrator } = config
  return [
    `-- modwall db bootstrap 生成${database.app.name === undefined ? '' : `（${database.app.name} 应用）`}：用超级用户在要用的库里执行，可以重复执行。不设密码。`,
    HEADER,
    doBlock(`
BEGIN
  ${versionCheck('modwall db bootstrap')}
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(login)}) THEN
    CREATE ROLE ${ident(login)} LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(migrator)}) THEN
    CREATE ROLE ${ident(migrator)} LOGIN NOINHERIT CREATEROLE;
  END IF;
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), ${literal(login)}, ${literal(migrator)});
  EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), ${literal(migrator)});
END`),
    // 两个账号本身没有权限、不继承模块角色，只能切身份；迁移账号另外能建角色（它建的模块角色归它管）
    `ALTER ROLE ${ident(login)} LOGIN NOINHERIT NOCREATEROLE NOCREATEDB;`,
    `ALTER ROLE ${ident(migrator)} LOGIN NOINHERIT CREATEROLE NOCREATEDB;`,
    'REVOKE CREATE ON SCHEMA public FROM PUBLIC;',
    `\\echo modwall db bootstrap：账号 ${login}、${migrator} 好了，库只让这两个连。密码按项目的方式设（ALTER ROLE … PASSWORD）`,
    '',
  ].join('\n')
}

/** 读迁移文件：路径相对仓库根目录。 */
export const fileReader = (root: string) => (path: string): string => readFileSync(join(root, path), 'utf8')

/** 把脚本从标准输入交给项目给的命令（在 sh 里跑），输出原样给用户。status：命令的退出码；没跑起来时有 error。 */
export function runScript(root: string, command: string, script: string): { status: number | null; error?: string } {
  const r = spawnSync('/bin/sh', ['-c', command], { cwd: root, input: script, stdio: ['pipe', 'inherit', 'inherit'] })
  return r.error ? { status: null, error: r.error.message } : { status: r.status }
}
