// modwall db bootstrap、modwall migrate 在真的 Postgres 上：权限、成员关系、迁移记录这些假 psql 守不住，要真库。命令这一层（参数、退出码）在 migrate.test.ts。
// 用 napbox 起一个临时环境（postgres/compose.yaml：16、17 各一个实例，另有一个 15 的看低于 16 时报错），跑完收掉。
// 16、17 两组同时跑，组里的测试一个接一个：角色整个实例共用，每个测试开始前把实例清回干净（删掉别的库、postgres 以外的角色），再建一个空库。
// psql 用容器里和服务器同一版的那个（napbox exec），本机不用装 psql。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BIN, ENV, type Result, sampleRepo, write } from './helpers.ts'

const COMPOSE_DIR = fileURLToPath(new URL('./postgres/', import.meta.url))
const TEMP = `modwall-pg-${process.pid}`
const DB = 'appdb'
const CONFIG = { roots: ['src/modules'], shared: ['src/shared/**'], app: ['src/main.ts'], entry: ['index.ts'], outside: ['scripts/**'] }
const DATABASE = { migrations: 'migrations', shared: 'src/shared/migrations', login: '<module>_app', migrator: 'migrator' }
const PASSWORD = 'first-pass'
/** 各块的运行账号：账号 → 本块的内部 schema。 */
const ACCOUNTS: Record<string, string> = { billing_app: 'billing', booking_app: 'booking', shared_app: 'shared' }

const SHARED = 'src/shared/migrations/20260101000000_shared.sql'
const BILLING = 'src/modules/billing/migrations/20260101000100_billing.sql'
const BOOKING = 'src/modules/booking/migrations/20260101000200_booking.sql'
/** 示例项目（billing、booking 两个模块）的迁移：表建在本模块的内部 schema，入口放视图和函数，共享层放一个函数。 */
const BASE: Record<string, string> = {
  [SHARED]: [
    'CREATE TABLE settings (k text PRIMARY KEY, v text);',
    "CREATE FUNCTION label(n int) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = shared, pg_temp AS $$ SELECT 'n=' || n $$;",
    '',
  ].join('\n'),
  [BILLING]: [
    'CREATE TABLE invoices (id int PRIMARY KEY, amount int NOT NULL);',
    'INSERT INTO invoices VALUES (1, 100), (2, 250);',
    'CREATE VIEW billing_api.invoices AS SELECT id, amount FROM invoices;',
    'CREATE FUNCTION billing_api.total() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = billing, pg_temp AS $$ SELECT sum(amount)::int FROM invoices $$;',
    'CREATE FUNCTION billing_api.charge(n int, amount int) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = billing, pg_temp AS $$ INSERT INTO invoices VALUES (n, amount) $$;',
    '',
  ].join('\n'),
  [BOOKING]: ['CREATE TABLE bookings (id int PRIMARY KEY);', 'CREATE VIEW booking_api.bookings AS SELECT id FROM bookings;', ''].join('\n'),
}

const checksum = (text: string): string => createHash('sha256').update(text).digest('hex')
/** 放进 sh 命令里的一个参数。 */
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`
/** pg_authid 里存的 SCRAM-SHA-256 是不是由 password 算出来的。 */
function scramOf(stored: string, password: string): boolean {
  const parts = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):/.exec(stored)
  if (!parts) return false
  const salted = pbkdf2Sync(password, Buffer.from(parts[2] as string, 'base64'), Number(parts[1]), 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  return createHash('sha256').update(clientKey).digest('base64') === parts[3]
}
const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const ran = (path: string): string => `modwall migrate：执行 ${path}`
/** 输出里"执行 …"的那几行，按出现的顺序。 */
const executed = (out: string): string[] => out.split('\n').filter(line => line.startsWith('modwall migrate：执行 '))

/** 跑一个命令（不挡住别的测试组），标准输入给 input，拿回退出码和输出。 */
function run(program: string, args: string[], { cwd = COMPOSE_DIR, input = '' }: { cwd?: string; input?: string } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: ENV })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (out += chunk))
    child.on('error', reject)
    child.on('close', code => resolve({ code, out }))
    child.stdin.end(input)
  })
}
const napbox = (args: string[], input?: string): Promise<Result> => run('napbox', args, input === undefined ? {} : { input })
const modwall = (repo: string, args: string[]): Promise<Result> => run(BIN, args, { cwd: repo })

/** 示例项目写上 database 和迁移（路径 → 内容）。 */
const project = (files: Record<string, string> = BASE, database: Record<string, unknown> = {}): string =>
  sampleRepo(dir => {
    write(dir, '.modwall/config.json', JSON.stringify({ ...CONFIG, database: { ...DATABASE, ...database } }))
    for (const [path, text] of Object.entries(files)) write(dir, path, text)
  })

/** 一个实例（compose 里的一个服务）上的操作。 */
function instance(service: string) {
  /** 容器里的 psql 拿不到这边的环境变量：要给密码时在命令前面用 env 设上（null 是不设）。 */
  const withPassword = (password: string | null): string[] => (password === null ? [] : ['env', `MODWALL_LOGIN_PASSWORD=${password}`])
  /** 交给 modwall 的 --psql：在 sh 里跑，先回到起环境的目录（napbox 按目录认环境）。 */
  const psqlCommand = (user: string, password: string | null = null): string =>
    `cd '${COMPOSE_DIR}' && napbox exec ${service} --temp ${TEMP} -- ${[...withPassword(password), 'psql', '-X', '-U', user, '-d', DB].map(quote).join(' ')}`
  /** 以 user 在库里执行 SQL：出错就停（退出码 3）；只输出查询结果，一行一条，列用 | 分开。 */
  const sql = (user: string, text: string, { db = DB, password = null }: { db?: string; password?: string | null } = {}): Promise<Result> =>
    napbox(['exec', service, '--temp', TEMP, '--', ...withPassword(password), 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db], text)
  /** 超级用户执行、必须成功，返回查询结果的各行。 */
  const admin = async (text: string, db = DB): Promise<string[]> => {
    const r = await sql('postgres', text, { db })
    if (r.code !== 0) throw new Error(`超级用户执行 SQL 失败：\n${text}\n${r.out}`)
    return r.out.split('\n').filter(Boolean)
  }
  const bootstrap = (repo: string): Promise<Result> => modwall(repo, ['db', 'bootstrap', '--psql', psqlCommand('postgres')])
  const migrate = (repo: string, { user = 'migrator', password = PASSWORD }: { user?: string; password?: string | null } = {}): Promise<Result> =>
    modwall(repo, ['migrate', '--psql', psqlCommand(user, password)])
  return {
    service, psqlCommand, sql, admin, bootstrap, migrate,
    /** 实例清回干净：删掉 postgres 以外的库和角色，建一个空库。 */
    reset: async (): Promise<void> => {
      await admin(
        [
          "SELECT format('DROP DATABASE %I WITH (FORCE)', datname) FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1') \\gexec",
          "SELECT 'DROP ROLE ' || string_agg(quote_ident(rolname), ', ') FROM pg_roles WHERE rolname <> 'postgres' AND rolname !~ '^pg_' HAVING count(*) > 0 \\gexec",
          `CREATE DATABASE ${DB};`,
        ].join('\n'),
        'postgres',
      )
    },
    /** bootstrap、migrate 都跑通的项目。 */
    migrated: async (files: Record<string, string> = BASE, database: Record<string, unknown> = {}): Promise<string> => {
      const repo = project(files, database)
      for (const step of [bootstrap, migrate]) {
        const r = await step(repo)
        if (r.code !== 0) throw new Error(`准备库没跑通：\n${r.out}`)
      }
      return repo
    },
  }
}

/** 成员关系（组, 成员, 继承, 能切过去, 能管）：同一对有几条授权的合起来看；系统自带的不列。 */
const MEMBERSHIPS = `SELECT g.rolname, u.rolname, bool_or(m.inherit_option), bool_or(m.set_option), bool_or(m.admin_option)
  FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
  WHERE g.rolname !~ '^pg_' GROUP BY 1, 2 ORDER BY 1, 2;`
const PROJECT_ROLES = `SELECT rolname FROM pg_roles WHERE rolname IN ('shared', 'billing', 'booking', 'modules_app', 'shared_app', 'billing_app', 'booking_app') ORDER BY 1;`
/** postgres 以外的角色（内置的不算）。 */
const OTHER_ROLES = `SELECT rolname FROM pg_roles WHERE rolname <> 'postgres' AND rolname !~ '^pg_' ORDER BY 1;`
const PROJECT_SCHEMAS = `SELECT nspname FROM pg_namespace WHERE nspname IN ('shared', 'billing', 'billing_api', 'booking', 'booking_api') ORDER BY 1;`

before(async () => {
  const r = await napbox(['up', '--temp', TEMP, '-f', 'compose.yaml', '--profile', 'pg15', '--profile', 'pg16', '--profile', 'pg17'])
  if (r.code !== 0) throw new Error(`napbox 没起来测试用的 Postgres：\n${r.out}`)
})
after(async () => {
  await napbox(['down', '--temp', TEMP])
})

describe('真的 Postgres 上的 modwall db bootstrap、modwall migrate', { concurrency: true }, () => {
  test('低于 16（15）：bootstrap、migrate 都报要 Postgres 16 以上，什么都没建', async () => {
    const pg = instance('pg15')
    await pg.reset()
    const repo = project()
    const boot = await pg.bootstrap(repo)
    assert.equal(boot.code, 1, boot.out)
    assert.match(boot.out, /modwall db bootstrap 要 Postgres 16 以上，这个库是 15\./)
    assert.deepEqual(await pg.admin(OTHER_ROLES), [])
    const m = await pg.migrate(repo, { user: 'postgres' })
    assert.equal(m.code, 1, m.out)
    assert.match(m.out, /modwall migrate 要 Postgres 16 以上，这个库是 15\./)
    assert.deepEqual(await pg.admin(PROJECT_ROLES), [])
    assert.deepEqual(await pg.admin(PROJECT_SCHEMAS), [])
  })

  for (const service of ['pg16', 'pg17']) {
    describe(`Postgres ${service.slice(2)}`, { concurrency: false }, () => {
      const pg = instance(service)
      const { admin, sql, bootstrap, migrate, migrated } = pg
      beforeEach(() => pg.reset())

      test('bootstrap 只建迁移账号（LOGIN NOINHERIT CREATEROLE，不能建库），不设密码；不建运行账号', async () => {
        const r = await bootstrap(project())
        assert.equal(r.code, 0, r.out)
        assert.match(r.out, /modwall db bootstrap：迁移账号 migrator 好了/)
        assert.deepEqual(await admin(OTHER_ROLES), ['migrator'])
        // 能登录, 继承, 能建角色, 能建库, 超级用户, 没有密码
        const roles = await admin("SELECT rolcanlogin, rolinherit, rolcreaterole, rolcreatedb, rolsuper, rolpassword IS NULL FROM pg_authid WHERE rolname = 'migrator';")
        assert.deepEqual(roles, ['t|f|t|f|f|t'])
      })

      test('bootstrap 后库只让迁移账号连（别的账号连不进来），迁移账号能在库里建 schema、能把 CONNECT 转授，PUBLIC 不能在 public 里建对象', async () => {
        await admin('CREATE ROLE outsider LOGIN; GRANT CREATE ON SCHEMA public TO PUBLIC;')
        const r = await bootstrap(project())
        assert.equal(r.code, 0, r.out)
        assert.deepEqual(await sql('migrator', 'SELECT current_user;'), { code: 0, out: 'migrator\n' })
        const outsider = await sql('outsider', 'SELECT 1;')
        assert.notEqual(outsider.code, 0)
        assert.match(outsider.out, /permission denied for database "appdb"/)
        const privileges = await admin(
          `SELECT has_database_privilege('migrator', '${DB}', 'CREATE'), has_database_privilege('migrator', '${DB}', 'CONNECT WITH GRANT OPTION'), has_schema_privilege('outsider', 'public', 'CREATE');`,
        )
        assert.deepEqual(privileges, ['t|t|f'])
      })

      test('bootstrap 可以重复执行：再跑一次照样通过，账号和授权不变', async () => {
        const repo = project()
        const STATE = `SELECT rolname, rolcanlogin, rolinherit, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'migrator';
          SELECT datacl::text FROM pg_database WHERE datname = '${DB}';
          SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public';`
        assert.equal((await bootstrap(repo)).code, 0)
        const first = await admin(STATE)
        const again = await bootstrap(repo)
        assert.equal(again.code, 0, again.out)
        assert.deepEqual(await admin(STATE), first)
      })

      test('migrate 要用配置的迁移账号连库：用超级用户、别的账号连都报错，什么都不做', async () => {
        const repo = project()
        assert.equal((await bootstrap(repo)).code, 0)
        await admin(`CREATE ROLE outsider LOGIN; GRANT CONNECT ON DATABASE ${DB} TO outsider;`)
        for (const user of ['postgres', 'outsider']) {
          const r = await migrate(repo, { user })
          assert.equal(r.code, 1, r.out)
          assert.match(r.out, new RegExp(`modwall migrate 要用跑迁移的账号 migrator 连库（.modwall/config.json 的 database.migrator），现在连的是 ${user}`))
        }
        assert.deepEqual(await admin(PROJECT_ROLES), [])
        assert.deepEqual(await admin(PROJECT_SCHEMAS), [])
      })

      test('迁移账号不能建角色、不能在库里建 schema、或不能转授 CONNECT：migrate 报错，让先用超级用户跑 bootstrap，什么都不做', async () => {
        const repo = project()
        assert.equal((await bootstrap(repo)).code, 0)
        const takes = ['ALTER ROLE migrator NOCREATEROLE;', `REVOKE CREATE ON DATABASE ${DB} FROM migrator;`, `REVOKE GRANT OPTION FOR CONNECT ON DATABASE ${DB} FROM migrator;`]
        for (const take of takes) {
          await admin(`ALTER ROLE migrator CREATEROLE; GRANT CREATE ON DATABASE ${DB} TO migrator; GRANT CONNECT ON DATABASE ${DB} TO migrator WITH GRANT OPTION; ${take}`)
          const r = await migrate(repo)
          assert.equal(r.code, 1, `${take}\n${r.out}`)
          assert.match(r.out, /跑迁移的账号 migrator 要能建角色、能在库里建 schema、能把 CONNECT 授给运行账号：先用超级用户跑 modwall db bootstrap/, take)
        }
        assert.deepEqual(await admin(PROJECT_ROLES), [])
        assert.deepEqual(await admin(PROJECT_SCHEMAS), [])
      })

      test('psql 的环境里没有 MODWALL_LOGIN_PASSWORD、或是空的：migrate 报错停下，什么都没建', async () => {
        const repo = project()
        assert.equal((await bootstrap(repo)).code, 0)
        const cases: Array<[string | null, RegExp]> = [
          [null, /modwall migrate 要环境变量 MODWALL_LOGIN_PASSWORD（各运行账号的密码），psql 的环境里没有它/],
          ['', /modwall migrate 的环境变量 MODWALL_LOGIN_PASSWORD 是空的/],
        ]
        for (const [password, error] of cases) {
          const r = await migrate(repo, { password })
          assert.equal(r.code, 1, r.out)
          assert.match(r.out, error)
        }
        assert.deepEqual(await admin(PROJECT_ROLES), [])
        assert.deepEqual(await admin(PROJECT_SCHEMAS), [])
      })

      test('migrate 建每个模块的角色、shared 角色和组角色 modules_app（都不能登录），每个模块和共享层一个能登录的运行账号；模块的内部、入口 schema 归模块的角色，shared 归 shared', async () => {
        await migrated()
        assert.deepEqual(await admin(`SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname <> 'postgres' AND rolname !~ '^pg_' ORDER BY 1;`), [
          'billing|f',
          'billing_app|t',
          'booking|f',
          'booking_app|t',
          'migrator|t',
          'modules_app|f',
          'shared|f',
          'shared_app|t',
        ])
        assert.deepEqual(await admin(`SELECT nspname, pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname IN ('shared', 'billing', 'billing_api', 'booking', 'booking_api') ORDER BY 1;`), [
          'billing|billing',
          'billing_api|billing',
          'booking|booking',
          'booking_api|booking',
          'shared|shared',
        ])
      })

      test('实例里已有同名的角色、不是迁移账号建的：migrate 报错，整步回滚（什么都没建），不借用它', async () => {
        const repo = project()
        assert.equal((await bootstrap(repo)).code, 0)
        await admin('CREATE ROLE billing NOLOGIN;')
        const r = await migrate(repo)
        assert.equal(r.code, 1, r.out)
        assert.match(r.out, /角色 billing 已经有了，但不是跑迁移的账号 migrator 建的/)
        assert.match(r.out, /出错的那一步整步回滚了/)
        assert.deepEqual(await admin(PROJECT_ROLES), ['billing'])
        assert.deepEqual(await admin(PROJECT_SCHEMAS), [])
        assert.deepEqual(await admin(MEMBERSHIPS), [])
      })

      test('成员关系：迁移账号是各模块角色和 shared 的成员（不继承、能切过去）；模块的角色和运行账号在组角色里（继承、不能切）；共享层的角色和运行账号不在组角色里', async () => {
        await migrated()
        // 组, 成员, 继承, 能切过去, 能管（迁移账号建的角色归它管）
        assert.deepEqual(await admin(MEMBERSHIPS), [
          'billing|migrator|f|t|t',
          'billing_app|migrator|f|f|t',
          'booking|migrator|f|t|t',
          'booking_app|migrator|f|f|t',
          'modules_app|billing|t|f|f',
          'modules_app|billing_app|t|f|f',
          'modules_app|booking|t|f|f',
          'modules_app|booking_app|t|f|f',
          'modules_app|migrator|f|f|t',
          'shared|migrator|f|t|t',
          'shared_app|migrator|f|f|t',
        ])
      })

      test('运行账号的密码就是 MODWALL_LOGIN_PASSWORD，每次 migrate 都重设；迁移账号以前建的、不能登录的同名账号也改成能登录；能连库，默认的 search_path 是本块的内部 schema 加 pg_temp', async () => {
        const repo = project()
        assert.equal((await bootstrap(repo)).code, 0)
        assert.equal((await sql('migrator', 'CREATE ROLE billing_app NOLOGIN;')).code, 0)
        const passwordsAre = async (password: string): Promise<void> => {
          const rows = (await admin(`SELECT rolname, rolcanlogin, rolpassword FROM pg_authid WHERE rolname IN ('billing_app', 'booking_app', 'shared_app') ORDER BY 1;`)).map(row => row.split('|'))
          assert.deepEqual(rows.map(([name, login]) => `${name}|${login}`), ['billing_app|t', 'booking_app|t', 'shared_app|t'])
          for (const [name, , stored] of rows) assert.ok(scramOf(stored as string, password), `${name} 的密码不是 ${password}：${stored}`)
        }
        const first = await migrate(repo)
        assert.equal(first.code, 0, first.out)
        await passwordsAre(PASSWORD)
        const again = await migrate(repo, { password: "o'brien 2" })
        assert.equal(again.code, 0, again.out)
        assert.equal(again.out, 'modwall migrate：没有要跑的迁移，库已是最新\n')
        await passwordsAre("o'brien 2")
        for (const [account, schema] of Object.entries(ACCOUNTS)) {
          assert.deepEqual(await sql(account, 'SELECT current_user; SHOW search_path;'), { code: 0, out: `${account}\n${schema}, pg_temp\n` })
        }
      })

      test('每个模块和 shared 一个 run_migration：归该角色、SECURITY DEFINER、search_path 是本 schema 和 pg_temp、PUBLIC 不能执行；迁移经它执行，建出来的对象在本模块的内部 schema、归本模块的角色', async () => {
        await migrated()
        // schema, 主人, SECURITY DEFINER, 设置, PUBLIC 能执行
        const functions = await admin(`SELECT n.nspname, pg_get_userbyid(p.proowner), p.prosecdef, array_to_string(p.proconfig, ';'),
            EXISTS (SELECT FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'run_migration' ORDER BY 1;`)
        assert.deepEqual(functions, ['billing', 'booking', 'shared'].map(owner => `${owner}|${owner}|t|search_path=${owner}, pg_temp|f`))
        const objects = await admin(`SELECT n.nspname || '.' || c.relname, pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname IN ('settings', 'invoices', 'bookings') ORDER BY 1;`)
        assert.deepEqual(objects, ['billing.invoices|billing', 'billing_api.invoices|billing', 'booking.bookings|booking', 'booking_api.bookings|booking', 'shared.settings|shared'])
      })

      test('迁移里写了切身份（SET ROLE、set_config 设 role）：库拒绝，这个迁移整个回滚、不记录', async () => {
        const repo = await migrated()
        const path = 'src/modules/billing/migrations/20260101000300_sneaky.sql'
        for (const sneak of ['SET ROLE shared;', "SELECT set_config('role', 'shared', false);"]) {
          write(repo, path, `CREATE TABLE sneaky (id int);\n${sneak}\n`)
          const r = await migrate(repo)
          assert.equal(r.code, 1, `${sneak}\n${r.out}`)
          assert.match(r.out, /cannot set parameter "role" within security-definer function/, sneak)
          assert.match(r.out, /出错的那一步整步回滚了/)
          const left = await admin(`SELECT to_regclass('billing.sneaky') IS NULL, count(*) FROM shared.modwall_migrations WHERE name = '20260101000300_sneaky.sql';`)
          assert.deepEqual(left, ['t|0'], sneak)
        }
      })

      test('迁移记在 shared.modwall_migrations（文件名、内容的 checksum、执行时间）；各模块和共享层的迁移按文件名统一排序执行；再跑只跑没跑过的，没有要跑的说库已是最新', async () => {
        const MORE = 'src/shared/migrations/20260101000150_more.sql'
        const files: Record<string, string> = { ...BASE, [MORE]: 'CREATE TABLE more (id int);\n' }
        const repo = project(files)
        assert.equal((await bootstrap(repo)).code, 0)
        const first = await migrate(repo)
        assert.equal(first.code, 0, first.out)
        const order = [SHARED, BILLING, MORE, BOOKING]
        assert.deepEqual(executed(first.out), order.map(ran))
        assert.match(first.out, /modwall migrate：完成\n$/)
        const ledger = await admin('SELECT name, checksum FROM shared.modwall_migrations ORDER BY applied_at, name;')
        assert.deepEqual(ledger, order.map(path => `${fileName(path)}|${checksum(files[path] as string)}`))
        assert.deepEqual(await admin('SELECT count(*) FROM shared.modwall_migrations WHERE applied_at IS NULL OR applied_at > now();'), ['0'])

        const again = await migrate(repo)
        assert.equal(again.code, 0, again.out)
        assert.equal(again.out, 'modwall migrate：没有要跑的迁移，库已是最新\n')

        const NEW = 'src/modules/booking/migrations/20260101000300_new.sql'
        write(repo, NEW, 'CREATE TABLE extra (id int);\n')
        const next = await migrate(repo)
        assert.equal(next.code, 0, next.out)
        assert.deepEqual(executed(next.out), [ran(NEW)])
        assert.match(next.out, /modwall migrate：完成\n$/)
        assert.deepEqual(await admin('SELECT count(*) FROM shared.modwall_migrations;'), ['5'])
      })

      test('一个迁移文件一个事务：出错的那个整个回滚、不记录，后面的不跑；改好再跑从它接着跑', async () => {
        const repo = project({ ...BASE, [BILLING]: `${BASE[BILLING]}SELECT 1 / 0;\n` })
        assert.equal((await bootstrap(repo)).code, 0)
        const r = await migrate(repo)
        assert.equal(r.code, 1, r.out)
        assert.deepEqual(executed(r.out), [ran(SHARED), ran(BILLING)])
        assert.match(r.out, /division by zero/)
        assert.match(r.out, /modwall migrate：没做完，出错的那一步整步回滚了/)
        const left = await admin(`SELECT name FROM shared.modwall_migrations; SELECT to_regclass('billing.invoices') IS NULL, to_regclass('booking.bookings') IS NULL;`)
        assert.deepEqual(left, ['20260101000000_shared.sql', 't|t'])

        write(repo, BILLING, BASE[BILLING] as string)
        const fixed = await migrate(repo)
        assert.equal(fixed.code, 0, fixed.out)
        assert.deepEqual(executed(fixed.out), [ran(BILLING), ran(BOOKING)])
      })

      test('跑过的迁移改了内容、文件删了：报错说是哪几个，一个都不跑（新加的也不跑）', async () => {
        const repo = await migrated()
        write(repo, BOOKING, `${BASE[BOOKING]}-- 改了一下\n`)
        rmSync(join(repo, BILLING))
        write(repo, 'src/modules/booking/migrations/20260101000300_new.sql', 'CREATE TABLE extra (id int);\n')
        const r = await migrate(repo)
        assert.equal(r.code, 1, r.out)
        assert.match(r.out, /跑过的迁移改了内容：20260101000200_booking\.sql；文件不见了：20260101000100_billing\.sql，一个都没跑/)
        assert.deepEqual(executed(r.out), [])
        assert.deepEqual(await admin(`SELECT count(*) FROM shared.modwall_migrations; SELECT to_regclass('booking.extra') IS NULL;`), ['3', 't'])
      })

      test('同一个库同时跑两次 migrate：排队，同一个迁移只执行一次', async () => {
        const repo = await migrated()
        const ONCE = 'src/modules/billing/migrations/20260101000300_once.sql'
        write(repo, ONCE, 'CREATE TABLE once (id int);\nINSERT INTO once VALUES (1);\n')
        // 超级用户先锁住迁移记录表，等两次 migrate 都在等锁了再放开：两次一定撞在一起
        const holder = sql('postgres', `BEGIN;
LOCK TABLE shared.modwall_migrations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  FOR i IN 1..600 LOOP
    IF (SELECT count(*) FROM pg_locks WHERE NOT granted) >= 2 THEN RETURN; END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
  RAISE EXCEPTION '两次 migrate 没有同时在等锁';
END $$;
COMMIT;`)
        const LOCKED = "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'modwall_migrations' AND l.mode = 'AccessExclusiveLock' AND l.granted;"
        let locked = false
        for (let i = 0; i < 100 && !locked; i++) locked = (await admin(LOCKED))[0] === '1'
        assert.ok(locked, '超级用户没锁上迁移记录表')
        const runs = [migrate(repo), migrate(repo)]
        const held = await holder
        assert.equal(held.code, 0, held.out)
        const outs = await Promise.all(runs)
        for (const r of outs) assert.equal(r.code, 0, r.out)
        assert.deepEqual(outs.map(r => executed(r.out)).sort((a, b) => a.length - b.length), [[], [ran(ONCE)]])
        assert.ok(outs.some(r => r.out.includes('modwall migrate：没有要跑的迁移，库已是最新')), outs.map(r => r.out).join('\n'))
        assert.deepEqual(await admin(`SELECT count(*) FROM billing.once; SELECT count(*) FROM shared.modwall_migrations WHERE name = '20260101000300_once.sql';`), ['1', '1'])
      })

      test('迁移正文里的 psql 写法（:变量、反斜杠命令）不被 psql 解释，$$ 函数体照常执行', async () => {
        const repo = await migrated()
        // modwall_ran 是 migrate 的脚本里设的 psql 变量：被 psql 换掉的话取到的是 a[1:1]
        write(repo, 'src/modules/billing/migrations/20260101000300_slice.sql', [
          'CREATE TABLE slices (modwall_ran int, a int[]);',
          'INSERT INTO slices VALUES (2, ARRAY[10, 20, 30]);',
          'CREATE TABLE picked AS SELECT a[1:modwall_ran] AS s FROM slices;',
          "CREATE FUNCTION billing_api.greet() RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = billing, pg_temp AS $$\nBEGIN\n  RETURN 'hi:' || (SELECT s::text FROM picked);\nEND $$;",
          '',
        ].join('\n'))
        const r = await migrate(repo)
        assert.equal(r.code, 0, r.out)
        assert.deepEqual(await admin('SELECT billing_api.greet();'), ['hi:{10,20}'])

        // \! 要是被 psql 当成命令，会在容器里建出这个文件；交给库的话是语法错误，这个迁移回滚
        const MARK = '/tmp/modwall-psql-ran'
        write(repo, 'src/modules/billing/migrations/20260101000400_shell.sql', `CREATE TABLE shell (id int);\n\\! touch ${MARK}\n`)
        const shell = await migrate(repo)
        assert.equal(shell.code, 1, shell.out)
        assert.match(shell.out, /syntax error at or near "\\"/)
        assert.equal((await napbox(['exec', service, '--temp', TEMP, '--', 'test', '-e', MARK])).code, 1, 'psql 没有执行 \\! 的命令')
        assert.deepEqual(await admin(`SELECT to_regclass('billing.shell') IS NULL;`), ['t'])
      })

      test('干净的项目：bootstrap、migrate（--print 出的脚本直接交给 psql 跑，打包上线的用法）之后 modwall db check 直接通过', async () => {
        const repo = project()
        const printed = async (args: string[]): Promise<string> => {
          const r = await modwall(repo, args)
          if (r.code !== 0) throw new Error(`${args.join(' ')} 没输出脚本：\n${r.out}`)
          return r.out
        }
        const boot = await sql('postgres', await printed(['db', 'bootstrap', '--print']))
        assert.equal(boot.code, 0, boot.out)
        const m = await sql('migrator', await printed(['migrate', '--print']), { password: PASSWORD })
        assert.equal(m.code, 0, m.out)
        assert.deepEqual(executed(m.out), [SHARED, BILLING, BOOKING].map(ran))
        const check = await modwall(repo, ['db', 'check', '--psql', pg.psqlCommand('migrator')])
        assert.equal(check.code, 0, check.out)
        assert.match(check.out, /modwall db check：通过。库里没有越界/)
      })

      test('模块的运行账号读写本模块内部 schema 的表（serial、identity 的列能插入），以后的迁移新建的表也能；建不了对象、调不了 run_migration、不拥有对象', async () => {
        const repo = await migrated()
        write(repo, 'src/modules/billing/migrations/20260101000300_later.sql', 'CREATE TABLE notes (id serial PRIMARY KEY, body text);\nCREATE TABLE tags (id int GENERATED ALWAYS AS IDENTITY, name text);\n')
        const later = await migrate(repo)
        assert.equal(later.code, 0, later.out)
        const as = (query: string): Promise<Result> => sql('billing_app', query)
        assert.deepEqual(await as('INSERT INTO invoices VALUES (3, 30); UPDATE invoices SET amount = 31 WHERE id = 3; DELETE FROM invoices WHERE id = 1; SELECT id, amount FROM invoices ORDER BY id;'), {
          code: 0,
          out: '2|250\n3|31\n',
        })
        assert.deepEqual(await as("INSERT INTO notes (body) VALUES ('a'); INSERT INTO tags (name) VALUES ('b'); UPDATE notes SET body = 'c'; DELETE FROM tags; SELECT id, body FROM notes;"), {
          code: 0,
          out: '1|c\n',
        })
        const denied: Array<[string, RegExp]> = [
          ['CREATE TABLE scratch (id int);', /permission denied for schema billing/],
          ['CREATE TABLE public.scratch (id int);', /permission denied for schema public/],
          ['CREATE SCHEMA scratch;', /permission denied for database appdb/],
          ["SELECT billing.run_migration('CREATE TABLE scratch (id int)');", /permission denied for function run_migration/],
        ]
        for (const [query, error] of denied) {
          const r = await as(query)
          assert.equal(r.code, 3, `${query}\n${r.out}`)
          assert.match(r.out, error, query)
        }
        assert.deepEqual(await admin(`SELECT count(*) FROM pg_shdepend WHERE refobjid = 'billing_app'::regrole AND deptype = 'o';`), ['0'])
      })

      test('模块的运行账号读不了别的模块的内部 schema；能读别的模块入口里的视图、调入口里的函数和 shared 的函数，在自己的事务里经对方入口写入时一起提交、一起失败；切不成任何模块的角色和组角色', async () => {
        await migrated()
        assert.deepEqual(await sql('booking_app', 'SELECT count(*) FROM billing_api.invoices; SELECT billing_api.total(); SELECT shared.label(3);'), { code: 0, out: '2\n350\nn=3\n' })
        const BOTH = 'SELECT (SELECT count(*) FROM booking.bookings WHERE id = 7), (SELECT count(*) FROM billing.invoices WHERE id = 7);'
        // 对方入口的函数出错（id 1 已经有了）：本模块先写的那行也不留
        const failed = await sql('booking_app', 'BEGIN; INSERT INTO bookings VALUES (7); SELECT billing_api.charge(1, 70); COMMIT;')
        assert.equal(failed.code, 3, failed.out)
        assert.match(failed.out, /duplicate key value/)
        assert.deepEqual(await admin(BOTH), ['0|0'])
        const done = await sql('booking_app', 'BEGIN; INSERT INTO bookings VALUES (7); SELECT billing_api.charge(7, 70); COMMIT;')
        assert.equal(done.code, 0, done.out)
        assert.deepEqual(await admin(BOTH), ['1|1'])
        const denied: Array<[string, RegExp]> = [
          ['SELECT count(*) FROM billing.invoices;', /permission denied for schema billing\b/],
          ...['billing', 'booking', 'shared', 'modules_app'].map((role): [string, RegExp] => [`SET ROLE ${role};`, new RegExp(`permission denied to set role "${role}"`)]),
        ]
        for (const [query, error] of denied) {
          const r = await sql('booking_app', query)
          assert.equal(r.code, 3, `${query}\n${r.out}`)
          assert.match(r.out, error, query)
        }
      })

      test('共享层的运行账号读写 shared 的表；读不到任何模块的入口，碰不到迁移记录，调不了 run_migration，切不成 shared 角色和组角色', async () => {
        await migrated()
        assert.deepEqual(await sql('shared_app', "INSERT INTO settings VALUES ('k', 'v'); UPDATE settings SET v = 'w'; SELECT k, v FROM settings; SELECT label(2); DELETE FROM settings;"), {
          code: 0,
          out: 'k|w\nn=2\n',
        })
        const denied: Array<[string, RegExp]> = [
          ['SELECT count(*) FROM billing_api.invoices;', /permission denied for schema billing_api/],
          ['SELECT count(*) FROM booking_api.bookings;', /permission denied for schema booking_api/],
          ['SELECT count(*) FROM shared.modwall_migrations;', /permission denied for table modwall_migrations/],
          ["INSERT INTO shared.modwall_migrations (name, checksum) VALUES ('x', 'y');", /permission denied for table modwall_migrations/],
          ["SELECT shared.run_migration('SELECT 1');", /permission denied for function run_migration/],
          ['SET ROLE shared;', /permission denied to set role "shared"/],
          ['SET ROLE modules_app;', /permission denied to set role "modules_app"/],
        ]
        for (const [query, error] of denied) {
          const r = await sql('shared_app', query)
          assert.equal(r.code, 3, `${query}\n${r.out}`)
          assert.match(r.out, error, query)
        }
      })

      test('migrate 之后加了越权的成员关系、授权，改了运行账号：modwall db check 报', async () => {
        const repo = await migrated()
        await admin(
          [
            'GRANT pg_read_all_data TO modules_app;',
            'GRANT modules_app TO shared;',
            // 以前的做法：一个登录账号属于所有模块的角色
            'CREATE ROLE app LOGIN;',
            'GRANT billing, booking TO app WITH INHERIT FALSE, SET TRUE;',
            'GRANT CREATE ON SCHEMA billing TO billing_app;',
            'ALTER TABLE billing.invoices OWNER TO billing_app;',
            'ALTER ROLE booking_app NOLOGIN;',
          ].join('\n'),
        )
        assert.equal((await sql('migrator', `REVOKE CONNECT ON DATABASE ${DB} FROM booking_app;`)).code, 0)
        const r = await modwall(repo, ['db', 'check', '--psql', pg.psqlCommand('migrator')])
        assert.equal(r.code, 1, r.out)
        for (const line of [
          '角色 billing_app 能使用（USAGE） booking 模块的内部 schema booking',
          '共享层的角色 shared 能切成（SET）、继承（INHERIT）角色 modules_app',
          '角色 app 能切成（SET）billing 模块的角色 billing',
          '角色 app 能切成（SET）booking 模块的角色 booking',
          'billing 模块的运行账号 billing_app能在 billing 模块的内部 schema billing 里建对象（CREATE）',
          'billing 模块的运行账号 billing_app 拥有对象',
          'booking 模块的运行账号 booking_app 不能登录、连不了库 appdb（没有 CONNECT）',
        ]) {
          assert.ok(r.out.includes(`✗ ${line}\n`), `没报：${line}\n${r.out}`)
        }
      })

      test('运行账号连着的会话建了临时表：modwall db check 不算它拥有对象', async () => {
        const repo = await migrated()
        const holding = sql('billing_app', 'CREATE TEMP TABLE scratch (id int); SELECT pg_sleep(60);')
        try {
          // 库里记着 billing_app 拥有这张临时表
          const TEMP_TABLES = `SELECT count(*) FROM pg_shdepend d JOIN pg_class c ON c.oid = d.objid
            WHERE d.refobjid = 'billing_app'::regrole AND d.deptype = 'o' AND d.classid = 'pg_class'::regclass AND c.relpersistence = 't';`
          let created = false
          for (let i = 0; i < 100 && !created; i++) created = (await admin(TEMP_TABLES))[0] !== '0'
          assert.ok(created, 'billing_app 的会话没建出临时表')
          const check = await modwall(repo, ['db', 'check', '--psql', pg.psqlCommand('migrator')])
          assert.equal(check.code, 0, check.out)
        } finally {
          await admin("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'billing_app';")
          await holding
        }
      })
    })
  }
})
