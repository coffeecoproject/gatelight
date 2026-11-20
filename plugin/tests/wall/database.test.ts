import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type Config, parseConfig } from '../../src/wall/config.ts'
import { schemaName, unreadSql } from '../../src/wall/database.ts'
import { codeRoleSwitches, migrationViolations } from '../../src/wall/dbrules.ts'
import { Layout } from '../../src/wall/layout.ts'
import { importViolations } from '../../src/wall/rules.ts'
import { statements } from '../../src/wall/sql.ts'
import { modwall, sampleRepo, write } from './helpers.ts'

const DATABASE = { migrations: 'migrations', shared: 'src/shared/migrations', login: 'app', migrator: 'migrator' }

/** 示例项目的划分加上数据库；sql：迁移文件 → 内容。 */
function project(sql: Record<string, string>, extra: Record<string, unknown> = {}): { layout: Layout; read: (path: string) => string } {
  const parsed = parseConfig(
    JSON.stringify({ roots: ['src/modules'], shared: ['src/shared/**'], app: ['src/main.ts'], entry: ['index.ts'], database: DATABASE, ...extra }),
  )
  assert.deepEqual(parsed.problems, [])
  const files = ['src/main.ts', 'src/modules/orders/index.ts', 'src/modules/billing/index.ts', 'src/modules/adminAccess/index.ts', ...Object.keys(sql)]
  return { layout: new Layout(parsed.config as Config, files), read: path => sql[path] as string }
}

const ORDERS = 'src/modules/orders/migrations/20261118090000_orders.sql'
const BILLING = 'src/modules/billing/migrations/20261118090100_billing.sql'
const SHARED = 'src/shared/migrations/20261118080000_shared.sql'

function r6(sql: Record<string, string>): Array<{ key: string; where: string; fix: string }> {
  const { layout, read } = project(sql)
  assert.deepEqual(layout.problems, [])
  return migrationViolations(layout.databases, read).violations.map(v => ({ key: v.key, where: v.where[0] as string, fix: v.fix }))
}

describe('数据库的 schema 和迁移文件（配置）', () => {
  test('schema 名由模块目录名转成小写加下划线，入口加 _api，共享层是 shared', () => {
    assert.deepEqual(['adminAccess', 'orders', 'private-lessons', 'HTTPServer'].map(schemaName), ['admin_access', 'orders', 'private_lessons', 'http_server'])
    const { layout } = project({})
    const schemas = [...(layout.databases[0]?.schemas.entries() ?? [])].map(([schema, owner]) => `${schema} ${owner.kind}${'module' in owner ? ` ${owner.module.id}` : ''}`)
    assert.deepEqual(schemas.sort(), [
      'admin_access internal adminAccess',
      'admin_access_api api adminAccess',
      'billing internal billing',
      'billing_api api billing',
      'orders internal orders',
      'orders_api api orders',
      'shared shared',
    ])
  })

  test('迁移文件：模块目录下的迁移子目录和共享层的迁移目录里第一层的 .sql', () => {
    const { layout } = project({ [ORDERS]: '', [SHARED]: '', 'src/modules/orders/migrations/seed/x.sql': '', 'src/modules/orders/queries/list.sql': '' })
    assert.deepEqual(layout.databases[0]?.migrations.map(m => `${m.path} ${m.module?.id ?? '共享层'}`), [`${ORDERS} orders`, `${SHARED} 共享层`])
  })

  test('时间戳重复、文件名不以 14 位时间戳开头、schema 名撞了：配置错误', () => {
    const { layout } = project({ [ORDERS]: '', 'src/modules/billing/migrations/20261118090000_dup.sql': '', 'src/shared/migrations/init.sql': '' })
    assert.deepEqual(layout.problems, [
      '迁移的时间戳重复：src/modules/billing/migrations/20261118090000_dup.sql 和 src/modules/orders/migrations/20261118090000_orders.sql 都是 20261118090000（各模块和共享层的迁移按时间戳统一排序执行），改成不同的时间。迁移只写正向，一个时间戳一个文件：不写回滚迁移（.down.sql 这类），按文件名排序执行的工具会把它当正向迁移跑',
      '迁移文件 src/shared/migrations/init.sql 的文件名要以精确到秒的时间戳开头（14 位数字，比如 20261118093000_create_orders.sql）：迁移按时间戳统一排序执行',
    ])
    const clash = project({ 'src/modules/orders_api/index.ts': '', 'src/modules/shared/index.ts': '' }).layout
    assert.deepEqual(clash.problems, [
      'orders_api 模块的内部 schema 叫 orders_api，和 orders 模块的入口 schema orders_api 撞了：给模块目录改个名字',
      'shared 模块的内部 schema 叫 shared，和 共享层的 schema shared 撞了：给模块目录改个名字',
    ])
  })

  test('database 的写法：两个目录、两个账号名都要写，目录不用通配；按应用分组时写在应用里', () => {
    const problems = (database: unknown): string[] => parseConfig(JSON.stringify({ roots: ['src/modules'], entry: ['index.ts'], database })).problems
    assert.deepEqual(problems({ ...DATABASE, shared: undefined }), ['.modwall/config.json 的 "database.shared" 要写共享层的迁移目录（从仓库根目录写起）（相对路径，不用通配）'])
    assert.deepEqual(problems({ ...DATABASE, migrations: '*/m', extra: 1 }), [
      '.modwall/config.json 的 "database" 有未知字段 "extra"',
      '.modwall/config.json 的 "database.migrations" 要写每个模块放迁移的子目录（相对模块目录，比如 "migrations"）（相对路径，不用通配）',
    ])
    assert.deepEqual(problems({ ...DATABASE, login: 'App-User', migrator: undefined }), [
      '.modwall/config.json 的 "database.login" 要写程序连库用的账号的名字（小写字母、数字和下划线，不以数字开头）',
      '.modwall/config.json 的 "database.migrator" 要写跑迁移用的账号的名字（小写字母、数字和下划线，不以数字开头）',
    ])
    const grouped = parseConfig(JSON.stringify({ apps: { server: { roots: ['server/modules'], entry: ['index.ts'] } }, database: DATABASE }))
    assert.match(grouped.problems.join('\n'), /"database" 要写进各个应用里/)
  })

  test('登录账号、迁移账号和模块的角色（内部 schema 名）、shared 同名：配置错误', () => {
    const { layout } = project({}, { database: { ...DATABASE, login: 'orders', migrator: 'shared' } })
    assert.deepEqual(layout.problems, [
      'database.login 的账号 orders 和orders 模块的角色同名：登录、迁移账号本身没有权限，只能切成模块的角色，换个名字',
      'database.migrator 的账号 shared 和共享层的角色同名：登录、迁移账号本身没有权限，只能切成模块的角色，换个名字',
    ])
  })
})

describe('R6 迁移文件', () => {
  test('引用别的模块的内部 schema 拦，入口 schema、本模块、shared、不是模块 schema 的名字不拦', () => {
    const found = r6({
      [ORDERS]: [
        'CREATE TABLE items (id bigint PRIMARY KEY, invoice_id bigint);',
        'CREATE FUNCTION orders_api.items() RETURNS SETOF bigint LANGUAGE sql SECURITY DEFINER SET search_path = orders, pg_temp AS $$ SELECT i.id FROM orders.items i JOIN billing_api.invoices v ON v.id = i.invoice_id $$;',
        'INSERT INTO billing.invoices (id) VALUES (1);',
        'SELECT shared.now(), public.gen_random_uuid(), pg_catalog.now();',
      ].join('\n'),
    })
    assert.deepEqual(
      found.map(v => v.where),
      [`${ORDERS}:3（orders 模块的迁移）引用了 billing 模块的内部 schema billing：billing.invoices`],
    )
    assert.match(found[0]?.fix as string, /走它的入口 schema billing_api 里的视图、函数，或者 billing 的代码入口.*billing 其实是表名、别名或变量的，改个和模块 schema 不同的名字/)
  })

  test('共享层引用模块的 schema（内部、入口都算）拦', () => {
    const found = r6({ [SHARED]: 'CREATE TABLE migrations (id text);\nSELECT * FROM orders_api.items;\n' })
    assert.deepEqual(found.map(v => v.where), [`${SHARED}:2（共享层的迁移）引用了 orders 模块的入口 schema orders_api：orders_api.items`])
    assert.match(found[0]?.fix as string, /共享层只放没有业务含义的结构/)
  })

  test('入口 schema 里建表、把表挪进入口 schema：拦', () => {
    const found = r6({ [ORDERS]: 'CREATE UNLOGGED TABLE IF NOT EXISTS orders_api.cache (id int);\nALTER TABLE orders.items SET SCHEMA orders_api;\n' })
    assert.deepEqual(found.map(v => v.where), [
      `${ORDERS}:1（orders 模块的迁移）在入口 schema orders_api 里建表 cache`,
      `${ORDERS}:2（orders 模块的迁移）在入口 schema orders_api 里建表 items`,
    ])
    assert.match(found[0]?.fix as string, /表建在 orders 的内部 schema orders 里，在 orders_api 里建视图或函数/)
  })

  test('跨模块的外键拦（只报外键，不再按引用内部报）；本模块和 shared 的外键不拦', () => {
    const found = r6({
      [ORDERS]: 'CREATE TABLE items (id int, invoice_id int REFERENCES billing.invoices(id), kind text REFERENCES shared.kinds, parent int REFERENCES orders.items);\n',
    })
    assert.deepEqual(found.map(v => v.where), [`${ORDERS}:1（orders 模块的迁移）建了指向 billing 模块的外键：REFERENCES billing.invoices`])
    assert.match(found[0]?.fix as string, /模块之间不建外键：只存 billing 的 id/)
  })

  test('函数要把 search_path 设成本模块的内部 schema 加 pg_temp，共享层的设成 shared 加 pg_temp', () => {
    const fn = (name: string, set: string): string => `CREATE OR REPLACE FUNCTION ${name}() RETURNS int LANGUAGE sql SECURITY DEFINER ${set} AS $$ SELECT 1 $$;`
    const found = r6({
      [ORDERS]: [
        fn('orders_api.ok1', 'SET search_path = orders, pg_temp'),
        fn('ok2', "SET search_path TO 'orders', \"pg_temp\""),
        fn('none', ''),
        fn('bare', 'SET search_path = orders'),
        fn('other', 'SET search_path = orders, shared'),
        fn('current', 'SET search_path FROM CURRENT'),
      ].join('\n'),
      [SHARED]: [fn('shared.ok', 'SET search_path = shared, pg_temp'), fn('shared.bad', 'SET search_path = orders, pg_temp')].join('\n'),
    })
    assert.deepEqual(found.map(v => v.where), [
      `${ORDERS}:3（orders 模块的迁移）的函数 none 没有设 search_path，要设成 orders, pg_temp`,
      `${ORDERS}:4（orders 模块的迁移）的函数 bare 的 search_path 设成了 orders，要设成 orders, pg_temp`,
      `${ORDERS}:5（orders 模块的迁移）的函数 other 的 search_path 设成了 orders, shared，要设成 orders, pg_temp`,
      `${ORDERS}:6（orders 模块的迁移）的函数 current 的 search_path 不是写定的值（FROM CURRENT），要设成 orders, pg_temp`,
      `${SHARED}:2（共享层的迁移）的函数 shared.bad 的 search_path 设成了 orders, pg_temp，要设成 shared, pg_temp`,
    ])
  })

  test('函数正文、DO 块里的引用也查，行号是文件里的行；注释和字符串里的不算', () => {
    const found = r6({
      [ORDERS]: [
        '-- billing.invoices 在注释里',
        "CREATE FUNCTION orders_api.total() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = orders, pg_temp AS $fn$",
        'BEGIN',
        "  RAISE NOTICE 'billing.invoices 在字符串里';",
        '  RETURN (SELECT count(*) FROM billing.invoices);',
        'END $fn$;',
        "DO 'BEGIN PERFORM billing.recalc(); END';",
      ].join('\n'),
    })
    assert.deepEqual(found.map(v => v.key), [`R6 ${ORDERS} 引用 billing.invoices`, `R6 ${ORDERS} 引用 billing.recalc`])
    assert.deepEqual(found.map(v => v.where.split('（')[0]), [`${ORDERS}:5`, `${ORDERS}:7`])
  })

  test('别名和模块的 schema 同名：报别名，这句里用别名限定的引用不再当成跨模块引用', () => {
    const found = r6({
      [ORDERS]: [
        'SELECT billing.id FROM orders.items billing;',
        'SELECT count(*) AS admin_access_api FROM orders.items;',
        'WITH billing AS (SELECT 1 AS id) SELECT billing.id FROM billing;',
        'SELECT o.id FROM orders.items o;',
      ].join('\n'),
    })
    assert.deepEqual(found.map(v => v.where), [
      `${ORDERS}:1（orders 模块的迁移）的别名 billing 和 billing 模块的内部 schema billing 同名`,
      `${ORDERS}:2（orders 模块的迁移）的别名 admin_access_api 和 adminAccess 模块的入口 schema admin_access_api 同名`,
      `${ORDERS}:3（orders 模块的迁移）的别名 billing 和 billing 模块的内部 schema billing 同名`,
    ])
    assert.match(found[0]?.fix as string, /别名、CTE 的名字、函数里的变量不能和模块的 schema 同名/)
  })

  test('经入口的引用和代码的 import 一起算环（R2）', () => {
    const fn = "CREATE FUNCTION orders_api.n() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = orders, pg_temp AS $$\n  SELECT count(*) FROM billing_api.invoices\n$$;\n"
    const { layout, read } = project({ [ORDERS]: fn })
    const { violations, edges } = migrationViolations(layout.databases, read)
    assert.deepEqual(violations, [])
    assert.deepEqual(edges, [{ from: 'orders', to: 'billing', site: `${ORDERS}:2`, what: '引用了 billing_api.invoices' }])
    const code = { imports: [{ from: 'src/modules/billing/index.ts', line: 3, to: 'src/modules/orders/index.ts', specifier: '../orders/index.ts' }], unresolved: [] }
    const [cycle] = importViolations(layout, code, edges)
    assert.equal(cycle?.key, 'R2 billing orders')
    assert.deepEqual(cycle?.where, [
      'billing → orders → billing',
      'billing → orders：src/modules/billing/index.ts:3 import 了 src/modules/orders/index.ts',
      `orders → billing：${ORDERS}:2 引用了 billing_api.invoices`,
    ])
    // 只有代码这一边，不成环
    assert.deepEqual(importViolations(layout, code), [])
  })
})

describe('R6 迁移文件：入口的变更规则、只改自己的 schema、按名字认 schema 的约定', () => {
  test('视图建在别的模块的入口上拦（plpgsql、AS $$…$$ 的函数里经入口读不拦）', () => {
    const found = r6({
      [ORDERS]: [
        'CREATE MATERIALIZED VIEW orders_api.summary AS SELECT b.id FROM billing_api.invoices b;',
        'CREATE FUNCTION orders_api.paid() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = orders, pg_temp AS $$ BEGIN RETURN (SELECT count(*) FROM billing_api.invoices b); END $$;',
      ].join('\n'),
    })
    assert.deepEqual(found.map(v => v.where), [`${ORDERS}:1（orders 模块的迁移）的视图建在 billing 模块的入口上：billing_api.invoices`])
    assert.match(found[0]?.fix as string, /不在别的模块的入口上建视图.*billing 以后就改不动自己的入口了.*跨模块的读取写在函数正文/)
  })

  test('在别的模块的 schema、shared 里建、改、删对象拦（只报一次）；在自己的两个 schema 里不拦；建 schema 拦（迁移工具建）', () => {
    const found = r6({
      [ORDERS]: [
        'CREATE SCHEMA IF NOT EXISTS orders;',
        'CREATE TABLE orders_api.cache (id int);',
        'CREATE OR REPLACE VIEW billing_api.extra AS SELECT 1 AS n;',
        'CREATE TABLE billing.mine (id int);',
        'DROP FUNCTION IF EXISTS shared.touch();',
        'ALTER TABLE items SET SCHEMA billing_api;',
      ].join('\n'),
    })
    assert.deepEqual(found.map(v => v.where), [
      `${ORDERS}:1（orders 模块的迁移）建了 schema orders`,
      `${ORDERS}:2（orders 模块的迁移）在入口 schema orders_api 里建表 cache`,
      `${ORDERS}:3（orders 模块的迁移）在 billing 模块的入口 schema billing_api 里建、改或删了 extra`,
      `${ORDERS}:4（orders 模块的迁移）在 billing 模块的内部 schema billing 里建、改或删了 mine`,
      `${ORDERS}:5（orders 模块的迁移）在 共享层的 schema shared 里建、改或删了 touch`,
      `${ORDERS}:6（orders 模块的迁移）在 billing 模块的入口 schema billing_api 里建、改或删了 items`,
    ])
    assert.match(found[0]?.fix as string, /迁移里不建 schema：跑迁移的工具按模块目录建好模块的角色和两个 schema/)
    assert.match(found[2]?.fix as string, /一个模块的迁移只在自己的内部、入口两个 schema 里建、改、删对象/)
  })

  test('共享层的迁移建 schema、删模块的 schema 拦；在别的模块的对象上挂触发器、索引，写注释、授权也算改它', () => {
    const found = r6({
      [SHARED]: 'CREATE SCHEMA IF NOT EXISTS shared;\nCREATE SCHEMA orders;\nDROP SCHEMA IF EXISTS billing_api CASCADE;\n',
      [ORDERS]: [
        'CREATE TRIGGER t INSTEAD OF INSERT ON billing_api.invoices FOR EACH ROW EXECUTE FUNCTION orders.t();',
        "COMMENT ON VIEW billing_api.invoices IS 'x';",
        'GRANT SELECT ON billing_api.invoices TO app;',
        'GRANT USAGE ON SCHEMA billing_api TO app;',
        'CREATE INDEX items_note ON orders.items (note);',
        "COMMENT ON COLUMN items.note IS 'x';",
        'GRANT SELECT ON ALL TABLES IN SCHEMA orders_api TO app;',
      ].join('\n'),
    })
    assert.deepEqual(found.map(v => v.where), [
      `${ORDERS}:1（orders 模块的迁移）在 billing 模块的入口 schema billing_api 里建、改或删了 invoices`,
      `${ORDERS}:2（orders 模块的迁移）在 billing 模块的入口 schema billing_api 里建、改或删了 invoices`,
      `${ORDERS}:3（orders 模块的迁移）在 billing 模块的入口 schema billing_api 里建、改或删了 invoices`,
      `${ORDERS}:4（orders 模块的迁移）在 billing 模块的入口 schema billing_api 里建、改或删了 billing_api`,
      `${SHARED}:1（共享层的迁移）建了 schema shared`,
      `${SHARED}:2（共享层的迁移）建了 schema orders`,
      `${SHARED}:3（共享层的迁移）在 billing 模块的入口 schema billing_api 里建、改或删了 billing_api`,
    ])
    assert.match(found.at(-1)?.fix as string, /共享层只放没有业务含义的结构/)
  })

  test('直接写别的模块入口里的视图拦（写入走对方入口里的函数）；写自己的不拦', () => {
    const found = r6({
      [ORDERS]: [
        'INSERT INTO billing_api.invoices (id) VALUES (1);',
        'CREATE FUNCTION orders_api.pay() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = orders, pg_temp AS $$ BEGIN UPDATE billing_api.invoices v SET paid = true; DELETE FROM ONLY billing_api.invoices; END $$;',
        'UPDATE items SET note = 1;',
        'CREATE TRIGGER t BEFORE INSERT OR UPDATE ON items FOR EACH ROW EXECUTE FUNCTION orders.touch();',
        'SELECT * FROM items FOR UPDATE;',
      ].join('\n'),
    })
    assert.deepEqual(found.map(v => v.where.split('）')[1]), [
      '直接写了 billing 模块入口里的 billing_api.invoices',
      '直接写了 billing 模块入口里的 billing_api.invoices',
      '直接写了 billing 模块入口里的 billing_api.invoices',
    ])
    assert.match(found[0]?.fix as string, /跨模块写入走对方入口里的函数.*在 billing 的入口里加一个做这件事的函数/)
  })

  test('迁移、函数里改 search_path 拦；建函数、改函数时设的 search_path 不算', () => {
    const found = r6({
      [ORDERS]: [
        'SET search_path = billing;',
        "SELECT set_config('search_path', 'billing', true);",
        'ALTER ROLE app SET search_path = billing;',
        'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = orders, pg_temp AS $$ BEGIN SET LOCAL search_path = billing; END $$;',
        'ALTER FUNCTION f() SET search_path = orders;',
        'RESET search_path;',
      ].join('\n'),
    })
    assert.deepEqual(found.map(v => v.where.split('（')[0]), [`${ORDERS}:1`, `${ORDERS}:2`, `${ORDERS}:3`, `${ORDERS}:4`, `${ORDERS}:6`])
    assert.ok(found.every(v => v.where.endsWith('改了 search_path')))
  })

  test('迁移里切身份拦（角色、DO 块里的也算）；函数正文、函数的设置里不查（函数一律 SECURITY DEFINER，库会拒绝）；给叫 role 的列赋值不算', () => {
    const found = r6({
      [ORDERS]: [
        'SET ROLE billing;',
        'SET LOCAL ROLE billing;',
        'RESET ROLE;',
        'SET SESSION AUTHORIZATION billing;',
        "SELECT set_config('role', 'billing', true);",
        'ALTER ROLE app SET role = billing;',
        'DO $$ BEGIN SET LOCAL ROLE billing; END $$;',
        'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = orders, pg_temp AS $$ BEGIN SET LOCAL ROLE billing; END $$;',
        'ALTER FUNCTION f() SET role = billing;',
        "UPDATE users SET role = 'admin';",
        "INSERT INTO users (id, role) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET role = excluded.role;",
        'ALTER TABLE users ALTER COLUMN role SET NOT NULL;',
      ].join('\n'),
    })
    assert.deepEqual(found.map(v => v.where.split('（')[0]), [1, 2, 3, 4, 5, 6, 7].map(line => `${ORDERS}:${line}`))
    assert.ok(found.every(v => v.where.endsWith('切了身份')))
    assert.match(found[0]?.fix as string, /迁移里不切身份.*跑迁移的工具已经切成本模块的角色/)
  })

  test('函数、过程一律 SECURITY DEFINER（模块的、共享层的）；ALTER … SECURITY INVOKER 拦', () => {
    const path = 'SET search_path = orders, pg_temp'
    const found = r6({
      [ORDERS]: [
        `CREATE FUNCTION a() RETURNS int LANGUAGE sql ${path} AS $$ SELECT 1 $$;`,
        `CREATE OR REPLACE FUNCTION orders_api.b() RETURNS int LANGUAGE sql EXTERNAL SECURITY DEFINER ${path} AS $$ SELECT 1 $$;`,
        `CREATE PROCEDURE c() LANGUAGE sql SECURITY INVOKER ${path} AS $$ SELECT 1 $$;`,
        'ALTER FUNCTION orders_api.b() SECURITY INVOKER;',
        'ALTER FUNCTION orders_api.b() SECURITY DEFINER;',
        `CREATE FUNCTION d() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER ${path} AS $$ BEGIN RETURN NEW; END $$;`,
      ].join('\n'),
      [SHARED]: 'CREATE FUNCTION shared.now() RETURNS timestamptz LANGUAGE sql SET search_path = shared, pg_temp AS $$ SELECT now() $$;',
    })
    assert.deepEqual(found.map(v => v.where), [
      `${ORDERS}:1（orders 模块的迁移）的函数 a 不是 SECURITY DEFINER`,
      `${ORDERS}:3（orders 模块的迁移）的函数 c 不是 SECURITY DEFINER`,
      `${ORDERS}:4（orders 模块的迁移）把函数 orders_api.b 改成了 SECURITY INVOKER`,
      `${SHARED}:1（共享层的迁移）的函数 shared.now 不是 SECURITY DEFINER`,
    ])
    assert.match(found[0]?.fix as string, /函数一律 SECURITY DEFINER.*函数里也切不了身份（Postgres 不让）.*CREATE OR REPLACE 不写会改回按调用者执行/)
  })

  test('引用的表名和别的模块的 schema 同名又没起别名：报表名，这句里的 表名.列 不当成跨模块引用；起了别名、本模块的不拦', () => {
    const found = r6({
      [BILLING]: [
        'SELECT orders.id FROM orders_api.orders WHERE orders.id > 0;',
        'SELECT o.id FROM orders_api.orders AS o;',
        'SELECT x.id FROM orders_api.orders x JOIN invoices i ON i.order_id = x.id;',
        'SELECT billing.id FROM billing;',
      ].join('\n'),
    })
    assert.deepEqual(found.map(v => v.where), [`${BILLING}:1（billing 模块的迁移）引用的表 orders 没起别名，和 orders 模块的内部 schema orders 同名`])
    assert.match(found[0]?.fix as string, /给它起个别名（FROM … AS 别名），用别名限定列/)
  })

  test('迁移目录以外的 .sql 列出来（只看用库的应用里的）', () => {
    const { layout } = project({ [ORDERS]: '', 'src/modules/orders/queries/list.sql': '', 'src/modules/orders/migrations/seed/x.sql': '', 'scripts/dump.sql': '' })
    assert.deepEqual(unreadSql(layout.databases, ['src/modules/orders/queries/list.sql', 'src/modules/orders/migrations/seed/x.sql', 'scripts/dump.sql', ORDERS], path => layout.owner(path)), [
      'src/modules/orders/queries/list.sql',
      'src/modules/orders/migrations/seed/x.sql',
    ])
  })
})

describe('读 SQL', () => {
  test('E 字符串的反斜杠、$tag$ 正文、嵌套注释、带引号的名字', () => {
    const [first, second] = statements("SELECT E'a\\';b' /* x /* billing.y */ z */ FROM \"Billing\".t; SELECT $q$;billing.z$q$ FROM billing.w")
    assert.deepEqual(first?.refs.map(ref => `${ref.schema}.${ref.name}`), ['Billing.t'])
    assert.deepEqual(second?.refs.map(ref => `${ref.schema}.${ref.name}:${ref.line}`), ['billing.w:1'])
  })

  test('触发器的 UPDATE ON、外键的 ON UPDATE 不当成关系后面的别名', () => {
    const [trigger] = statements('CREATE TRIGGER t BEFORE UPDATE ON orders.items FOR EACH ROW EXECUTE FUNCTION orders.touch()')
    assert.deepEqual(trigger?.aliases, [])
  })
})

describe('modwall check 里的 R6', () => {
  test('模块的代码和迁移以外的 .sql 里切身份拦（按固定写法认，不分大小写；迁移另按语句查）；装配层、共享层、测试文件里可以', () => {
    const code: Record<string, string> = {
      'src/modules/orders/repo.ts': "const a = 1\nawait db.query('set local role billing')\nawait db.query(`SELECT set_config( 'role', $1, true)`)\n",
      'src/modules/billing/auth.py': 'cursor.execute("RESET ROLE")\nuser.set_role("admin")\n',
      'src/modules/billing/repo.test.ts': "await db.query('SET ROLE orders')\n",
      'src/shared/db.ts': "await client.query(`SELECT set_config('role', $1, true)`)\n",
      'src/main.ts': "await pool.query('SET SESSION AUTHORIZATION app')\n",
      'src/modules/orders/notes.md': 'SET ROLE billing\n',
      'src/modules/orders/queries/as_billing.sql': 'SET LOCAL ROLE billing;\nSELECT 1;\n',
      'src/modules/orders/migrations/20261118090000_orders.sql': 'SET ROLE billing;\n',
    }
    const { layout } = project({ 'src/modules/orders/migrations/20261118090000_orders.sql': '' })
    const found = codeRoleSwitches(layout.databases, Object.keys(code), path => layout.owner(path), path => code[path] as string)
    assert.deepEqual(found.map(v => v.where[0]), [
      "src/modules/orders/repo.ts:2（orders 模块）切了数据库的身份：set local role",
      "src/modules/orders/repo.ts:3（orders 模块）切了数据库的身份：set_config( 'role'",
      'src/modules/billing/auth.py:1（billing 模块）切了数据库的身份：RESET ROLE',
      'src/modules/orders/queries/as_billing.sql:1（orders 模块）切了数据库的身份：SET LOCAL ROLE',
    ])
    assert.match(found[0]?.fix as string, /模块的代码不自己切身份：连接在事务开头由装配层或共享层里那个切身份的小函数切成本模块的角色/)
  })

  test('示例项目加上数据库：迁移干净时通过；有越界时 R6 拦，时间戳重复是配置错误', () => {
    const repo = sampleRepo(dir => {
      const config = { roots: ['src/modules'], shared: ['src/shared/**'], app: ['src/main.ts'], entry: ['index.ts'], outside: ['scripts/**'], database: DATABASE }
      write(dir, '.modwall/config.json', JSON.stringify(config))
      write(dir, 'src/shared/migrations/20261118080000_init.sql', 'CREATE TABLE shared.migrations (name text PRIMARY KEY);\n')
      write(dir, 'src/modules/booking/migrations/20261118090000_bookings.sql', 'CREATE TABLE bookings (id bigint PRIMARY KEY, invoice_id bigint);\n')
    })
    const clean = modwall(repo, ['check'])
    assert.equal(clean.code, 0, clean.out)

    write(repo, 'src/modules/billing/migrations/20261118090100_invoices.sql', 'CREATE TABLE invoices (id bigint PRIMARY KEY, booking_id bigint REFERENCES booking.bookings(id));\n')
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /R6 数据库越界（1 处）\n {2}✗ src\/modules\/billing\/migrations\/20261118090100_invoices\.sql:1（billing 模块的迁移）建了指向 booking 模块的外键：REFERENCES booking\.bookings\n {4}改法：模块之间不建外键/)
    const status = modwall(repo, ['status']).out
    assert.match(status, /R5 0、R6 1/)
    // 示例项目接入了 testpace，full 里没写 modwall db check
    assert.match(status, /数据库：testpace\.json 的 full 里没看到 modwall db check/)
    write(repo, 'testpace.json', JSON.stringify({ fast: 'true', files: 'true', full: 'npm run migrate && modwall db check --psql "psql $DATABASE_URL" && npm test', tests: ['tests/**'] }))
    assert.match(modwall(repo, ['status']).out, /数据库：testpace 的 full 里跑了 modwall db check/)
    rmSync(join(repo, 'testpace.json'))
    assert.match(modwall(repo, ['status']).out, /数据库：库里的现状要在迁移跑完后用 modwall db check 查；没接入 testpace/)

    write(repo, 'src/modules/billing/queries/list.sql', 'SELECT * FROM booking.bookings;\n')
    assert.match(modwall(repo, ['check']).out, /没检查到.*\n(?: {2}· .*\n)* {2}· src\/modules\/billing\/queries\/list\.sql：不在迁移目录里，R6 只查它有没有切身份/)

    write(repo, 'src/modules/billing/migrations/20261118090000_dup.sql', 'SELECT 1;\n')
    const dup = modwall(repo, ['check'])
    assert.equal(dup.code, 2, dup.out)
    assert.match(dup.out, /配置有问题.*\n {2}✗ 迁移的时间戳重复/)
  })
})
