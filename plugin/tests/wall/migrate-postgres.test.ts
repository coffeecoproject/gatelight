// modwall db bootstrap、modwall migrate 在真的 Postgres 上：权限、成员关系、迁移记录这些假 psql 守不住，要真库。命令这一层（参数、退出码）在 migrate.test.ts。
// 用 napbox 起一个临时环境（postgres/compose.yaml：16、17 各一个实例，另有一个 15 的看低于 16 时报错），跑完收掉。
// 16、17 两组同时跑，组里的测试一个接一个：角色整个实例共用，每个测试开始前把实例清回干净（删掉别的库、postgres 以外的角色），再建一个空库。
// psql 用容器里和服务器同一版的那个（napbox exec），本机不用装 psql。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BIN, editConfig, ENV, type Result, sampleRepo, write } from './helpers.ts'

const COMPOSE_DIR = fileURLToPath(new URL('./postgres/', import.meta.url))
const TEMP = `modwall-pg-${process.pid}`
const DB = 'appdb'
const CONFIG = { roots: ['src/modules'], shared: ['src/shared/**'], app: ['src/main.ts'], entry: ['index.ts'], outside: ['scripts/**'] }
const DATABASE = { migrations: 'migrations', shared: 'src/shared/migrations', login: 'app', migrator: 'migrator' }

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
    '',
  ].join('\n'),
  [BOOKING]: ['CREATE TABLE bookings (id int PRIMARY KEY);', 'CREATE VIEW booking_api.bookings AS SELECT id FROM bookings;', ''].join('\n'),
}

const checksum = (text: string): string => createHash('sha256').update(text).digest('hex')
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
  /** 交给 modwall 的 --psql：在 sh 里跑，先回到起环境的目录（napbox 按目录认环境）。 */
  const psqlCommand = (user: string): string => `cd '${COMPOSE_DIR}' && napbox exec ${service} --temp ${TEMP} -- psql -X -U ${user} -d ${DB}`
  /** 以 user 在库里执行 SQL：出错就停（退出码 3）；只输出查询结果，一行一条，列用 | 分开。 */
  const sql = (user: string, text: string, db = DB): Promise<Result> =>
    napbox(['exec', service, '--temp', TEMP, '--', 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db], text)
  /** 超级用户执行、必须成功，返回查询结果的各行。 */
  const admin = async (text: string, db = DB): Promise<string[]> => {
    const r = await sql('postgres', text, db)
    if (r.code !== 0) throw new Error(`超级用户执行 SQL 失败：\n${text}\n${r.out}`)
    return r.out.split('\n').filter(Boolean)
  }
  const bootstrap = (repo: string): Promise<Result> => modwall(repo, ['db', 'bootstrap', '--psql', psqlCommand('postgres')])
  const migrate = (repo: string, user = 'migrator'): Promise<Result> => modwall(repo, ['migrate', '--psql', psqlCommand(user)])
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
const PROJECT_ROLES = `SELECT rolname FROM pg_roles WHERE rolname IN ('shared', 'billing', 'booking', 'app_modules') ORDER BY 1;`
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
    assert.deepEqual(await pg.admin("SELECT rolname FROM pg_roles WHERE rolname IN ('app', 'migrator');"), [])
    const m = await pg.migrate(repo, 'postgres')
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

      test('bootstrap 建登录账号（LOGIN NOINHERIT，不能建角色、建库）和迁移账号（LOGIN NOINHERIT CREATEROLE，不能建库），不设密码', async () => {
        const r = await bootstrap(project())
        assert.equal(r.code, 0, r.out)
        assert.match(r.out, /modwall db bootstrap：账号 app、migrator 好了/)
        // 账号, 能登录, 继承, 能建角色, 能建库, 超级用户, 没有密码
        const roles = await admin("SELECT rolname, rolcanlogin, rolinherit, rolcreaterole, rolcreatedb, rolsuper, rolpassword IS NULL FROM pg_authid WHERE rolname IN ('app', 'migrator') ORDER BY 1;")
        assert.deepEqual(roles, ['app|t|f|f|f|f|t', 'migrator|t|f|t|f|f|t'])
      })

      test('bootstrap 后库只让登录账号、迁移账号连（别的账号连不进来），迁移账号能在库里建 schema，PUBLIC 不能在 public 里建对象', async () => {
        await admin('CREATE ROLE outsider LOGIN; GRANT CREATE ON SCHEMA public TO PUBLIC;')
        const r = await bootstrap(project())
        assert.equal(r.code, 0, r.out)
        for (const user of ['app', 'migrator']) assert.deepEqual(await sql(user, 'SELECT current_user;'), { code: 0, out: `${user}\n` })
        const outsider = await sql('outsider', 'SELECT 1;')
        assert.notEqual(outsider.code, 0)
        assert.match(outsider.out, /permission denied for database "appdb"/)
        const privileges = await admin(`SELECT has_database_privilege('migrator', '${DB}', 'CREATE'), has_database_privilege('app', '${DB}', 'CREATE'), has_schema_privilege('outsider', 'public', 'CREATE');`)
        assert.deepEqual(privileges, ['t|f|f'])
      })

      test('bootstrap 可以重复执行：再跑一次照样通过，账号和授权不变', async () => {
        const repo = project()
        const STATE = `SELECT rolname, rolcanlogin, rolinherit, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname IN ('app', 'migrator') ORDER BY 1;
          SELECT datacl::text FROM pg_database WHERE datname = '${DB}';
          SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public';`
        assert.equal((await bootstrap(repo)).code, 0)
        const first = await admin(STATE)
        const again = await bootstrap(repo)
        assert.equal(again.code, 0, again.out)
        assert.deepEqual(await admin(STATE), first)
      })

      test('migrate 要用配置的迁移账号连库：用超级用户、登录账号连都报错，什么都不做', async () => {
        const repo = project()
        assert.equal((await bootstrap(repo)).code, 0)
        for (const user of ['postgres', 'app']) {
          const r = await migrate(repo, user)
          assert.equal(r.code, 1, r.out)
          assert.match(r.out, new RegExp(`modwall migrate 要用跑迁移的账号 migrator 连库（.modwall/config.json 的 database.migrator），现在连的是 ${user}`))
        }
        assert.deepEqual(await admin(PROJECT_ROLES), [])
        assert.deepEqual(await admin(PROJECT_SCHEMAS), [])
      })

      test('迁移账号不能建角色、或不能在库里建 schema：migrate 报错，让先用超级用户跑 bootstrap，什么都不做', async () => {
        const repo = project()
        assert.equal((await bootstrap(repo)).code, 0)
        for (const take of ['ALTER ROLE migrator NOCREATEROLE;', `REVOKE CREATE ON DATABASE ${DB} FROM migrator;`]) {
          await admin(`ALTER ROLE migrator CREATEROLE; GRANT CREATE ON DATABASE ${DB} TO migrator; ${take}`)
          const r = await migrate(repo)
          assert.equal(r.code, 1, `${take}\n${r.out}`)
          assert.match(r.out, /跑迁移的账号 migrator 要能建角色、能在库里建 schema：先用超级用户跑 modwall db bootstrap/, take)
        }
        assert.deepEqual(await admin(PROJECT_ROLES), [])
        assert.deepEqual(await admin(PROJECT_SCHEMAS), [])
      })

      test('migrate 建每个模块的角色、shared 角色和组角色 app_modules（都不能登录）；模块的内部、入口 schema 归模块的角色，shared 归 shared', async () => {
        await migrated()
        assert.deepEqual(await admin(`SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('shared', 'billing', 'booking', 'app_modules') ORDER BY 1;`), [
          'app_modules|f',
          'billing|f',
          'booking|f',
          'shared|f',
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

      test('成员关系：迁移账号是各模块角色和 shared 的成员，登录账号是各模块角色的成员、不是 shared 的（都不继承、能切过去）；模块角色在组角色里（继承）', async () => {
        await migrated()
        // 组, 成员, 继承, 能切过去, 能管（迁移账号建的角色归它管）
        assert.deepEqual(await admin(MEMBERSHIPS), [
          'app_modules|billing|t|f|f',
          'app_modules|booking|t|f|f',
          'app_modules|migrator|f|f|t',
          'billing|app|f|t|f',
          'billing|migrator|f|t|t',
          'booking|app|f|t|f',
          'booking|migrator|f|t|t',
          'shared|migrator|f|t|t',
        ])
      })

      test('配置写了 database.runtime：migrate 给每个模块建运行角色、放进组角色；登录账号改成只是运行角色的成员，原来是模块角色成员的收回', async () => {
        const repo = await migrated()
        editConfig(repo, config => {
          config.database.runtime = '<module>_app'
        })
        const r = await migrate(repo)
        assert.equal(r.code, 0, r.out)
        assert.deepEqual(await admin(MEMBERSHIPS), [
          'app_modules|billing|t|f|f',
          'app_modules|billing_app|t|f|f',
          'app_modules|booking|t|f|f',
          'app_modules|booking_app|t|f|f',
          'app_modules|migrator|f|f|t',
          'billing|migrator|f|t|t',
          'billing_app|app|f|t|f',
          'billing_app|migrator|f|f|t',
          'booking|migrator|f|t|t',
          'booking_app|app|f|t|f',
          'booking_app|migrator|f|f|t',
          'shared|migrator|f|t|t',
        ])
        assert.deepEqual(await admin(`SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname LIKE '%\\_app' ORDER BY 1;`), ['billing_app|f', 'booking_app|f'])
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

      test('干净的项目：bootstrap、migrate（--print 出的脚本直接交给 psql 跑，打包上线的用法）之后 modwall db check 通过', async () => {
        const repo = project()
        const printed = async (args: string[]): Promise<string> => {
          const r = await modwall(repo, args)
          if (r.code !== 0) throw new Error(`${args.join(' ')} 没输出脚本：\n${r.out}`)
          return r.out
        }
        const boot = await sql('postgres', await printed(['db', 'bootstrap', '--print']))
        assert.equal(boot.code, 0, boot.out)
        const m = await sql('migrator', await printed(['migrate', '--print']))
        assert.equal(m.code, 0, m.out)
        assert.deepEqual(executed(m.out), [SHARED, BILLING, BOOKING].map(ran))
        const check = await modwall(repo, ['db', 'check', '--psql', pg.psqlCommand('app')])
        assert.equal(check.code, 0, check.out)
        assert.match(check.out, /modwall db check：通过。库里没有越界/)
      })

      test('登录账号切成一个模块后能读另一个模块入口里的视图、调入口里的函数、用 shared 的函数，读不了对方的内部表；不切身份读不了入口；切不成 shared；模块读不到迁移记录', async () => {
        await migrated()
        const as = (role: string, query: string): Promise<Result> => sql('app', `BEGIN; SET LOCAL ROLE ${role}; ${query} COMMIT;`)
        assert.deepEqual(await as('booking', 'SELECT count(*) FROM billing_api.invoices; SELECT billing_api.total(); SELECT shared.label(3);'), { code: 0, out: '2\n350\nn=3\n' })
        const denied: Array<[Result, RegExp]> = [
          [await as('booking', 'SELECT count(*) FROM billing.invoices;'), /permission denied for schema billing\b/],
          [await sql('app', 'SELECT count(*) FROM billing_api.invoices;'), /permission denied for schema billing_api/],
          [await sql('app', 'SET ROLE shared;'), /permission denied to set role "shared"/],
          [await as('billing', 'SELECT count(*) FROM shared.modwall_migrations;'), /permission denied for table modwall_migrations/],
        ]
        for (const [r, error] of denied) {
          assert.equal(r.code, 3, r.out)
          assert.match(r.out, error)
        }
      })
    })
  }
})
