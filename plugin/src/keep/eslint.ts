// eslint 生效的规则：对仓库里每个代码文件，用项目自己装的 eslint 的程序接口（ESLint 的 calculateConfigForFile、isPathIgnored）
// 算它实际用的规则，分叉点那一版和现在比（eslint 的配置是代码，读文件读不出规则）。路径都传绝对路径：相对路径会被当成忽略。
// 每个文件都算，不挑代表文件：按目录加的覆盖、忽略，挑代表文件会漏。实测 1500 个文件 0.3 秒。
// 算放松的：规则没了、关了、error 降成 warn；上限类规则（行数、复杂度、嵌套、参数）数字调大；别的规则改了参数（判断不了方向）；
// 文件变成不被 lint（被忽略、配置不再覆盖它）；reportUnusedDisableDirectives 降级或关掉；noInlineConfig 关掉（代码里的注释又能就地关规则）。
// 新加规则、调严的不算。
// 只比两边都有的文件：这次新加的文件没有"原来"。

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConfirmItem } from '../base/confirm.ts'

/** 一个文件生效的规则；不被 lint（被忽略、配置没覆盖它）时是 undefined。 */
export interface Effective {
  /** 规则名 → [级别 0/1/2, ...参数]。 */
  rules: Record<string, unknown[]>
  /** 没用的 eslint-disable 注释报不报：0 关、1 警告、2 报错。 */
  unusedDirectives: number
  /** 代码里就地关规则、改配置的注释（eslint-disable 和 eslint 规则: off 这类）不起作用。 */
  noInlineConfig: boolean
}

/** 文件（相对仓库根目录）→ 生效的规则。 */
export type FileRules = Map<string, Effective | undefined>

/** eslint 查的代码文件。 */
export const isCode = (path: string): boolean => /\.[cm]?[jt]sx?$/.test(path)

interface EslintInstance {
  isPathIgnored(path: string): Promise<boolean>
  calculateConfigForFile(path: string): Promise<{ rules?: Record<string, unknown>; linterOptions?: { reportUnusedDisableDirectives?: unknown; noInlineConfig?: unknown } } | undefined>
}
type EslintClass = new (options: { cwd: string; overrideConfigFile: string }) => EslintInstance

/** 项目自己装的 eslint：从工作区里配置文件所在的目录往上找（根目录装的也找得到）。找不到时抛错。 */
export async function loadEslint(root: string, config: string): Promise<EslintClass> {
  const require = createRequire(join(root, dirname(config), 'noop.js'))
  let entry: string
  try {
    entry = require.resolve('eslint')
  } catch {
    throw new Error('项目里没装 eslint（从配置文件所在的目录往上找不到），先装好依赖')
  }
  const module = (await import(pathToFileURL(entry).href)) as { ESLint?: EslintClass }
  if (typeof module.ESLint !== 'function') throw new Error(`${entry} 里没有 ESLint 的程序接口`)
  return module.ESLint
}

/** 级别写法统一成数字。 */
function level(value: unknown): number {
  if (value === 'error' || value === 2) return 2
  if (value === 'warn' || value === 1) return 1
  if (value === true) return 2
  return 0
}

/** 在 tree（仓库或分叉点的临时 worktree）里算这些文件（相对 tree）生效的规则。算不出来时抛错。 */
export async function fileRules(eslint: EslintClass, tree: string, config: string, files: string[]): Promise<FileRules> {
  const instance = new eslint({ cwd: tree, overrideConfigFile: join(tree, config) })
  const result: FileRules = new Map()
  for (const file of files) {
    const path = join(tree, file)
    if (await instance.isPathIgnored(path)) {
      result.set(file, undefined)
      continue
    }
    const computed = await instance.calculateConfigForFile(path)
    if (!computed) {
      result.set(file, undefined)
      continue
    }
    const rules: Record<string, unknown[]> = {}
    for (const [name, setting] of Object.entries(computed.rules ?? {})) {
      const [severity, ...options] = Array.isArray(setting) ? setting : [setting]
      rules[name] = [level(severity), ...options]
    }
    const options = computed.linterOptions
    result.set(file, { rules, unusedDirectives: level(options?.reportUnusedDisableDirectives), noInlineConfig: options?.noInlineConfig === true })
  }
  return result
}

/** 键按字母排的 JSON：参数一样、写的顺序不同算一样。 */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  )
}

/** 上限类规则：数字越大越松。what 是白话的名字，unit 是单位，then 是调大以后意味着什么；fallback 是不写数字时规则自己的默认值。 */
const LIMITS: Record<string, { what: string; unit: string; then: string; fallback: number }> = {
  'max-lines': { what: '单个文件的行数上限', unit: '行', then: '以后一个文件可以写得更长，更难读', fallback: 300 },
  'max-lines-per-function': { what: '函数长度上限', unit: '行', then: '以后一个函数可以写得更长，更难读', fallback: 50 },
  complexity: { what: '函数复杂度上限（分支的多少）', unit: '', then: '以后一个函数里可以有更多分支，更难读、更难测', fallback: 20 },
  'max-depth': { what: '代码嵌套层数上限', unit: '层', then: '以后代码可以嵌套得更深，更难读', fallback: 4 },
  'max-params': { what: '函数参数个数上限', unit: '个', then: '以后函数可以带更多参数，更难用对', fallback: 3 },
  'max-nested-callbacks': { what: '回调嵌套层数上限', unit: '层', then: '以后回调可以套得更深，更难读', fallback: 10 },
}

/** 常见规则的白话说明：弹窗给用户看，用户不认得规则名。没列的只写规则名。 */
const RULE_PLAIN: Record<string, string> = {
  '@eslint-community/eslint-comments/require-description': '"这里不查"的注释要写理由',
  '@eslint-community/eslint-comments/no-unused-disable': '用不上的"这里不查"注释要删掉',
  '@typescript-eslint/ban-ts-comment': '不许用注释关掉类型检查',
  '@typescript-eslint/no-explicit-any': '不许用 any 跳过类型',
  '@typescript-eslint/no-unused-vars': '不许有没用的变量和导入',
  '@typescript-eslint/no-non-null-assertion': '不许用 ! 断定值不为空',
  'no-unused-vars': '不许有没用的变量',
  'no-console': '不许留调试用的 console',
  'no-debugger': '不许留 debugger',
  eqeqeq: '比较要用 === 不用 ==',
  'react-hooks/rules-of-hooks': 'React hooks 的调用规则',
  'react-hooks/exhaustive-deps': 'React hooks 的依赖要写全',
}

/** 规则在弹窗里的叫法：白话（规则名），没有白话的只写规则名。 */
export function ruleName(rule: string): string {
  const plain = RULE_PLAIN[rule] ?? LIMITS[rule]?.what
  return plain ? `${plain}（${rule}）` : rule
}

/** 上限类规则的数字和别的参数（别的参数改了判断不了方向）。 */
function limitOf(rule: string, options: unknown[]): { max: number; rest: string } {
  const [first] = options
  if (typeof first === 'number') return { max: first, rest: stable(options.slice(1)) }
  if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
    const { max, maximum, ...rest } = first as Record<string, unknown>
    const value = typeof max === 'number' ? max : typeof maximum === 'number' ? maximum : LIMITS[rule]!.fallback
    return { max: value, rest: stable([rest, ...options.slice(1)]) }
  }
  return { max: LIMITS[rule]!.fallback, rest: stable(options.slice(1)) }
}

const LEVEL_NAMES = ['关掉', '警告', '报错']

/** 一处放松：同一处改动出现在几个文件上时合成一项。 */
interface Change {
  before: string
  after: string
  text: string
}

/** 一个文件上规则的放松（before 是分叉点那一版，now 是现在，两边都被 lint）。 */
function changesOf(before: Effective, now: Effective): Change[] {
  const changes: Change[] = []
  for (const [rule, was] of Object.entries(before.rules)) {
    const [wasLevel = 0, ...wasOptions] = was as [number, ...unknown[]]
    if (wasLevel === 0) continue
    const is = now.rules[rule]
    const [isLevel = 0, ...isOptions] = (is ?? [0]) as [number, ...unknown[]]
    const pair = { before: stable(['rule', rule, was]), after: stable(['rule', rule, is ?? null]) }
    if (isLevel === 0) {
      changes.push({ ...pair, text: `lint 规则 ${ruleName(rule)} ${is ? '关掉了' : '没了'}：以后不再查这一条` })
      continue
    }
    if (isLevel < wasLevel) {
      changes.push({ ...pair, text: `lint 规则 ${ruleName(rule)} 从报错降成了警告：以后违反它也能通过检查` })
      continue
    }
    const limit = LIMITS[rule]
    if (limit) {
      const old = limitOf(rule, wasOptions)
      const current = limitOf(rule, isOptions)
      if (old.rest !== current.rest) changes.push({ ...pair, text: changedText(rule, wasOptions, isOptions) })
      else if (current.max > old.max) {
        const unit = limit.unit ? ` ${limit.unit}` : ' '
        changes.push({ ...pair, text: `${limit.what}（${rule}）从 ${old.max}${unit}调到 ${current.max}${unit.trimEnd()}：${limit.then}` })
      }
      continue
    }
    if (stable(wasOptions) !== stable(isOptions)) changes.push({ ...pair, text: changedText(rule, wasOptions, isOptions) })
  }
  if (now.unusedDirectives < before.unusedDirectives) {
    changes.push({
      before: stable(['unusedDirectives', before.unusedDirectives]),
      after: stable(['unusedDirectives', now.unusedDirectives]),
      text: `没用了的"这里不查"注释（eslint-disable）从${LEVEL_NAMES[before.unusedDirectives]}改成${LEVEL_NAMES[now.unusedDirectives]}（reportUnusedDisableDirectives）：以后用不上的这类注释可以留在代码里`,
    })
  }
  if (before.noInlineConfig && !now.noInlineConfig) {
    changes.push({
      before: stable(['noInlineConfig', true]),
      after: stable(['noInlineConfig', false]),
      text: '代码里就地关规则的注释（eslint-disable、/* eslint 规则: off */）从不起作用改成起作用（关掉了 noInlineConfig）：以后在代码里写一句注释就能关掉规则，不用改配置',
    })
  }
  return changes
}

function changedText(rule: string, was: unknown[], is: unknown[]): string {
  return [`lint 规则 ${ruleName(rule)} 的参数改了，程序看不出是改松还是改紧`, `原来：${stable(was)}`, `现在：${stable(is)}`].join('\n')
}

/** 列出来的文件最多几个。 */
const SHOWN = 20

/** 几个文件说成一句：个数，太多的只列前几个。files 已排好序。 */
export function fileList(files: string[], shown = 3): string {
  return files.length <= shown ? files.join('、') : `${files.slice(0, shown).join('、')} 等 ${files.length} 个文件`
}

/**
 * 两边都有的文件上的放松：同一处规则改动合成一项，写明影响多少文件；原来被 lint、现在不被 lint 的文件合成一项。
 * 文字里的文件只取分叉点上就有的，这次新加文件不会让同意过的项重问。
 */
export function eslintItems(before: FileRules, now: FileRules): ConfirmItem[] {
  const merged = new Map<string, { change: Change; files: string[] }>()
  const dropped: string[] = []
  for (const [file, rules] of now) {
    const was = before.get(file)
    if (!was) continue
    if (!rules) {
      dropped.push(file)
      continue
    }
    for (const change of changesOf(was, rules)) {
      const key = `${change.before}\0${change.after}`
      const found = merged.get(key)
      if (found) found.files.push(file)
      else merged.set(key, { change, files: [file] })
    }
  }
  const items: ConfirmItem[] = [...merged.values()].map(({ change, files }) => ({
    before: change.before,
    after: change.after,
    text: `${change.text}\n影响的代码：${fileList(files.sort())}`,
  }))
  if (dropped.length) {
    dropped.sort()
    items.push({
      before: stable(['linted', dropped]),
      after: stable(['not-linted', dropped]),
      text: [
        `${dropped.length} 个文件不再被 lint（被忽略了，或 eslint 配置不再覆盖它们）：以后这些代码 lint 一条也不查`,
        ...dropped.slice(0, SHOWN),
        ...(dropped.length > SHOWN ? [`……还有 ${dropped.length - SHOWN} 个`] : []),
      ].join('\n'),
    })
  }
  return items
}
