// 停止门（方案 5.3）：agent 要结束这一轮时，这个会话起的整组还在跑、或跑完还没看结果，就拦一次。
// 顺带检查默认分支的最新提交有没有整组通过记录，发现绕过合并门的提交时提示用户。

import { duration, short, when } from './format.ts'
import { branchTip, defaultBranch } from './git.ts'
import { contractOf, coverageOf, openRepo, type Repo } from './repo.ts'

export interface StopInput {
  sessionId: string
  cwd: string
  /** 这一轮已经因为停止 hook 继续过一次：不再拦，避免死循环。 */
  active: boolean
  now: number
}

export interface StopResult {
  /** 拦下来时给 agent 的话。 */
  block?: string
  /** 给用户看的提示。 */
  warn?: string
}

export function stopCheck(input: StopInput): StopResult {
  const repo = openRepo(input.cwd)
  const config = repo && contractOf(repo)
  if (!repo || !config) return {}
  const session = repo.store.session(input.sessionId, input.now, () => defaultTip(repo))
  const result: StopResult = {}

  if (!input.active) {
    const running = repo.store.running().find(marker => marker.kind === 'full' && marker.worktree === repo.root && marker.startedAt >= session.startedAt)
    const last = repo.store
      .readRuns()
      .filter(run => run.kind === 'full' && run.worktree === repo.root && run.startedAt >= session.startedAt)
      .sort((a, b) => b.startedAt - a.startedAt)[0]
    if (running) {
      result.block = `这个工作区的整组还在跑（开始于 ${when(running.startedAt)}，已 ${duration(input.now - running.startedAt)}）。结论要等整组结果：等它结束后跑 testpace status 看结果，再收尾。`
    } else if (last && last.startedAt + last.durationMs > repo.store.readAt(repo.root)) {
      const outcome = { pass: '通过', fail: '失败', interrupted: '被中断' }[last.result]
      result.block = `这个会话跑的整组已经结束（${outcome}），还没看结果。先跑 testpace status 看结果，再收尾。`
    }
  }

  // 绕过合并门的落地：默认分支在这个会话里有了新提交，却没有整组通过记录
  const branch = defaultBranch(repo.root)
  const tip = branch && branchTip(repo.root, branch)
  if (branch && tip && tip.commit !== session.tipAtStart && !session.warned.includes(tip.commit)) {
    if (coverageOf(repo, config, tip.tree).kind === 'none') {
      result.warn = `testpace：${branch} 的最新提交 ${short(tip.commit)} 没有整组通过记录，可能绕过了合并门（比如在脚本里调用 git）。`
      repo.store.saveSession(input.sessionId, { ...session, warned: [...session.warned, tip.commit] })
    }
  }
  return result
}

/** 默认分支现在的最新提交。 */
export function defaultTip(repo: Repo): string | undefined {
  const branch = defaultBranch(repo.root)
  return branch ? branchTip(repo.root, branch)?.commit : undefined
}
