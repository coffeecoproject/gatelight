// 各 agent 的 hook 输入输出格式。hook 分三段：读（这里的 read）把 agent 的输入转成同一种内部事件，判断（hook.ts 的 judge）只看内部事件、
// 只给结论，写（这里的 write）把结论编成这个 agent 的输出。判断那一段不出现任何 agent 的字段名。
// 哪个 agent 用哪一组读写记在 AGENTS 表里（agent.ts），别处不判断 agent 的种类。
// Claude Code、Codex、dsh 共用一组：格式一样（Codex 实测：执行命令的工具也叫 Bash，输入是字符串的 command），
// 工具名的大小写不一样（dsh 是 bash），读的时候统一。Antigravity 另一组（字段是驼峰写法，工具名、怎么拒绝、怎么让 agent 继续都不同）。

import { PLUGIN_NAME } from './version.ts'

interface Session {
  sessionId: string
  /** 这次 hook 给的目录：agent 现在所在的目录（cd 会留住，会话所在目录按第一次见到的认，见 sessions.ts 的 sessionHome）。 */
  cwd: string
}

/** 内部事件：判断只认这几种。读不出其中一种的输入（别的事件、别的工具、缺了要用的字段）不是事件，不判断。 */
export type HookEvent = Session &
  (
    | { kind: 'start' }
    /** 要用改文件的工具改一个文件：路径（相对 cwd，或绝对路径），和这次要写进去的新文字（拿得到时）。可以拒绝。 */
    | { kind: 'edit'; file: string; text?: string }
    /** 要用一段补丁改这几个文件（Codex 的 apply_patch）：只记下改到的工作区，不检查（一段补丁里有几个文件，修改的部分只有差异）。 */
    | { kind: 'patch'; files: string[] }
    /** 要执行一条命令。 */
    | { kind: 'command'; command: string }
    /** 一条命令执行完了。放到后台的，agent 这时还没看到它的输出。 */
    | { kind: 'ran'; command: string; background: boolean }
    /** 要结束这一轮。busy：会话放到后台的 agent（子代理、workflow、队友）还在干活，这一轮结束不是活干完了，它们干完会再叫醒会话。 */
    | { kind: 'stop'; busy?: boolean }
    /**
     * 要调 gatelight 自己的 MCP 服务（src/mcp.ts，只有确认工具 confirm_with_user）：text 是要给用户看的原文（调用里填的，没填是 undefined）。
     * 只有工具自己不能保证每次弹窗的 agent 才读出这种事件（Antigravity）；Claude Code 靠工具自己的标记弹窗，不经过 hook。
     */
    | { kind: 'confirm'; text?: string }
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
  /** 这次工具调用要用户当场同意才执行：给用户看的原文。只对确认工具的调用给（confirm 事件）。 */
  ask?: string
}

export interface HookFormat {
  /** agent 的输入转成内部事件；不归 hook 管的输入返回 undefined。 */
  read(input: unknown): HookEvent | undefined
  /** 结论编成这个 agent 的输出（写到标准输出的 JSON）；什么都不用输出时返回 undefined。 */
  write(event: HookEvent, verdict: HookVerdict): unknown
  /** hook 自己出错时的输出：不挡 agent，但要让人看得到。什么都不能输出的 agent 返回 undefined（错误只写到标准错误）。 */
  failure(message: string): unknown
  /**
   * 执行命令之前给模型的话怎么送：note 是加在这次调用上、命令照跑；refuse 是这个 agent 没有只加一句话的写法，
   * 只能拒绝这次调用、在原因里说（同一段话一个会话只拦一次，hook.ts）。
   */
  beforeCommand: 'note' | 'refuse'
}

interface ClaudeInput {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: { command?: unknown; run_in_background?: unknown; file_path?: unknown; content?: unknown; new_string?: unknown; edits?: unknown }
  tool_response?: unknown
  /** Stop 时还在跑的后台任务（Claude Code 给；老版本没有这个字段）。type 是 subagent、workflow、teammate、shell、monitor 这类。 */
  background_tasks?: Array<{ type?: unknown }>
}

/** 会在本机替会话改文件、跑命令的后台任务。shell、monitor 不算：开着的开发服务、监视器会一直在，算上它们停止门就再也不问了。 */
const WORKING_TASKS = new Set(['subagent', 'workflow', 'teammate'])

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
 * 路径相对 cwd，也可以是绝对路径。
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
  confirm: 'PreToolUse',
}

/** Claude Code 的 hook 格式；Codex、dsh 也用它。 */
export const CLAUDE_HOOKS: HookFormat = {
  read(raw) {
    const input = raw as ClaudeInput
    const session: Session = { sessionId: input.session_id ?? 'unknown', cwd: input.cwd ?? process.cwd() }
    const event = input.hook_event_name
    if (event === 'SessionStart') return { ...session, kind: 'start' }
    if (event === 'Stop') {
      const busy = Array.isArray(input.background_tasks) && input.background_tasks.some(task => WORKING_TASKS.has(task?.type as string))
      return { ...session, kind: 'stop', ...(busy ? { busy } : {}) }
    }
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
  beforeCommand: 'note',
}

interface AntigravityInput {
  hookEventName?: string
  conversationId?: string
  /** agent 的工作目录（它的命令默认在这里跑），不是 hook 进程的工作目录。 */
  cwd?: string
  toolCall?: {
    name?: string
    args?: { CommandLine?: unknown; Path?: unknown; Content?: unknown; Replacement?: unknown; ServerName?: unknown; Arguments?: unknown }
  }
  terminationReason?: string
}

/**
 * Antigravity 里 gatelight 的 MCP 服务叫什么：插件名_服务名（实测），服务名就是插件名（mcp_config.json）。
 * 调确认工具要用 call_mcp_tool、ServerName 填它。这个服务只有确认工具，所以认调用只看服务名（hooks/antigravity.sh 出错时也这样认）。
 */
export const ANTIGRAVITY_SERVER = `${PLUGIN_NAME}_${PLUGIN_NAME}`

/** call_mcp_tool 的 Arguments 里的 text：实测是对象；万一是一段 JSON 文字也认。 */
function confirmText(args: unknown): string | undefined {
  let value = args
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const text = (value as { text?: unknown } | null)?.text
  return typeof text === 'string' ? text : undefined
}

/**
 * 给 Antigravity 的弹窗原文：它的弹窗把换行压成一段、不渲染 Markdown（实测），所以每行去掉首尾空白、去掉空行，用空格连成一段；
 * 原文里每项本来就用"1.""2."开头，连起来也分得清。
 */
function oneParagraph(text: string): string {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * Antigravity（桌面 App）的 hook 格式，按 2026-11-24 的实测：
 * - 跑命令是 run_command（args.CommandLine）；改文件的专门工具只有 write_file（args.Path 是绝对路径、args.Content）和
 *   edit_file（args.Path、args.Replacement 是换进去的文字；它的输入没实际见过，照工具定义）。删文件、移动文件只能走 run_command，和 Claude Code 下走 Bash 一样不在改文件的检查里。
 * - 不干预时什么都不能输出：PreToolUse 输出 {}、空的 decision、退出码非 0 都会把这次工具调用拦掉。所以这里没有要说的就返回 undefined，
 *   出错也不输出（入口脚本保证退出码 0）。绝不输出 allow：那会替用户放行，绕过 Antigravity 自己的权限。
 * - 命令执行完（PostToolUse）的输入里没有命令的输出，也分不出命令有没有自己转到后台（几分钟的命令一定会转），所以不接：
 *   agent 看没看到整组结果只认 testpace status。
 * - 要结束这一轮（Stop）只管正常说完话的（terminationReason 是 NO_TOOL_CALL）；用户取消、出错、超过上限的不拦。
 *   只拦一次靠停止门自己记下拦过的（stop.ts），不看输入里的 continuationActive（实测一直是 false）。
 */
export const ANTIGRAVITY_HOOKS: HookFormat = {
  read(raw) {
    const input = raw as AntigravityInput
    // 没有 agent 的工作目录时不管：hook 进程自己的目录是插件目录，拿它顶替会把会话当成在插件所在的仓库里干活
    // （开发期插件是指向 gatelight 仓库的链接，那个仓库本身接入了 testpace）
    const event = input.hookEventName
    const tool = input.toolCall?.name
    const args = input.toolCall?.args
    // 确认工具的调用不看 cwd：缺了 cwd 也要弹窗，不能当成不归 hook 管而放过去
    if (event === 'PreToolUse' && tool === 'call_mcp_tool' && args?.ServerName === ANTIGRAVITY_SERVER) {
      const text = confirmText(args.Arguments)
      return { sessionId: input.conversationId ?? 'unknown', cwd: typeof input.cwd === 'string' ? input.cwd : '', kind: 'confirm', ...(text === undefined ? {} : { text }) }
    }
    if (typeof input.cwd !== 'string' || input.cwd === '') return undefined
    const session: Session = { sessionId: input.conversationId ?? 'unknown', cwd: input.cwd }
    if (event === 'SessionStart') return { ...session, kind: 'start' }
    if (event === 'Stop') return input.terminationReason === 'NO_TOOL_CALL' ? { ...session, kind: 'stop' } : undefined
    if (event !== 'PreToolUse') return undefined
    if (tool === 'run_command') return typeof args?.CommandLine === 'string' && args.CommandLine ? { ...session, kind: 'command', command: args.CommandLine } : undefined
    if (tool === 'write_file' || tool === 'edit_file') {
      if (typeof args?.Path !== 'string') return undefined
      const text = tool === 'write_file' ? args.Content : args.Replacement
      return { ...session, kind: 'edit', file: args.Path, ...(typeof text === 'string' ? { text } : {}) }
    }
    return undefined
  },
  write(event, verdict) {
    if (event.kind === 'start') {
      const steps = [
        ...(verdict.context ? [{ systemMessage: { systemMessage: verdict.context } }] : []),
        // 只给用户看的话：模型那边是空的
        ...(verdict.notice ? [{ systemMessage: { systemMessage: '', metadata: { user_markdown: verdict.notice } } }] : []),
      ]
      return steps.length > 0 ? { injectSteps: steps } : undefined
    }
    // Stop 的输出里没有只给用户看、不拦的写法：提醒类的话只能不说，并进 reason 就成了拦 agent
    if (event.kind === 'stop') return verdict.block ? { decision: 'continue', reason: verdict.block } : undefined
    // force_ask：每次都弹窗问用户，"总是允许"在弹窗里选不了（实测）；用户拒绝时工具不执行
    if (verdict.ask) return { decision: 'force_ask', reason: oneParagraph(verdict.ask) }
    // 工具调用之前：只有拒绝这一种说法（给模型的话由判断改成了拒绝的原因，见 beforeCommand）
    return verdict.deny ? { decision: 'deny', reason: verdict.deny } : undefined
  },
  failure() {
    return undefined
  },
  beforeCommand: 'refuse',
}
