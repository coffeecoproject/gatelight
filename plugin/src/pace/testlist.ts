// 认一个测试，和按测试记的两份名单：时好时坏的测试、连着几轮没过的测试。
// 存在底座的记录目录里（.git/testpace/ 下的 flaky/、rounds/），读写都在这里，底座不认识这两份名单。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Store, worktreeKey, writeWhole } from '../base/store.ts'

/** files 的参数可以是 文件:行号，只跑那一行的测试；测试框架输出里常见的 文件:行号:列号 也算。 */
export const LOCATED = /:\d+(?::\d+)?$/

/** files 的一个参数对应的测试文件。 */
export function testFile(target: string): string {
  return target.replace(LOCATED, '')
}

/** 一个测试：文件（相对仓库根目录）和带外层分组的名字认它；行号用来显示和重跑。 */
export interface TestId {
  file: string
  line?: number
  name: string
}

/** 时好时坏名单上的一个测试。 */
export interface FlakyTest extends TestId {
  /** 怎么认出来的：同一份代码上先没过后过了（或连跑时前面过了后面没过），还是框架重试后才过。 */
  how: 'reran' | 'retried'
  foundAt: number
  tree: string
  worktree: string
  /** 没过那次的日志。重试后才过的就是通过那次的日志。 */
  failLog: string
  passLog: string
  /** 认出它的 agent 会话。 */
  session?: string
}

/** 一个测试在一个工作区里连着几轮没过：每轮的代码、日志、时间。 */
export interface Rounds extends TestId {
  rounds: Array<{ tree: string; log: string; at: number }>
}

/** 名单、计数里认同一个测试用的键。 */
export function testKey(test: Pick<TestId, 'file' | 'name'>): string {
  return `${test.file}\0${test.name}`
}

function flakyDir(store: Store): string {
  return join(store.dir, 'flaky')
}

function flakyPath(store: Store, test: Pick<TestId, 'file' | 'name'>): string {
  return join(flakyDir(store), `${createHash('sha1').update(testKey(test)).digest('hex').slice(0, 16)}.json`)
}

/** 时好时坏的名单，先认出的在前。一个测试一份文件：几个工作区同时跑完时各写各的，不会互相覆盖。 */
export function flakyTests(store: Store): FlakyTest[] {
  if (!existsSync(flakyDir(store))) return []
  const list: FlakyTest[] = []
  for (const name of readdirSync(flakyDir(store)).filter(name => name.endsWith('.json'))) {
    try {
      list.push(JSON.parse(readFileSync(join(flakyDir(store), name), 'utf8')) as FlakyTest)
    } catch {
      // 写坏了的跳过
    }
  }
  return list.sort((a, b) => a.foundAt - b.foundAt)
}

export function addFlaky(store: Store, test: FlakyTest): void {
  mkdirSync(flakyDir(store), { recursive: true })
  writeWhole(flakyPath(store, test), JSON.stringify(test))
}

export function removeFlaky(store: Store, test: Pick<TestId, 'file' | 'name'>): void {
  rmSync(flakyPath(store, test), { force: true })
}

/** 这个工作区里连着没过的测试，按 testKey。同一个工作区一次只跑一轮，读写不会撞上。 */
export function readRounds(store: Store, worktree: string): Record<string, Rounds> {
  try {
    return JSON.parse(readFileSync(join(store.dir, 'rounds', `${worktreeKey(worktree)}.json`), 'utf8')) as Record<string, Rounds>
  } catch {
    return {}
  }
}

export function saveRounds(store: Store, worktree: string, rounds: Record<string, Rounds>): void {
  mkdirSync(join(store.dir, 'rounds'), { recursive: true })
  writeWhole(join(store.dir, 'rounds', `${worktreeKey(worktree)}.json`), JSON.stringify(rounds))
}
