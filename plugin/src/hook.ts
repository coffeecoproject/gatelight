// Claude Code hook 的判断：SessionStart 注入节奏说明，PreToolUse 跑合并门和软提示，
// PostToolUse 记下 agent 在前台看到了整组结果，Stop 跑停止门。
// 入口在 plugin/hooks/testpace.ts。

import { basename } from 'node:path'
import { checkCommand } from './gate.ts'
import { contractOf, openRepo } from './repo.ts'
import { invocations } from './shell.ts'
import { defaultTip, stopCheck } from './stop.ts'

interface HookInput {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: { command?: unknown; run_in_background?: unknown }
  tool_response?: unknown
  stop_hook_active?: boolean
}

export const RHYTHM = [
  '这个仓库用 testpace 管测试节奏（testpace.json）：',
  '1. 改完先跑 testpace focused：fast 检查加上和改动相关的测试。它提示跑整组时照做。',
  '2. 一个阶段做完，就把 testpace full 放到后台跑（run_in_background），同时做复查，不等到收尾才跑。',
  '3. 有失败，先用 testpace files <测试文件> 只重跑失败的文件，修好后再交一次整组。',
  '提交、合并或推送到默认分支前必须有整组通过的记录，合并门会检查；直接跑项目自己的整组命令不留记录。',
].join('\n')

export function handle(input: HookInput, now: number): unknown {
  const cwd = input.cwd ?? process.cwd()
  const event = input.hook_event_name
  const sessionId = input.session_id ?? 'unknown'

  if (event === 'SessionStart') {
    const repo = openRepo(cwd)
    if (!repo || !contractOf(repo)) return undefined
    repo.store.session(sessionId, now, () => defaultTip(repo))
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: RHYTHM } }
  }

  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : undefined
  if (event === 'PreToolUse' && input.tool_name === 'Bash' && command) {
    // 记下会话第一次出现的时间：停止门只管这之后起的整组。记不下来也不影响合并门。
    try {
      const repo = openRepo(cwd)
      if (repo && contractOf(repo)) repo.store.session(sessionId, now, () => defaultTip(repo))
    } catch {
      // 忽略
    }
    const result = checkCommand(command, cwd)
    if (result.deny) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.deny } }
    }
    if (result.context) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: result.context } }
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
    const result = stopCheck({ sessionId, cwd, active: input.stop_hook_active === true, now })
    if (!result.block && !result.warn) return undefined
    return {
      ...(result.block ? { decision: 'block', reason: result.block } : {}),
      ...(result.warn ? { systemMessage: result.warn } : {}),
    }
  }
  return undefined
}
