// 某份代码内容有没有整组通过的记录（方案 5.3、5.4）。

import type { RunRecord } from './store.ts'

export type Coverage =
  | { kind: 'exact'; run: RunRecord }
  | { kind: 'ignored'; run: RunRecord; changed: string[] }
  | { kind: 'none' }

/** 能当通过记录的整组：通过，而且跑的过程中代码没改过。 */
export function isValidPass(run: RunRecord): boolean {
  return run.kind === 'full' && run.result === 'pass' && run.tree === run.treeAtEnd
}

/** 只和最近这么多份通过的代码比较忽略路径，避免历史很长时逐个 diff。 */
const IGNORE_CANDIDATES = 20

/**
 * 先找内容完全一致的通过记录；没有的话，找相对它只改了 ignore 路径的最近一次。
 * diff 由调用方给（git diff-tree），这里不碰 git，方便单测。
 */
export function findCoverage(
  tree: string,
  runs: RunRecord[],
  isIgnored: (path: string) => boolean,
  diff: (from: string, to: string) => string[],
): Coverage {
  const passes = runs.filter(isValidPass).sort((a, b) => b.startedAt - a.startedAt)
  const exact = passes.find(run => run.tree === tree)
  if (exact) return { kind: 'exact', run: exact }

  const seen = new Set<string>()
  for (const run of passes) {
    if (seen.has(run.tree)) continue
    seen.add(run.tree)
    if (seen.size > IGNORE_CANDIDATES) break
    let changed: string[]
    try {
      changed = diff(run.tree, tree)
    } catch {
      continue // 树对象已被清理
    }
    if (changed.length > 0 && changed.every(isIgnored)) return { kind: 'ignored', run, changed }
  }
  return { kind: 'none' }
}
