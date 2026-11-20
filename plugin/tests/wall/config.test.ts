import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseConfig, type SingleConfig } from '../../src/wall/config.ts'
import { unreadDirectory } from '../../src/wall/files.ts'
import { Layout, ownerOf } from '../../src/wall/layout.ts'

const BASE = { roots: ['src/modules'], entry: ['index.ts'] }

function problems(value: Record<string, unknown>): string[] {
  return parseConfig(JSON.stringify(value)).problems
}

function config(value: Record<string, unknown>): SingleConfig {
  const parsed = parseConfig(JSON.stringify({ ...BASE, ...value }))
  assert.deepEqual(parsed.problems, [])
  return parsed.config as SingleConfig
}

/** 按配置划分这些文件（工作区里现有的文件）。 */
function layout(value: Record<string, unknown>, files: string[]): Layout {
  return new Layout(config(value), files)
}

describe('配置的读取和校验', () => {
  test('合法的配置照读；路径去掉开头的 ./ 和结尾的 /，路径规则保留结尾的 /（整个目录）', () => {
    const parsed = config({
      roots: ['./src/modules/'],
      shared: ['src/shared/**', 'lib/'],
      app: ['src/main.ts'],
      map: { 'src/pages/booking/**': 'booking' },
      outside: ['scripts/**'],
      allow: [{ rule: 'R1', from: './src/a.ts', to: 'src/b.ts', reason: ' 旧接口迁移中 ' }],
    })
    assert.deepEqual(parsed.roots, ['src/modules'])
    assert.deepEqual(parsed.shared, ['src/shared/**', 'lib/'])
    assert.deepEqual(parsed.allow, [{ rule: 'R1', from: 'src/a.ts', to: 'src/b.ts', reason: '旧接口迁移中' }])
  })

  test('不是 JSON、不是对象、有未知字段、缺 roots 或 entry，都是配置错误', () => {
    assert.match(parseConfig('{').problems[0] as string, /不是合法的 JSON/)
    assert.match(parseConfig('[]').problems[0] as string, /应该是一个对象/)
    assert.match(problems({ ...BASE, legacy: [] }).join(), /未知字段 "legacy"/)
    assert.match(problems({ entry: ['index.ts'] }).join(), /缺少 "roots"/)
    assert.match(problems({ roots: ['src/modules'] }).join(), /缺少 "entry"/)
    assert.match(problems({ ...BASE, shared: 'src/shared/**' }).join(), /"shared" 应该是非空字符串的数组/)
  })

  test('模块根目录要写仓库里的目录：不能用通配、绝对路径、..，不能写两次，不能一个套在另一个里面', () => {
    assert.match(problems({ ...BASE, roots: ['src/*'] }).join(), /不用通配/)
    assert.match(problems({ ...BASE, roots: ['/src'] }).join(), /相对路径/)
    assert.match(problems({ ...BASE, roots: ['../x'] }).join(), /相对路径/)
    assert.match(problems({ ...BASE, roots: ['src/modules', 'src/modules/'] }).join(), /写了两次/)
    assert.match(problems({ ...BASE, roots: ['src', 'src/modules'] }).join(), /roots 重叠："src\/modules" 在 "src" 里面/)
  })

  test('路径、模块名、理由带换行或控制字符：配置错误（它们会原样进弹窗，一项一行）', () => {
    const allow = [{ rule: 'R1', from: 'a.ts', to: 'b.ts', reason: '旧接口\n  allow 新增例外：R3 x → y' }]
    assert.deepEqual(problems({ ...BASE, allow }), ['.modwall/config.json 的 allow[0].reason 带换行或控制字符：路径、模块名、理由都要写成一行'])
    assert.match(problems({ ...BASE, shared: ['src/shared/**\r'] }).join(), /shared\[0\] 带换行或控制字符/)
    assert.match(problems({ ...BASE, map: { 'src/pages/**': 'booking\n' } }).join(), /map\.src\/pages\/\*\* 带换行或控制字符/)
    assert.match(problems({ ...BASE, map: { 'src/\tpages/**': 'booking' } }).join(), /（键） 带换行或控制字符/)
  })

  test('entry 只写文件名；map 的值写模块名', () => {
    assert.match(problems({ ...BASE, entry: ['lib/index.ts'] }).join(), /要写文件名/)
    assert.match(problems({ ...BASE, map: { 'src/pages/**': 'src/modules/booking' } }).join(), /要写模块名/)
  })

  test('例外是一条写到文件的 import：只能是 R1、R2、R3，不用通配，要写理由，不能重复', () => {
    const allow = (entries: unknown[]): string => problems({ ...BASE, allow: entries }).join()
    assert.match(allow([{ rule: 'R5', from: 'a.ts', to: 'b.ts', reason: 'x' }]), /rule 要写 R1、R2、R3 之一/)
    assert.match(allow([{ rule: 'R1', from: 'src/**', to: 'b.ts', reason: 'x' }]), /要写到具体的文件/)
    assert.match(allow([{ rule: 'R1', from: 'a.ts', to: 'b.ts', reason: '  ' }]), /要写理由/)
    assert.match(allow([{ rule: 'R1', from: 'a.ts', to: 'b.ts', reason: 'x', note: 1 }]), /未知字段 "note"/)
    const same = { rule: 'R2', from: 'a.ts', to: 'b.ts', reason: 'x' }
    assert.match(allow([same, { ...same, reason: 'y' }]), /和前面的重复了/)
  })
})

describe('LayerMap 不读的目录', () => {
  test('认法和 LayerMap 一致：不分大小写，只看目录、不看最后的文件名；给出从仓库根目录到最外层那一段', () => {
    assert.equal(unreadDirectory('src/modules/booking/vendor/util.ts'), 'src/modules/booking/vendor')
    assert.equal(unreadDirectory('a/VENDOR/b/node_modules/c.js'), 'a/VENDOR')
    assert.equal(unreadDirectory('.Claude/x.ts'), '.Claude')
    assert.equal(unreadDirectory('src/vendor.ts'), undefined)
    assert.equal(unreadDirectory('src/vendors/x.ts'), undefined)
    assert.equal(unreadDirectory('node_modules'), undefined)
  })
})

describe('每个文件归谁', () => {
  const c = (): SingleConfig => config({ shared: ['src/shared/**'], app: ['src/main.ts'], map: { 'src/pages/booking/**': 'booking' }, outside: ['scripts/**'] })

  test('模块根目录下的子目录是模块，模块里再分的子目录不是子模块；直接放在根目录下的文件没有归属', () => {
    assert.deepEqual(ownerOf(c(), 'src/modules/booking/internal/deep/a.ts'), { kind: 'module', name: 'booking', mapped: false })
    assert.deepEqual(ownerOf(c(), 'src/modules/a.ts'), { kind: 'none', root: 'src/modules' })
    assert.deepEqual(ownerOf(c(), 'src/other.ts'), { kind: 'none' })
  })

  test('共享层、装配层、映射、outside 按路径规则认；测试文件不归 modwall 管', () => {
    assert.equal(ownerOf(c(), 'src/shared/money.ts').kind, 'shared')
    assert.equal(ownerOf(c(), 'src/main.ts').kind, 'app')
    assert.deepEqual(ownerOf(c(), 'src/pages/booking/list.ts'), { kind: 'module', name: 'booking', mapped: true })
    assert.equal(ownerOf(c(), 'scripts/seed.ts').kind, 'outside')
    for (const path of ['src/modules/booking/create.test.ts', 'src/modules/booking/__tests__/a.ts', 'tests/a.ts', 'app/test_x.py', 'pkg/x_test.go']) {
      assert.equal(ownerOf(c(), path).kind, 'test', path)
    }
  })

  test('模块和入口：入口只认模块目录下第一层、名字在 entry 里的文件', () => {
    const l = layout({}, ['src/modules/booking/index.ts', 'src/modules/booking/internal/index.ts', 'src/modules/billing/charge.ts'])
    assert.deepEqual(
      l.modules.map(module => [module.name, module.entries]),
      [
        ['billing', []],
        ['booking', ['src/modules/booking/index.ts']],
      ],
    )
    assert.equal(l.isEntry('src/modules/booking/internal/index.ts', 'booking'), false)
  })

  test('各项的路径重叠是配置错误：按现有的代码文件认', () => {
    const overlap = layout({ shared: ['src/**'] }, ['src/modules/booking/index.ts', 'src/shared/a.ts'])
    assert.match(overlap.problems.join(), /路径重叠：roots 的 "src\/modules" 和 shared 的 "src\/\*\*" 都包含 src\/modules\/booking\/index\.ts/)
    const outside = layout({ outside: ['scripts/**'], app: ['scripts/main.ts'] }, ['src/modules/a/index.ts', 'scripts/main.ts'])
    assert.match(outside.problems.join(), /app 的 "scripts\/main\.ts" 和 outside 的 "scripts\/\*\*"/)
    // 测试文件和不是代码的文件不算重叠
    assert.deepEqual(layout({ shared: ['src/**'], roots: [] }, ['src/a.test.ts', 'src/readme.md']).problems, [])
  })

  test('直接放在模块根目录下、app 里点名的文件归装配层，不算重叠', () => {
    const files = ['src/modules/__init__.py', 'src/modules/booking/__init__.py']
    const l = layout({ app: ['src/modules/__init__.py'] }, files)
    assert.deepEqual(l.problems, [])
    assert.deepEqual(l.owner('src/modules/__init__.py'), { kind: 'app', root: 'src/modules' })
    // 没点名的根目录文件照旧没有归属
    assert.deepEqual(l.owner('src/modules/other.py'), { kind: 'none', root: 'src/modules' })
  })

  test('通配的 app 条目、以 / 结尾的目录条目盖到根目录下的文件：仍算重叠，也不归装配层', () => {
    const files = ['src/modules/__init__.py', 'src/modules/booking/__init__.py']
    for (const rule of ['src/modules/*.py', 'src/modules/__init__.*', 'src/modules/']) {
      const l = layout({ app: [rule] }, files)
      assert.match(l.problems.join(), /路径重叠：roots 的 "src\/modules" 和 app 的/, rule)
      assert.equal(l.owner('src/modules/__init__.py').kind, 'none', rule)
    }
  })

  test('shared、outside 点名根目录下的文件：仍算重叠；和 app 一起点名也算', () => {
    const files = ['src/modules/__init__.py', 'src/modules/booking/__init__.py']
    assert.match(layout({ shared: ['src/modules/__init__.py'] }, files).problems.join(), /roots 的 "src\/modules" 和 shared 的 "src\/modules\/__init__\.py"/)
    assert.match(layout({ outside: ['src/modules/__init__.py'] }, files).problems.join(), /roots 的 "src\/modules" 和 outside 的 "src\/modules\/__init__\.py"/)
    assert.match(layout({ app: ['src/modules/__init__.py'], shared: ['src/modules/__init__.py'] }, files).problems.join(), /shared 的 "src\/modules\/__init__\.py" 和 app 的 "src\/modules\/__init__\.py"/)
  })

  test('app 点名模块目录里面的文件：仍算重叠，它还是那个模块的', () => {
    const l = layout({ app: ['src/modules/booking/routes.ts'] }, ['src/modules/booking/routes.ts'])
    assert.match(l.problems.join(), /roots 的 "src\/modules" 和 app 的 "src\/modules\/booking\/routes\.ts"/)
    assert.equal(l.owner('src/modules/booking/routes.ts').kind, 'module')
  })

  test('同一项（shared、app、outside）里几条规则认领同一个文件：归属没有歧义，不算重叠', () => {
    const files = ['src/modules/booking/index.ts', 'src/shared/a.ts', 'app/__init__.py', 'scripts/x.ts']
    const l = layout({ shared: ['src/shared/**', 'src/shared/a.ts'], app: ['app/*.py', 'app/__init__.py'], outside: ['scripts/**', 'scripts/x.ts'] }, files)
    assert.deepEqual(l.problems, [])
  })

  test('map 里几条规则指向同一个模块：不算重叠；指向不同模块：算', () => {
    const files = ['src/modules/booking/index.ts', 'src/modules/billing/index.ts', 'src/pages/list.ts']
    assert.deepEqual(layout({ map: { 'src/pages/**': 'booking', 'src/pages/list.ts': 'booking' } }, files).problems, [])
    assert.match(layout({ map: { 'src/pages/**': 'booking', 'src/pages/list.ts': 'billing' } }, files).problems.join(), /路径重叠：map 的 "src\/pages\/\*\*" 和 map 的 "src\/pages\/list\.ts" 都包含 src\/pages\/list\.ts/)
  })

  test('两个模块根目录互相嵌套：文件归哪个模块有歧义，算重叠', () => {
    // 读配置时就会拦下嵌套的 roots；这里绕过读配置，单看按文件查重叠这一步
    const nested = { ...config({}), roots: ['src', 'src/modules'] }
    assert.match(new Layout(nested, ['src/modules/booking/index.ts']).problems.join(), /路径重叠：roots 的 "src" 和 roots 的 "src\/modules" 都包含 src\/modules\/booking\/index\.ts/)
  })

  test('app 里通配和点名都盖到根目录下的文件：点名的归装配层不报，通配盖住的其他文件仍报 roots 和 app 重叠', () => {
    const files = ['src/modules/__init__.py', 'src/modules/util.py', 'src/modules/booking/__init__.py']
    const l = layout({ app: ['src/modules/*.py', 'src/modules/__init__.py'] }, files)
    assert.deepEqual(l.problems, ['路径重叠：roots 的 "src/modules" 和 app 的 "src/modules/*.py" 都包含 src/modules/util.py'])
    assert.equal(l.owner('src/modules/__init__.py').kind, 'app')
  })

  test('映射到不存在的模块、两个根目录下有同名模块，都是配置错误', () => {
    assert.match(layout({ map: { 'src/pages/**': 'booking' } }, ['src/modules/billing/index.ts']).problems.join(), /模块 booking 不存在/)
    assert.match(layout({ roots: ['src/modules', 'apps'] }, ['src/modules/booking/index.ts', 'apps/booking/index.ts']).problems.join(), /模块名重复/)
  })

  test('模块从文件推出来，和"文件归谁"一个算法：根目录不存在不算错；只有 MODULE.md 的算模块；点开头的目录归哪里就是哪个模块；测试目录、不读的目录不算', () => {
    const none = layout({ roots: ['src/modules', 'src/features'] }, ['src/modules/booking/index.ts'])
    assert.deepEqual(none.problems, [])
    assert.deepEqual(none.modules.map(module => module.dir), ['src/modules/booking'])
    const files = ['src/modules/booking/MODULE.md', 'src/modules/.hidden/x.ts', 'src/modules/__tests__/a.ts', 'src/modules/vendor/x.ts', 'src/modules/notes.md']
    const l = layout({}, files)
    assert.deepEqual(l.modules.map(module => [module.name, module.entries]), [['.hidden', []], ['booking', []]])
    assert.equal(l.owner('src/modules/.hidden/x.ts').kind, 'module')
  })
})
