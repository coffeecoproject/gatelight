// 检查员复查的这段时间。复查中会改测试，测试每改一次，证明和放水检查的记录就对不上一次：
// 中间重跑的，下一轮一改就作废。所以复查前先跑过一次（检查员要看输出），testcraft review start 记下"复查中"；
// 到 testcraft review done 之前停止门不催这两项（见 session.ts），问题都改完后再跑一次。
// 记在工作目录的这次改动上（分叉点变了就是换了任务，上一次没结束的复查不算）。

import { onTestSide, type Snapshot } from './change.ts'
import { guardsFor, proofKey, proveTargets } from './prove.ts'
import { readRecords } from './records.ts'
import { hash, type Store } from './store.ts'
import { behaviorUnits, staticSignals, weakenKey } from './weaken.ts'

export function reviewKey(s: Snapshot): string {
  return hash(s.root, s.base)
}

export function reviewing(s: Snapshot, store: Store): boolean {
  return store.reviews.get(reviewKey(s)) !== undefined
}

/** 这份改动还缺的检查：有要写理由的地方却没有放水检查通过的记录，有要证明的测试还没证明。只查记录，不跑测试。 */
export function missingChecks(s: Snapshot, store: Store): string[] {
  const signals = staticSignals(s)
  if (!s.changes.some(onTestSide) && signals.length === 0) return []
  const todo: string[] = []
  const needsWeaken = signals.length > 0 || behaviorUnits(s).length > 0
  if (needsWeaken && store.weaken.get(weakenKey(s))?.result !== 'pass') todo.push('testcraft weaken（放水检查）')
  const records = readRecords(s.root, s.changes)
  const unproven = proveTargets(s).filter(target => !store.proofs.get(proofKey(s, target, guardsFor(records, target))))
  if (unproven.length) todo.push(`testcraft prove（还没证明能抓错：${unproven.map(target => target.change.path).join('、')}）`)
  return todo
}
