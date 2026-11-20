// 一个仓库里有几个应用：配置的两种写法、按应用算的规则、应用之间的 R3、放宽项、钩子、status、init。

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type Config, type GroupedConfig, parseConfig } from '../../src/wall/config.ts'
import type { ChangeFacts, ImportFact, ProjectImports } from '../../src/wall/layermap.ts'
import { Layout } from '../../src/wall/layout.ts'
import { type ConfigSide, looseningItems } from '../../src/wall/loosen.ts'
import { behaviorHints, entryExports, importViolations, unownedFiles } from '../../src/wall/rules.ts'
import { hook, modwall, sh, tempDir, write } from './helpers.ts'

const APPS = {
  apps: {
    admin: {
      roots: ['apps/admin/src/features'],
      shared: ['apps/admin/src/components/**'],
      app: ['apps/admin/src/main.ts'],
      entry: ['index.ts'],
      map: { 'apps/admin/src/pages/courses/**': 'courses' },
    },
    api: {
      roots: ['services/api/src/modules'],
      shared: ['services/api/src/shared/**'],
      app: ['services/api/src/server.ts'],
      entry: ['index.ts'],
    },
  },
  shared: ['packages/common/**'],
  outside: ['scripts/**'],
  allow: [],
}

const FILES = [
  'apps/admin/src/main.ts',
  'apps/admin/src/components/button.ts',
  'apps/admin/src/features/courses/index.ts',
  'apps/admin/src/features/courses/list.ts',
  'apps/admin/src/features/orders/index.ts',
  'apps/admin/src/pages/courses/page.ts',
  'services/api/src/server.ts',
  'services/api/src/shared/db.ts',
  'services/api/src/modules/courses/index.ts',
  'services/api/src/modules/courses/repo.ts',
  'services/api/src/modules/orders/index.ts',
  'packages/common/money.ts',
  'scripts/seed.ts',
]

function parsed(value: Record<string, unknown> = APPS): Config {
  const result = parseConfig(JSON.stringify(value))
  assert.deepEqual(result.problems, [])
  return result.config as Config
}

function layout(value: Record<string, unknown> = APPS, files: string[] = FILES): Layout {
  const l = new Layout(parsed(value), files)
  assert.deepEqual(l.problems, [])
  return l
}

const problems = (value: Record<string, unknown>): string => parseConfig(JSON.stringify(value)).problems.join('\n')

let line = 0
const imp = (from: string, to: string): ImportFact => ({ from, line: ++line, to, specifier: to })
const facts = (...imports: ImportFact[]): ProjectImports => ({ imports, unresolved: [] })
const keys = (l: Layout, ...imports: ImportFact[]): string[] => importViolations(l, facts(...imports)).map(v => v.key)

/** 按应用分组的配置，改一处。 */
const grouped = (change: (config: Record<string, any>) => void): Record<string, unknown> => {
  const copy = JSON.parse(JSON.stringify(APPS))
  change(copy)
  return copy
}

describe('按应用分组的写法', () => {
  test('合法的写法照读：每个应用一组，外面一层只有 apps、shared、outside、allow', () => {
    const config = parsed() as GroupedConfig
    assert.deepEqual(Object.keys(config.apps), ['admin', 'api'])
    assert.deepEqual(config.apps.api?.map, {})
    assert.deepEqual(config.shared, ['packages/common/**'])
  })

  test('两种写法混用是配置错误；outside、allow 写进应用里也是', () => {
    assert.match(problems({ ...APPS, roots: ['src/modules'] }), /写了 "apps"（按应用分组），外面一层就只能有 apps、shared、outside、allow："roots" 要写进各个应用里，两种写法不能混用/)
    assert.match(problems({ ...APPS, entry: ['index.ts'] }), /"entry" 要写进各个应用里/)
    assert.match(problems(grouped(c => (c.apps.admin as any).outside = ['x/**'])), /"apps\.admin\.outside" 要写在外面一层/)
    assert.match(problems(grouped(c => (c.apps.admin as any).legacy = 1)), /"apps\.admin" 有未知字段 "legacy"/)
  })

  test('应用的字段照单应用的规矩校验，报错里写明是哪个应用', () => {
    assert.match(problems(grouped(c => delete (c.apps.api as any).entry)), /缺少 "apps\.api\.entry"/)
    assert.match(problems(grouped(c => (c.apps.api.roots = ['services/*']))), /apps\.api\.roots 里的 "services\/\*" 要写仓库里的目录/)
    assert.match(problems(grouped(c => (c.apps.admin.map = { 'x/**': 'a/b' }))), /apps\.admin\.map 里 "x\/\*\*" 的值要写模块名/)
  })

  test('apps 要写成至少一个应用的对象；应用名不能带 /', () => {
    assert.match(problems({ apps: [] }), /"apps" 应该是"应用名 → 这个应用的 roots、shared、app、entry、map"的对象/)
    assert.match(problems({ apps: {} }), /"apps" 里至少要有一个应用/)
    assert.match(problems({ apps: { web: 1 } }), /"apps\.web" 应该是这个应用的 roots、shared、app、entry、map、database/)
    assert.match(problems({ apps: { 'a/b': APPS.apps.api } }), /应用名 "a\/b" 要写成一段名字/)
  })

  test('模块根目录在不同应用之间也不能嵌套、不能是同一个', () => {
    assert.match(problems(grouped(c => (c.apps.api.roots = ['apps/admin/src/features/x']))), /roots 重叠：apps\.api\.roots 的 "apps\/admin\/src\/features\/x" 在 apps\.admin\.roots 的 "apps\/admin\/src\/features" 里面/)
    assert.match(problems(grouped(c => (c.apps.api.roots = ['apps/admin/src/features']))), /roots 重叠：apps\.admin\.roots 的 "apps\/admin\/src\/features" 和 apps\.api\.roots 的 "apps\/admin\/src\/features" 是同一个目录/)
  })
})

describe('按应用分组的划分', () => {
  test('文件归哪个应用；模块名写成 应用名/模块名；外面一层的 shared 是几个应用共用的', () => {
    const l = layout()
    assert.deepEqual(l.owner('apps/admin/src/features/courses/list.ts'), { kind: 'module', name: 'courses', mapped: false, app: 'admin' })
    assert.deepEqual(l.owner('apps/admin/src/pages/courses/page.ts'), { kind: 'module', name: 'courses', mapped: true, app: 'admin' })
    assert.deepEqual(l.owner('services/api/src/shared/db.ts'), { kind: 'shared', app: 'api' })
    assert.deepEqual(l.owner('services/api/src/server.ts'), { kind: 'app', app: 'api' })
    assert.deepEqual(l.owner('packages/common/money.ts'), { kind: 'common' })
    assert.deepEqual(l.owner('services/api/src/modules/stray.ts'), { kind: 'none', root: 'services/api/src/modules', app: 'api' })
    assert.deepEqual(
      l.modules.map(module => module.id),
      ['admin/courses', 'admin/orders', 'api/courses', 'api/orders'],
    )
    assert.equal(l.isEntry('services/api/src/modules/courses/index.ts', 'api/courses'), true)
  })

  test('两个应用有同名模块不报错；同一个应用里两个根目录下有同名模块报错', () => {
    layout()
    const same = grouped(c => (c.apps.api.roots = ['services/api/src/modules', 'services/api/src/more']))
    const l = new Layout(parsed(same), [...FILES, 'services/api/src/more/courses/index.ts'])
    assert.deepEqual(l.problems, ['模块名重复：services/api/src/modules/courses 和 services/api/src/more/courses 都叫 api/courses（模块按目录名认，要改个名字）'])
  })

  test('map 只能指向本应用的模块', () => {
    const other = grouped(c => (c.apps.api.map = { 'apps/admin/src/pages/orders/**': 'refunds' }))
    const l = new Layout(parsed(other), FILES)
    assert.match(l.problems.join('\n'), /apps\.api\.map 里 "apps\/admin\/src\/pages\/orders\/\*\*" 指向的模块 api\/refunds 不存在/)
  })

  test('路径重叠：不同应用之间、应用和外面一层的 shared 之间都算不同的项', () => {
    const across = new Layout(parsed(grouped(c => c.apps.api.shared.push('apps/admin/src/components/**'))), FILES)
    assert.match(across.problems.join('\n'), /路径重叠：apps\.admin\.shared 的 "apps\/admin\/src\/components\/\*\*" 和 apps\.api\.shared 的 "apps\/admin\/src\/components\/\*\*" 都包含 apps\/admin\/src\/components\/button\.ts/)
    const common = new Layout(parsed(grouped(c => c.shared.push('services/api/src/shared/**'))), FILES)
    assert.match(common.problems.join('\n'), /路径重叠：apps\.api\.shared 的 "services\/api\/src\/shared\/\*\*" 和 shared 的 "services\/api\/src\/shared\/\*\*" 都包含 services\/api\/src\/shared\/db\.ts/)
    // 一个应用的 app 点名了另一个应用模块根目录下的文件：不算点名，照样重叠
    const named = new Layout(parsed(grouped(c => c.apps.admin.app.push('services/api/src/modules/__init__.py'))), [...FILES, 'services/api/src/modules/__init__.py'])
    assert.match(named.problems.join('\n'), /apps\.api\.roots 的 "services\/api\/src\/modules" 和 apps\.admin\.app 的 "services\/api\/src\/modules\/__init__\.py"/)
  })
})

describe('按应用算的规则', () => {
  test('应用之间引用代码报 R3：引用对方的模块、共享层、装配层都算，改法是放进外面一层的 shared', () => {
    const l = layout()
    const vs = importViolations(
      l,
      facts(
        imp('apps/admin/src/features/courses/list.ts', 'services/api/src/modules/courses/index.ts'),
        imp('apps/admin/src/main.ts', 'services/api/src/shared/db.ts'),
        imp('apps/admin/src/components/button.ts', 'services/api/src/server.ts'),
      ),
    )
    assert.deepEqual(vs.map(v => v.rule), ['R3', 'R3', 'R3'])
    assert.match(vs[0]?.where[0] as string, /apps\/admin\/src\/features\/courses\/list\.ts:\d+（admin\/courses 模块）import 了 api\/courses 模块 services\/api\/src\/modules\/courses\/index\.ts/)
    assert.match(vs[1]?.where[0] as string, /（admin 应用的装配层）import 了 api 应用的共享层/)
    assert.match(vs[2]?.where[0] as string, /（admin 应用的共享层）import 了 api 应用的装配层/)
    assert.match(vs[0]?.fix as string, /应用之间不能引用代码。要共用的代码放进外面一层的 shared/)
  })

  test('外面一层的 shared：每个应用都能引用；它反过来引用任何应用的代码报 R3', () => {
    const l = layout()
    assert.deepEqual(keys(l, imp('apps/admin/src/features/courses/list.ts', 'packages/common/money.ts'), imp('services/api/src/shared/db.ts', 'packages/common/money.ts')), [])
    const vs = importViolations(l, facts(imp('packages/common/money.ts', 'services/api/src/shared/db.ts'), imp('packages/common/money.ts', 'scripts/seed.ts')))
    assert.deepEqual(vs.map(v => v.key), ['R3 packages/common/money.ts → services/api/src/shared/db.ts', 'R3 packages/common/money.ts → scripts/seed.ts'])
    assert.match(vs[0]?.where[0] as string, /（外面一层的共享层）import 了 api 应用的共享层/)
    assert.match(vs[0]?.fix as string, /外面一层的共享层是几个应用共用的，不能引用任何应用的代码/)
  })

  test('R1 只在同一个应用里算：绕过同应用模块的入口报 R1，改法写 应用名/模块名', () => {
    const l = layout()
    const [v] = importViolations(l, facts(imp('services/api/src/modules/orders/index.ts', 'services/api/src/modules/courses/repo.ts')))
    assert.equal(v?.key, 'R1 services/api/src/modules/orders/index.ts → services/api/src/modules/courses/repo.ts')
    assert.match(v?.where[0] as string, /（api\/orders 模块）import 了 api\/courses 模块的内部文件/)
    assert.match(v?.fix as string, /改成从 api\/courses 的入口 services\/api\/src\/modules\/courses\/index\.ts 引用/)
    // 应用里的同名模块是两个模块：admin/courses 引用 api/courses 的内部文件是 R3，不是 R1
    assert.deepEqual(keys(l, imp('apps/admin/src/features/courses/list.ts', 'services/api/src/modules/courses/repo.ts')), ['R3 apps/admin/src/features/courses/list.ts → services/api/src/modules/courses/repo.ts'])
  })

  test('成环按应用各算：两个应用各有一个环各报一次；跨应用的引用不连成环', () => {
    const l = layout()
    const vs = importViolations(
      l,
      facts(
        imp('apps/admin/src/features/courses/index.ts', 'apps/admin/src/features/orders/index.ts'),
        imp('apps/admin/src/features/orders/index.ts', 'apps/admin/src/features/courses/index.ts'),
        imp('services/api/src/modules/courses/index.ts', 'services/api/src/modules/orders/index.ts'),
        imp('services/api/src/modules/orders/index.ts', 'services/api/src/modules/courses/index.ts'),
      ),
    ).filter(v => v.rule === 'R2')
    assert.deepEqual(vs.map(v => [v.key, v.where[0]]), [
      ['R2 admin/courses admin/orders', 'admin/courses → admin/orders → admin/courses'],
      ['R2 api/courses api/orders', 'api/courses → api/orders → api/courses'],
    ])
    // admin/courses → api/orders → api/courses …… 跨应用的那一步是 R3，不算环的边
    const across = keys(
      l,
      imp('apps/admin/src/features/courses/index.ts', 'services/api/src/modules/orders/index.ts'),
      imp('services/api/src/modules/orders/index.ts', 'apps/admin/src/features/courses/index.ts'),
    )
    assert.deepEqual(across.filter(key => key.startsWith('R2')), [])
  })

  test('R4 和入口新增导出只看同一个应用；写成 应用名/模块名', () => {
    const l = layout()
    const changes = (value: Partial<ChangeFacts>): ChangeFacts => ({ imports: [], calls: [], declarations: [], edgesTruncated: false, truncated: false, incomplete: [], unmapped: [], ...value })
    const declaration = { path: 'services/api/src/modules/courses/repo.ts', declaration: 'find', line: 2, exported: true }
    const call = { from: 'services/api/src/modules/orders/index.ts', line: 5, to: declaration.path, declaration: 'find', exported: true }
    const hints = behaviorHints(l, changes({ declarations: [declaration], calls: [call, { ...call, from: 'apps/admin/src/features/courses/list.ts' }] }))
    assert.deepEqual(hints.map(hint => hint.where), ['api/courses 模块的 find（services/api/src/modules/courses/repo.ts:2）这次改了实现，api/orders 模块在 services/api/src/modules/orders/index.ts:5 新增了对它的调用'])
    const exports = entryExports(l, changes({ imports: [{ from: 'services/api/src/modules/courses/index.ts', to: 'services/api/src/modules/courses/repo.ts', line: 1, change: 'ADDED' }] }))
    assert.deepEqual(exports.map(hint => hint.where), ['api/courses 的入口 services/api/src/modules/courses/index.ts:1 新增引用 services/api/src/modules/courses/repo.ts'])
  })

  test('R5 按应用说：知道在哪个应用的只说那个应用，不知道的列出每个应用和外面一层的共享层', () => {
    const files = [...FILES, 'services/api/src/modules/stray.ts', 'apps/admin/src/legacy.ts']
    const vs = unownedFiles(layout(APPS, files), files)
    assert.deepEqual(vs.map(v => v.key), ['R5 apps/admin/src/legacy.ts', 'R5 services/api/src/modules/stray.ts'])
    assert.equal(
      vs[0]?.fix,
      '放进它所在应用的模块、共享层或装配层：admin 应用的某个模块（apps/admin/src/features/<模块名>/）、共享层（apps/admin/src/components/**）、装配层（apps/admin/src/main.ts）；api 应用的某个模块（services/api/src/modules/<模块名>/）、共享层（services/api/src/shared/**）、装配层（services/api/src/server.ts）。几个应用共用的放进外面一层的共享层（packages/common/**）。',
    )
    assert.equal(vs[1]?.where[0], 'services/api/src/modules/stray.ts 直接放在 api 应用的模块根目录 services/api/src/modules 下，没有归属（模块是根目录下的子目录）')
    assert.match(vs[1]?.fix as string, /^放进 api 应用的某个模块（services\/api\/src\/modules\/<模块名>\/）.*在 apps\.api\.app 里写到这个文件（"services\/api\/src\/modules\/stray\.ts"，不用通配），它就归装配层。$/)
  })
})

/** 各项给用户看的文字。 */
const texts = (before: Config | undefined, now: ConfigSide): string[] => looseningItems(before, now).map(item => item.text)

describe('放宽项（有几个应用时）', () => {
  const items = (change: (config: Record<string, any>) => void, before: Record<string, unknown> = APPS): string[] =>
    texts(parsed(before), { config: parsed(grouped(change)), hasDir: true })

  test('配置没变：没有放宽项', () => {
    assert.deepEqual(
      items(() => {}),
      [],
    )
  })

  test('每个应用和分叉点上同名的应用比，项里写明是哪个应用', () => {
    assert.deepEqual(
      items(c => {
        c.apps.admin.shared.push('apps/admin/src/hooks/**')
        c.apps.api.roots = []
        c.apps.api.entry.push('main.ts')
        c.apps.api.map = { 'services/api/src/routes/**': 'courses' }
      }),
      [
        'apps.api.roots 删掉了模块根目录 "services/api/src/modules"',
        'apps.admin.shared 扩大：新增 "apps/admin/src/hooks/**"',
        'apps.api.map 新增："services/api/src/routes/**" 归到 courses 模块',
        'apps.api.entry 新增入口文件名 "main.ts"',
      ],
    )
    // 收紧：缩小共享层、新增模块根目录
    assert.deepEqual(
      items(c => {
        c.apps.admin.shared = ['apps/admin/src/components/ui/**']
        c.apps.api.roots.push('services/api/src/more')
      }),
      [],
    )
  })

  test('新加一个应用：roots 是收紧，shared、app、map、entry 按扩大算', () => {
    assert.deepEqual(
      items(c => {
        c.apps.mini = { roots: ['miniprogram/modules'], shared: ['miniprogram/utils/**'], app: ['miniprogram/app.ts'], entry: ['index.ts'], map: { 'miniprogram/pages/courses/**': 'courses' } }
      }),
      [
        'apps.mini.shared 扩大：新增 "miniprogram/utils/**"',
        'apps.mini.app 扩大：新增 "miniprogram/app.ts"',
        'apps.mini.map 新增："miniprogram/pages/courses/**" 归到 courses 模块',
        'apps.mini.entry 新增入口文件名 "index.ts"',
      ],
    )
    assert.deepEqual(
      items(c => {
        c.apps.mini = { roots: ['miniprogram/modules'], entry: [] }
      }),
      [],
    )
  })

  test('删掉应用、给应用改名：按删掉它的 roots 算（改名后的新应用按新加的算）', () => {
    assert.deepEqual(
      items(c => {
        delete c.apps.api
      }),
      ['删掉了应用 api（改名也算删掉）：apps.api.roots 的模块根目录 "services/api/src/modules" 不再管'],
    )
    assert.deepEqual(
      items(c => {
        c.apps.server = c.apps.api
        delete c.apps.api
      }),
      [
        '删掉了应用 api（改名也算删掉）：apps.api.roots 的模块根目录 "services/api/src/modules" 不再管',
        'apps.server.shared 扩大：新增 "services/api/src/shared/**"',
        'apps.server.app 扩大：新增 "services/api/src/server.ts"',
        'apps.server.entry 新增入口文件名 "index.ts"',
      ],
    )
  })

  test('外面一层的 shared、outside、allow 和单应用时一样比', () => {
    assert.deepEqual(
      items(c => {
        c.shared.push('packages/ui/**')
        c.outside.push('infra/**')
        c.allow.push({ rule: 'R3', from: 'apps/admin/src/main.ts', to: 'services/api/src/server.ts', reason: '待拆' })
      }),
      ['shared 扩大：新增 "packages/ui/**"', 'outside 扩大：新增 "infra/**"', 'allow 新增例外：R3 apps/admin/src/main.ts → services/api/src/server.ts，理由：待拆'],
    )
    assert.deepEqual(
      items(c => {
        c.shared = []
      }),
      [],
    )
  })

  test('两种写法之间切换：整份配置算一项，两个方向都是', () => {
    const single = { roots: ['src/modules'], shared: [], app: [], entry: ['index.ts'], map: {}, outside: [], allow: [] }
    const toGrouped = texts(parsed(single), { config: parsed({ apps: { web: { roots: ['src/modules'], entry: ['index.ts'] } } }), hasDir: true })
    assert.deepEqual(toGrouped, [
      '配置从单应用的写法换成了按应用分组的写法，和首次接入一样，整份配置：{"apps":{"web":{"roots":["src/modules"],"shared":[],"app":[],"entry":["index.ts"],"map":{}}},"shared":[],"outside":[],"allow":[]}',
    ])
    const toSingle = texts(parsed(), { config: parsed(single), hasDir: true })
    assert.equal(toSingle.length, 1)
    assert.match(toSingle[0] as string, /^配置从按应用分组的写法换成了单应用的写法，和首次接入一样，整份配置：\{"roots":\["src\/modules"\]/)
  })
})

/** 两个应用的仓库，提交到 main，切到 feature 分支：admin（管理后台）和 api（后端），都有 courses 模块。 */
function appsRepo(): string {
  const repo = join(tempDir('modwall-apps-'), 'repo')
  write(repo, '.modwall/config.json', JSON.stringify(APPS, null, 2))
  // 钩子只管接入了 testpace 的仓库
  write(repo, 'testpace.json', '{"fast":"node -e 0","files":"node --test","full":"node -e 0","tests":["tests/**/*.test.ts"]}\n')
  write(repo, 'apps/admin/src/main.ts', "import { list } from './features/courses/index.ts'\n\nexport const start = list\n")
  write(repo, 'apps/admin/src/components/button.ts', "import { round } from '../../../../packages/common/money.ts'\n\nexport const size = round(1)\n")
  write(repo, 'apps/admin/src/features/courses/index.ts', "export { list } from './list.ts'\n")
  write(repo, 'apps/admin/src/features/courses/list.ts', 'export function list(): string[] {\n  return []\n}\n')
  write(repo, 'apps/admin/src/features/courses/MODULE.md', '管理后台的课程列表。不管下单。\n')
  write(repo, 'apps/admin/src/pages/courses/page.ts', "import { list } from '../../features/courses/list.ts'\n\nexport const page = list\n")
  write(repo, 'services/api/src/server.ts', "import { find } from './modules/courses/index.ts'\n\nexport const serve = find\n")
  write(repo, 'services/api/src/shared/db.ts', 'export const db = 1\n')
  write(repo, 'services/api/src/modules/courses/index.ts', "export { find } from './repo.ts'\n")
  write(repo, 'services/api/src/modules/courses/repo.ts', "import { db } from '../../shared/db.ts'\n\nexport function find(): number {\n  return db\n}\n")
  write(repo, 'services/api/src/modules/courses/MODULE.md', '后端的课程数据。不管页面。\n')
  write(repo, 'packages/common/money.ts', 'export function round(n: number): number {\n  return Math.round(n)\n}\n')
  write(repo, 'scripts/seed.ts', "import { find } from '../services/api/src/modules/courses/repo.ts'\n\nexport const seed = find\n")
  sh(repo, 'git init -q -b main && git add -A && git commit -qm init && git checkout -qb feature')
  return repo
}

describe('modwall check、status 和钩子（有几个应用时）', () => {
  test('两个应用各有 courses 模块、互不引用：通过；status 按应用分组列模块', () => {
    const repo = appsRepo()
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    const status = modwall(repo, ['status']).out
    assert.match(status, /模块（2 个，按应用分）：\n {2}admin 应用（1 个）：\n {4}admin\/courses（apps\/admin\/src\/features\/courses）入口：apps\/admin\/src\/features\/courses\/index\.ts\n {2}api 应用（1 个）：\n {4}api\/courses（services\/api\/src\/modules\/courses）入口：services\/api\/src\/modules\/courses\/index\.ts/)
  })

  test('应用之间互相引用：用真的 layermap 报 R3', () => {
    const repo = appsRepo()
    write(repo, 'apps/admin/src/features/courses/list.ts', "import { find } from '../../../../../services/api/src/modules/courses/index.ts'\n\nexport function list(): number[] {\n  return [find()]\n}\n")
    write(repo, 'services/api/src/shared/db.ts', "import { size } from '../../../../apps/admin/src/components/button.ts'\n\nexport const db = size\n")
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /R3 依赖方向反了（2 处）/)
    assert.match(r.out, /✗ apps\/admin\/src\/features\/courses\/list\.ts:1（admin\/courses 模块）import 了 api\/courses 模块 services\/api\/src\/modules\/courses\/index\.ts/)
    assert.match(r.out, /✗ services\/api\/src\/shared\/db\.ts:1（api 应用的共享层）import 了 admin 应用的共享层 apps\/admin\/src\/components\/button\.ts/)
    assert.match(r.out, /改法：应用之间不能引用代码。要共用的代码放进外面一层的 shared/)
    assert.doesNotMatch(r.out, /R1|R2/)
  })

  test('会话开始按应用分组列模块；改文件之前的 R5 说明和改法按应用说', () => {
    const repo = appsRepo()
    const text = hook(repo, 'SessionStart')?.hookSpecificOutput.additionalContext as string
    assert.match(text, /这个仓库有 2 个应用（admin、api），每个应用各有一套模块/)
    assert.match(text, /几个应用共用的代码放进外面一层的共享层（packages\/common\/\*\*）/)
    assert.match(text, /模块（2 个，按应用分）：\nadmin 应用（1 个）：\n- admin\/courses（apps\/admin\/src\/features\/courses）：管理后台的课程列表。不管下单。\napi 应用（1 个）：\n- api\/courses（services\/api\/src\/modules\/courses）：后端的课程数据。不管页面。/)

    const edit = (path: string): string | undefined =>
      hook(repo, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: join(repo, path) } })?.hookSpecificOutput.permissionDecisionReason
    assert.match(edit('services/api/src/modules/helper.ts') as string, /直接放在 api 应用的模块根目录 services\/api\/src\/modules 下.*放进 api 应用的某个模块.*在 apps\.api\.app 里写到这个文件/)
    assert.match(edit('apps/admin/src/legacy.ts') as string, /没有归属。代码文件要放进它所在应用的模块、共享层或装配层：admin 应用的.*；api 应用的.*新功能默认在所在应用的模块根目录下新建一个模块目录/)
    assert.equal(edit('services/api/src/modules/orders/index.ts'), undefined)
    assert.equal(edit('packages/common/date.ts'), undefined)
  })

  test('单应用的写法换成按应用分组：整份配置要用户确认一次', () => {
    const repo = join(tempDir('modwall-apps-'), 'repo')
    write(repo, '.modwall/config.json', JSON.stringify({ roots: ['services/api/src/modules'], entry: ['index.ts'] }))
    write(repo, 'services/api/src/modules/courses/index.ts', 'export const find = 1\n')
    sh(repo, 'git init -q -b main && git add -A && git commit -qm init && git checkout -qb feature')
    writeFileSync(join(repo, '.modwall/config.json'), JSON.stringify({ apps: { api: { roots: ['services/api/src/modules'], entry: ['index.ts'] } } }))
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /放宽规则 1 项（和分叉点上的配置比），要用户同意/)
    assert.match(r.out, /\n1\. 配置从单应用的写法换成了按应用分组的写法/)
  })
})

describe('modwall init（有几个应用时）', () => {
  test('模块根目录分属几个应用目录：按应用分组起草，应用名取应用目录名；认不出来的应用目录（不是工作区包的小程序）列为没有归属', () => {
    // 常见的多应用仓库：pnpm 工作区里有仓库根目录、apps/*、services/*；小程序不是工作区包，project.config.json 不读
    const repo = join(tempDir('modwall-init-'), 'repo')
    write(repo, 'pnpm-workspace.yaml', "packages:\n  - .\n  - 'apps/*'\n  - services/*\n\nallowBuilds:\n  esbuild: true\n")
    write(repo, 'package.json', '{"name":"root","private":true}\n')
    write(repo, 'project.config.json', '{"miniprogramRoot":"miniprogram/","compileType":"miniprogram"}\n')
    write(repo, 'apps/admin-web/package.json', '{"name":"admin"}\n')
    write(repo, 'services/api/package.json', '{"name":"api"}\n')
    for (const path of [
      'apps/admin-web/src/main.tsx',
      'apps/admin-web/vite.config.ts',
      'apps/admin-web/src/features/courses/index.ts',
      'apps/admin-web/src/shared/http.ts',
      'services/api/src/app.ts',
      'services/api/src/modules/courses/index.ts',
      'services/api/src/modules/orders/index.ts',
      'miniprogram/modules/courses/index.ts',
      'miniprogram/app.ts',
      'scripts/contracts.mjs',
      'eslint.config.mjs',
    ]) {
      write(repo, path, 'export const x = 1\n')
    }
    sh(repo, 'git init -q -b main && git add -A && git commit -qm init')
    const r = modwall(repo, ['init'])
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(JSON.parse(readFileSync(join(repo, '.modwall/config.json'), 'utf8')), {
      apps: {
        'admin-web': {
          roots: ['apps/admin-web/src/features'],
          shared: ['apps/admin-web/src/shared/**'],
          app: ['apps/admin-web/src/main.tsx'],
          entry: ['index.ts', 'index.tsx', 'index.js', '__init__.py'],
          map: {},
        },
        api: { roots: ['services/api/src/modules'], shared: [], app: ['services/api/src/app.ts'], entry: ['index.ts', 'index.tsx', 'index.js', '__init__.py'], map: {} },
      },
      shared: [],
      outside: ['eslint.config.mjs', 'scripts/**', 'apps/admin-web/vite.config.ts'],
      allow: [],
    })
    // 认不出来的应用目录不起草：它下面的代码列为没有归属，由接入的 agent 手动补一组应用配置
    assert.match(r.out, /还有 2 个代码文件没有归属（R5）.*\n {2}· miniprogram\/app\.ts 没有归属\n {2}· miniprogram\/modules\/courses\/index\.ts 没有归属/)
    assert.doesNotMatch(r.out, /配置有问题/)
  })

  test('只有一个应用目录里有模块根目录：照单应用起草', () => {
    const repo = join(tempDir('modwall-init-'), 'repo')
    for (const path of ['src/modules/booking/index.ts', 'apps/web/src/features/home/index.ts']) write(repo, path, 'export const x = 1\n')
    sh(repo, 'git init -q -b main && git add -A && git commit -qm init')
    assert.equal(modwall(repo, ['init']).code, 0)
    const config = JSON.parse(readFileSync(join(repo, '.modwall/config.json'), 'utf8'))
    assert.equal(config.apps, undefined)
    assert.deepEqual(config.roots, ['src/modules'])
  })
})
