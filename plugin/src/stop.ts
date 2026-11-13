// 停止门：agent 要结束这一轮时，这个会话起的整组还在跑、或跑完还没看结果，就拦一次。
// 谁起的整组看记录里的会话号（testpace full 从命令环境的 CLAUDE_CODE_SESSION_ID 记下）；
// 想跑整组时发现同一个工作区已经在跑、等着用它结果的会话也算。别的会话或用户在终端里起的不管。
// 顺带检查默认分支的最新提交有没有整组通过记录，发现绕过合并门的提交时提示用户。

import { duration, short, when } from './format.ts'
import { branchTip, defaultBranch } from './git.ts'
import { contractOf, coverageOf, openRepo, type Repo } from './repo.ts'

export interface StopInput {
  sessionId: string
  cwd: string
  /** 这一轮已经因为停止 hook 继续过一次：不再拦，避免死循环。 */
  active: boolean
  /** 仓库不是会话所在目录的（会话从仓库外开始），话里写上是哪个仓库。 */
  named?: boolean
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
  const place = input.named ? `${repo.root} 这个工作区` : '这个工作区'

  if (!input.active) {
    const ours = (record: { kind: string; worktree: string; session?: string; waiting?: string[] }): boolean =>
      record.kind === 'full' &&
      record.worktree === repo.root &&
      (record.session === input.sessionId || record.waiting?.includes(input.sessionId) === true)
    const running = repo.store.running().find(ours)
    const last = repo.store
      .readRuns()
      .filter(ours)
      .sort((a, b) => b.startedAt - a.startedAt)[0]
    if (running) {
      result.block = `${place}的整组还在跑（开始于 ${when(running.startedAt)}，已 ${duration(input.now - running.startedAt)}）。结论要等整组结果：等它结束后跑 testpace status 看结果，再收尾。`
    } else if (last && last.startedAt + last.durationMs > repo.store.readAt(repo.root)) {
      const outcome = { pass: '通过', fail: '失败', interrupted: '被中断' }[last.result]
      const verb = last.session === input.sessionId ? '跑' : '等'
      result.block = `这个会话${input.named ? `在 ${repo.root} ` : ''}${verb}的整组已经结束（${outcome}），还没看结果。先跑 testpace status 看结果，再收尾。`
    }
  }

  // 绕过合并门的落地：默认分支在这个会话里有了新提交，却没有整组通过记录
  const branch = defaultBranch(repo.root)
  const tip = branch && branchTip(repo.root, branch)
  if (branch && tip && tip.commit !== session.tipAtStart && !session.warned.includes(tip.commit)) {
    if (coverageOf(repo, config, tip.tree).kind === 'none') {
      result.warn = `testpace：${input.named ? `${repo.root} 的 ` : ''}${branch} 的最新提交 ${short(tip.commit)} 没有整组通过记录，可能绕过了合并门（比如在脚本里调用 git）。`
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
