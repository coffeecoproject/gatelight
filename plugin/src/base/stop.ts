// 停止门：agent 要结束这一轮时，这个会话起的整组还在跑、或跑完还没看结果，就拦一次。
// 各模块在这个会话里还没处理完的事（module.ts 的 unfinished，比如改了代码还没有 modwall check 的通过记录），每件也拦一次。
// 每次整组只拦一次（还在跑时一次、跑完没看结果时一次），拦过的记在会话状态里，不靠 agent 给的 stop_hook_active：
// 有的 agent 不给或总是 false，靠它会反复拦。
// 谁起的整组看记录里的会话号（testpace full 从命令环境里 agent 的会话号记下，见 agent.ts）；
// 想跑整组时发现同一个工作区已经在跑、等着用它结果的会话也算。别的会话或用户在终端里起的不管。
// 顺带检查本地和远程（origin）默认分支在这个会话里有没有落了没测过的代码，有就提示用户：
// 合并门只在 agent 移动本地默认分支时把关，推送别的分支到默认分支、在 GitHub 上合并 PR 不经过它。
// 这一项和合并门一样看提交里的 testpace.json：管不管、按哪些 ignore 判断，都不看工作区里的文件。

import { contractAt, CONTRACT_FILE, effectiveIgnore, joined } from './contract.ts'
import { duration, short, when } from './format.ts'
import { hasFile, refTip } from './git.ts'
import { modules } from './module.ts'
import { coverageOf, defaultTips, openRepo } from './repo.ts'

export interface StopInput {
  sessionId: string
  cwd: string
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
  if (!repo || !joined(repo.root)) return {}
  const session = repo.store.session(input.sessionId, input.now, () => defaultTips(repo))
  const result: StopResult = {}
  const place = input.named ? `${repo.root} 这个工作区` : '这个工作区'

  const blocked = [...(session.blocked ?? [])]
  const ours = (record: { kind: string; worktree: string; session?: string; waiting?: string[] }): boolean =>
    record.kind === 'full' &&
    record.worktree === repo.root &&
    (record.session === input.sessionId || record.waiting?.includes(input.sessionId) === true)
  const running = repo.store.running().find(marker => ours({ ...marker, waiting: repo.store.waiting(marker) }))
  const last = repo.store
    .readRuns()
    .filter(ours)
    .sort((a, b) => b.startedAt - a.startedAt)[0]
  if (running && !blocked.includes(`running:${running.id}`)) {
    blocked.push(`running:${running.id}`)
    result.block = `${place}的整组还在跑（开始于 ${when(running.startedAt)}，已 ${duration(input.now - running.startedAt)}）。结论要等整组结果：等它结束后跑 testpace status 看结果，再收尾。`
  } else if (!running && last && last.startedAt + last.durationMs > (session.read?.[repo.root] ?? 0) && !blocked.includes(`unread:${last.id}`)) {
    blocked.push(`unread:${last.id}`)
    const outcome = last.result === 'pass' ? '通过' : '失败'
    const verb = last.session === input.sessionId ? '跑' : '等'
    result.block = `这个会话${input.named ? `在 ${repo.root} ` : ''}${verb}的整组已经结束（${outcome}），还没看结果。先跑 testpace status 看结果，再收尾。`
  }

  // 各模块在这个会话里还没处理完的事（比如认出的时好时坏测试）：每件拦一次，免得一句带过
  const moduleProblems: string[] = []
  for (const module of modules()) {
    if (result.block) break
    let left: ReturnType<NonNullable<typeof module.unfinished>>
    try {
      left = module.unfinished?.(repo, input.sessionId, blocked, input.named === true)
    } catch (error) {
      // 一个模块出错不挡别的检查，但要让人看得到
      moduleProblems.push(`testpace：停止门里"${module.name}"这一项检查出错，这次没查它（${(error as Error).message.split('\n')[0]}）。`)
      continue
    }
    if (!left) continue
    blocked.push(...left.keys)
    result.block = left.text
  }

  // 没经过合并门的落地：默认分支在这个会话里有了新提交，却没有整组通过记录
  const warned = [...session.warned]
  const warns: string[] = [...moduleProblems]
  for (const [ref, commit] of Object.entries(defaultTips(repo))) {
    if (commit === session.tipsAtStart[ref] || warned.includes(commit)) continue
    const tip = refTip(repo.root, ref)
    if (!tip) continue
    // 和合并门一样：会话开始时它指向的代码或现在的代码里有 testpace.json 才管
    const contract = contractAt(repo.root, tip.commit)
    const start = session.tipsAtStart[ref]
    if (!contract && !(start && hasFile(repo.root, start, CONTRACT_FILE))) continue
    // ignore 按会话开始时默认分支上那份认（和合并门一样：新加的规则落地以后才生效）
    if (coverageOf(repo, effectiveIgnore(contract, start ? contractAt(repo.root, start) : undefined), tip.tree).kind !== 'none') continue
    warned.push(commit)
    const name = ref.replace(/^refs\/(heads|remotes)\//, '')
    const how = ref.startsWith('refs/heads/') ? '可能不是 agent 提交的（合并门只管 agent 的命令），或者合并门没装上' : '可能是推送了别的分支到默认分支，或者在 GitHub 上合并了 PR'
    warns.push(`testpace：${input.named ? `${repo.root} 的 ` : ''}${name} 的最新提交 ${short(commit)} 没有整组通过记录（${how}）。`)
  }
  if (warns.length > 0) result.warn = warns.join('\n')
  if (warns.length > 0 || result.block) repo.store.saveSession(input.sessionId, { ...session, warned, blocked })
  return result
}
