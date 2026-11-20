// 这次改动的全貌：分叉点、改了哪些文件。清单按它挑命中的条目。

import { type Change, changesSince, forkPoint } from '../base/git.ts'
import { joined } from './config.ts'

export interface Snapshot {
  root: string
  base: string
  branch: string
  changes: Change[]
}

export type Opened = { snapshot: Snapshot } | { problem: string; code: 'notJoined' | 'usage' }

export function open(root: string): Opened {
  const base = forkPoint(root)
  if ('problem' in base) {
    // 找不到分叉点时只看工作区：没有 .testcraft/ 就是没接入
    if (!joined(root)) return { problem: '这个仓库没有接入 testcraft（没有 .testcraft/ 目录）', code: 'notJoined' }
    return { problem: base.problem, code: 'usage' }
  }
  if (!joined(root, base.commit)) return { problem: '这个仓库没有接入 testcraft（没有 .testcraft/ 目录）', code: 'notJoined' }
  return { snapshot: { root, base: base.commit, branch: base.branch, changes: changesSince(root, base.commit) } }
}
