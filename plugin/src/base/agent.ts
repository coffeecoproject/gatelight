// 当前在哪个 agent 里：Claude Code、Codex、Antigravity（桌面 App），以及以后要接的 DeepSeek Harness（dsh，现在只认出来，没有接入）。
// 各 agent 的差别都记在 AGENTS 这张表里，别处只从表里取：认 agent、合并门的钩子看哪些变量、hook 要补充哪些前提、hook 的输入输出用哪种格式。
// 命令行靠命令环境里的变量认；hook 由入口参数说明是哪个 agent，不靠环境变量（见 hooks/testpace.ts）。
// 一个 agent 从另一个里启动时会继承外层的变量（比如 Codex 从 Claude Code 里启动时带着 CLAUDECODE 和
// CLAUDE_CODE_SESSION_ID），所以表里非 Claude 的排在前面：有 CODEX_THREAD_ID 就算 Codex。
// 光看环境变量分不出嵌套顺序：Claude Code 从 Codex 里启动时会被认成 Codex，这是已知限制。
// Antigravity 排在 Codex 后、Claude Code 前：从 Antigravity 里起的 Codex 算 Codex，从 Claude Code 里起的 Antigravity 算 Antigravity；
// 三个互相嵌套的其余情况一样分不出来。

import { ANTIGRAVITY_HOOKS, ANTIGRAVITY_SERVER, CLAUDE_HOOKS, type HookFormat } from './hookformat.ts'

export type AgentKind = 'claude' | 'codex' | 'antigravity' | 'dsh'

interface AgentProfile {
  name: string
  /** 命令环境里有其中一个就是这个 agent。 */
  markers: string[]
  /** 已经接入：合并门的钩子看它的标记变量，拦它的命令。还没接入的只认出来。 */
  connected: boolean
  /** 会话号所在的变量：停止门只管起整组的会话。 */
  session: string
  /** 有这个变量表示命令在 agent 的沙箱里跑：测试可能因为端口、网络被拒跑出假失败。没有沙箱、或沙箱里没有这样的变量的不填。 */
  sandbox?: string
  /**
   * 有沙箱的 agent：会话说明里告诉它怎么申请到沙箱外跑（接在"每次"后面）。testpace 的命令在沙箱里跑不了，有没有标记沙箱的变量都要说。
   * 没有沙箱的不填。
   */
  leaveSandbox?: string
  /** 插件的 bin 目录不在命令的 PATH 上，要靠固定命令入口找到插件的命令。 */
  needsEntry: boolean
  /** hook 的输入怎么读、结论怎么写（hookformat.ts）。 */
  hooks: HookFormat
  /**
   * 说给 agent 的话里技能叫什么：话里写的是 Claude Code 的全名（插件名:技能名），这个 agent 里叫法不一样的填一个换法。
   * 没填的照原样。
   */
  skill?(name: string): string
  /** 确认工具（confirm.ts）在这个 agent 里怎么调，接在"<插件名> 的 <工具名> 工具"后面。按工具名直接调的不填。 */
  confirmCall?(tool: string): string
}

/** 按认的先后排（非 Claude 的在前）。dsh 还没接入，只认出来：合并门不拦它，沙箱、固定入口接入时实测再填。 */
export const AGENTS: Record<AgentKind, AgentProfile> = {
  codex: {
    name: 'Codex',
    markers: ['CODEX_THREAD_ID'],
    connected: true,
    session: 'CODEX_THREAD_ID',
    sandbox: 'CODEX_SANDBOX',
    leaveSandbox: '申请提权在沙箱外跑',
    needsEntry: true,
    hooks: CLAUDE_HOOKS,
  },
  // 桌面 App 实测：ANTIGRAVITY_AGENT 沙箱内外的命令里都有，hook 的环境里没有（hook 不靠环境变量认 agent）；会话号和 hook 输入的 conversationId 同值。
  // 沙箱里没有标记它的变量：在沙箱里时固定入口找不到插件（看不见 Antigravity 的配置目录），由入口拒跑并说明（entry/command）。
  // 技能名前面不带插件名（实测是光名字），撞名的可能先不管，话里说清楚是 gatelight 的。
  antigravity: {
    name: 'Antigravity',
    markers: ['ANTIGRAVITY_AGENT'],
    connected: true,
    session: 'ANTIGRAVITY_CONVERSATION_ID',
    leaveSandbox: '在 run_command 里加上 BypassSandbox 申请在沙箱外跑',
    needsEntry: true,
    hooks: ANTIGRAVITY_HOOKS,
    skill: name => `gatelight 的 ${name}`,
    // 系统提示里只列服务名和工具名，MCP 工具要经 call_mcp_tool 调（实测 agent 第一次没找到确认工具，直接说没有）
    confirmCall: tool => `用 call_mcp_tool 调：ServerName 填 ${ANTIGRAVITY_SERVER}，ToolName 填 ${tool}，Arguments 填 repo、id、text`,
  },
  dsh: { name: 'DeepSeek Harness', markers: ['DSH_SHELL'], connected: false, session: 'DSH_SESSION_ID', needsEntry: false, hooks: CLAUDE_HOOKS },
  // 桌面版里 Claude 往终端面板打的命令不带 CLAUDECODE，它开的标签带着 CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS（实测）。
  // 这个变量放的是开标签的会话号，可能不止一个，不拿来当会话号。用户自己开的标签没有它；用户在 Claude 开的标签里打的命令也算 Claude 的。
  claude: { name: 'Claude Code', markers: ['CLAUDECODE', 'CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS'], connected: true, session: 'CLAUDE_CODE_SESSION_ID', needsEntry: false, hooks: CLAUDE_HOOKS },
}

const KINDS = Object.keys(AGENTS) as AgentKind[]

/** 已接入的 agent 的标记变量：合并门的钩子有其中一个才检查。排好序：钩子命令的正文不随表里的先后变。 */
export const AGENT_MARKERS: string[] = KINDS.filter(kind => AGENTS[kind].connected)
  .flatMap(kind => AGENTS[kind].markers)
  .sort()

export interface Agent {
  kind: AgentKind
  /** 会话号：停止门只管起整组的会话；没有时不记。 */
  session?: string
  /** 命令在 agent 的沙箱里跑。 */
  sandboxed: boolean
}

/** 命令环境里的 agent；用户自己在终端里跑的返回 undefined。 */
export function currentAgent(env: NodeJS.ProcessEnv = process.env): Agent | undefined {
  const kind = KINDS.find(kind => AGENTS[kind].markers.some(marker => env[marker]))
  if (!kind) return undefined
  const { session, sandbox } = AGENTS[kind]
  return { kind, ...(env[session] ? { session: env[session] } : {}), sandboxed: Boolean(sandbox && env[sandbox]) }
}

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && KINDS.includes(value as AgentKind)
}
