// 放宽项：和分叉点的配置比，这次放宽了哪些规则。放宽要用户在确认工具的弹窗里同意（底座的用户确认，base/confirm.ts），收紧不用。
//   往 allow 加条目；扩大 shared、app、map、outside 的范围；删掉或缩小 roots；往 entry 加文件名；删掉 database 或改它的目录、账号名；
//   删掉配置或整个 .modwall/。加上 database 是收紧。
//   首次接入（分叉点上还没有配置）：整份配置算一项。
// 有几个应用时，每个应用和分叉点上同名的应用比，项里写明是哪个应用（apps.<应用名>.<字段>）：
//   新加的应用和一个空的应用比（roots 是收紧，shared、app、map、entry 按扩大算）；删掉或改名的应用按删掉它的 roots 算；
//   外面一层的 shared、outside、allow 和单应用时一样比；单应用的写法和按应用分组的写法之间切换，整份配置算一项。
// 路径规则新加的一条，被分叉点上的某条盖住（一样，或在它 /** 的目录里面）才算没扩大；判断不了的都当扩大。
//
// 每一项除了给用户看的文字，还带着它具体改了什么（改之前、改成什么）：同意按这三样记，不只按文字记。
//   文字里已经写全了改动的（新增一条例外、新增一条路径规则、删掉一个模块根目录），改之前、改成什么就是那一条本身，
//     哪个分支上做同一项放宽都是同一个决定，共用一次同意；配置别处再怎么变，这一项不用重新问。
//   文字是固定的、或没写全的（删掉配置、删掉 database、换写法、首次接入），改之前、改成什么是被删掉或换掉的那份内容：
//     删的是另一份配置，就是另一项，要重新同意。

import { type App, type AppConfig, type Config, CONFIG_PATH, field, MODWALL_DIR, schemeOf } from './config.ts'

/** 一项放宽。 */
export interface LoosenItem {
  /** 给用户看的文字。 */
  text: string
  /** 这一项改之前是什么、改成了什么（没有的一边是空的）。 */
  before: string
  after: string
}

/** 工作区这一侧。 */
export interface ConfigSide {
  /** 能用的配置（文件在、校验通过）。 */
  config?: Config
  /** 有 .modwall/ 目录。 */
  hasDir: boolean
}

/** old 盖住了 rule：rule 认的路径都在 old 里面。 */
function covers(old: string, rule: string): boolean {
  if (old === rule || old === '**' || old === '**/') return true
  if (old.endsWith('/**')) return rule.startsWith(old.slice(0, -2))
  if (old.endsWith('/')) return rule.startsWith(old)
  return false
}

const appFields = (app: AppConfig): AppConfig => ({
  roots: app.roots,
  shared: app.shared,
  app: app.app,
  entry: app.entry,
  map: app.map,
  ...(app.database ? { database: { migrations: app.database.migrations, shared: app.database.shared, login: app.database.login, migrator: app.database.migrator } } : {}),
})

/** 整份配置的文字：字段按固定顺序，弹窗里给用户看。 */
export function configText(config: Config): string {
  if ('apps' in config) {
    const apps = Object.fromEntries(Object.entries(config.apps).map(([name, app]) => [name, appFields(app)]))
    return JSON.stringify({ apps, shared: config.shared, outside: config.outside, allow: config.allow })
  }
  return JSON.stringify({ ...appFields(config), outside: config.outside, allow: config.allow })
}

const EMPTY: AppConfig = { roots: [], shared: [], app: [], entry: [], map: {} }

/** 新加的路径规则里，没被 old 的哪一条盖住的。 */
const widened = (old: readonly string[], now: readonly string[]): string[] => now.filter(rule => !old.some(previous => covers(previous, rule)))

const databaseText = (database: NonNullable<AppConfig['database']>): string =>
  JSON.stringify({ migrations: database.migrations, shared: database.shared, login: database.login, migrator: database.migrator })

/** before：分叉点上能用的配置。 */
export function looseningItems(before: Config | undefined, now: ConfigSide): LoosenItem[] {
  if (!before) return now.config ? [{ text: `首次接入 modwall（分叉点上还没有配置），整份配置：${configText(now.config)}`, before: '', after: configText(now.config) }] : []
  if (!now.config) {
    return [{ text: now.hasDir ? `删掉了配置文件 ${CONFIG_PATH}` : `删掉了整个 ${MODWALL_DIR}/ 目录`, before: configText(before), after: '' }]
  }
  const old = schemeOf(before)
  const scheme = schemeOf(now.config)
  if (old.grouped !== scheme.grouped) {
    const form = (grouped: boolean): string => (grouped ? '按应用分组的写法' : '单应用的写法')
    return [
      {
        text: `配置从${form(old.grouped)}换成了${form(scheme.grouped)}，和首次接入一样，整份配置：${configText(now.config)}`,
        before: configText(before),
        after: configText(now.config),
      },
    ]
  }
  // 每个应用和分叉点上同名的应用比：新加的和空的应用比，删掉（或改名）的和空的应用比
  const pairs: Array<{ before: App; now: App; gone?: true }> = [
    ...scheme.apps.map(app => ({ before: old.apps.find(previous => previous.name === app.name) ?? { ...EMPTY, ...(app.name === undefined ? {} : { name: app.name }) }, now: app })),
    ...old.apps
      .filter(previous => !scheme.apps.some(app => app.name === previous.name))
      .map(previous => ({ before: previous, now: { ...EMPTY, ...(previous.name === undefined ? {} : { name: previous.name }) }, gone: true as const })),
  ]
  const items: LoosenItem[] = []
  const add = (text: string, was: string, is: string): void => void items.push({ text, before: was, after: is })
  for (const { before: was, now: app, gone } of pairs) {
    for (const root of was.roots) {
      if (app.roots.includes(root)) continue
      add(gone ? `删掉了应用 ${was.name}（改名也算删掉）：${field(was, 'roots')} 的模块根目录 "${root}" 不再管` : `${field(app, 'roots')} 删掉了模块根目录 "${root}"`, root, '')
    }
  }
  for (const key of ['shared', 'app'] as const) {
    for (const { before: was, now: app } of pairs) {
      for (const rule of widened(was[key], app[key])) add(`${field(app, key)} 扩大：新增 "${rule}"`, '', rule)
    }
  }
  for (const rule of widened(old.shared, scheme.shared)) add(`shared 扩大：新增 "${rule}"`, '', rule)
  for (const rule of widened(old.outside, scheme.outside)) add(`outside 扩大：新增 "${rule}"`, '', rule)
  for (const { before: was, now: app } of pairs) {
    for (const [rule, name] of Object.entries(app.map)) {
      if (Object.entries(was.map).some(([previous, module]) => module === name && covers(previous, rule))) continue
      const previous = was.map[rule]
      const key = field(app, 'map')
      add(previous === undefined ? `${key} 新增："${rule}" 归到 ${name} 模块` : `${key} 改了："${rule}" 从 ${previous} 模块改归 ${name} 模块`, previous ?? '', name)
    }
  }
  for (const { before: was, now: app, gone } of pairs) {
    // 删掉的应用已经按删掉 roots 算了
    if (!was.database || gone) continue
    const key = field(app, 'database')
    if (!app.database) {
      add(`删掉了 ${key}：数据库不再按模块检查`, databaseText(was.database), '')
      continue
    }
    for (const part of ['migrations', 'shared', 'login', 'migrator'] as const) {
      if (was.database[part] !== app.database[part]) add(`${key}.${part} 改了："${was.database[part]}" 改成 "${app.database[part]}"`, was.database[part], app.database[part])
    }
  }
  for (const { before: was, now: app } of pairs) {
    for (const name of app.entry) {
      if (!was.entry.includes(name)) add(`${field(app, 'entry')} 新增入口文件名 "${name}"`, '', name)
    }
  }
  for (const entry of scheme.allow) {
    const same = old.allow.some(previous => previous.rule === entry.rule && previous.from === entry.from && previous.to === entry.to && previous.reason === entry.reason)
    if (!same) add(`allow 新增例外：${entry.rule} ${entry.from} → ${entry.to}，理由：${entry.reason}`, '', JSON.stringify([entry.rule, entry.from, entry.to, entry.reason]))
  }
  return items
}
