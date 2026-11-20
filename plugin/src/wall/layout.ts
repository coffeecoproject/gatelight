// 项目的划分：每个文件归谁（哪个应用的模块、共享层、装配层，外面一层的共享层、outside、测试），有哪些模块、各自的入口；
// 各项路径重叠、数据库的 schema 名撞了、迁移时间戳重复算配置错误。只看路径，不调用 LayerMap：改文件之前的钩子也用它。
// 单应用 = 一个没有名字的应用：归属里不带 app，模块名不加前缀。按应用分组时模块写成 应用名/模块名。
// LayerMap 不读的目录（vendor、node_modules、.claude 等）里的代码，它引用了谁查不到：只有写进 outside 才算有归属。

import { type App, type AppConfig, type Config, field, GLOB_CHARS, moduleId, type Scheme, schemeOf } from './config.ts'
import { type Database, databasesOf } from './database.ts'
import { isCode, isTest, unreadDirectory } from './files.ts'
import { globToRegExp } from '../base/glob.ts'

/** app：所在的应用（按应用分组时才有）。 */
export type Owner =
  | { kind: 'module'; name: string; mapped: boolean; app?: string }
  | { kind: 'shared'; app?: string }
  /** root：直接放在这个模块根目录下、在 app 里点名的文件。 */
  | { kind: 'app'; root?: string; app?: string }
  /** 外面一层的共享层：几个应用共用的（只有按应用分组时才有）。 */
  | { kind: 'common' }
  | { kind: 'outside' }
  | { kind: 'test' }
  /**
   * 没有归属。root：直接放在这个模块根目录下的文件（app：那个根目录所在的应用）。
   * unread：在这个 LayerMap 不读的目录里，又没写进 outside；within：按路径它本来归谁（模块、共享层、装配层、映射），别处的没有。
   */
  | { kind: 'none'; root?: string; app?: string; unread?: string; within?: string }

const matcher = (patterns: readonly string[]): ((path: string) => boolean) => {
  const regs = patterns.map(pattern => globToRegExp(pattern))
  return path => regs.some(reg => reg.test(path))
}

/** 归属里的应用名：单应用不写。 */
const inApp = (app: App): { app?: string } => (app.name === undefined ? {} : { app: app.name })

/** 归属的说法，比如 booking 模块、admin/booking 模块、admin 应用的共享层。 */
export function label(owner: Owner): string {
  switch (owner.kind) {
    case 'module':
      return `${moduleId(owner.app, owner.name)} 模块${owner.mapped ? '（映射）' : ''}`
    case 'shared':
      return owner.app === undefined ? '共享层' : `${owner.app} 应用的共享层`
    case 'app':
      return owner.app === undefined ? '装配层' : `${owner.app} 应用的装配层`
    case 'common':
      return '外面一层的共享层'
    case 'outside':
      return 'outside'
    case 'test':
      return '测试文件'
    case 'none':
      return '没有归属的文件'
  }
}

/**
 * 路径在哪个模块根目录下：name 是它所在的模块（根目录下第一层的目录名）；
 * 没有 name 就是直接放在根目录下的文件，不在任何模块目录里。
 */
export function placeInRoots(config: Pick<AppConfig, 'roots'>, path: string): { root: string; name?: string } | undefined {
  const root = config.roots.find(dir => path.startsWith(`${dir}/`))
  if (root === undefined) return undefined
  const rest = path.slice(root.length + 1)
  const slash = rest.indexOf('/')
  return slash === -1 ? { root } : { root, name: rest.slice(0, slash) }
}

/** 路径在哪个应用的哪个模块根目录下。 */
function placeIn(scheme: Scheme, path: string): { app: App; root: string; name?: string } | undefined {
  for (const app of scheme.apps) {
    const place = placeInRoots(app, path)
    if (place) return { app, ...place }
  }
  return undefined
}

/** app 里点名写了这个文件：写到具体的文件、不用通配。直接放在模块根目录下的文件只有这样才能归装配层。 */
function namedInApp(app: App, path: string): boolean {
  return app.app.some(rule => rule === path && !GLOB_CHARS.test(rule))
}

/**
 * 这个路径归谁。测试文件不归 modwall 管；LayerMap 不读的目录里的，只有 outside 认领了才有归属。
 * 路径重叠时的先后只在配置有错时起作用。
 */
export function ownerOf(config: Config, path: string): Owner {
  return ownerIn(schemeOf(config), path)
}

export function ownerIn(scheme: Scheme, path: string): Owner {
  if (isTest(path)) return { kind: 'test' }
  const owner = ownerByPath(scheme, path)
  const unread = unreadDirectory(path)
  if (unread === undefined || owner.kind === 'outside') return owner
  const within = owner.kind === 'module' || owner.kind === 'shared' || owner.kind === 'app' || owner.kind === 'common' ? label(owner) : undefined
  return { kind: 'none', unread, ...(within ? { within } : {}) }
}

/** 只按配置里的路径看归谁，不管 LayerMap 读不读。 */
function ownerByPath(scheme: Scheme, path: string): Owner {
  if (matcher(scheme.outside)(path)) return { kind: 'outside' }
  for (const app of scheme.apps) {
    for (const [pattern, name] of Object.entries(app.map)) {
      if (globToRegExp(pattern).test(path)) return { kind: 'module', name, mapped: true, ...inApp(app) }
    }
  }
  const place = placeIn(scheme, path)
  if (place?.name !== undefined) return { kind: 'module', name: place.name, mapped: false, ...inApp(place.app) }
  if (place) return namedInApp(place.app, path) ? { kind: 'app', root: place.root, ...inApp(place.app) } : { kind: 'none', root: place.root, ...inApp(place.app) }
  for (const app of scheme.apps) if (matcher(app.shared)(path)) return { kind: 'shared', ...inApp(app) }
  for (const app of scheme.apps) if (matcher(app.app)(path)) return { kind: 'app', ...inApp(app) }
  if (matcher(scheme.shared)(path)) return { kind: 'common' }
  return { kind: 'none' }
}

export interface Module {
  /** 所在的应用（按应用分组时才有）。 */
  app?: string
  name: string
  /** 模块的名字：单应用就是 name，按应用分组是 应用名/模块名。 */
  id: string
  /** 模块目录。 */
  dir: string
  /** 现有的入口文件（模块目录下第一层、名字在这个应用的 entry 里的代码文件）。 */
  entries: string[]
}

export class Layout {
  readonly config: Config
  readonly scheme: Scheme
  readonly modules: Module[] = []
  /** 写了 database 的应用各一个库：schema、迁移文件各归谁。 */
  readonly databases: Database[]
  readonly problems: string[] = []
  /** problems 里有路径重叠。 */
  overlapping = false
  private readonly byId = new Map<string, Module>()

  /**
   * files：工作区里现有的文件（相对仓库根目录）。模块从文件推出来：模块根目录下有文件按路径归到某个模块，它就是一个模块，
   * 和"文件归谁"同一个算法。只有 MODULE.md、还没有代码的模块目录也算；git 不跟踪空目录，空目录不算。根目录不存在不算错。
   * 模块名只在应用内唯一：几个应用都有同名的模块是正常的。
   */
  constructor(config: Config, files: readonly string[]) {
    this.config = config
    this.scheme = schemeOf(config)
    const present = new Set(files)
    const dirs = new Map<string, { app: App; name: string }>()
    for (const path of files) {
      const owner = ownerIn(this.scheme, path)
      const place = placeIn(this.scheme, path)
      if (owner.kind === 'module' && !owner.mapped && place?.name !== undefined) dirs.set(`${place.root}/${place.name}`, { app: place.app, name: place.name })
    }
    for (const [dir, { app, name }] of [...dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const entries = app.entry.map(file => `${dir}/${file}`).filter(path => present.has(path) && isCode(path))
      const id = moduleId(app.name, name)
      const module: Module = { ...inApp(app), name, id, dir, entries }
      const other = this.byId.get(id)
      if (other) this.problems.push(`模块名重复：${other.dir} 和 ${dir} 都叫 ${id}（模块按目录名认，要改个名字）`)
      else this.byId.set(id, module)
      this.modules.push(module)
    }
    for (const app of this.scheme.apps) {
      for (const [pattern, name] of Object.entries(app.map)) {
        const id = moduleId(app.name, name)
        if (!this.byId.has(id)) this.problems.push(`${field(app, 'map')} 里 "${pattern}" 指向的模块 ${id} 不存在（模块是模块根目录下的子目录）`)
      }
    }
    this.checkOverlaps(files)
    this.databases = databasesOf(this.scheme.apps, this.modules, files)
    for (const database of this.databases) this.problems.push(...database.problems)
  }

  /**
   * 各项的路径不能重叠：看现有的代码文件（测试文件除外）各被哪几项认领。重叠要报，是因为文件归谁有歧义：
   * 同一项（同一个应用的 shared、app，外面一层的 shared、outside）里几条规则认领同一个文件不算；
   * map 里指向同一个模块的不算，指向不同模块的算；每个模块根目录各算一项（互相嵌套时文件归哪个模块有歧义）。
   * 不同应用的各项、应用和外面一层的 shared 都是不同的项。
   * 唯一的例外：直接放在模块根目录下、在那个应用的 app 里点名的文件，不算 roots 认领了它。
   */
  private checkOverlaps(files: readonly string[]): void {
    /** name：报错里的写法；item：属于哪一项，同一项里的认领不算重叠。 */
    type Claim = { name: string; item: string; claims: (path: string) => boolean; root?: true }
    const claims: Claim[] = [
      ...this.scheme.apps.flatMap(app =>
        app.roots.map((root): Claim => ({ name: `${field(app, 'roots')} 的 "${root}"`, item: `roots ${root}`, claims: path => path.startsWith(`${root}/`), root: true })),
      ),
      ...this.scheme.apps.flatMap(app => app.shared.map((rule): Claim => ({ name: `${field(app, 'shared')} 的 "${rule}"`, item: field(app, 'shared'), claims: matcher([rule]) }))),
      ...this.scheme.apps.flatMap(app => app.app.map((rule): Claim => ({ name: `${field(app, 'app')} 的 "${rule}"`, item: field(app, 'app'), claims: matcher([rule]) }))),
      ...this.scheme.apps.flatMap(app =>
        Object.entries(app.map).map(([rule, module]): Claim => ({ name: `${field(app, 'map')} 的 "${rule}"`, item: `${field(app, 'map')} ${module}`, claims: matcher([rule]) })),
      ),
      // 外面一层的 shared：项名 common，和单应用写法里应用自己的 shared 分开
      ...this.scheme.shared.map((rule): Claim => ({ name: `shared 的 "${rule}"`, item: 'common', claims: matcher([rule]) })),
      ...this.scheme.outside.map((rule): Claim => ({ name: `outside 的 "${rule}"`, item: 'outside', claims: matcher([rule]) })),
    ]
    const overlaps = new Map<string, string[]>()
    for (const path of files) {
      if (!isCode(path) || isTest(path)) continue
      const place = placeIn(this.scheme, path)
      const named = place !== undefined && place.name === undefined && namedInApp(place.app, path)
      const by = claims.filter(claim => claim.claims(path) && !(named && claim.root))
      if (new Set(by.map(claim => claim.item)).size < 2) continue
      const key = by.map(claim => claim.name).join(' 和 ')
      overlaps.set(key, [...(overlaps.get(key) ?? []), path])
    }
    this.overlapping = overlaps.size > 0
    for (const [by, paths] of overlaps) {
      const shown = paths.slice(0, 3).join('、')
      this.problems.push(`路径重叠：${by} 都包含 ${shown}${paths.length > 3 ? ` 等 ${paths.length} 个文件` : ''}`)
    }
  }

  owner(path: string): Owner {
    return ownerIn(this.scheme, path)
  }

  /** id：模块的名字（按应用分组时是 应用名/模块名）。 */
  module(id: string): Module | undefined {
    return this.byId.get(id)
  }

  /** 这个文件是这个模块（id）的入口。 */
  isEntry(path: string, id: string): boolean {
    return this.byId.get(id)?.entries.includes(path) ?? false
  }

  /** 应用（单应用时是那个没有名字的应用）。 */
  app(name: string | undefined): App | undefined {
    return this.scheme.apps.find(app => app.name === name)
  }
}
