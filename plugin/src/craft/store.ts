// "测试写法"要记的东西：证明和放水检查的结果（按内容记），会话开始时测试的样子，开着的复查，日志。
// 都经底座存取（base/records.ts，文件在 .git/testpace/craft/ 下，所有 worktree 共用），这里只定记的是什么。
// 用户过目同意的记录不在这里：归底座的用户确认（base/confirm.ts）。

import { hash, ModuleRecords } from '../base/records.ts'
import type { Repo } from '../base/repo.ts'
import { newRunId } from '../base/store.ts'

export interface ProofRecord {
  test: string
  method: 'revert' | 'mutant'
  detail: string
  /** 证明二里，发现之前它没发现的几处破坏：给检查员作补测试的线索。 */
  missed?: string[]
  at: number
}

/** 一个文件里要给用户过目的放水（几种合成一项）。 */
export interface UserReview {
  /** 文件现在的路径。 */
  path: string
  /** 改名前的路径。 */
  oldPath?: string
  /** 给用户看的文件名；改了名的写"旧 → 新"。 */
  file: string
  /** 看到的改动，每种一句白话。 */
  seen: string[]
  /** 改动记录"## 给用户过目"里写的说明。 */
  plain: string
}

export interface WeakenRecord {
  result: 'pass' | 'fail'
  /** 通过时，用户判断得了的那几种放水（按文件合并）：合并前要给用户过目。 */
  review?: UserReview[]
  at: number
}

export interface SessionRecord {
  /** 会话开始时测试这一侧的样子。 */
  fingerprint: string
  /** 会话开始时清单命中的文件和改动记录的样子。 */
  checklist?: string
  at: number
}

/** 开着的复查（见 review.ts）：有这条就是复查中，结束时去掉。 */
export interface ReviewRecord {
  at: number
}

export interface Store {
  proofs: ModuleRecords<ProofRecord>
  weaken: ModuleRecords<WeakenRecord>
  sessions: ModuleRecords<SessionRecord>
  reviews: ModuleRecords<ReviewRecord>
  /** 新日志的路径（底座只留最近的若干份）。 */
  logPath(name: string): string
}

const MODULE = 'craft'

export function openStore(repo: Repo): Store {
  return {
    proofs: new ModuleRecords(repo.store, MODULE, 'proofs'),
    weaken: new ModuleRecords(repo.store, MODULE, 'weaken'),
    sessions: new ModuleRecords(repo.store, MODULE, 'sessions'),
    reviews: new ModuleRecords(repo.store, MODULE, 'reviews'),
    logPath: name => repo.store.logPath(`${newRunId(Date.now())}-${name}`),
  }
}

/** 内容摘要用底座的那一份。 */
export { hash }
