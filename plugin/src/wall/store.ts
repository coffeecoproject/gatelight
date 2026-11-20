// "模块边界"要记的东西：检查的通过记录（按内容记）、会话开始时内容的样子、每个分支上一次查全了的越界、每次检查的日志。
// 都经底座存取（base/records.ts，文件在 .git/testpace/wall/ 下，所有 worktree 共用），这里只定记的是什么。
// 用户同意过的放宽项不在这里：归底座的用户确认（base/confirm.ts）。

import { hash, ModuleRecords } from '../base/records.ts'
import type { Repo } from '../base/repo.ts'
import { newRunId } from '../base/store.ts'

export interface PassRecord {
  at: number
}

export interface SessionRecord {
  /** 会话开始时的内容摘要（contentKey）。 */
  fingerprint: string
  at: number
}

/** 一个分支上一次查全了的检查：下一次据此算改正了哪些越界。 */
export interface LastCheck {
  violations: string[]
  at: number
}

export interface Store {
  /** modwall check 的通过记录，按当时的内容记，内容变了就对不上。 */
  passes: ModuleRecords<PassRecord>
  /** 会话开始时内容的样子：停止门只管这个会话改过的。 */
  sessions: ModuleRecords<SessionRecord>
  /** 按分支记。 */
  last: ModuleRecords<LastCheck>
  /** 新日志的路径（底座只留最近的若干份）。 */
  logPath(name: string): string
}

const MODULE = 'wall'

export function openStore(repo: Repo): Store {
  return {
    passes: new ModuleRecords(repo.store, MODULE, 'passes'),
    sessions: new ModuleRecords(repo.store, MODULE, 'sessions'),
    last: new ModuleRecords(repo.store, MODULE, 'last'),
    logPath: name => repo.store.logPath(`${newRunId(Date.now())}-${name}`),
  }
}

/** 分支名当记录的键：取摘要，名字里有什么字符都不要紧。 */
export const branchKey = (branch: string): string => hash('branch', branch)
