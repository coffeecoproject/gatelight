// 规则：哪些关系算越界、怎么改。事实来自 layermap.ts（import、这次改动增删的关系）和 layout.ts（每个文件归谁）。
//   R1 绕过入口    别的模块、装配层 import 了 B 入口以外的文件（只管 TS/JS 和 Python）       拦
//   R2 循环        模块之间有回环                                                         拦
//   R3 方向反了    共享层引用模块或装配层；模块引用装配层；被管的代码引用 outside 或测试文件；  拦
//                  一个应用引用另一个应用的代码；外面一层的共享层引用任何应用的代码
//   R4 改已有行为  改了 B 已有导出函数的实现，A 在这次改动里新增了对它的调用；                只提示
//                  这次新建了模块，同时改了已有模块里已有的声明、在它的新迁移里改删已有的对象
//   R5 没有归属    代码文件不在模块、共享层、装配层、映射和 outside 里                       拦
//   R6 数据库越界  迁移文件那部分在 database.ts，库里的现状在 dbcheck.ts                       拦
// R1、R2、R3、R5、R6 看项目当前的全部代码；R4 和"入口新增导出"看这次改动（和分叉点比）。
// 有几个应用时，R1、R2、R4 和"入口新增导出"只看同一个应用里的模块；应用之间的引用都是 R3。
// import 非代码文件（样式、图片、JSON）：LayerMap 对不上，写相对路径、指向项目里存在的文件的，由 withAssets 算出目标，照 R1、R2、R3 判。
// 小程序的 .json（usingComponents）、.wxml、.wxss 里的引用由 miniprogram.ts 读出来，也照 R1、R2、R3 判：
// 组件的入口是模块目录下第一层的 components/ 里的组件；模板、样式不能经入口导出。
// R2 的环把数据库里模块之间的引用（database.ts 给的边）和代码的 import 一起算。

import { type App, type ExceptionRule, field, moduleId, type Scheme } from './config.ts'
import { posix } from 'node:path'
import { inEntryLanguage, isCode, isStylesheet, UNREAD_DIRECTORIES } from './files.ts'
import type { ChangeFacts, ProjectImports } from './layermap.ts'
import { label, type Layout, type Module, type Owner } from './layout.ts'

export type Rule = 'R1' | 'R2' | 'R3' | 'R5' | 'R6'

/** 拦截的规则，输出按这个顺序。 */
export const BLOCKING_RULES: readonly Rule[] = ['R1', 'R2', 'R3', 'R5', 'R6']

export const RULE_NAMES: Record<Rule | 'R4', string> = {
  R1: '绕过入口',
  R2: '模块之间成环',
  R3: '依赖方向反了',
  R4: '为新功能改了别人的已有行为',
  R5: '文件没有归属',
  R6: '数据库越界',
}

export interface Violation {
  rule: Rule
  /** 认这一处的键（不含行号，行号会挪）：日志里比上一次的越界这次改正了没有。 */
  key: string
  /** 哪里越界：第一行是概括，后面是细节。 */
  where: string[]
  fix: string
}

export interface Hint {
  where: string
  fix?: string
}

const site = (fact: { from: string; line: number }): string => `${fact.from}:${fact.line}`

function allowed(scheme: Scheme, rule: ExceptionRule, from: string, to: string): boolean {
  return scheme.allow.some(entry => entry.rule === rule && entry.from === from && entry.to === to)
}

const MOVE = '把那段代码搬到该在的地方：只有一个模块用的搬回那个模块，真正通用的搬进共享层'

/** 属于某个应用的代码（模块、共享层、装配层）：给出应用名，单应用时是 undefined。 */
const appCode = (owner: Owner): { app: string | undefined } | undefined =>
  owner.kind === 'module' || owner.kind === 'shared' || owner.kind === 'app' ? { app: owner.app } : undefined

/** R2 的一条边：同一个应用里模块到模块的一处引用（代码的 import，或数据库里经入口的引用）。 */
export interface Edge {
  from: string
  to: string
  /** 文件:行 */
  site: string
  /** 引用了什么，比如 import 了 src/b/index.ts。 */
  what: string
}

/**
 * import 非代码文件：LayerMap 记成 SYMBOL_NOT_RESOLVED。写的是相对路径、又指向项目里存在的非代码文件的，算出目标，
 * 从"没对上"挪进 imports，照 R1、R2、R3 判。路径后面的 ?query、#hash（打包工具的写法）去掉再找。
 */
export function withAssets(facts: ProjectImports, files: readonly string[]): ProjectImports {
  const present = new Set(files)
  const imports = [...facts.imports]
  const unresolved = facts.unresolved.filter(fact => {
    if (fact.reason !== 'SYMBOL_NOT_RESOLVED' || !/^\.\.?\//.test(fact.specifier)) return true
    const to = posix.normalize(posix.join(posix.dirname(fact.from), fact.specifier.replace(/[?#].*$/, '')))
    if (to.startsWith('../') || isCode(to) || !present.has(to)) return true
    imports.push({ from: fact.from, line: fact.line, to, specifier: fact.specifier })
    return false
  })
  return { imports, unresolved }
}

/** R1、R2、R3：看项目现有的全部 import。dbEdges：数据库里模块之间的引用，和 import 一起算环。 */
export function importViolations(layout: Layout, facts: ProjectImports, dbEdges: readonly Edge[] = []): Violation[] {
  const { scheme } = layout
  const r1: Violation[] = []
  const r3: Violation[] = []
  const edges: Edge[] = []
  for (const fact of facts.imports) {
    const from = layout.owner(fact.from)
    const to = layout.owner(fact.to)
    // outside 和没有归属的文件不查（后者是 R5）；测试文件不在事实里
    if (from.kind === 'outside' || from.kind === 'none' || from.kind === 'test') continue

    // R3：方向反了
    let r3Text: string | undefined
    let r3Fix = `${MOVE}。`
    if (to.kind === 'outside') {
      r3Text = 'outside 里的文件（不归 modwall 管的路径）'
      r3Fix = '正式代码要用的东西不放在 outside 里：搬进共享层，或者搬进用它的那个模块。'
    } else if (to.kind === 'test') {
      r3Text = '测试文件'
      r3Fix = '正式代码要用的东西不放在测试目录里：搬进共享层，或者搬进用它的那个模块。'
    } else if (appCode(from) && appCode(to) && appCode(from)?.app !== appCode(to)?.app) {
      r3Text = label(to)
      r3Fix = '应用之间不能引用代码。要共用的代码放进外面一层的 shared（几个应用共用的共享层）；应用之间通过接口（HTTP、生成的契约副本）打交道。'
    } else if (from.kind === 'common' && appCode(to)) {
      r3Text = label(to)
      r3Fix = `外面一层的共享层是几个应用共用的，不能引用任何应用的代码。把那段代码搬到该在的地方：只有一个应用用的搬回那个应用，真正通用的留在外面一层的共享层；要用应用里的东西，通过参数传进来。`
    } else if (from.kind === 'shared' && (to.kind === 'module' || to.kind === 'app')) {
      r3Text = label(to)
      r3Fix = `共享层只放真正通用的东西，不能引用模块和装配层。${MOVE}；共享层要用的东西，通过参数传进来。`
    } else if (from.kind === 'module' && to.kind === 'app') {
      r3Text = label(to)
      r3Fix = `模块不能引用装配层。${MOVE}；要装配层组装好的东西，由装配层通过参数传进来。`
    }
    if (r3Text !== undefined && to.kind === 'app' && to.root && fact.to.endsWith('/__init__.py')) {
      // 模块根目录的 __init__.py 归了装配层：从包名引模块的两种写法会被记成引用了它
      const pkg = to.root.split('/').join('.')
      r3Fix += `如果引的其实是别的模块：\`from ${pkg} import 模块名\` 和 \`from .. import 模块名\` 会被记成同时引用了 ${fact.to}，写成 \`from ${pkg}.模块名 import …\` 或 \`from ..模块名 import …\`。`
    }
    if (r3Text !== undefined) {
      if (!allowed(scheme, 'R3', fact.from, fact.to)) {
        r3.push({
          rule: 'R3',
          key: `R3 ${fact.from} → ${fact.to}`,
          where: [`${site(fact)}（${label(from)}）import 了 ${r3Text} ${fact.to}`],
          fix: r3Fix,
        })
      }
      continue
    }

    // 走到这里，引用的是同一个应用里的代码（或外面一层的共享层）
    if (to.kind !== 'module') continue
    const target = moduleId(to.app, to.name)
    const fromModule = from.kind === 'module' ? moduleId(from.app, from.name) : undefined
    if (fromModule === target) continue

    // R1：别的模块、装配层只能走 B 的入口
    const kind = entryKind(fact)
    const module = layout.module(target)
    const dir = module?.dir ?? target
    const viaEntry = kind === 'component' ? isPublicComponent(dir, fact.to) : (kind === 'code' || kind === 'asset') && layout.isEntry(fact.to, target)
    if ((from.kind === 'module' || from.kind === 'app') && kind !== undefined && !viaEntry && !allowed(scheme, 'R1', fact.from, fact.to)) {
      const entries = module?.entries ?? []
      const components = `${target} 对外的组件（${dir}/components/ 下第一层的组件）`
      const fix =
        kind === 'style'
          ? `样式不能经入口导出：几个模块都用的样式，搬进共享层；只该 ${target} 用的，改成用 ${target} 入口导出的组件。`
          : kind === 'template'
            ? `小程序的模板、样式不能经入口导出：几个模块都用的，搬进共享层；只该 ${target} 用的，改成用 ${components}。`
            : kind === 'component'
              ? `改成用 ${components}；这个组件该给别的模块用，就挪进 ${dir}/components/（作为单独的一小步）；几个模块都用的通用组件搬进共享层。`
              : entries.length
                ? `改成从 ${target} 的入口 ${entries.join(' 或 ')} 引用；入口里没有，就在入口新增导出（作为单独的一小步）。`
                : `${target} 还没有入口：在 ${dir}/ 下新建入口文件（${(layout.app(to.app)?.entry ?? []).join('、')} 之一），导出要用的东西，再从入口引用。`
      r1.push({
        rule: 'R1',
        key: `R1 ${fact.from} → ${fact.to}`,
        where: [`${site(fact)}（${label(from)}）${kind === 'component' ? '用了' : 'import 了'} ${target} 模块的内部文件 ${fact.to}`],
        fix,
      })
    }

    // R2 的边：同一个应用里模块到模块（应用之间的引用是 R3，不进来），所以环按应用各算
    if (fromModule !== undefined && !allowed(scheme, 'R2', fact.from, fact.to)) {
      edges.push({ from: fromModule, to: target, site: site(fact), what: `import 了 ${fact.to}` })
    }
  }
  return [...r1, ...cycles([...edges, ...dbEdges]), ...r3]
}

type EntryKind = 'code' | 'asset' | 'style' | 'component' | 'template'

/**
 * R1 怎么判这条引用：TS/JS、Python 引用代码（code）、非代码文件（asset，样式是 style）按入口文件判；
 * 小程序 .json 引用组件（component）按 components/ 判；.wxml、.wxss 引用模板、样式（template）不能经入口导出。
 * Go、Java 第一版不管（undefined）。
 */
function entryKind(fact: { from: string; to: string }): EntryKind | undefined {
  if (fact.from.endsWith('.json')) return 'component'
  if (fact.from.endsWith('.wxml') || fact.from.endsWith('.wxss')) return 'template'
  if (!inEntryLanguage(fact.from)) return undefined
  if (inEntryLanguage(fact.to)) return 'code'
  if (isCode(fact.to)) return undefined
  return isStylesheet(fact.to) ? 'style' : 'asset'
}

/** 小程序组件在模块目录下第一层的 components/ 里（components/<组件>/<文件>）：模块对外的组件。 */
function isPublicComponent(dir: string, path: string): boolean {
  const prefix = `${dir}/components/`
  return path.startsWith(prefix) && path.slice(prefix.length).split('/').length === 2
}

/** R2：模块之间的回环。每个强连通的模块组报一次，给出一条环和环上每一步的引用。 */
function cycles(list: readonly Edge[]): Violation[] {
  const edges = new Map<string, Map<string, Edge[]>>()
  for (const edge of list) {
    const out = edges.get(edge.from) ?? new Map<string, Edge[]>()
    out.set(edge.to, [...(out.get(edge.to) ?? []), edge])
    edges.set(edge.from, out)
  }
  const nodes = [...new Set([...edges.keys(), ...[...edges.values()].flatMap(out => [...out.keys()])])].sort()
  // Tarjan 求强连通分量
  let counter = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const groups: string[][] = []
  const visit = (node: string): void => {
    index.set(node, counter)
    low.set(node, counter)
    counter++
    stack.push(node)
    onStack.add(node)
    for (const next of [...(edges.get(node)?.keys() ?? [])].sort()) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node) as number, low.get(next) as number))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) as number, index.get(next) as number))
      }
    }
    if (low.get(node) === index.get(node)) {
      const group: string[] = []
      let member: string
      do {
        member = stack.pop() as string
        onStack.delete(member)
        group.push(member)
      } while (member !== node)
      if (group.length > 1) groups.push(group.sort())
    }
  }
  for (const node of nodes) if (!index.has(node)) visit(node)

  return groups
    .sort((a, b) => (a[0] as string).localeCompare(b[0] as string))
    .map(group => {
      const members = new Set(group)
      const start = group[0] as string
      // 从组里第一个模块出发，找最短的一条回到它的路
      const previous = new Map<string, string>()
      const queue = [start]
      let end: string | undefined
      while (queue.length && end === undefined) {
        const node = queue.shift() as string
        for (const next of [...(edges.get(node)?.keys() ?? [])].sort()) {
          if (!members.has(next)) continue
          if (next === start) {
            end = node
            break
          }
          if (!previous.has(next)) {
            previous.set(next, node)
            queue.push(next)
          }
        }
      }
      const path = [start]
      for (let node = end as string; node !== start; node = previous.get(node) as string) path.splice(1, 0, node)
      path.push(start)
      const where = [`${path.join(' → ')}${group.length > path.length - 1 ? `（成环的模块还有：${group.filter(name => !path.includes(name)).join('、')}）` : ''}`]
      for (let i = 0; i + 1 < path.length; i++) {
        const facts = edges.get(path[i] as string)?.get(path[i + 1] as string) ?? []
        for (const fact of facts.slice(0, 3)) where.push(`${path[i]} → ${path[i + 1]}：${fact.site} ${fact.what}`)
        if (facts.length > 3) where.push(`${path[i]} → ${path[i + 1]}：还有 ${facts.length - 3} 处`)
      }
      return {
        rule: 'R2' as const,
        key: `R2 ${group.join(' ')}`,
        where,
        fix: '把共用的东西下沉到共享层，或者通过参数传进来；两个模块确实分不开，就合成一个。',
      }
    })
}

/** 一个应用里代码文件能放的地方。 */
function places(app: App): string {
  const items = [
    ...app.roots.map(root => `某个模块（${root}/<模块名>/）`),
    ...(app.shared.length ? [`共享层（${app.shared.join('、')}）`] : []),
    ...(app.app.length ? [`装配层（${app.app.join('、')}）`] : []),
  ]
  return items.length ? items.join('、') : '某个模块、共享层或装配层'
}

/**
 * R5 的改法：代码文件该放到哪里。rootFile：这个文件直接放在这个应用的模块根目录下。
 * 有几个应用时按应用说：知道在哪个应用里的只说那个应用，不知道的列出每个应用能放的地方和外面一层的共享层。
 */
function homeFix(scheme: Scheme, rootFile?: { path: string; app: App }): string {
  const keep = rootFile
    ? `要保留在模块根目录下的（比如 Python 包的 __init__.py），在 ${field(rootFile.app, 'app')} 里写到这个文件（"${rootFile.path}"，不用通配），它就归装配层。`
    : ''
  if (!scheme.grouped) return `放进${places(scheme.apps[0] as App)}。${keep}`
  if (rootFile) return `放进 ${rootFile.app.name} 应用的${places(rootFile.app)}。${keep}`
  const each = scheme.apps.map(app => `${app.name} 应用的${places(app)}`).join('；')
  const common = scheme.shared.length ? `外面一层的共享层（${scheme.shared.join('、')}）` : '外面一层的共享层（shared，现在没写）'
  return `放进它所在应用的模块、共享层或装配层：${each}。几个应用共用的放进${common}。`
}

/** R5 怎么报、怎么改：modwall check 和改文件之前的钩子共用。 */
export function unownedText(scheme: Scheme, path: string, owner: Extract<Owner, { kind: 'none' }>): { where: string; fix: string } {
  if (owner.unread) {
    const where = `${path} 在 LayerMap 不读的目录 ${owner.unread} 里，modwall 查不到它引用了谁${owner.within ? `（按路径它在${owner.within}里）` : ''}，没有归属`
    const fix = owner.within
      ? `换个目录名，把它搬出 ${owner.unread}/（LayerMap 不读的目录名有 ${UNREAD_DIRECTORIES.join('、')}，不分大小写）；业务上叫这类名字的模块（比如供应商 vendor）也要换个目录名。`
      : `第三方或工具的代码，在 outside 里写上 "${owner.unread}/**"（放宽规则，要用户同意）；项目自己的代码${homeFix(scheme)}`
    return { where, fix }
  }
  const app = owner.root === undefined ? undefined : scheme.apps.find(item => item.name === owner.app)
  if (owner.root !== undefined && app) {
    const at = app.name === undefined ? '' : ` ${app.name} 应用的`
    return { where: `${path} 直接放在${at}模块根目录 ${owner.root} 下，没有归属（模块是根目录下的子目录）`, fix: homeFix(scheme, { path, app }) }
  }
  return { where: `${path} 没有归属`, fix: homeFix(scheme) }
}

/** R5：代码文件没有归属。只看路径。 */
export function unownedFiles(layout: Layout, files: readonly string[]): Violation[] {
  return files
    .filter(path => isCode(path))
    .map(path => ({ path, owner: layout.owner(path) }))
    .filter((item): item is { path: string; owner: Extract<Owner, { kind: 'none' }> } => item.owner.kind === 'none')
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, owner }) => {
      const { where, fix } = unownedText(layout.scheme, path, owner)
      return { rule: 'R5' as const, key: `R5 ${path}`, where: [where], fix }
    })
}

type ChangedDeclaration = ChangeFacts['declarations'][number]

/** 这次改动里，同一个应用里别的模块新增的、对这个已有导出声明的调用（应用之间的调用另由 R3 拦）。 */
function newCallsFromOthers(layout: Layout, changes: ChangeFacts, declaration: ChangedDeclaration): ChangeFacts['calls'] {
  const owner = layout.owner(declaration.path)
  if (!declaration.exported || owner.kind !== 'module') return []
  return changes.calls.filter(call => {
    if (call.to !== declaration.path || call.declaration !== declaration.declaration) return false
    const caller = layout.owner(call.from)
    return caller.kind === 'module' && caller.app === owner.app && caller.name !== owner.name
  })
}

/** R4：这次改了 B 模块已有的导出函数的实现，同时 A 模块在这次改动里新增了对它的调用。只提示。 */
export function behaviorHints(layout: Layout, changes: ChangeFacts): Hint[] {
  const hints: Hint[] = []
  for (const declaration of changes.declarations) {
    const owner = layout.owner(declaration.path)
    if (owner.kind !== 'module') continue
    const callee = moduleId(owner.app, owner.name)
    for (const call of newCallsFromOthers(layout, changes, declaration)) {
      const caller = layout.owner(call.from) as Extract<Owner, { kind: 'module' }>
      hints.push({
        where: `${callee} 模块的 ${declaration.declaration}（${declaration.path}:${declaration.line}）这次改了实现，${moduleId(caller.app, caller.name)} 模块在 ${site(call)} 新增了对它的调用`,
        fix: `为新功能就在 ${callee} 新增一个函数，不要给旧函数加分支；是正常的重构（比如改了签名、同时更新调用处）就不用管。`,
      })
    }
  }
  return hints
}

/** 新迁移里改、删已有对象的一句：所在的模块、位置。 */
export interface MigrationAlter {
  module: Module
  path: string
  line: number
}

/**
 * R4 的另一种：这次新建了模块，同一个应用里已有的模块又被改了已有的东西（声明、迁移里改删已有的对象）。
 * 新模块要的应该在对方新增；改对方已有的，常是在对方的名单、类型、常量、约束、映射表里加上新模块的名字，
 * 对方因此认识了用它的模块。这种依赖写在字符串里，看引用查不出来，模块之间经装配层接线时也没有调用可查，所以按"改了已有的"提示。
 * 已经按调用提示过的（上面的 behaviorHints）不再列。
 */
export function existingChangeHints(layout: Layout, changes: ChangeFacts, fresh: ReadonlySet<string>, alters: readonly MigrationAlter[]): Hint[] {
  const freshIn = (app: string | undefined): string[] => layout.modules.filter(module => module.app === app && fresh.has(module.id)).map(module => module.id)
  const touched = new Map<string, { app: string | undefined; id: string; where: string[] }>()
  // 同一处（key）只说一次，位置写第一次见到的
  const seen = new Set<string>()
  const add = (app: string | undefined, id: string, key: string, where: string): void => {
    if (seen.has(key)) return
    seen.add(key)
    const found = touched.get(id) ?? { app, id, where: [] }
    found.where.push(where)
    touched.set(id, found)
  }
  for (const declaration of changes.declarations) {
    const owner = layout.owner(declaration.path)
    if (owner.kind !== 'module') continue
    const id = moduleId(owner.app, owner.name)
    if (fresh.has(id) || freshIn(owner.app).length === 0) continue
    // 对象字面量的属性报成 PAGES.deposit 这样，同一个文件里按顶层的名字说一次
    const name = declaration.declaration.split('.')[0] as string
    if (newCallsFromOthers(layout, changes, declaration).length) continue
    add(owner.app, id, `${declaration.path}\0${name}`, `${name}（${declaration.path}:${declaration.line}）`)
  }
  // 一个迁移文件只说一次，位置写第一句
  for (const alter of alters) {
    if (fresh.has(alter.module.id) || freshIn(alter.module.app).length === 0) continue
    add(alter.module.app, alter.module.id, alter.path, `迁移里改、删了已有的对象（${alter.path}:${alter.line}）`)
  }
  return [...touched.values()].map(({ app, id, where }) => ({
    where: `这次新建了 ${freshIn(app).join('、')} 模块，同时改了已有的 ${id} 模块里已有的：${where.join('、')}`,
    fix: `新模块要的在 ${id} 新增，不改它已有的。是在 ${id} 的名单、类型、常量、约束、映射表里加上新模块的名字的（${id} 因此认识了用它的模块），改成 ${id} 收一个值，或者由装配层接进来；是正常的重构就不用管。`,
  }))
}

/** 这次改动给哪些模块的入口新增了引用（转导出也算 import）：不算违规，留作试点数据。 */
export function entryExports(layout: Layout, changes: ChangeFacts): Hint[] {
  return changes.imports
    .filter(edge => edge.change === 'ADDED')
    .flatMap(edge => {
      const from = layout.owner(edge.from)
      const to = layout.owner(edge.to)
      if (from.kind !== 'module' || to.kind !== 'module' || from.app !== to.app || from.name !== to.name) return []
      const id = moduleId(from.app, from.name)
      if (!layout.isEntry(edge.from, id)) return []
      return [{ where: `${id} 的入口 ${edge.from}:${edge.line} 新增引用 ${edge.to}` }]
    })
}

const REASONS: Record<string, string> = {
  SYMBOL_NOT_RESOLVED: '路径或别名没对上文件，也可能是样式文件或没装的包',
  SOURCE_DECLARATION_UNMAPPED: '是项目里的文件，但地图里没有它的声明',
  SYNTAX_ONLY: '这个文件只做了语法解析，它的 import 一条都没解析',
}

/** LayerMap 标明没看全的地方：照列，不拦。可能是项目自己的 import 里，写相对路径的排在前面。 */
export function uncheckedItems(layout: Layout, facts: ProjectImports | undefined, changes: ChangeFacts | undefined): string[] {
  const items: string[] = []
  if (facts) {
    const own = facts.unresolved
      .filter(fact => fact.possiblyOwn && layout.owner(fact.from).kind !== 'outside')
      .sort((a, b) => Number(!a.specifier.startsWith('.')) - Number(!b.specifier.startsWith('.')))
    for (const fact of own) items.push(`${site(fact)} 的 import "${fact.specifier}"：${REASONS[fact.reason] ?? fact.reason}`)
  }
  if (changes) {
    for (const text of changes.incomplete) items.push(`检查没做完：${text}`)
    // 只列代码文件：配置、文档这些 modwall 本来就不查，不存在"没检查到"
    for (const file of changes.unmapped) if (isCode(file.path)) items.push(`LayerMap 不跟的改动文件：${file.path}（${file.kind}）`)
    if (changes.truncated) items.push('这次改动的检查结果被截断了，有的关系没列出来')
    if (changes.edgesTruncated) items.push('这次改动的声明超过 LayerMap 跟踪的上限（200 个），R4 的提示可能不全')
  }
  return items
}
