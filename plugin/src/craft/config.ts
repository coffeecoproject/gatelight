// 项目约定："测试写法"自己的配置 .testcraft/config.json，和它要用的 testpace.json 里的命令、ignore。
// 两份都是评判用的配置，只经底座读（base/judging.ts），拿分叉点那一版和工作区现在这一版：
//   .testcraft/config.json 整份走"合并后才生效"——分支上放松的这次不算，加严的马上算（见 effectiveConfig）；
//   testpace.json 的 ignore 也按分叉点那一版认（change.ts）。三条命令用现在的：改命令要用户同意，由"跑测试"在整组前把关。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CONTRACT_FILE } from '../base/contract.ts'
import { hasFile } from '../base/git.ts'
import { type Judging, judgingFile } from '../base/judging.ts'

export const TESTCRAFT_DIR = '.testcraft'
export const CONFIG_PATH = `${TESTCRAFT_DIR}/config.json`
export const CHANGES_DIR = `${TESTCRAFT_DIR}/changes`
export const RULES_DIR = `${TESTCRAFT_DIR}/rules`
export const CHECKLIST_DIR = `${TESTCRAFT_DIR}/checklist`
export const TESTPACE_FILE = CONTRACT_FILE

export interface Config {
  /** 认作测试文件的路径规则（在常见命名之外补充）。 */
  tests: string[]
  /** 认作测试辅助文件的路径规则（只给测试用的代码、数据）。 */
  helpers: string[]
  /** 另外算作测试约定的文件（比如测试用的 compose 文件、测试脚本调到的配置）：改了要写理由。 */
  contract: string[]
  /** 不算测试这一侧的路径规则：名字、位置像测试，但项目的 files 命令不跑它（比如手动跑的练习脚本），或者其实是业务代码。 */
  notTests: string[]
  /** 每跑一次测试最多等多久。 */
  timeoutSeconds: number
}

export const DEFAULT_TIMEOUT_SECONDS = 900

const LISTS = ['tests', 'helpers', 'contract', 'notTests'] as const

export interface Loaded {
  config: Config
  problems: string[]
  /** 分支上改了、这次不算的地方（合并后才生效），说给 agent。 */
  deferred: string[]
}

const defaults = (): Config => ({ tests: [], helpers: [], contract: [], notTests: [], timeoutSeconds: DEFAULT_TIMEOUT_SECONDS })

/** 从文件内容读配置；没有这个文件就是默认值。 */
export function parseConfig(text: string | undefined): { config: Config; problems: string[] } {
  const config = defaults()
  if (text === undefined) return { config, problems: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { config, problems: [`${CONFIG_PATH} 不是合法的 JSON：${(error as Error).message}`] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { config, problems: [`${CONFIG_PATH} 应该是一个对象`] }
  const problems: string[] = []
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!['tests', 'helpers', 'contract', 'notTests', 'timeoutSeconds'].includes(key)) problems.push(`${CONFIG_PATH} 有未知字段 "${key}"`)
  }
  for (const key of LISTS) {
    const value = record[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) problems.push(`${CONFIG_PATH} 的 "${key}" 应该是路径规则的字符串数组`)
    else config[key] = value as string[]
  }
  const timeout = record.timeoutSeconds
  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || !(timeout > 0)) problems.push(`${CONFIG_PATH} 的 "timeoutSeconds" 应该是正数`)
    else config.timeoutSeconds = timeout
  }
  return { config, problems }
}

/**
 * 这次改动按哪份配置判：分支上的放松这次不算，合并后才生效；加严的马上算。
 *   tests、helpers、contract 是"多认一些文件归测试管"：分叉点上有的和现在有的都算（分支上删掉的这次仍然算）。
 *   notTests 是"这些不归测试管"：分叉点上和现在都有的才算（分支上新加的这次不算）。
 *   timeoutSeconds 只是等多久，不影响判断，用现在的。
 * 现在这一版写坏了要说出来；分叉点那一版写坏了的，按它读得出的部分算。
 */
export function effectiveConfig(judging: Judging): Loaded {
  const now = parseConfig(judging.now)
  const before = parseConfig(judging.before).config
  const deferred: string[] = []
  const config = defaults()
  for (const key of ['tests', 'helpers', 'contract'] as const) {
    config[key] = [...new Set([...before[key], ...now.config[key]])]
    const removed = before[key].filter(rule => !now.config[key].includes(rule))
    if (removed.length) deferred.push(`${CONFIG_PATH} 的 "${key}" 删掉了 ${removed.map(rule => `"${rule}"`).join('、')}：合并后才生效，这次改动仍按有它判`)
  }
  config.notTests = now.config.notTests.filter(rule => before.notTests.includes(rule))
  const added = now.config.notTests.filter(rule => !before.notTests.includes(rule))
  if (added.length) deferred.push(`${CONFIG_PATH} 的 "notTests" 新加了 ${added.map(rule => `"${rule}"`).join('、')}：合并后才生效，这次改动仍按没有它判`)
  config.timeoutSeconds = now.config.timeoutSeconds
  return { config, problems: now.problems, deferred }
}

/** fork 是分叉点的提交。 */
export function loadConfig(root: string, fork: string): Loaded {
  return effectiveConfig(judgingFile(root, fork, CONFIG_PATH))
}

/** 接入了：分叉点或工作区里有 .testcraft/。按分叉点也算，删掉目录躲不过检查。 */
export function joined(root: string, fork?: string): boolean {
  return existsSync(join(root, TESTCRAFT_DIR)) || (fork !== undefined && hasFile(root, fork, TESTCRAFT_DIR))
}

/** testpace.json 里"测试写法"要用的部分。 */
export interface TestpaceCommands {
  fast?: string
  files?: string
  full?: string
  /** 改了不影响测试的文件（文档这类）的路径规则。 */
  ignore: string[]
}

export function readTestpace(text: string | undefined): TestpaceCommands | undefined {
  if (text === undefined) return undefined
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const pick = (key: string): string | undefined => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined)
    const ignore = Array.isArray(raw.ignore) ? raw.ignore.filter((item): item is string => typeof item === 'string' && item !== '') : []
    return { fast: pick('fast'), files: pick('files'), full: pick('full'), ignore: ignore.map(item => item.replace(/^\.\//, '')) }
  } catch {
    return undefined
  }
}
