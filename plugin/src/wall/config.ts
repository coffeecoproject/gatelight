// 项目约定 .modwall/config.json 的读取和校验。各项路径重叠要看实际的文件，在 layout.ts 里查。
//   roots   模块根目录：下面每个子目录是一个模块（写目录，不用通配）
//   shared  共享层，app 装配层，outside 不归 modwall 管的路径（路径规则）
//   entry   模块对外入口的文件名（模块目录下第一层）
//   map     框架要求放在固定目录的文件：路径规则 → 模块名
//   allow   用户确认过的例外：一条被放过的 import，写到文件
//   database 用 Postgres 时：每个模块放迁移的子目录名（migrations）、共享层的迁移目录（shared）、程序的登录账号（login）、跑迁移的账号（migrator）。
//            schema 和模块的角色按模块目录名算（database.ts）
// 一个仓库里有几个应用时按应用分组写：apps 每组一个应用（roots、shared、app、entry、map，用库的应用写 database），
// 外面一层只能有 apps、shared（几个应用共用的共享层）、outside、allow。两种写法不能混用。
// 规则都按 schemeOf 统一成"几个应用"来算：单应用就是一个没有名字的应用。

import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { hasFile } from '../base/git.ts'

export const MODWALL_DIR = '.modwall'
export const CONFIG_PATH = `${MODWALL_DIR}/config.json`

const RULES_WITH_EXCEPTIONS = ['R1', 'R2', 'R3'] as const
export type ExceptionRule = (typeof RULES_WITH_EXCEPTIONS)[number]

export interface AllowEntry {
  rule: ExceptionRule
  from: string
  to: string
  reason: string
}

/**
 * 数据库：migrations 是每个模块放迁移的子目录（相对模块目录），shared 是共享层的迁移目录（相对仓库根目录）；
 * login 是程序连库用的账号，migrator 是跑迁移用的账号（都只能切成模块的角色，modwall db check 查它们）。
 */
export interface DatabaseConfig {
  migrations: string
  shared: string
  login: string
  migrator: string
}

const DATABASE_SHAPE = '{ "migrations": 模块里放迁移的子目录, "shared": 共享层的迁移目录, "login": 程序的登录账号, "migrator": 跑迁移的账号 }'
const DATABASE_KEYS = ['migrations', 'shared', 'login', 'migrator']

/** 一个应用的划分：单应用写法的这几项，或者按应用分组时 apps 里的一组。database：这个应用用 Postgres 时才有。 */
export interface AppConfig {
  roots: string[]
  shared: string[]
  app: string[]
  entry: string[]
  map: Record<string, string>
  database?: DatabaseConfig
}

/** 单应用的写法：整个仓库一套模块。 */
export interface SingleConfig extends AppConfig {
  outside: string[]
  allow: AllowEntry[]
}

/** 按应用分组的写法：apps 每组一个应用；外面一层的 shared 是几个应用共用的共享层，outside、allow 只写在外面一层。 */
export interface GroupedConfig {
  apps: Record<string, AppConfig>
  shared: string[]
  outside: string[]
  allow: AllowEntry[]
}

/** 配置文件里写的样子（两种写法之一）。规则都按 schemeOf 统一成"几个应用"来算。 */
export type Config = SingleConfig | GroupedConfig

const APP_KEYS = ['roots', 'shared', 'app', 'entry', 'map', 'database'] as const
const SINGLE_KEYS = [...APP_KEYS, 'outside', 'allow'] as const
const GROUPED_KEYS = ['apps', 'shared', 'outside', 'allow'] as const

/** 一个应用。name：按应用分组时的应用名；单应用的写法是一个没有名字的应用。 */
export interface App extends AppConfig {
  name?: string
}

/**
 * 统一的划分：单应用 = 一个没有名字的应用、外面一层的 shared 为空。
 * shared：外面一层的共享层（几个应用共用的）；grouped：配置是按应用分组写的。
 */
export interface Scheme {
  grouped: boolean
  apps: App[]
  shared: string[]
  outside: string[]
  allow: AllowEntry[]
}

export function schemeOf(config: Config): Scheme {
  if ('apps' in config) {
    return { grouped: true, apps: Object.entries(config.apps).map(([name, app]) => ({ name, ...app })), shared: config.shared, outside: config.outside, allow: config.allow }
  }
  const { outside, allow, ...app } = config
  return { grouped: false, apps: [app], shared: [], outside, allow }
}

/** 这个应用的某一项在配置里的写法：单应用就是字段名，按应用分组是 apps.<应用名>.<字段名>。 */
export const field = (app: App, key: string): string => (app.name === undefined ? key : `apps.${app.name}.${key}`)

/** 模块的名字：模块名只在应用内唯一，按应用分组时写成 应用名/模块名。 */
export const moduleId = (app: string | undefined, name: string): string => (app === undefined ? name : `${app}/${name}`)

export interface Parsed {
  config?: Config
  problems: string[]
}

/** 仓库里的相对路径：去掉开头的 ./ 和结尾的 /；不能是绝对路径，不能有 ..、空段。 */
function relativePath(value: string): string | undefined {
  const plain = value.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  if (plain === '' || plain.startsWith('/') || plain.includes('\\')) return undefined
  if (plain.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  return posix.normalize(plain) === plain ? plain : undefined
}

export const GLOB_CHARS = /[*?[\]{}]/
/** 账号名、schema 名：不用加引号的 Postgres 名字。 */
export const PLAIN_NAME = /^[a-z_][a-z0-9_]*$/

/** 路径规则：和 relativePath 一样，但保留结尾的 /（表示整个目录）。 */
function pattern(value: string): string | undefined {
  const dir = value.endsWith('/')
  const plain = relativePath(value)
  return plain === undefined ? undefined : dir ? `${plain}/` : plain
}

const CONTROL = /[\u0000-\u001f\u007f]/

/** 配置里带换行或控制字符的字符串（键和值）在哪里，比如 allow[0].reason。 */
function linesIn(value: unknown, where: string): string[] {
  if (typeof value === 'string') return CONTROL.test(value) ? [where] : []
  if (Array.isArray(value)) return value.flatMap((item, index) => linesIn(item, `${where}[${index}]`))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, item]) => {
    const at = where ? `${where}.${JSON.stringify(key).slice(1, -1)}` : JSON.stringify(key).slice(1, -1)
    return [...(CONTROL.test(key) ? [`${at}（键）`] : []), ...linesIn(item, at)]
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 读一组字段时的上下文：prefix 是报错里字段名前面的部分（按应用分组时是 apps.<应用名>.）。 */
class Reader {
  readonly record: Record<string, unknown>
  readonly prefix: string
  readonly problems: string[]

  constructor(record: Record<string, unknown>, prefix: string, problems: string[]) {
    this.record = record
    this.prefix = prefix
    this.problems = problems
  }

  strings(key: string, required: boolean): string[] | undefined {
    const value = this.record[key]
    const name = `${this.prefix}${key}`
    if (value === undefined) {
      if (required) this.problems.push(`${CONFIG_PATH} 缺少 "${name}"`)
      return undefined
    }
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
      this.problems.push(`${CONFIG_PATH} 的 "${name}" 应该是非空字符串的数组`)
      return undefined
    }
    return value as string[]
  }

  /** shared、app、outside 这类路径规则的列表。 */
  patterns(key: string): string[] {
    const rules: string[] = []
    const name = `${this.prefix}${key}`
    for (const value of this.strings(key, false) ?? []) {
      const rule = pattern(value)
      if (rule === undefined) this.problems.push(`${name} 里的 "${value}" 要写仓库里的相对路径或路径规则`)
      else if (rules.includes(rule)) this.problems.push(`${name} 里的 "${value}" 写了两次`)
      else rules.push(rule)
    }
    return rules
  }

  /** 一个应用的 roots、shared、app、entry、map、database。 */
  app(): AppConfig {
    const { prefix, problems } = this
    const config: AppConfig = { roots: [], shared: [], app: [], entry: [], map: {} }
    for (const value of this.strings('roots', true) ?? []) {
      const root = relativePath(value)
      if (root === undefined || GLOB_CHARS.test(root)) problems.push(`${prefix}roots 里的 "${value}" 要写仓库里的目录（相对路径，不用通配）`)
      else if (config.roots.includes(root)) problems.push(`${prefix}roots 里的 "${value}" 写了两次`)
      else config.roots.push(root)
    }
    config.shared = this.patterns('shared')
    config.app = this.patterns('app')

    for (const value of this.strings('entry', true) ?? []) {
      if (value.includes('/') || GLOB_CHARS.test(value) || value === '.' || value === '..') problems.push(`${prefix}entry 里的 "${value}" 要写文件名（模块目录下第一层的文件），不带目录和通配`)
      else if (config.entry.includes(value)) problems.push(`${prefix}entry 里的 "${value}" 写了两次`)
      else config.entry.push(value)
    }

    const map = this.record.map
    if (map !== undefined) {
      if (!isRecord(map)) problems.push(`${CONFIG_PATH} 的 "${prefix}map" 应该是"路径规则 → 模块名"的对象`)
      else {
        for (const [key, value] of Object.entries(map)) {
          const rule = pattern(key)
          if (rule === undefined) problems.push(`${prefix}map 里的 "${key}" 要写仓库里的相对路径或路径规则`)
          else if (typeof value !== 'string' || value === '' || value.includes('/')) problems.push(`${prefix}map 里 "${key}" 的值要写模块名（模块根目录下的目录名）`)
          else if (rule in config.map) problems.push(`${prefix}map 里的 "${key}" 写了两次`)
          else config.map[rule] = value
        }
      }
    }
    const database = this.database()
    if (database) config.database = database
    return config
  }

  /** database：两个目录（写目录、不用通配）和两个账号名。 */
  database(): DatabaseConfig | undefined {
    const value = this.record.database
    const name = `${this.prefix}database`
    if (value === undefined) return undefined
    if (!isRecord(value)) {
      this.problems.push(`${CONFIG_PATH} 的 "${name}" 应该是 ${DATABASE_SHAPE}`)
      return undefined
    }
    const extra = Object.keys(value).filter(key => !DATABASE_KEYS.includes(key))
    if (extra.length) this.problems.push(`${CONFIG_PATH} 的 "${name}" 有未知字段 ${extra.map(key => `"${key}"`).join('、')}`)
    const dir = (key: 'migrations' | 'shared', what: string): string | undefined => {
      const raw = value[key]
      const path = typeof raw === 'string' ? relativePath(raw) : undefined
      if (path === undefined || GLOB_CHARS.test(path)) {
        this.problems.push(`${CONFIG_PATH} 的 "${name}.${key}" 要写${what}（相对路径，不用通配）`)
        return undefined
      }
      return path
    }
    const account = (key: 'login' | 'migrator', what: string): string | undefined => {
      const raw = value[key]
      if (typeof raw === 'string' && PLAIN_NAME.test(raw)) return raw
      this.problems.push(`${CONFIG_PATH} 的 "${name}.${key}" 要写${what}的名字（小写字母、数字和下划线，不以数字开头）`)
      return undefined
    }
    const migrations = dir('migrations', '每个模块放迁移的子目录（相对模块目录，比如 "migrations"）')
    const shared = dir('shared', '共享层的迁移目录（从仓库根目录写起）')
    const login = account('login', '程序连库用的账号')
    const migrator = account('migrator', '跑迁移用的账号')
    if (migrations === undefined || shared === undefined || login === undefined || migrator === undefined) return undefined
    return { migrations, shared, login, migrator }
  }

  allow(): AllowEntry[] {
    const { problems } = this
    const entries: AllowEntry[] = []
    const allow = this.record.allow
    if (allow === undefined) return entries
    if (!Array.isArray(allow)) {
      problems.push(`${CONFIG_PATH} 的 "allow" 应该是数组`)
      return entries
    }
    const seen = new Set<string>()
    allow.forEach((item, index) => {
      const where = `allow 的第 ${index + 1} 条`
      if (!isRecord(item)) {
        problems.push(`${where} 应该是 { "rule", "from", "to", "reason" }`)
        return
      }
      const entry = item
      const extra = Object.keys(entry).filter(key => !['rule', 'from', 'to', 'reason'].includes(key))
      if (extra.length) problems.push(`${where} 有未知字段 ${extra.map(key => `"${key}"`).join('、')}`)
      if (typeof entry.rule !== 'string' || !(RULES_WITH_EXCEPTIONS as readonly string[]).includes(entry.rule)) {
        problems.push(`${where} 的 rule 要写 ${RULES_WITH_EXCEPTIONS.join('、')} 之一（例外是一条被放过的 import）`)
        return
      }
      const from = typeof entry.from === 'string' ? relativePath(entry.from) : undefined
      const to = typeof entry.to === 'string' ? relativePath(entry.to) : undefined
      if (from === undefined || to === undefined || GLOB_CHARS.test(from) || GLOB_CHARS.test(to)) {
        problems.push(`${where} 的 from 和 to 要写到具体的文件（相对路径，不用通配）`)
        return
      }
      if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
        problems.push(`${where} 要写理由（reason）`)
        return
      }
      const key = `${entry.rule}\0${from}\0${to}`
      if (seen.has(key)) {
        problems.push(`${where} 和前面的重复了（${entry.rule} ${from} → ${to}）`)
        return
      }
      seen.add(key)
      entries.push({ rule: entry.rule as ExceptionRule, from, to, reason: entry.reason.trim() })
    })
    return entries
  }
}

/** 模块根目录不能互相嵌套：一个应用里的，不同应用之间的都不行。 */
function nestedRoots(scheme: Scheme): string[] {
  const all = scheme.apps.flatMap(app => app.roots.map(root => ({ root, at: scheme.grouped ? `${field(app, 'roots')} 的 ` : '' })))
  const problems: string[] = []
  all.forEach((a, i) => {
    all.forEach((b, j) => {
      if (i === j) return
      if (b.root.startsWith(`${a.root}/`)) problems.push(`roots 重叠：${b.at}"${b.root}" 在 ${a.at}"${a.root}" 里面`)
      else if (a.root === b.root && i < j) problems.push(`roots 重叠：${a.at}"${a.root}" 和 ${b.at}"${b.root}" 是同一个目录`)
    })
  })
  return problems
}

export function parseConfig(text: string): Parsed {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { problems: [`${CONFIG_PATH} 不是合法的 JSON：${(error as Error).message}`] }
  }
  if (!isRecord(raw)) return { problems: [`${CONFIG_PATH} 应该是一个对象`] }
  const record = raw
  // 路径、模块名、应用名、理由都会原样进放宽项的文字（弹窗里一项一行）：带换行的会多出一行像另一项的文字，先拦下
  const multiline = linesIn(record, '')
  if (multiline.length) return { problems: multiline.map(where => `${CONFIG_PATH} 的 ${where} 带换行或控制字符：路径、模块名、理由都要写成一行`) }
  const problems: string[] = []
  const outer = new Reader(record, '', problems)
  let config: Config
  if ('apps' in record) {
    for (const key of Object.keys(record)) {
      if ((GROUPED_KEYS as readonly string[]).includes(key)) continue
      if ((APP_KEYS as readonly string[]).includes(key)) problems.push(`${CONFIG_PATH} 写了 "apps"（按应用分组），外面一层就只能有 ${GROUPED_KEYS.join('、')}："${key}" 要写进各个应用里，两种写法不能混用`)
      else problems.push(`${CONFIG_PATH} 有未知字段 "${key}"`)
    }
    const apps: Record<string, AppConfig> = {}
    if (!isRecord(record.apps)) problems.push(`${CONFIG_PATH} 的 "apps" 应该是"应用名 → 这个应用的 roots、shared、app、entry、map"的对象`)
    else if (Object.keys(record.apps).length === 0) problems.push(`${CONFIG_PATH} 的 "apps" 里至少要有一个应用；只有一个应用就用单应用的写法`)
    else {
      for (const [name, value] of Object.entries(record.apps)) {
        const prefix = `apps.${name}.`
        if (name.trim() === '' || name.includes('/')) {
          problems.push(`${CONFIG_PATH} 的 apps 里的应用名 "${name}" 要写成一段名字（不带 /）`)
          continue
        }
        if (!isRecord(value)) {
          problems.push(`${CONFIG_PATH} 的 "apps.${name}" 应该是这个应用的 roots、shared、app、entry、map、database`)
          continue
        }
        for (const key of Object.keys(value)) {
          if ((APP_KEYS as readonly string[]).includes(key)) continue
          if (key === 'outside' || key === 'allow') problems.push(`${CONFIG_PATH} 的 "${prefix}${key}" 要写在外面一层：${key} 不分应用`)
          else problems.push(`${CONFIG_PATH} 的 "apps.${name}" 有未知字段 "${key}"`)
        }
        apps[name] = new Reader(value, prefix, problems).app()
      }
    }
    config = { apps, shared: outer.patterns('shared'), outside: outer.patterns('outside'), allow: outer.allow() }
  } else {
    for (const key of Object.keys(record)) {
      if (!(SINGLE_KEYS as readonly string[]).includes(key)) problems.push(`${CONFIG_PATH} 有未知字段 "${key}"`)
    }
    const app = outer.app()
    config = { ...app, outside: outer.patterns('outside'), allow: outer.allow() }
  }
  problems.push(...nestedRoots(schemeOf(config)))
  return problems.length ? { problems } : { config, problems }
}

/** 一版配置（text 是配置文件的内容，经底座读来）：exists 为 false 时就是没有配置文件。 */
export function readConfig(text: string | undefined): Parsed & { exists: boolean } {
  return text === undefined ? { exists: false, problems: [] } : { exists: true, ...parseConfig(text) }
}

/** 接入了 modwall：分叉点或工作区里有 .modwall/。按分叉点也算，删掉目录躲不过检查。 */
export function joined(root: string, fork?: string): boolean {
  return existsSync(join(root, MODWALL_DIR)) || (fork !== undefined && hasFile(root, fork, MODWALL_DIR))
}
