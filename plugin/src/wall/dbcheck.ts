// modwall db check：R6 里库的那部分，查迁移跑完之后库里的现状。
// 不连数据库、不装客户端库：把查系统目录的 SQL 从标准输入交给项目给的命令（psql $DATABASE_URL、napbox exec postgres -- psql），
// 读它输出的一行 JSON 再比对。查的是：
//   不对应任何模块的 schema；public 里的对象；入口 schema 里的表；跨模块的外键；函数的 search_path；
//   视图、函数跨模块引用内部 schema（视图和 BEGIN ATOMIC 的函数看 pg_depend，plpgsql 和 AS $$…$$ 的 sql 函数读正文）；
//   视图、BEGIN ATOMIC 的函数硬依赖在别的模块入口里的视图、函数上（pg_depend 里有记录；用对方入口里的类型可以）；函数正文直接写别的模块入口里的视图。
// 按模块的数据库角色：
//   每个模块有同名的角色，共享层有 shared 角色：不能登录、不是超级用户、不能绕过行级权限、不能建角色和库，不能在 public 里建对象、不能在库里建 schema；
//   模块两个 schema 和里面的对象归模块的角色，shared 的归 shared 角色；除了超级用户和 schema 的主人，没有角色（包括经继承）能用模块的内部 schema、
//   能在模块的两个 schema 和 shared 里建对象；函数都是 SECURITY DEFINER（函数里也就切不了身份），入口视图没有设 security_invoker；
//   迁移账号存在、能登录、不是超级用户、不拥有任何对象。
//   每个模块和共享层的运行账号（database.login 模板）存在、能登录、能连库，可以用本块的内部 schema（别的模块的照样不行），
//   不是超级用户、不能绕过行级权限、不能建角色和库、不能在库里建 schema、不能在任何 schema 里建对象（本块的也不行）、不拥有任何对象。
//   成员关系：模块的角色、运行账号的成员只能是迁移账号；运行账号只属于组角色（共享层的什么都不属于）。超级用户当成员的不管。
// 扩展自带的 schema 和对象不算。

import { spawnSync } from 'node:child_process'
import { accountOf, type Database, groupOf, internalOf, PUBLIC_SCHEMA, SHARED_SCHEMA, type SchemaOwner, schemaLabel } from './database.ts'
import { crossing, expectedSearchPath, FIXES, nameClashes, searchPathOk, writtenApis } from './dbrules.ts'
import type { Module } from './layout.ts'
import type { Violation } from './rules.ts'
import { parseSearchPath, statements } from './sql.ts'

const MARKER = 'modwall-db:'

/** 交给 psql 的脚本：先把输出设成一行一个值、不分页、不计时，出错就停；结果是一行带前缀的 JSON。 */
export const CATALOG_SQL = String.raw`\set QUIET on
\set ON_ERROR_STOP on
\set ECHO none
\pset pager off
\pset format unaligned
\pset tuples_only on
\timing off
WITH ext AS (
  SELECT classid, objid FROM pg_depend WHERE deptype = 'e'
), ns AS (
  SELECT n.oid, n.nspname, n.nspowner FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
)
SELECT '${MARKER}' || json_build_object(
  'database', json_build_object('name', current_database(), 'ident', quote_ident(current_database()), 'publicConnect', has_database_privilege('public', current_database(), 'CONNECT')),
  'schemas', (
    SELECT coalesce(json_agg(json_build_object('name', ns.nspname, 'owner', pg_get_userbyid(ns.nspowner)) ORDER BY ns.nspname), '[]'::json) FROM ns
    WHERE NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_namespace'::regclass AND ext.objid = ns.oid)
  ),
  'relations', (
    SELECT coalesce(json_agg(json_build_object(
      'schema', ns.nspname, 'name', c.relname, 'kind', c.relkind, 'owner', pg_get_userbyid(c.relowner),
      'securityInvoker', coalesce((SELECT o.option_value::boolean FROM pg_options_to_table(c.reloptions) o WHERE o.option_name = 'security_invoker'), false)
    )), '[]'::json)
    FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_class'::regclass AND ext.objid = c.oid)
      AND NOT (c.relkind = 'S' AND EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i')
      ))
  ),
  'types', (
    SELECT coalesce(json_agg(json_build_object('schema', ns.nspname, 'name', t.typname, 'owner', pg_get_userbyid(t.typowner))), '[]'::json)
    FROM pg_type t JOIN ns ON ns.oid = t.typnamespace
    WHERE t.typtype IN ('c', 'd', 'e', 'r')
      AND (t.typrelid = 0 OR (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c')
      AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_type'::regclass AND ext.objid = t.oid)
  ),
  'functions', (
    SELECT coalesce(json_agg(json_build_object(
      'schema', ns.nspname, 'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid), 'kind', p.prokind,
      'config', p.proconfig, 'source', CASE WHEN l.lanname IN ('sql', 'plpgsql') THEN p.prosrc END,
      'owner', pg_get_userbyid(p.proowner), 'securityDefiner', p.prosecdef
    )), '[]'::json)
    FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
    WHERE NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_proc'::regclass AND ext.objid = p.oid)
  ),
  'foreignKeys', (
    SELECT coalesce(json_agg(json_build_object(
      'schema', a.nspname, 'table', ca.relname, 'name', k.conname, 'refSchema', b.nspname, 'refTable', cb.relname
    )), '[]'::json)
    FROM pg_constraint k
    JOIN pg_class ca ON ca.oid = k.conrelid JOIN pg_namespace a ON a.oid = ca.relnamespace
    JOIN pg_class cb ON cb.oid = k.confrelid JOIN pg_namespace b ON b.oid = cb.relnamespace
    WHERE k.contype = 'f' AND k.conparentid = 0 AND a.oid <> b.oid
  ),
  'dependencies', (
    SELECT coalesce(json_agg(row_to_json(x)), '[]'::json) FROM (
      SELECT DISTINCT dep.kind, dep.schema, dep.name, ref.schema AS "refSchema", ref.name AS "refName", ref.kind AS "refKind"
      FROM pg_depend d
      CROSS JOIN LATERAL (
        SELECT 'view' AS kind, n.nspname AS schema, c.relname::text AS name
        FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE d.classid = 'pg_rewrite'::regclass AND r.oid = d.objid AND d.refobjid <> r.ev_class
        UNION ALL
        SELECT 'function', n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE d.classid = 'pg_proc'::regclass AND p.oid = d.objid
      ) dep
      CROSS JOIN LATERAL (
        SELECT n.nspname AS schema, c.relname::text AS name, 'relation' AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE d.refclassid = 'pg_class'::regclass AND c.oid = d.refobjid
        UNION ALL
        SELECT n.nspname, p.proname::text, 'function' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE d.refclassid = 'pg_proc'::regclass AND p.oid = d.refobjid
        UNION ALL
        SELECT n.nspname, t.typname::text, 'type' FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE d.refclassid = 'pg_type'::regclass AND t.oid = d.refobjid
      ) ref
      WHERE d.classid IN ('pg_rewrite'::regclass, 'pg_proc'::regclass) AND d.deptype = 'n' AND dep.schema <> ref.schema
    ) x
  ),
  'roles', (
    SELECT coalesce(json_agg(json_build_object(
      'name', r.rolname, 'login', r.rolcanlogin, 'superuser', r.rolsuper, 'bypassRls', r.rolbypassrls,
      'createRole', r.rolcreaterole, 'createDb', r.rolcreatedb,
      'createSchema', has_database_privilege(r.oid, current_database(), 'CREATE'),
      'connect', has_database_privilege(r.oid, current_database(), 'CONNECT'),
      'ownsObjects', EXISTS (
        SELECT 1 FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o'
          AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
          -- 连着的会话建的临时表不算
          AND NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE d.classid = 'pg_class'::regclass AND c.oid = d.objid AND n.nspname ~ '^pg_(toast_)?temp_'
          )
      )
    ) ORDER BY r.rolname), '[]'::json)
    FROM pg_roles r WHERE r.rolname !~ '^pg_'
  ),
  'memberships', (
    SELECT coalesce(json_agg(json_build_object(
      'role', g.rolname, 'member', u.rolname, 'admin', m.admin_option, 'inherit', m.inherit_option, 'set', m.set_option, 'superuser', u.rolsuper
    ) ORDER BY g.rolname, u.rolname), '[]'::json)
    FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
  ),
  'privileges', (
    SELECT coalesce(json_agg(json_build_object('schema', x.nspname, 'role', x.rolname, 'usage', x.usage, 'create', x.create)), '[]'::json) FROM (
      SELECT n.nspname, r.rolname, has_schema_privilege(r.oid, n.oid, 'USAGE') AS usage, has_schema_privilege(r.oid, n.oid, 'CREATE') AS create
      FROM pg_namespace n CROSS JOIN pg_roles r
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND NOT r.rolsuper AND r.rolname !~ '^pg_'
    ) x WHERE x.usage OR x.create
  )
)::text;
`

/** 库里的现状：只有比对要用的那些。 */
export interface Catalog {
  /** 当前库：名字，写进 SQL 时的写法（Postgres 按标识符规则加双引号，只在需要时加），CONNECT 有没有授给 PUBLIC（新建的库默认授）。 */
  database: { name: string; ident: string; publicConnect: boolean }
  schemas: Array<{ name: string; owner: string }>
  /** securityInvoker：视图设了 security_invoker（值由 Postgres 自己转成真假，t、on、yes 等都算）。 */
  relations: Array<{ schema: string; name: string; kind: string; owner: string; securityInvoker: boolean }>
  types: Array<{ schema: string; name: string; owner: string }>
  functions: Array<{
    schema: string
    name: string
    args: string
    kind: string
    config: string[] | null
    source: string | null
    owner: string
    securityDefiner: boolean
  }>
  foreignKeys: Array<{ schema: string; table: string; name: string; refSchema: string; refTable: string }>
  /** refKind：依赖的是表或视图（relation）、函数、类型。 */
  dependencies: Array<{ kind: 'view' | 'function'; schema: string; name: string; refSchema: string; refName: string; refKind: 'relation' | 'function' | 'type' }>
  /** 实例上的角色（pg_ 开头的内置角色除外）。createSchema：能在当前库里建 schema；connect：能连当前库；ownsObjects：在当前库里（或实例共用的对象里）拥有对象。 */
  roles: Array<{ name: string; login: boolean; superuser: boolean; bypassRls: boolean; createRole: boolean; createDb: boolean; createSchema: boolean; connect: boolean; ownsObjects: boolean }>
  /** 成员关系：member 是 role 的成员。admin：能转授；inherit：继承 role 的权限；set：能切成 role；superuser：member 是超级用户。 */
  memberships: Array<{ role: string; member: string; admin: boolean; inherit: boolean; set: boolean; superuser: boolean }>
  /** 非超级用户的角色对 schema 有的权限（包括经成员关系继承的），只列有权限的。 */
  privileges: Array<{ schema: string; role: string; usage: boolean; create: boolean }>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const rows = (value: unknown, ...keys: string[]): boolean => Array.isArray(value) && value.every(row => isRecord(row) && keys.every(key => key in row))

function parseCatalog(text: string): Catalog | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const ok =
    isRecord(value.database) && typeof value.database.name === 'string' && typeof value.database.ident === 'string' && typeof value.database.publicConnect === 'boolean' &&
    rows(value.schemas, 'name', 'owner') &&
    rows(value.relations, 'schema', 'name', 'kind', 'owner', 'securityInvoker') &&
    rows(value.types, 'schema', 'name', 'owner') &&
    rows(value.functions, 'schema', 'name', 'args', 'kind', 'config', 'source', 'owner', 'securityDefiner') &&
    rows(value.foreignKeys, 'schema', 'table', 'name', 'refSchema', 'refTable') &&
    rows(value.dependencies, 'kind', 'schema', 'name', 'refSchema', 'refName', 'refKind') &&
    rows(value.roles, 'name', 'login', 'superuser', 'bypassRls', 'createRole', 'createDb', 'createSchema', 'connect', 'ownsObjects') &&
    rows(value.memberships, 'role', 'member', 'admin', 'inherit', 'set', 'superuser') &&
    rows(value.privileges, 'schema', 'role', 'usage', 'create')
  return ok ? (value as unknown as Catalog) : undefined
}

/** 用项目给的命令执行查询，读回库里的现状。命令在 sh 里跑（可以写环境变量），SQL 从标准输入给。 */
export function readCatalog(root: string, command: string): { ok: true; value: Catalog } | { ok: false; problem: string } {
  const r = spawnSync('/bin/sh', ['-c', command], { cwd: root, input: CATALOG_SQL, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
  const said = (): string => (r.stderr || r.stdout || '').trim().split('\n').slice(0, 5).join('\n')
  if (r.error) return { ok: false, problem: `执行 SQL 的命令没跑起来（${command}）：${r.error.message}` }
  if (r.status !== 0) return { ok: false, problem: `执行 SQL 的命令失败（退出码 ${r.status}，命令：${command}）：${said()}` }
  const line = r.stdout.split('\n').find(text => text.startsWith(MARKER))
  if (line === undefined) return { ok: false, problem: `执行 SQL 的命令没输出查询结果（命令：${command}；它要把标准输入的 SQL 交给 psql 执行）：${said()}` }
  const catalog = parseCatalog(line.slice(MARKER.length))
  return catalog ? { ok: true, value: catalog } : { ok: false, problem: '查询结果读不懂：输出的那一行不是预期的 JSON' }
}

const RELATION_KINDS: Record<string, string> = { r: '表', p: '表', f: '外部表', v: '视图', m: '物化视图', S: '序列' }
const TABLE_KINDS = new Set(['r', 'p', 'f'])

/** 比对库里的现状和模块划分，给出 R6 的越界。 */
export function catalogViolations(database: Database, catalog: Catalog): Violation[] {
  const violations = new Map<string, Violation>()
  const add = (what: string, where: string, fix: string): void => {
    const key = `R6 库 ${what}`
    if (!violations.has(key)) violations.set(key, { rule: 'R6', key, where: [where], fix })
  }
  const owner = (schema: string): SchemaOwner | undefined => database.schemas.get(schema)
  /** 这个 schema 里的对象归哪个模块：模块的内部、入口 schema 归那个模块，shared 是共享层（undefined），别的不管（null）。 */
  const home = (schema: string): Module | undefined | null => {
    const at = owner(schema)
    if (!at) return null
    return at.kind === 'shared' ? undefined : at.module
  }

  for (const { name: schema } of catalog.schemas) {
    if (schema === PUBLIC_SCHEMA || owner(schema)) continue
    add(
      `schema ${schema}`,
      `库里的 schema ${schema} 不对应任何模块`,
      `schema 由模块目录名定：模块的内部 schema 是目录名转成小写加下划线（adminAccess → admin_access），入口是 <内部>_api，共享层是 shared。把 ${schema} 里的对象挪进所属模块的 schema，再删掉它。`,
    )
  }

  const publicFix = 'public 里不放对象（扩展自带的除外）：挪进所属模块的内部 schema；没有业务含义的通用结构放进 shared。'
  for (const relation of catalog.relations) {
    const kind = RELATION_KINDS[relation.kind] ?? '对象'
    if (relation.schema === PUBLIC_SCHEMA) add(`public ${relation.name}`, `public 里有${kind} ${relation.name}`, publicFix)
    const at = owner(relation.schema)
    if (at?.kind === 'api' && TABLE_KINDS.has(relation.kind)) {
      add(
        `入口建表 ${relation.schema}.${relation.name}`,
        `入口 schema ${relation.schema} 里有${kind} ${relation.name}`,
        FIXES.apiTable(at.module, relation.schema),
      )
    }
  }
  for (const type of catalog.types) if (type.schema === PUBLIC_SCHEMA) add(`public 类型 ${type.name}`, `public 里有类型 ${type.name}`, publicFix)

  for (const key of catalog.foreignKeys) {
    const from = home(key.schema)
    const to = home(key.refSchema)
    if (from === null || to === null || to === undefined || from?.id === to.id) continue
    const where = `${key.schema}.${key.table} 的外键 ${key.name} 指向 ${to.id} 模块的 ${key.refSchema}.${key.refTable}`
    if (from === undefined) add(`外键 ${key.schema}.${key.table}.${key.name}`, `共享层：${where}`, FIXES.shared)
    else add(`外键 ${key.schema}.${key.table}.${key.name}`, `${from.id} 模块的 ${where}`, FIXES.foreignKey(to.id))
  }

  /** 视图、函数引用了别的 schema 里的对象：from 是它所在 schema 归的模块（undefined 是共享层）。hard：pg_depend 里记着的、对视图或函数的硬依赖。 */
  const reference = (what: string, from: Module | undefined, schema: string, target: string, hard: boolean): void => {
    const found = crossing(database, from, schema)
    if (!found) return
    const who = from ? `${from.id} 模块的` : '共享层的'
    if (found.kind === 'api') {
      if (hard) add(`${what} 建在 ${target}`, `${who}${what} 硬依赖在 ${found.owner.module.id} 模块的入口上：${target}`, FIXES.viewOnApi(found.owner.module))
      return
    }
    add(`${what} 引用 ${target}`, `${who}${what} 引用了 ${schemaLabel(schema, found.owner)}：${target}`, found.kind === 'internal' ? FIXES.internal(found.owner.module, schema) : FIXES.shared)
  }
  for (const dependency of catalog.dependencies) {
    const from = home(dependency.schema)
    if (from === null) continue
    // 用对方入口里的类型可以（类型只加不删）；引用内部 schema 的类型照样报
    const hard = dependency.refKind !== 'type'
    reference(`${dependency.kind === 'view' ? '视图' : '函数'} ${dependency.schema}.${dependency.name}`, from, dependency.refSchema, `${dependency.refSchema}.${dependency.refName}`, hard)
  }

  for (const fn of catalog.functions) {
    const name = `${fn.schema}.${fn.name}(${fn.args})`
    if (fn.schema === PUBLIC_SCHEMA) add(`public 函数 ${name}`, `public 里有函数 ${fn.name}(${fn.args})`, publicFix)
    const from = home(fn.schema)
    if (from === null) continue
    if (fn.kind === 'f' || fn.kind === 'p') {
      const setting = fn.config?.find(item => item.startsWith('search_path='))
      const values = setting === undefined ? undefined : parseSearchPath(setting.slice('search_path='.length))
      if (values === undefined || !searchPathOk(from, values)) {
        const said = values === undefined ? '没有设 search_path' : `的 search_path 设成了 ${values.join(', ')}`
        add(`函数 ${name} search_path`, `函数 ${name} ${said}，要设成 ${expectedSearchPath(from)}`, FIXES.searchPath(expectedSearchPath(from)))
      }
    }
    if (fn.source) {
      for (const statement of statements(fn.source)) {
        const clashing = new Set(nameClashes(database, from, statement).map(clash => clash.name))
        for (const ref of statement.refs) if (!clashing.has(ref.schema)) reference(`函数 ${name}`, from, ref.schema, `${ref.schema}.${ref.name}`, false)
        for (const written of writtenApis(database, from, statement)) {
          add(`函数 ${name} 写 ${written.target}`, `${from ? `${from.id} 模块的` : ''}函数 ${name} 直接写了 ${written.module.id} 模块入口里的 ${written.target}`, FIXES.writeApi(written.module))
        }
      }
    }
  }
  roleViolations(database, catalog, add)
  return [...violations.values()]
}

/** 按模块的数据库角色：角色和运行账号的属性、成员关系、对象的归属、内部 schema 的权限、入口函数和视图以谁的身份执行、库的 CONNECT、迁移账号。 */
function roleViolations(database: Database, catalog: Catalog, add: (what: string, where: string, fix: string) => void): void {
  const config = database.app.database as NonNullable<Database['app']['database']>
  const roles = new Map(catalog.roles.map(role => [role.name, role]))
  const publicCreate = (name: string): boolean => catalog.privileges.some(item => item.schema === PUBLIC_SCHEMA && item.role === name && item.create)
  /** 模块和共享层的角色：名字和说法；account 是这一块的运行账号。 */
  const owners: Array<{ role: string; who: string; account: string }> = [{ role: SHARED_SCHEMA, who: '共享层', account: accountOf(SHARED_SCHEMA, config.login) }]
  for (const [schema, at] of database.schemas) if (at.kind === 'internal') owners.push({ role: schema, who: `${at.module.id} 模块`, account: accountOf(schema, config.login) })

  for (const { role: name, who } of owners) {
    const role = roles.get(name)
    if (!role) {
      add(`角色 ${name}`, `库里没有 ${who}的角色 ${name}`, FIXES.missingRole(name))
      continue
    }
    const wrong = [
      role.login && '能登录',
      role.superuser && '是超级用户',
      role.bypassRls && '能绕过行级权限（BYPASSRLS）',
      role.createRole && '能建角色',
      role.createDb && '能建库',
      role.createSchema && '能在库里建 schema',
    ].filter(Boolean)
    if (wrong.length) add(`角色 ${name} 属性`, `${who}的角色 ${name} ${wrong.join('、')}`, FIXES.roleAttributes(name))
    if (publicCreate(name)) add(`角色 ${name} 在 public 建对象`, `${who}的角色 ${name} 能在 public 里建对象`, FIXES.publicCreate)
  }

  // 运行账号：只读写本块，不拥有对象、不能做 DDL。在别的 schema 里建对象由下面查权限的地方报
  for (const { role: owner, who, account: name } of owners) {
    const role = roles.get(name)
    if (!role) {
      add(`运行账号 ${name}`, `库里没有${who}的运行账号 ${name}（database.login 是 ${config.login}）`, FIXES.account(name, owner))
      continue
    }
    const wrong = [
      !role.login && '不能登录',
      !role.connect && `连不了库 ${catalog.database.name}（没有 CONNECT）`,
      role.superuser && '是超级用户',
      role.bypassRls && '能绕过行级权限（BYPASSRLS）',
      role.createRole && '能建角色',
      role.createDb && '能建库',
      role.createSchema && '能在库里建 schema',
      publicCreate(name) && '能在 public 里建对象',
      role.ownsObjects && '拥有对象',
    ].filter(Boolean)
    if (wrong.length) add(`运行账号 ${name} 属性`, `${who}的运行账号 ${name} ${wrong.join('、')}`, FIXES.account(name, owner))
  }

  // 成员关系：切成、继承、转授模块的角色和运行账号的，只能是迁移账号；它们自己只属于组角色（共享层的什么都不属于）
  const whose = new Map<string, string>()
  for (const { role, who, account } of owners) {
    whose.set(role, `${who}的角色 ${role}`)
    whose.set(account, `${who}的运行账号 ${account}`)
  }
  const group = groupOf(config.login)
  const sharedAccount = accountOf(SHARED_SCHEMA, config.login)
  for (const item of catalog.memberships) {
    if (item.superuser || item.member === config.migrator || !(item.admin || item.inherit || item.set)) continue
    const what = [item.set && '切成（SET）', item.inherit && '继承（INHERIT）', item.admin && '转授（ADMIN）'].filter(Boolean).join('、')
    const target = whose.get(item.role)
    if (target !== undefined) {
      add(`成员 ${item.role} ${item.member}`, `角色 ${item.member} 能${what}${target}`, FIXES.membership(item.role, item.member))
      continue
    }
    const member = whose.get(item.member)
    if (member === undefined) continue
    if (item.role === group && item.member !== sharedAccount && item.member !== SHARED_SCHEMA && !item.set && !item.admin) continue
    add(`成员 ${item.role} ${item.member}`, `${member} 能${what}角色 ${item.role}`, FIXES.membership(item.role, item.member))
  }

  /** schema 归谁的角色：模块的两个 schema 归模块的角色，shared 归 shared 角色。 */
  const expectedOwner = (schema: string): string | undefined => {
    const at = database.schemas.get(schema)
    if (!at) return undefined
    return at.kind === 'shared' ? SHARED_SCHEMA : internalOf(at.module)
  }
  const owned = (what: string, schema: string, actual: string): void => {
    const expected = expectedOwner(schema)
    if (expected === undefined || expected === actual) return
    add(`归属 ${what}`, `${what} 归角色 ${actual}，要归 ${expected}`, FIXES.owner(expected))
  }
  for (const schema of catalog.schemas) owned(`schema ${schema.name}`, schema.name, schema.owner)
  for (const relation of catalog.relations) owned(`${RELATION_KINDS[relation.kind] ?? '对象'} ${relation.schema}.${relation.name}`, relation.schema, relation.owner)
  for (const type of catalog.types) owned(`类型 ${type.schema}.${type.name}`, type.schema, type.owner)
  for (const fn of catalog.functions) owned(`函数 ${fn.schema}.${fn.name}(${fn.args})`, fn.schema, fn.owner)

  // 内部 schema（和 shared）只有它的主人和本块的运行账号能用，运行账号不能建对象；模块的两个 schema 和 shared 只有主人能建对象
  const accountSchema = new Map(owners.map(owner => [owner.account, owner.role]))
  for (const item of catalog.privileges) {
    const at = database.schemas.get(item.schema)
    const expected = expectedOwner(item.schema)
    if (!at || expected === undefined || item.role === expected) continue
    if (accountSchema.get(item.role) === expected && at.kind !== 'api') {
      if (item.create) add(`权限 ${item.schema} ${item.role}`, `${whose.get(item.role)}能在 ${schemaLabel(item.schema, at)} 里建对象（CREATE）`, FIXES.accountCreate(item.schema, item.role, expected))
    } else if (at.kind === 'internal' && (item.usage || item.create)) {
      const what = [item.usage && '使用（USAGE）', item.create && '建对象（CREATE）'].filter(Boolean).join('、')
      add(`权限 ${item.schema} ${item.role}`, `角色 ${item.role} 能${what} ${at.module.id} 模块的内部 schema ${item.schema}`, FIXES.internalPrivilege(item.schema, item.role))
    } else if (item.create) {
      add(`权限 ${item.schema} ${item.role}`, `角色 ${item.role} 能在 ${schemaLabel(item.schema, at)} 里建对象（CREATE）`, FIXES.createPrivilege(item.schema, expected, item.role))
    }
  }

  for (const fn of catalog.functions) {
    if (expectedOwner(fn.schema) === undefined || (fn.kind !== 'f' && fn.kind !== 'p') || fn.securityDefiner) continue
    add(`函数 ${fn.schema}.${fn.name}(${fn.args}) 身份`, `函数 ${fn.schema}.${fn.name}(${fn.args}) 不是 SECURITY DEFINER`, FIXES.securityDefiner)
  }
  for (const relation of catalog.relations) {
    const at = database.schemas.get(relation.schema)
    if (at?.kind !== 'api' || relation.kind !== 'v' || !relation.securityInvoker) continue
    add(`入口视图 ${relation.schema}.${relation.name} 身份`, `入口视图 ${relation.schema}.${relation.name} 设了 security_invoker`, FIXES.securityInvoker(at.module))
  }

  // 角色整个实例共用：库的 CONNECT 授给了 PUBLIC，同一个实例上别的项目的账号就能连进来
  const accounts = [config.migrator, ...owners.map(owner => owner.account)]
  if (catalog.database.publicConnect) add('库 CONNECT', `库 ${catalog.database.name} 的 CONNECT 授给了 PUBLIC`, FIXES.connect(catalog.database.ident, accounts))
  const migrator = roles.get(config.migrator)
  if (!migrator) {
    add(`账号 ${config.migrator}`, `库里没有跑迁移的账号 ${config.migrator}（database.migrator）`, FIXES.migrator(config.migrator))
    return
  }
  const wrong = [!migrator.login && '不能登录', migrator.superuser && '是超级用户', migrator.ownsObjects && '拥有对象'].filter(Boolean)
  if (wrong.length) add(`账号 ${config.migrator} 属性`, `跑迁移的账号 ${config.migrator} ${wrong.join('、')}`, FIXES.migrator(config.migrator))
  if (!migrator.connect) add(`账号 ${config.migrator} CONNECT`, `跑迁移的账号 ${config.migrator} 连不了库 ${catalog.database.name}（没有 CONNECT）`, FIXES.connect(catalog.database.ident, accounts))
}
