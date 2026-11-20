import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type Config, parseConfig } from '../../src/wall/config.ts'
import { type ConfigSide, looseningItems } from '../../src/wall/loosen.ts'

/** 各项给用户看的文字。 */
const texts = (before: Config | undefined, now: ConfigSide): string[] => looseningItems(before, now).map(item => item.text)

const BASE = {
  roots: ['src/modules'],
  shared: ['src/shared/**'],
  app: ['src/main.ts'],
  entry: ['index.ts'],
  map: { 'src/pages/booking/**': 'booking' },
  outside: ['scripts/**'],
  allow: [{ rule: 'R1', from: 'src/main.ts', to: 'src/modules/a/x.ts', reason: '迁移中' }],
}

const config = (change: Record<string, unknown> = {}): Config => parseConfig(JSON.stringify({ ...BASE, ...change })).config as Config
const items = (change: Record<string, unknown>): string[] => texts(config(), { config: config(change), hasDir: true })

describe('放宽项（和分叉点上的配置比）', () => {
  test('首次接入：整份配置算一项', () => {
    const [item, ...rest] = texts(undefined, { config: config(), hasDir: true })
    assert.deepEqual(rest, [])
    assert.match(item as string, /^首次接入 modwall（分叉点上还没有配置），整份配置：\{"roots":\["src\/modules"\]/)
  })

  test('删掉配置文件、删掉整个 .modwall/ 目录都算放宽', () => {
    assert.deepEqual(texts(config(), { hasDir: true }), ['删掉了配置文件 .modwall/config.json'])
    assert.deepEqual(texts(config(), { hasDir: false }), ['删掉了整个 .modwall/ 目录'])
  })

  test('配置没变：没有放宽项', () => {
    assert.deepEqual(items({}), [])
  })

  test('扩大 shared、app、outside：放宽；在原来的目录里面加、删掉一条：不算', () => {
    assert.deepEqual(items({ shared: ['src/shared/**', 'src/common/**'], app: ['src/main.ts', 'src/app/**'], outside: ['scripts/**', 'migrations/'] }), [
      'shared 扩大：新增 "src/common/**"',
      'app 扩大：新增 "src/app/**"',
      'outside 扩大：新增 "migrations/"',
    ])
    assert.deepEqual(items({ shared: ['src/shared/money/**', 'src/shared/a.ts'], outside: [] }), [])
  })

  test('app 点名模块根目录下的文件，让它归装配层：也是扩大，要确认', () => {
    assert.deepEqual(items({ app: ['src/main.ts', 'src/modules/__init__.py'] }), ['app 扩大：新增 "src/modules/__init__.py"'])
  })

  test('把原来的规则换成更宽的也算扩大', () => {
    assert.deepEqual(items({ shared: ['src/**'] }), ['shared 扩大：新增 "src/**"'])
  })

  test('删掉或缩小模块根目录：放宽；新增模块根目录：收紧，不用确认', () => {
    assert.deepEqual(items({ roots: ['src/modules/core'] }), ['roots 删掉了模块根目录 "src/modules"'])
    assert.deepEqual(items({ roots: ['src/modules', 'packages'] }), [])
  })

  test('往 entry 加文件名：放宽；去掉：不算', () => {
    assert.deepEqual(items({ entry: ['index.ts', 'main.ts'] }), ['entry 新增入口文件名 "main.ts"'])
    assert.deepEqual(items({ entry: [] }), [])
  })

  test('map 新增、改归别的模块：放宽；在原来的映射里面细分到同一个模块：不算', () => {
    assert.deepEqual(items({ map: { 'src/pages/booking/**': 'billing', 'src/pages/stock/**': 'stock' } }), [
      'map 改了："src/pages/booking/**" 从 booking 模块改归 billing 模块',
      'map 新增："src/pages/stock/**" 归到 stock 模块',
    ])
    assert.deepEqual(items({ map: { 'src/pages/booking/list/**': 'booking' } }), [])
  })

  test('往 allow 加例外（含改了理由）：放宽；删掉例外：不算', () => {
    const added = { rule: 'R3', from: 'src/shared/a.ts', to: 'src/main.ts', reason: '待拆' }
    assert.deepEqual(items({ allow: [...BASE.allow, added] }), ['allow 新增例外：R3 src/shared/a.ts → src/main.ts，理由：待拆'])
    assert.deepEqual(items({ allow: [{ ...BASE.allow[0], reason: '换个理由' }] }), ['allow 新增例外：R1 src/main.ts → src/modules/a/x.ts，理由：换个理由'])
    assert.deepEqual(items({ allow: [] }), [])
  })

  test('删掉 database、改它的目录和账号名：放宽；加上 database：收紧，不用确认；首次接入的整份配置里有 database', () => {
    const database = { migrations: 'migrations', shared: 'src/shared/migrations', login: 'app', migrator: 'migrator' }
    const withDb = (db: unknown): Config => config(db === undefined ? {} : { database: db })
    const between = (before: unknown, now: unknown): string[] => texts(withDb(before), { config: withDb(now), hasDir: true })
    assert.deepEqual(between(undefined, database), [])
    assert.deepEqual(between(database, undefined), ['删掉了 database：数据库不再按模块检查'])
    assert.deepEqual(between(database, { migrations: 'db', shared: 'db/shared', login: 'web', migrator: 'owner' }), [
      'database.migrations 改了："migrations" 改成 "db"',
      'database.shared 改了："src/shared/migrations" 改成 "db/shared"',
      'database.login 改了："app" 改成 "web"',
      'database.migrator 改了："migrator" 改成 "owner"',
    ])
    assert.match(
      texts(undefined, { config: withDb(database), hasDir: true })[0] as string,
      /"database":\{"migrations":"migrations","shared":"src\/shared\/migrations","login":"app","migrator":"migrator"\}/,
    )
  })
})
