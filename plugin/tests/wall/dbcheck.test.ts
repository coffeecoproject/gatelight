import assert from 'node:assert/strict'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type Config, parseConfig } from '../../src/wall/config.ts'
import { type Catalog, catalogViolations } from '../../src/wall/dbcheck.ts'
import { Layout } from '../../src/wall/layout.ts'
import { modwall, sampleRepo, tempDir, write } from './helpers.ts'

const DATABASE = { migrations: 'migrations', shared: 'src/shared/migrations', login: 'app', migrator: 'migrator' }

function database(): NonNullable<Layout['databases'][number]> {
  const parsed = parseConfig(JSON.stringify({ roots: ['src/modules'], entry: ['index.ts'], database: DATABASE }))
  const layout = new Layout(parsed.config as Config, ['src/modules/orders/index.ts', 'src/modules/billing/index.ts'])
  return layout.databases[0] as NonNullable<Layout['databases'][number]>
}

/** schema 归谁的角色：模块的两个 schema 归模块的角色，shared 归 shared，public 归 postgres。 */
const ownerOf = (schema: string): string => (schema === 'public' ? 'postgres' : schema.replace(/_api$/, ''))
const schemas = (...names: string[]): Catalog['schemas'] => names.map(name => ({ name, owner: ownerOf(name) }))
type Role = Catalog['roles'][number]
const role = (name: string, login: boolean, extra: Partial<Role> = {}): Role => ({
  name, login, superuser: false, bypassRls: false, createRole: false, createDb: false, createSchema: false, connect: true, ownsObjects: false, ...extra,
})

/** 干净的库：两个模块、shared 的 schema 和角色都对，登录账号、迁移账号只能登录。 */
const EMPTY: Catalog = {
  database: { name: 'appdb', ident: 'appdb', publicConnect: false },
  schemas: schemas('billing', 'billing_api', 'orders', 'orders_api', 'public', 'shared'),
  relations: [],
  types: [],
  functions: [],
  foreignKeys: [],
  dependencies: [],
  roles: [role('postgres', true, { superuser: true, createRole: true, createDb: true, createSchema: true, ownsObjects: true }), role('orders', false), role('billing', false), role('shared', false), role('app', true), role('migrator', true)],
  privileges: [
    { schema: 'orders', role: 'orders', usage: true, create: true },
    { schema: 'orders_api', role: 'billing', usage: true, create: false },
    { schema: 'shared', role: 'orders', usage: true, create: false },
  ],
}
const rel = (schema: string, name: string, kind: string, extra: Partial<Catalog['relations'][number]> = {}): Catalog['relations'][number] => ({
  schema, name, kind, owner: ownerOf(schema), securityInvoker: false, ...extra,
})
const fn = (schema: string, name: string, config: string[] | null, source: string | null = null): Catalog['functions'][number] => ({
  schema, name, args: '', kind: 'f', config, source, owner: ownerOf(schema), securityDefiner: true,
})

const found = (catalog: Partial<Catalog>): string[] => catalogViolations(database(), { ...EMPTY, ...catalog }).map(v => v.where[0] as string)

describe('db check 的比对', () => {
  test('模块的两个 schema、shared、public 都对得上：没有越界；不对应任何模块的 schema 拦', () => {
    assert.deepEqual(found({}), [])
    assert.deepEqual(found({ schemas: [...EMPTY.schemas, ...schemas('legacy')] }), ['库里的 schema legacy 不对应任何模块'])
  })

  test('public 里的表、视图、函数、类型拦（扩展的对象查询时已经去掉）', () => {
    const r = found({
      relations: [rel('public', 'users', 'r'), rel('orders', 'items', 'r')],
      types: [{ schema: 'public', name: 'mood', owner: 'postgres' }],
      functions: [fn('public', 'helper', null)],
    })
    assert.deepEqual(r, ['public 里有表 users', 'public 里有类型 mood', 'public 里有函数 helper()'])
  })

  test('入口 schema 里的表拦，视图不拦', () => {
    const r = found({ relations: [rel('orders_api', 'cache', 'r'), rel('orders_api', 'items', 'v')] })
    assert.deepEqual(r, ['入口 schema orders_api 里有表 cache'])
  })

  test('模块之间的外键拦；本模块、指向 shared 的不拦；共享层指向模块的拦', () => {
    const fk = (schema: string, refSchema: string): Catalog['foreignKeys'][number] => ({ schema, table: 't', name: `${schema}_fk`, refSchema, refTable: 'r' })
    const r = found({ foreignKeys: [fk('orders', 'billing'), fk('orders', 'shared'), fk('orders', 'orders_api'), fk('shared', 'orders')] })
    assert.deepEqual(r, ['orders 模块的 orders.t 的外键 orders_fk 指向 billing 模块的 billing.r', '共享层：shared.t 的外键 shared_fk 指向 orders 模块的 orders.r'])
  })

  test('函数的 search_path：模块的（内部、入口 schema 里的）设成内部 schema 加 pg_temp；共享层的设成 shared 加 pg_temp', () => {
    const r = found({
      functions: [
        fn('orders', 'a', ['search_path=orders, pg_temp']),
        fn('orders_api', 'b', ['search_path="orders", "pg_temp"']),
        fn('orders', 'c', ['search_path=orders']),
        fn('orders_api', 'd', null),
        fn('billing', 'e', ['search_path=billing, shared']),
        fn('shared', 'f', ['search_path=shared, pg_temp']),
        fn('shared', 'g', ['statement_timeout=1s']),
        { ...fn('orders', 'agg', null), kind: 'a' },
      ],
    })
    assert.deepEqual(r, [
      '函数 orders.c() 的 search_path 设成了 orders，要设成 orders, pg_temp',
      '函数 orders_api.d() 没有设 search_path，要设成 orders, pg_temp',
      '函数 billing.e() 的 search_path 设成了 billing, shared，要设成 billing, pg_temp',
      '函数 shared.g() 没有设 search_path，要设成 shared, pg_temp',
    ])
  })

  test('视图、函数跨模块引用内部 schema 拦（pg_depend 和函数正文）；硬依赖在别的模块入口上拦，函数正文里经入口读不拦', () => {
    const r = found({
      dependencies: [
        { kind: 'view', schema: 'orders_api', name: 'items', refSchema: 'billing', refName: 'invoices', refKind: 'relation' },
        { kind: 'view', schema: 'orders_api', name: 'ok', refSchema: 'billing_api', refName: 'invoices', refKind: 'relation' },
        { kind: 'function', schema: 'shared', name: 'f()', refSchema: 'orders_api', refName: 'v', refKind: 'relation' },
        // 用对方入口里的类型可以，内部 schema 的类型不行
        { kind: 'function', schema: 'orders', name: 'g(billing_api.status)', refSchema: 'billing_api', refName: 'status', refKind: 'type' },
        { kind: 'function', schema: 'orders', name: 'h(billing.secret)', refSchema: 'billing', refName: 'secret', refKind: 'type' },
      ],
      functions: [
        fn('orders', 'total', ['search_path=orders, pg_temp'], 'BEGIN RETURN (SELECT count(*) FROM billing.invoices b JOIN billing_api.v x ON true); END'),
        fn('billing', 'mine', ['search_path=billing, pg_temp'], 'SELECT orders.id FROM orders_api.orders'),
        fn('billing', 'poke', ['search_path=billing, pg_temp'], 'BEGIN UPDATE orders_api.items i SET n = 1; END'),
      ],
    })
    assert.deepEqual(r, [
      'orders 模块的视图 orders_api.items 引用了 billing 模块的内部 schema billing：billing.invoices',
      'orders 模块的视图 orders_api.ok 硬依赖在 billing 模块的入口上：billing_api.invoices',
      '共享层的函数 shared.f() 引用了 orders 模块的入口 schema orders_api：orders_api.v',
      'orders 模块的函数 orders.h(billing.secret) 引用了 billing 模块的内部 schema billing：billing.secret',
      'orders 模块的函数 orders.total() 引用了 billing 模块的内部 schema billing：billing.invoices',
      'billing 模块的函数 billing.poke() 直接写了 orders 模块入口里的 orders_api.items',
    ])
  })

  test('模块和共享层的角色：没有的拦；能登录、有特权、能在库里或 public 里建对象的拦', () => {
    const roles = EMPTY.roles.filter(item => item.name !== 'billing').map(item =>
      item.name === 'orders' ? role('orders', true, { bypassRls: true, createSchema: true }) : item.name === 'shared' ? role('shared', false, { superuser: true }) : item,
    )
    const r = found({ roles, privileges: [...EMPTY.privileges, { schema: 'public', role: 'shared', usage: true, create: true }] })
    assert.deepEqual(r, [
      '共享层的角色 shared 是超级用户',
      '共享层的角色 shared 能在 public 里建对象',
      '库里没有 billing 模块的角色 billing',
      'orders 模块的角色 orders 能登录、能绕过行级权限（BYPASSRLS）、能在库里建 schema',
    ])
  })

  test('模块的两个 schema 和里面的对象归模块的角色，shared 的归 shared 角色；public 里的不管归谁', () => {
    const r = found({
      schemas: EMPTY.schemas.map(item => (item.name === 'orders_api' ? { ...item, owner: 'app' } : item)),
      relations: [rel('orders', 'items', 'r', { owner: 'migrator' }), rel('orders', 'ok', 'r'), rel('shared', 'log', 'r', { owner: 'orders' }), rel('public', 'x', 'r')],
      types: [{ schema: 'billing', name: 'status', owner: 'postgres' }],
      functions: [{ ...fn('orders_api', 'f', ['search_path=orders, pg_temp']), owner: 'billing' }],
    })
    assert.deepEqual(r, [
      'public 里有表 x',
      'schema orders_api 归角色 app，要归 orders',
      '表 orders.items 归角色 migrator，要归 orders',
      '表 shared.log 归角色 orders，要归 shared',
      '类型 billing.status 归角色 postgres，要归 billing',
      '函数 orders_api.f() 归角色 billing，要归 orders',
    ])
  })

  test('除了 schema 的主人（包括经继承的登录账号）：没有角色能用模块的内部 schema，没有角色能在模块的 schema、shared 里建对象；入口、shared 的使用权可以授', () => {
    const r = found({
      privileges: [
        ...EMPTY.privileges,
        { schema: 'orders', role: 'app', usage: true, create: false },
        { schema: 'billing', role: 'orders', usage: false, create: true },
        { schema: 'billing_api', role: 'orders', usage: true, create: false },
        { schema: 'orders_api', role: 'billing', usage: true, create: true },
        { schema: 'shared', role: 'billing', usage: true, create: true },
        { schema: 'shared', role: 'shared', usage: true, create: true },
      ],
    })
    assert.deepEqual(r, [
      '角色 app 能使用（USAGE） orders 模块的内部 schema orders',
      '角色 orders 能建对象（CREATE） billing 模块的内部 schema billing',
      '角色 billing 能在 orders 模块的入口 schema orders_api 里建对象（CREATE）',
      '角色 billing 能在 共享层的 schema shared 里建对象（CREATE）',
    ])
  })

  test('模块和共享层的函数、过程都要 SECURITY DEFINER（函数里就切不了身份），聚合函数不管；入口视图不能设 security_invoker，内部 schema 里的不管', () => {
    const path = ['search_path=orders, pg_temp']
    const r = found({
      functions: [
        { ...fn('orders_api', 'a', path), securityDefiner: false },
        { ...fn('orders', 'b', path), securityDefiner: false, kind: 'p' },
        { ...fn('shared', 'c', ['search_path=shared, pg_temp']), securityDefiner: false },
        fn('orders', 'd', path),
        { ...fn('orders', 'agg', null), kind: 'a', securityDefiner: false },
      ],
      relations: [rel('orders_api', 'v', 'v', { securityInvoker: true }), rel('orders_api', 'w', 'v'), rel('orders', 'x', 'v', { securityInvoker: true })],
    })
    assert.deepEqual(r, [
      '函数 orders_api.a() 不是 SECURITY DEFINER',
      '函数 orders.b() 不是 SECURITY DEFINER',
      '函数 shared.c() 不是 SECURITY DEFINER',
      '入口视图 orders_api.v 设了 security_invoker',
    ])
  })

  test('登录账号、迁移账号：要有、能登录、不是超级用户、不拥有对象', () => {
    const roles = EMPTY.roles.filter(item => item.name !== 'migrator').map(item => (item.name === 'app' ? role('app', false, { superuser: true, ownsObjects: true }) : item))
    assert.deepEqual(found({ roles }), ['程序的登录账号 app 不能登录、是超级用户、拥有对象', '库里没有跑迁移的账号 migrator（database.migrator）'])
  })

  test('库的 CONNECT 不授给 PUBLIC，登录账号、迁移账号要有：角色整个实例共用，别的项目的同名模块角色会串进来', () => {
    const roles = EMPTY.roles.map(item => (item.name === 'migrator' ? role('migrator', true, { connect: false }) : item))
    const violations = catalogViolations(database(), { ...EMPTY, database: { name: 'App-DB', ident: '"App-DB"', publicConnect: true }, roles })
    assert.deepEqual(
      violations.map(v => v.where[0]),
      ['库 App-DB 的 CONNECT 授给了 PUBLIC', '跑迁移的账号 migrator 连不了库 App-DB（没有 CONNECT）'],
    )
    // 改法里的库名用 Postgres 给的标识符写法，照抄就能执行
    assert.match(violations[0]?.fix ?? '', /REVOKE CONNECT ON DATABASE "App-DB" FROM PUBLIC；GRANT CONNECT ON DATABASE "App-DB" TO app, migrator/)
  })
})

/** 假的 psql：把收到的标准输入存下来，输出 lines。返回执行它的命令。 */
function fakePsql(lines: string[], exit = 0): { command: string; stdin: string } {
  const dir = tempDir('modwall-psql-')
  const script = join(dir, 'psql')
  const stdin = join(dir, 'stdin.sql')
  writeFileSync(script, `#!/bin/sh\ncat > '${stdin}'\nprintf '%s\\n' ${lines.map(line => `'${line.replace(/'/g, `'\\''`)}'`).join(' ')}\nexit ${exit}\n`)
  chmodSync(script, 0o755)
  return { command: `${script} --dbname "$MODWALL_TEST_DB"`, stdin }
}

function dbRepo(config: Record<string, unknown> = { database: DATABASE }): string {
  return sampleRepo(dir => {
    write(dir, '.modwall/config.json', JSON.stringify({ roots: ['src/modules'], shared: ['src/shared/**'], app: ['src/main.ts'], entry: ['index.ts'], outside: ['scripts/**'], ...config }))
  })
}

/** 这几个模块的干净的库。 */
const catalogOf = (...modules: string[]): Catalog => ({
  ...EMPTY,
  schemas: schemas(...modules.flatMap(name => [name, `${name}_api`]), 'public', 'shared'),
  roles: [...modules.map(name => role(name, false)), role('shared', false), role('app', true), role('migrator', true)],
  privileges: [],
})
const SAMPLE = catalogOf('billing', 'booking')

describe('modwall db check', () => {
  test('SQL 从标准输入交给 --psql 的命令（在 sh 里跑），读回带前缀的那一行；干净的库通过', () => {
    const repo = dbRepo()
    const psql = fakePsql(['psqlrc 打的别的行', `modwall-db:${JSON.stringify(SAMPLE)}`])
    const r = modwall(repo, ['db', 'check', '--psql', psql.command])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /modwall db check：通过。库里没有越界/)
    const sent = readFileSync(psql.stdin, 'utf8')
    assert.match(sent, /^\\set QUIET on/)
    assert.match(sent, /\\set ON_ERROR_STOP on/)
    assert.match(sent, /FROM pg_namespace/)
  })

  test('有越界：列出来，退出码 1', () => {
    const repo = dbRepo()
    const catalog = { ...SAMPLE, schemas: [...SAMPLE.schemas, ...schemas('legacy')], relations: [rel('booking_api', 'cache', 'r')] }
    const r = modwall(repo, ['db', 'check', '--psql', fakePsql([`modwall-db:${JSON.stringify(catalog)}`]).command])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /库里越界 2 处/)
    assert.match(r.out, /R6 数据库越界（2 处）\n {2}✗ 库里的 schema legacy 不对应任何模块\n {4}改法：schema 由模块目录名定/)
    assert.match(r.out, /✗ 入口 schema booking_api 里有表 cache\n {4}改法：入口 schema 只放给别的模块用的视图和函数/)
  })

  test('命令失败、没输出结果、结果读不懂：没查成，退出码 2', () => {
    const repo = dbRepo()
    const failed = modwall(repo, ['db', 'check', '--psql', fakePsql(['psql: error: connection refused'], 2).command])
    assert.equal(failed.code, 2, failed.out)
    assert.match(failed.out, /没查成，执行 SQL 的命令失败（退出码 2/)
    const silent = modwall(repo, ['db', 'check', '--psql', fakePsql(['hello']).command])
    assert.equal(silent.code, 2, silent.out)
    assert.match(silent.out, /没输出查询结果/)
    const garbled = modwall(repo, ['db', 'check', '--psql', fakePsql(['modwall-db:{"schemas":1}']).command])
    assert.equal(garbled.code, 2, garbled.out)
    assert.match(garbled.out, /查询结果读不懂/)
  })

  test('没写 --psql、配置里没有 database：用法错误，退出码 2', () => {
    const repo = dbRepo()
    const bare = modwall(repo, ['db', 'check'])
    assert.equal(bare.code, 2)
    assert.match(bare.out, /要用 --psql 告诉它用什么命令执行 SQL/)
    const none = modwall(dbRepo({}), ['db', 'check', '--psql', 'psql'])
    assert.equal(none.code, 2)
    assert.match(none.out, /里没有写 database/)
  })

  test('几个应用都写了 database：要用 --app 指定，查的是那个应用的模块', () => {
    const repo = sampleRepo(dir => {
      const app = (name: string) => ({ roots: [`apps/${name}/modules`], shared: [`apps/${name}/shared/**`], entry: ['index.ts'], database: { ...DATABASE, shared: `apps/${name}/shared/migrations` } })
      write(dir, '.modwall/config.json', JSON.stringify({ apps: { web: app('web'), server: app('server') }, outside: ['scripts/**', 'src/**'] }))
      write(dir, 'apps/web/modules/pages/index.ts', 'export const a = 1\n')
      write(dir, 'apps/server/modules/orders/index.ts', 'export const b = 1\n')
    })
    const catalog = `modwall-db:${JSON.stringify(catalogOf('orders'))}`
    const which = modwall(repo, ['db', 'check', '--psql', fakePsql([catalog]).command])
    assert.equal(which.code, 2, which.out)
    assert.match(which.out, /web、server 几个应用都写了 database，用 --app 指定/)
    const server = modwall(repo, ['db', 'check', '--app', 'server', '--psql', fakePsql([catalog]).command])
    assert.equal(server.code, 0, server.out)
    assert.match(server.out, /通过（server 应用的库）/)
    const web = modwall(repo, ['db', 'check', '--app', 'web', '--psql', fakePsql([catalog]).command])
    assert.equal(web.code, 1, web.out)
    assert.match(web.out, /库里的 schema orders 不对应任何模块/)
  })
})
