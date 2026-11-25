import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type Config, parseConfig } from '../../src/wall/config.ts'
import type { ChangeFacts, ImportFact, ProjectImports } from '../../src/wall/layermap.ts'
import { Layout } from '../../src/wall/layout.ts'
import { behaviorHints, entryExports, existingChangeHints, importViolations, type MigrationAlter, uncheckedItems, unownedFiles, withAssets } from '../../src/wall/rules.ts'

const FILES = [
  'src/main.ts',
  'src/shared/money.ts',
  'src/modules/booking/index.ts',
  'src/modules/booking/internal/create.ts',
  'src/modules/billing/index.ts',
  'src/modules/billing/charge.ts',
  'src/modules/stock/count.ts',
  'src/modules/py/__init__.py',
  'src/modules/py/inner.py',
  'src/modules/go/go.go',
  'src/modules/go2/go.go',
  'src/pages/booking/list.ts',
  'scripts/seed.ts',
  'tests/fx.ts',
]

function layout(extra: Record<string, unknown> = {}, files: string[] = FILES): Layout {
  const parsed = parseConfig(
    JSON.stringify({
      roots: ['src/modules'],
      shared: ['src/shared/**'],
      app: ['src/main.ts'],
      entry: ['index.ts', '__init__.py'],
      map: { 'src/pages/booking/**': 'booking' },
      outside: ['scripts/**'],
      ...extra,
    }),
  )
  assert.deepEqual(parsed.problems, [])
  const l = new Layout(parsed.config as Config, files)
  assert.deepEqual(l.problems, [])
  return l
}

let line = 0
/** 一条 import：from → to。 */
const imp = (from: string, to: string): ImportFact => ({ from, line: ++line, to, specifier: to })
const facts = (...imports: ImportFact[]): ProjectImports => ({ imports, unresolved: [] })
const rules = (l: Layout, ...imports: ImportFact[]): string[] => importViolations(l, facts(...imports)).map(v => v.key)

describe('R1 绕过入口', () => {
  test('别的模块 import 了 B 入口以外的文件：拦，改法指向 B 的入口', () => {
    const [v] = importViolations(layout(), facts(imp('src/modules/billing/charge.ts', 'src/modules/booking/internal/create.ts')))
    assert.equal(v?.rule, 'R1')
    assert.match(v?.where[0] as string, /billing 模块）import 了 booking 模块的内部文件 src\/modules\/booking\/internal\/create\.ts/)
    assert.match(v?.fix as string, /改成从 booking 的入口 src\/modules\/booking\/index\.ts 引用；入口里没有，就在入口新增导出/)
  })

  test('装配层也只能走入口；走入口、同一个模块里互相引用都不拦', () => {
    const l = layout()
    assert.deepEqual(rules(l, imp('src/main.ts', 'src/modules/booking/internal/create.ts')), ['R1 src/main.ts → src/modules/booking/internal/create.ts'])
    assert.deepEqual(
      rules(l, imp('src/main.ts', 'src/modules/booking/index.ts'), imp('src/modules/billing/charge.ts', 'src/modules/booking/index.ts'), imp('src/modules/booking/index.ts', 'src/modules/booking/internal/create.ts')),
      [],
    )
  })

  test('映射进模块的文件算那个模块的内部文件：别的模块引用它要拦，模块自己引用不拦', () => {
    const l = layout()
    assert.deepEqual(rules(l, imp('src/modules/billing/charge.ts', 'src/pages/booking/list.ts')), ['R1 src/modules/billing/charge.ts → src/pages/booking/list.ts'])
    assert.deepEqual(rules(l, imp('src/pages/booking/list.ts', 'src/modules/booking/internal/create.ts')), [])
  })

  test('B 还没有入口：改法是在 B 新建入口', () => {
    const [v] = importViolations(layout(), facts(imp('src/modules/billing/charge.ts', 'src/modules/stock/count.ts')))
    assert.match(v?.fix as string, /stock 还没有入口：在 src\/modules\/stock\/ 下新建入口文件（index\.ts、__init__\.py 之一）/)
  })

  test('Python：入口是 __init__.py，引用里面的模块文件要拦', () => {
    const l = layout()
    assert.deepEqual(rules(l, imp('src/modules/billing/charge.ts', 'src/modules/py/__init__.py')), [])
    assert.deepEqual(rules(l, imp('src/modules/billing/charge.ts', 'src/modules/py/inner.py')), ['R1 src/modules/billing/charge.ts → src/modules/py/inner.py'])
  })

  test('第一版不管 Go 和 Java 的入口', () => {
    assert.deepEqual(rules(layout(), imp('src/modules/go/go.go', 'src/modules/go2/go.go')), [])
  })

  test('allow 里用户确认过的例外放过这一条，别的照拦', () => {
    const l = layout({ allow: [{ rule: 'R1', from: 'src/main.ts', to: 'src/modules/booking/internal/create.ts', reason: '旧入口迁移中' }] })
    assert.deepEqual(rules(l, imp('src/main.ts', 'src/modules/booking/internal/create.ts'), imp('src/modules/billing/charge.ts', 'src/modules/booking/internal/create.ts')), [
      'R1 src/modules/billing/charge.ts → src/modules/booking/internal/create.ts',
    ])
  })
})

describe('R2 循环', () => {
  test('两个模块互相引用：报一次，列出环上每一步的 import', () => {
    const vs = importViolations(layout(), facts(imp('src/modules/billing/index.ts', 'src/modules/booking/index.ts'), imp('src/modules/booking/internal/create.ts', 'src/modules/billing/index.ts')))
    assert.deepEqual(vs.map(v => v.key), ['R2 billing booking'])
    assert.equal(vs[0]?.where[0], 'billing → booking → billing')
    assert.match(vs[0]?.where.join('\n') as string, /booking → billing：src\/modules\/booking\/internal\/create\.ts:\d+ import 了 src\/modules\/billing\/index\.ts/)
    assert.match(vs[0]?.fix as string, /下沉到共享层，或者通过参数传进来；两个模块确实分不开，就合成一个/)
  })

  test('三个模块绕一圈也是环；只有单向依赖不算；Go 的包也算', () => {
    const l = layout()
    const ring = [
      imp('src/modules/billing/index.ts', 'src/modules/booking/index.ts'),
      imp('src/modules/booking/index.ts', 'src/modules/stock/count.ts'),
      imp('src/modules/stock/count.ts', 'src/modules/billing/index.ts'),
    ]
    const vs = importViolations(l, facts(...ring)).filter(v => v.rule === 'R2')
    assert.deepEqual(vs.map(v => v.where[0]), ['billing → booking → stock → billing'])
    assert.deepEqual(rules(l, ...ring.slice(0, 2)).filter(key => key.startsWith('R2')), [])
    assert.deepEqual(rules(l, imp('src/modules/go/go.go', 'src/modules/go2/go.go'), imp('src/modules/go2/go.go', 'src/modules/go/go.go')), ['R2 go go2'])
  })

  test('映射进模块的文件算那个模块；allow 的 R2 例外不算这条边', () => {
    const cycle = [imp('src/pages/booking/list.ts', 'src/modules/billing/index.ts'), imp('src/modules/billing/index.ts', 'src/modules/booking/index.ts')]
    assert.deepEqual(rules(layout(), ...cycle), ['R2 billing booking'])
    const allowed = layout({ allow: [{ rule: 'R2', from: 'src/pages/booking/list.ts', to: 'src/modules/billing/index.ts', reason: '框架要求' }] })
    assert.deepEqual(rules(allowed, ...cycle), [])
  })
})

describe('R3 依赖方向反了', () => {
  test('共享层引用模块或装配层、模块引用装配层：拦', () => {
    const l = layout()
    assert.deepEqual(
      rules(l, imp('src/shared/money.ts', 'src/modules/booking/index.ts'), imp('src/shared/money.ts', 'src/main.ts'), imp('src/modules/billing/charge.ts', 'src/main.ts')),
      ['R3 src/shared/money.ts → src/modules/booking/index.ts', 'R3 src/shared/money.ts → src/main.ts', 'R3 src/modules/billing/charge.ts → src/main.ts'],
    )
    const [v] = importViolations(l, facts(imp('src/shared/money.ts', 'src/modules/booking/index.ts')))
    assert.match(v?.fix as string, /只有一个模块用的搬回那个模块，真正通用的搬进共享层/)
  })

  test('被管的代码引用 outside 或测试文件：拦；outside 自己引用什么都不管', () => {
    const l = layout()
    const vs = importViolations(l, facts(imp('src/main.ts', 'scripts/seed.ts'), imp('src/modules/billing/charge.ts', 'tests/fx.ts'), imp('scripts/seed.ts', 'src/modules/booking/internal/create.ts')))
    assert.deepEqual(vs.map(v => v.key), ['R3 src/main.ts → scripts/seed.ts', 'R3 src/modules/billing/charge.ts → tests/fx.ts'])
    assert.match(vs[0]?.fix as string, /不放在 outside 里/)
    assert.match(vs[1]?.fix as string, /不放在测试目录里/)
  })

  test('模块和装配层引用共享层、装配层引用模块入口：方向是对的', () => {
    assert.deepEqual(rules(layout(), imp('src/modules/billing/charge.ts', 'src/shared/money.ts'), imp('src/main.ts', 'src/shared/money.ts'), imp('src/main.ts', 'src/modules/billing/index.ts')), [])
  })

  test('allow 的 R3 例外放过这一条', () => {
    const l = layout({ allow: [{ rule: 'R3', from: 'src/main.ts', to: 'scripts/seed.ts', reason: '启动时读种子数据' }] })
    assert.deepEqual(rules(l, imp('src/main.ts', 'scripts/seed.ts')), [])
  })
})

describe('R5 文件没有归属', () => {
  test('代码文件不在模块、共享层、装配层、映射和 outside 里：拦；直接放在模块根目录下的也没有归属', () => {
    const files = [...FILES, 'src/loose.ts', 'src/modules/stray.py', 'src/readme.md', 'src/util.test.ts', 'tools/x.go']
    const vs = unownedFiles(layout({}, files), files)
    assert.deepEqual(vs.map(v => v.key), ['R5 src/loose.ts', 'R5 src/modules/stray.py', 'R5 tools/x.go'])
    assert.match(vs[1]?.where[0] as string, /直接放在模块根目录 src\/modules 下/)
    assert.equal(vs[0]?.fix, '放进某个模块（src/modules/<模块名>/）、共享层（src/shared/**）、装配层（src/main.ts）。')
    // 直接放在根目录下的：改法里多一句可以在 app 里点名
    assert.match(vs[1]?.fix as string, /要保留在模块根目录下的（比如 Python 包的 __init__\.py），在 app 里写到这个文件（"src\/modules\/stray\.py"，不用通配），它就归装配层/)
  })

  test('LayerMap 不读的目录在模块、共享层、装配层里：没有归属，改法是换个目录名；目录名不分大小写；测试文件照旧不管', () => {
    const files = [...FILES, 'src/modules/booking/vendor/util.ts', 'src/shared/Node_Modules/x.js', 'src/modules/booking/vendor/util.test.ts']
    const vs = unownedFiles(layout({}, files), files)
    assert.deepEqual(vs.map(v => v.key), ['R5 src/modules/booking/vendor/util.ts', 'R5 src/shared/Node_Modules/x.js'])
    assert.equal(vs[0]?.where[0], 'src/modules/booking/vendor/util.ts 在 LayerMap 不读的目录 src/modules/booking/vendor 里，modwall 查不到它引用了谁（按路径它在booking 模块里），没有归属')
    assert.match(vs[0]?.fix as string, /^换个目录名，把它搬出 src\/modules\/booking\/vendor\/（LayerMap 不读的目录名有 node_modules、vendor、/)
    assert.match(vs[1]?.where[0] as string, /不读的目录 src\/shared\/Node_Modules 里.*（按路径它在共享层里）/)
  })

  test('模块根目录下叫 vendor 的子目录不算模块，里面的代码文件没有归属', () => {
    const files = [...FILES, 'src/modules/vendor/index.ts']
    const l = layout({}, files)
    assert.ok(!l.modules.some(module => module.name === 'vendor'))
    assert.match(unownedFiles(l, files)[0]?.where[0] as string, /src\/modules\/vendor\/index\.ts 在 LayerMap 不读的目录 src\/modules\/vendor 里.*（按路径它在vendor 模块里）/)
  })

  test('别处的 LayerMap 不读的目录：没写进 outside 没有归属，改法是写进 outside 或搬进模块；写进 outside 后有归属', () => {
    const files = [...FILES, 'third/vendor/lib.go', '.claude/hooks/x.ts']
    const vs = unownedFiles(layout({}, files), files)
    assert.deepEqual(vs.map(v => v.key), ['R5 .claude/hooks/x.ts', 'R5 third/vendor/lib.go'])
    assert.match(vs[1]?.fix as string, /^第三方或工具的代码，在 outside 里写上 "third\/vendor\/\*\*"（放宽规则，要用户同意）；项目自己的代码放进某个模块/)
    const covered = layout({ outside: ['scripts/**', 'third/vendor/**', '.claude/**'] }, files)
    assert.deepEqual(unownedFiles(covered, files), [])
    assert.equal(covered.owner('third/vendor/lib.go').kind, 'outside')
  })

  test('app 点名的根目录文件归装配层，不算没有归属；模块引用它是 R3，它绕过入口引用模块内部是 R1', () => {
    const files = [...FILES, 'src/modules/__init__.py']
    const l = layout({ app: ['src/main.ts', 'src/modules/__init__.py'] }, files)
    assert.deepEqual(unownedFiles(l, files), [])
    const vs = importViolations(
      l,
      facts(imp('src/modules/billing/charge.ts', 'src/modules/__init__.py'), imp('src/modules/__init__.py', 'src/modules/py/__init__.py'), imp('src/modules/__init__.py', 'src/modules/py/inner.py')),
    )
    assert.deepEqual(vs.map(v => v.key), ['R1 src/modules/__init__.py → src/modules/py/inner.py', 'R3 src/modules/billing/charge.ts → src/modules/__init__.py'])
    assert.match(vs[1]?.fix as string, /`from src\.modules import 模块名` 和 `from \.\. import 模块名` 会被记成同时引用了 src\/modules\/__init__\.py，写成 `from src\.modules\.模块名 import …` 或 `from \.\.模块名 import …`/)
  })
})

const changes = (value: Partial<ChangeFacts>): ChangeFacts => ({
  imports: [],
  calls: [],
  declarations: [],
  edgesTruncated: false,
  truncated: false,
  incomplete: [],
  unmapped: [],
  ...value,
})

describe('R4 为新功能改了别人的已有行为（只提示）', () => {
  const changed = { path: 'src/modules/booking/internal/create.ts', declaration: 'price', line: 3, exported: true }
  const call = { from: 'src/modules/billing/charge.ts', line: 7, to: 'src/modules/booking/internal/create.ts', declaration: 'price', exported: true }

  test('改了 B 已有导出函数的实现，A 在这次改动里新增了对它的调用：提示在 B 新增函数', () => {
    const hints = behaviorHints(layout(), changes({ declarations: [changed], calls: [call] }))
    assert.equal(hints.length, 1)
    assert.match(hints[0]?.where as string, /booking 模块的 price（src\/modules\/booking\/internal\/create\.ts:3）这次改了实现，billing 模块在 src\/modules\/billing\/charge\.ts:7 新增了对它的调用/)
    assert.match(hints[0]?.fix as string, /在 booking 新增一个函数，不要给旧函数加分支/)
  })

  test('没导出的、同一个模块里调用的、装配层调用的、没新增调用的：不提示', () => {
    const l = layout()
    assert.deepEqual(behaviorHints(l, changes({ declarations: [{ ...changed, exported: false }], calls: [call] })), [])
    assert.deepEqual(behaviorHints(l, changes({ declarations: [changed], calls: [{ ...call, from: 'src/modules/booking/index.ts' }] })), [])
    assert.deepEqual(behaviorHints(l, changes({ declarations: [changed], calls: [{ ...call, from: 'src/main.ts' }] })), [])
    assert.deepEqual(behaviorHints(l, changes({ declarations: [changed], calls: [{ ...call, declaration: 'createBooking' }] })), [])
  })
})

describe('R4 的另一种：新建了模块，又改了已有模块里已有的（只提示）', () => {
  const CREATE = 'src/modules/booking/internal/create.ts'
  const MIGRATION = 'src/modules/billing/migrations/20261125090000_source.sql'
  const decl = (path: string, declaration: string, line: number, exported = true) => ({ path, declaration, line, exported })
  const where = (l: Layout, fresh: string[], value: Partial<ChangeFacts>, alters: MigrationAlter[] = []): string[] =>
    existingChangeHints(l, changes(value), new Set(fresh), alters).map(hint => hint.where)
  const alter = (l: Layout, module: string, path: string, line: number): MigrationAlter => ({ module: l.modules.find(m => m.id === module) as MigrationAlter['module'], path, line })

  test('新建了模块，又改了已有模块里已有的声明：每个已有模块一条，写明新模块、已有模块、声明名和位置', () => {
    const l = layout()
    const hints = existingChangeHints(
      l,
      changes({ declarations: [decl(CREATE, 'Source', 9), decl('src/modules/billing/charge.ts', 'LIMIT', 2, false), decl(CREATE, 'price', 7)] }),
      new Set(['stock']),
      [],
    )
    assert.deepEqual(hints.map(hint => hint.where), [
      `这次新建了 stock 模块，同时改了已有的 booking 模块里已有的：Source（${CREATE}:9）、price（${CREATE}:7）`,
      '这次新建了 stock 模块，同时改了已有的 billing 模块里已有的：LIMIT（src/modules/billing/charge.ts:2）',
    ])
    assert.match(hints[0]?.fix as string, /^新模块要的在 booking 新增，不改它已有的。.*改成 booking 收一个值，或者由装配层接进来；是正常的重构就不用管。$/)
  })

  test('同时新建了几个模块：都写上', () => {
    assert.deepEqual(where(layout(), ['stock', 'go'], { declarations: [decl(CREATE, 'Source', 9)] }), [`这次新建了 go、stock 模块，同时改了已有的 booking 模块里已有的：Source（${CREATE}:9）`])
  })

  test('映射进已有模块的文件也算那个模块的', () => {
    assert.deepEqual(where(layout(), ['stock'], { declarations: [decl('src/pages/booking/list.ts', 'COLUMNS', 4)] }), ['这次新建了 stock 模块，同时改了已有的 booking 模块里已有的：COLUMNS（src/pages/booking/list.ts:4）'])
  })

  test('对象字面量的属性（PAGES.deposit）按顶层的名字报', () => {
    assert.deepEqual(where(layout(), ['stock'], { declarations: [decl(CREATE, 'PAGES.deposit', 12)] }), [`这次新建了 stock 模块，同时改了已有的 booking 模块里已有的：PAGES（${CREATE}:12）`])
  })

  test('同一个对象字面量改了几个属性：按顶层的名字只说一次', () => {
    const [hint] = where(layout(), ['stock'], { declarations: [decl(CREATE, 'PAGES.deposit', 12), decl(CREATE, 'PAGES.refund', 13)] })
    assert.equal(hint?.match(/PAGES（/g)?.length, 1, hint)
    assert.match(hint as string, new RegExp(`PAGES（${CREATE}:12）`))
  })

  test('这次没有新建模块：改已有模块不提示', () => {
    const l = layout()
    assert.deepEqual(where(l, [], { declarations: [decl(CREATE, 'Source', 9)] }, [alter(l, 'billing', MIGRATION, 3)]), [])
  })

  test('新模块自己的、装配层的、共享层的、outside 里的改动不提示', () => {
    const declarations = [decl('src/modules/stock/count.ts', 'count', 1), decl('src/main.ts', 'ROUTES', 3), decl('src/shared/money.ts', 'round', 1), decl('scripts/seed.ts', 'seed', 1)]
    assert.deepEqual(where(layout(), ['stock'], { declarations }), [])
  })

  test('已经按"改了实现、别的模块新增了调用"提示过的声明不再列；没导出的、只在本模块里新增调用的照列', () => {
    const l = layout()
    const price = decl(CREATE, 'price', 7)
    const call = { from: 'src/modules/stock/count.ts', line: 2, to: CREATE, declaration: 'price', exported: true }
    const value = { declarations: [price], calls: [call] }
    assert.equal(behaviorHints(l, changes(value)).length, 1)
    assert.deepEqual(where(l, ['stock'], value), [])
    assert.deepEqual(where(l, ['stock'], { declarations: [{ ...price, exported: false }], calls: [call] }), [`这次新建了 stock 模块，同时改了已有的 booking 模块里已有的：price（${CREATE}:7）`])
    assert.deepEqual(where(l, ['stock'], { declarations: [price], calls: [{ ...call, from: 'src/modules/booking/index.ts' }] }), [`这次新建了 stock 模块，同时改了已有的 booking 模块里已有的：price（${CREATE}:7）`])
  })

  test('已有模块的新迁移里改、删已有的对象：一个文件只说一次，位置写第一句；和改了的声明并在这个模块的一条里', () => {
    const l = layout()
    const hints = where(l, ['stock'], { declarations: [decl('src/modules/billing/charge.ts', 'LIMIT', 2)] }, [alter(l, 'billing', MIGRATION, 7), alter(l, 'billing', MIGRATION, 8)])
    assert.deepEqual(hints, [`这次新建了 stock 模块，同时改了已有的 billing 模块里已有的：LIMIT（src/modules/billing/charge.ts:2）、迁移里改、删了已有的对象（${MIGRATION}:7）`])
  })

  test('新模块自己的迁移里改、删对象不提示', () => {
    const l = layout()
    assert.deepEqual(where(l, ['stock'], {}, [alter(l, 'stock', 'src/modules/stock/migrations/20261125090000_stock.sql', 2)]), [])
  })
})

describe('入口新增导出和没检查到的地方（只列出来）', () => {
  test('入口这次新增了对本模块文件的引用（转导出也算）：列出来；删掉的、不是入口的不列', () => {
    const hints = entryExports(
      layout(),
      changes({
        imports: [
          { from: 'src/modules/booking/index.ts', to: 'src/modules/booking/internal/create.ts', line: 2, change: 'ADDED' },
          { from: 'src/modules/booking/index.ts', to: 'src/modules/booking/internal/create.ts', line: 1, change: 'REMOVED' },
          { from: 'src/modules/billing/charge.ts', to: 'src/modules/billing/index.ts', line: 1, change: 'ADDED' },
          { from: 'src/modules/booking/index.ts', to: 'src/shared/money.ts', line: 3, change: 'ADDED' },
        ],
      }),
    )
    assert.deepEqual(hints.map(hint => hint.where), ['booking 的入口 src/modules/booking/index.ts:2 新增引用 src/modules/booking/internal/create.ts'])
  })

  test('可能是项目自己的、没对上文件的 import 照列，相对路径的在前；外部包、outside 里的不列；LayerMap 没看全的地方照列，不跟的改动文件只列代码文件', () => {
    const unresolved = [
      { from: 'src/main.ts', line: 1, specifier: '@app/x', reason: 'SYMBOL_NOT_RESOLVED', possiblyOwn: true },
      { from: 'src/main.ts', line: 2, specifier: './style.css', reason: 'SYMBOL_NOT_RESOLVED', possiblyOwn: true },
      { from: 'src/main.ts', line: 3, specifier: 'react', reason: 'OUTSIDE_SOURCE_CONTEXT', possiblyOwn: false },
      { from: 'scripts/seed.ts', line: 1, specifier: './gone', reason: 'SYMBOL_NOT_RESOLVED', possiblyOwn: true },
    ]
    const unmapped = [
      { path: 'db/migrations/001_init.ts', kind: 'migration' },
      // 不是代码文件的不列：modwall 本来就不查它们，包括它自己的配置
      { path: 'db/1.sql', kind: 'migration' },
      { path: 'testpace.json', kind: 'unanalyzed file' },
      { path: '.modwall/config.json', kind: 'unanalyzed file' },
    ]
    const items = uncheckedItems(layout(), { imports: [], unresolved }, changes({ incomplete: ['search cut by the deadline'], unmapped, edgesTruncated: true }))
    assert.deepEqual(items, [
      'src/main.ts:2 的 import "./style.css"：路径或别名没对上文件，也可能是样式文件或没装的包',
      'src/main.ts:1 的 import "@app/x"：路径或别名没对上文件，也可能是样式文件或没装的包',
      '检查没做完：search cut by the deadline',
      'LayerMap 不跟的改动文件：db/migrations/001_init.ts（migration）',
      '这次改动的声明超过 LayerMap 跟踪的上限（200 个），R4 的提示可能不全',
    ])
  })
})

describe('import 非代码文件（样式、图片、JSON）', () => {
  const ASSETS = [...FILES, 'src/modules/booking/theme.css', 'src/modules/booking/logo.png', 'src/shared/base.css', 'src/modules/billing/data.json']
  const unresolved = (from: string, specifier: string, reason = 'SYMBOL_NOT_RESOLVED') => ({ from, line: 7, specifier, reason, possiblyOwn: reason === 'SYMBOL_NOT_RESOLVED' })

  test('写相对路径、指向项目里存在的非代码文件的，算出目标当成 import；别的照旧留在没对上的里', () => {
    const resolved = withAssets(
      {
        imports: [],
        unresolved: [
          unresolved('src/modules/billing/index.ts', '../booking/theme.css'),
          unresolved('src/modules/billing/index.ts', '../booking/logo.png?url'),
          unresolved('src/modules/billing/index.ts', './data.json'),
          unresolved('src/modules/billing/index.ts', '../booking/gone.css'),
          unresolved('src/modules/billing/index.ts', '@styles/theme.css'),
          unresolved('src/modules/billing/index.ts', '../booking/index.ts'),
          unresolved('src/modules/billing/index.ts', '../../../../outside.css'),
          unresolved('src/modules/billing/index.ts', './data.json', 'SOURCE_DECLARATION_UNMAPPED'),
        ],
      },
      ASSETS,
    )
    assert.deepEqual(
      resolved.imports.map(fact => fact.to),
      ['src/modules/booking/theme.css', 'src/modules/booking/logo.png', 'src/modules/billing/data.json'],
    )
    assert.deepEqual(
      resolved.unresolved.map(fact => fact.specifier),
      ['../booking/gone.css', '@styles/theme.css', '../booking/index.ts', '../../../../outside.css', './data.json'],
    )
  })

  test('引用别的模块的样式、图片按 R1 拦：样式的改法是搬进共享层或用对方入口导出的组件，图片照代码从入口导出；本模块的、共享层的不拦', () => {
    const l = layout({}, ASSETS)
    const vs = importViolations(
      l,
      facts(
        imp('src/modules/billing/index.ts', 'src/modules/booking/theme.css'),
        imp('src/modules/billing/index.ts', 'src/modules/booking/logo.png'),
        imp('src/modules/billing/index.ts', 'src/shared/base.css'),
        imp('src/modules/billing/index.ts', 'src/modules/billing/data.json'),
      ),
    )
    assert.deepEqual(vs.map(v => v.key), ['R1 src/modules/billing/index.ts → src/modules/booking/theme.css', 'R1 src/modules/billing/index.ts → src/modules/booking/logo.png'])
    assert.equal(vs[0]?.fix, '样式不能经入口导出：几个模块都用的样式，搬进共享层；只该 booking 用的，改成用 booking 入口导出的组件。')
    assert.match(vs[1]?.fix as string, /^改成从 booking 的入口 src\/modules\/booking\/index\.ts 引用/)
  })

  test('共享层引用模块的样式按 R3 拦；经样式成环也算 R2', () => {
    const l = layout({}, ASSETS)
    const keys = importViolations(
      l,
      facts(imp('src/shared/money.ts', 'src/modules/booking/theme.css'), imp('src/modules/billing/index.ts', 'src/modules/booking/logo.png'), imp('src/modules/booking/index.ts', 'src/modules/billing/index.ts')),
    ).map(v => v.key)
    assert.deepEqual(keys, ['R1 src/modules/billing/index.ts → src/modules/booking/logo.png', 'R2 billing booking', 'R3 src/shared/money.ts → src/modules/booking/theme.css'])
  })
})
