// 各 agent 的 hook 输入输出格式。hook 分三段：读（这里的 read）把 agent 的输入转成同一种内部事件，判断（hook.ts 的 judge）只看内部事件、
// 只给结论，写（这里的 write）把结论编成这个 agent 的输出。判断那一段不出现任何 agent 的字段名。
// 哪个 agent 用哪一组读写记在 AGENTS 表里（agent.ts），别处不判断 agent 的种类。
// Claude Code、Codex、dsh 共用一组：格式一样（Codex 实测：执行命令的工具也叫 Bash，输入是字符串的 command），
// 工具名的大小写不一样（dsh 是 bash），读的时候统一。

interface Session {
  sessionId: string
  /** 会话所在目录。 */
  cwd: string
}

/** 内部事件：判断只认这几种。读不出其中一种的输入（别的事件、别的工具、缺了要用的字段）不是事件，不判断。 */
export type HookEvent = Session &
  (
    | { kind: 'start' }
    /** 要用改文件的工具改一个文件：路径（相对会话所在目录，或绝对路径），和这次要写进去的新文字（拿得到时）。可以拒绝。 */
    | { kind: 'edit'; file: string; text?: string }
    /** 要用一段补丁改这几个文件（Codex 的 apply_patch）：只记下改到的工作区，不检查（一段补丁里有几个文件，修改的部分只有差异）。 */
    | { kind: 'patch'; files: string[] }
    /** 要执行一条命令。 */
    | { kind: 'command'; command: string }
    /** 一条命令执行完了。放到后台的，agent 这时还没看到它的输出。 */
    | { kind: 'ran'; command: string; background: boolean }
    | { kind: 'stop' }
  )

/** 判断的结论。什么都不用说、不用拦时没有结论（undefined），不是空对象。 */
export interface HookVerdict {
  /** 给模型的话。 */
  context?: string
  /** 给用户看的话。 */
  notice?: string
  /** 拒绝这次工具调用的原因。 */
  deny?: string
  /** 不让结束这一轮的原因。 */
  block?: string
}

export interface HookFormat {
  /** agent 的输入转成内部事件；不归 hook 管的输入返回 undefined。 */
  read(input: unknown): HookEvent | undefined
  /** 结论编成这个 agent 的输出（写到标准输出的 JSON）。 */
  write(event: HookEvent, verdict: HookVerdict): unknown
  /** hook 自己出错时的输出：不挡 agent，但要让人看得到。 */
  failure(message: string): unknown
}

interface ClaudeInput {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: { command?: unknown; run_in_background?: unknown; file_path?: unknown; content?: unknown; new_string?: unknown; edits?: unknown }
  tool_response?: unknown
}

/** 改文件的工具（Claude Code 的，和 hooks.json 里的 matcher 一样）。Codex 的 apply_patch 另算（patchFiles）。 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

/** 改文件的工具这次要写进文件的新文字：Write 的整份内容，Edit、MultiEdit 替换进去的那几段。 */
function writtenText(input: ClaudeInput['tool_input']): string | undefined {
  const parts: string[] = []
  if (typeof input?.content === 'string') parts.push(input.content)
  if (typeof input?.new_string === 'string') parts.push(input.new_string)
  if (Array.isArray(input?.edits)) {
    for (const item of input.edits as unknown[]) {
      const text = (item as { new_string?: unknown } | null)?.new_string
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/**
 * Codex 的 apply_patch 补丁（tool_input.command 是补丁正文）要改的文件：新建、修改、删除的，和改名后的新路径。
 * 路径相对会话所在目录，也可以是绝对路径。
 */
function patchFiles(patch: string): string[] {
  return patch.split('\n').flatMap(line => /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/.exec(line)?.[1] ?? [])
}

/** 内部事件在 Claude Code 的格式里叫什么（hookSpecificOutput 要写明是哪个事件）。 */
const CLAUDE_EVENT: Record<HookEvent['kind'], string> = {
  start: 'SessionStart',
  edit: 'PreToolUse',
  patch: 'PreToolUse',
  command: 'PreToolUse',
  ran: 'PostToolUse',
  stop: 'Stop',
}

/** Claude Code 的 hook 格式；Codex、dsh 也用它。 */
export const CLAUDE_HOOKS: HookFormat = {
  read(raw) {
    const input = raw as ClaudeInput
    const session: Session = { sessionId: input.session_id ?? 'unknown', cwd: input.cwd ?? process.cwd() }
    const event = input.hook_event_name
    if (event === 'SessionStart') return { ...session, kind: 'start' }
    if (event === 'Stop') return { ...session, kind: 'stop' }
    const tool = input.tool_name ?? ''
    if (event === 'PreToolUse' && EDIT_TOOLS.has(tool)) {
      const file = input.tool_input?.file_path
      if (typeof file !== 'string') return undefined
      const text = writtenText(input.tool_input)
      return { ...session, kind: 'edit', file, ...(text === undefined ? {} : { text }) }
    }
    // tool_input.command 是字符串的不都是命令：Codex 改文件的 apply_patch 输入里也有（补丁正文），不能当命令解析
    const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : undefined
    if (!command) return undefined
    if (event === 'PreToolUse' && tool.toLowerCase() === 'apply_patch') return { ...session, kind: 'patch', files: patchFiles(command) }
    if (tool.toLowerCase() !== 'bash') return undefined
    if (event === 'PreToolUse') return { ...session, kind: 'command', command }
    // 命令退出码非零时 Claude Code 发的是 PostToolUseFailure：失败的输出 agent 同样看到了
    if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
      // 放到后台的：Claude Code 的 run_in_background，或者它自己把命令转到了后台（tool_response 里有后台任务号）
      const background =
        input.tool_input?.run_in_background === true ||
        typeof (input.tool_response as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId === 'string'
      return { ...session, kind: 'ran', command, background }
    }
    return undefined
  },
  write(event, verdict) {
    const specific = verdict.deny
      ? { permissionDecision: 'deny', permissionDecisionReason: verdict.deny }
      : verdict.context
        ? { additionalContext: verdict.context }
        : undefined
    return {
      ...(specific ? { hookSpecificOutput: { hookEventName: CLAUDE_EVENT[event.kind], ...specific } } : {}),
      ...(verdict.block ? { decision: 'block', reason: verdict.block } : {}),
      ...(verdict.notice ? { systemMessage: verdict.notice } : {}),
    }
  },
  failure(message) {
    return { systemMessage: message }
  },
}
