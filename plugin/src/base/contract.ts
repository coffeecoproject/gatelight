// 项目的约定文件 testpace.json，底座看到的部分：接没接入、哪些路径不影响结果（ignore）、整个文件有没有问题。
// 别的字段归各模块（见 module.ts 的 fields、contractProblems），底座只把它们的问题合到一起。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileAt } from './git.ts'
import { modules } from './module.ts'

export const CONTRACT_FILE = 'testpace.json'

export interface Contract {
  /** 不影响结果的路径规则。文件写坏了读不出来时为空（按没有 ignore 算：要内容完全一致的通过记录）。 */
  ignore: string[]
  /** 文件的内容；不是合法的 JSON 对象时没有。 */
  raw?: Record<string, unknown>
  /** 约定的问题：格式不对、未知字段、ignore 写错，和各模块对自己字段的检查。有问题时整组跑不了。 */
  problems: string[]
}

/** 工作区接入了：根目录有 testpace.json。写坏了也算接入，问题由命令和会话说明讲出来。 */
export function joined(root: string): boolean {
  return existsSync(join(root, CONTRACT_FILE))
}

/** 工作区里的约定；没接入返回 undefined。 */
export function loadContract(root: string): Contract | undefined {
  return joined(root) ? readContract(readFileSync(join(root, CONTRACT_FILE), 'utf8')) : undefined
}

/**
 * 一个提交自己带的约定（提交里的 testpace.json）；提交里没有这个文件返回 undefined。
 * 合并门、停止门判断落到默认分支的代码时用它，不看工作区里的文件：工作区里没提交的改动、
 * 别的分支检出的旧文件都不该影响判断。
 */
export function contractAt(root: string, rev: string): Contract | undefined {
  const text = fileAt(root, rev, CONTRACT_FILE)
  return text === undefined ? undefined : readContract(text)
}

/** 从 testpace.json 的内容读约定（工作区里的文件，或某个提交里的那份）。 */
export function readContract(text: string): Contract {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ignore: [], problems: [`${CONTRACT_FILE} 不是合法的 JSON：${(error as Error).message}`] }
  }
  return parseContract(raw)
}

export function parseContract(raw: unknown): Contract {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ignore: [], problems: [`${CONTRACT_FILE} 应该是一个对象`] }
  }
  const record = raw as Record<string, unknown>
  const problems: string[] = []
  const known = new Set(['ignore', ...modules().flatMap(module => module.fields ?? [])])
  for (const key of Object.keys(record)) {
    if (!known.has(key)) problems.push(`未知字段 "${key}"`)
  }
  for (const module of modules()) problems.push(...(module.contractProblems?.(record) ?? []))
  let ignore: string[] = []
  if (record.ignore !== undefined) {
    if (!Array.isArray(record.ignore) || record.ignore.some(item => typeof item !== 'string' || item === '')) {
      problems.push('"ignore" 应该是路径规则的字符串数组')
    } else {
      ignore = record.ignore as string[]
    }
  }
  return { ignore, raw: record, problems }
}
