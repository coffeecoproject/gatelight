// Claude Code hook 的判断：SessionStart 注入节奏说明，PreToolUse 跑合并门和软提示，
// PostToolUse 记下 agent 在前台看到了整组结果，Stop 跑停止门。
// 入口在 plugin/hooks/testpace.ts。

import { basename } from 'node:path'
import { checkCommand } from './gate.ts'
import { contractOf, openRepo, type Repo } from './repo.ts'
import { noteSessionRepos, sessionRepos } from './sessions.ts'
import { invocations } from './shell.ts'
import { defaultTip, stopCheck } from './stop.ts'
import type { SessionState } from './store.ts'

interface HookInput {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: { command?: unknown; run_in_background?: unknown }
  tool_response?: unknown
  stop_hook_active?: boolean
}

/** 测试节奏说明。会话从仓库外（比如上一级目录）开始时，说明里写上是哪个仓库。 */
export function rhythm(repo = '这个仓库'): string {
  return [
    `${repo}用 testpace 管测试节奏（testpace.json）：`,
    '1. 改完先跑 testpace focused：fast 检查加上和改动相关的测试。它提示跑整组时照做。',
    '2. 一个阶段做完，就把 testpace full 放到后台跑（run_in_background），同时做复查，不等到收尾才跑。',
    '3. 有失败，先用 testpace files <文件:行号> 只重跑失败的那几个测试（位置看失败输出），修好后再交一次整组。',
    '提交、合并或推送到默认分支前必须有整组通过的记录，合并门会检查；直接跑项目自己的整组命令不留记录。',
  ].join('\n')
}

export const RHYTHM = rhythm()

/** 这些目录所在的、接入了 testpace 的仓库，按根目录去重。 */
function contractRepos(dirs: Iterable<string>): Repo[] {
  const roots = new Map<string, Repo>()
  for (const dir of new Set(dirs)) {
    const repo = openRepo(dir)
    if (repo && !roots.has(repo.root) && contractOf(repo)) roots.set(repo.root, repo)
  }
  return [...roots.values()]
}

/**
 * 这条命令碰到的接入仓库（会话所在目录和命令里 cd 进去的目录；同一条命令里多数调用在同一个目录，按目录去重）。
 * 每个仓库都记下会话，插件数据目录里记下会话碰过它；返回还没给这个会话说过节奏的。
 */
function untoldRepos(command: string, cwd: string, sessionId: string, now: number): Array<{ repo: Repo; state: SessionState }> {
  const repos = contractRepos([cwd, ...invocations(command, cwd).map(call => call.cwd)])
  noteSessionRepos(sessionId, repos.map(repo => repo.root), now)
  const untold: Array<{ repo: Repo; state: SessionState }> = []
  for (const repo of repos) {
    const state = repo.store.session(sessionId, now, () => defaultTip(repo))
    if (!state.rhythm) untold.push({ repo, state })
  }
  return untold
}

export function handle(input: HookInput, now: number): unknown {
  const cwd = input.cwd ?? process.cwd()
  const event = input.hook_event_name
  const sessionId = input.session_id ?? 'unknown'

  if (event === 'SessionStart') {
    // 会话所在目录的仓库，加上会话之前碰过的仓库（压缩、恢复后重新开始时上下文里的节奏说明可能没了）。
    const here = openRepo(cwd)?.root
    const repos = contractRepos([cwd, ...sessionRepos(sessionId)])
    if (repos.length === 0) return undefined
    for (const repo of repos) {
      const state = repo.store.session(sessionId, now, () => defaultTip(repo))
      repo.store.saveSession(sessionId, { ...state, rhythm: true })
    }
    noteSessionRepos(sessionId, repos.map(repo => repo.root), now)
    const context = repos.map(repo => (repo.root === here ? RHYTHM : rhythm(`${repo.root} 这个仓库`))).join('\n\n')
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }
  }

  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : undefined
  if (event === 'PreToolUse' && input.tool_name === 'Bash' && command) {
    // 记下会话第一次出现的时间：停止门只管这之后起的整组。会话不在仓库里开始（SessionStart 没说节奏）时，
    // 第一次碰到接入的仓库就补说一次。记不下来也不影响合并门。
    let untold: Array<{ repo: Repo; state: SessionState }> = []
    try {
      untold = untoldRepos(command, cwd, sessionId, now)
    } catch {
      // 忽略
    }
    const result = checkCommand(command, cwd)
    if (result.deny) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.deny } }
    }
    // 拦下的命令没执行，节奏留到下一条命令再说。
    try {
      for (const { repo, state } of untold) repo.store.saveSession(sessionId, { ...state, rhythm: true })
    } catch {
      // 忽略：下一条命令再说一次
    }
    const context = [...untold.map(({ repo }) => rhythm(`${repo.root} 这个仓库`)), ...(result.context ? [result.context] : [])].join('\n\n')
    if (context) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }
    return undefined
  }

  if (event === 'PostToolUse' && input.tool_name === 'Bash' && command) {
    // 在前台跑完 testpace full，agent 已经看到了结果；放到后台的要等它看 testpace status
    const background = typeof (input.tool_response as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId === 'string'
    if (background) return undefined
    for (const call of invocations(command, cwd)) {
      if (basename(call.argv[0] ?? '') !== 'testpace' || call.argv[1] !== 'full') continue
      const repo = openRepo(call.cwd)
      repo?.store.markRead(repo.root, now)
    }
    return undefined
  }

  if (event === 'Stop') {
    // 会话所在目录的仓库和会话碰过的仓库都查；不是所在目录的，话里写上是哪个仓库。
    const here = openRepo(cwd)?.root
    const blocks: string[] = []
    const warns: string[] = []
    for (const repo of contractRepos([cwd, ...sessionRepos(sessionId)])) {
      const result = stopCheck({ sessionId, cwd: repo.root, active: input.stop_hook_active === true, now, named: repo.root !== here })
      if (result.block) blocks.push(result.block)
      if (result.warn) warns.push(result.warn)
    }
    if (blocks.length === 0 && warns.length === 0) return undefined
    return {
      ...(blocks.length ? { decision: 'block', reason: blocks.join('\n') } : {}),
      ...(warns.length ? { systemMessage: warns.join('\n') } : {}),
    }
  }
  return undefined
}
