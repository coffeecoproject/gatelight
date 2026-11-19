// agent hook 的判断：SessionStart 注入节奏说明，PreToolUse 补说节奏和软提示，
// PostToolUse、PostToolUseFailure 记下 agent 在前台看到了整组结果（Claude Code 通过的走前者，失败的走后者），Stop 跑停止门。
// 各 agent 的 hook 输入输出格式和 Claude Code 一样（Codex 实测：执行命令的工具也叫 Bash，输入是字符串的 command）；
// 工具名的大小写不一样（dsh 是 bash），这里统一。
// 合并门不在这里：它是 git 的钩子（gate.ts），git 移动默认分支时检查。
// 入口在 plugin/hooks/testpace.ts，由它说明是哪个 agent。

import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS, type AgentKind } from './agent.ts'
import { CONTRACT_FILE, joined, loadContract } from './contract.ts'
import { entryPath, entryState } from './entry.ts'
import { ensureGate, gateProblem } from './gate.ts'
import { git } from './git.ts'
import { modules } from './module.ts'
import { defaultTips, openRepo, type Repo } from './repo.ts'
import { noteSessionRepos, sessionRepos } from './sessions.ts'
import { invocations } from './shell.ts'
import { stopCheck } from './stop.ts'
import type { SessionState } from './store.ts'

interface HookInput {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: { command?: unknown; run_in_background?: unknown }
  tool_response?: unknown
}

/** 落地的规矩：底座自己的一句，跟在各模块的会话说明后面。 */
export const LANDING_RULE =
  '落到默认分支的代码必须有整组通过记录：合并门在 git 移动默认分支时检查，没测过的提交、合并、cherry-pick、reset 都会被取消。直接跑项目自己的测试、检查命令不留记录。'

/** 会话说明：各模块的规矩（module.ts 的 brief），加上落地的规矩。会话从仓库外（比如上一级目录）开始时，说明里写上是哪个仓库。 */
export function sessionBrief(label = '这个仓库', repo?: Repo): string {
  return [...modules().flatMap(module => module.brief?.(label, repo) ?? []), LANDING_RULE].join('\n')
}

/** 会话碰到了这个仓库：让各模块记下自己要记的。哪个模块出错不挡别的，也不挡会话说明。 */
function noteSession(repo: Repo, sessionId: string): void {
  for (const module of modules()) {
    try {
      module.onSession?.(repo, sessionId)
    } catch {
      // 记不下只是停止门少一个参照，不挡 agent
    }
  }
}

/** 新仓库最多这么多个提交：还没接入时，会话开始就提出接入。老仓库要先改造，不在这里提。 */
export const NEW_REPO_COMMITS = 20

/** 还没提交过，或提交很少的仓库。 */
function isNewRepo(root: string): boolean {
  try {
    return Number(git(root, ['rev-list', '--count', 'HEAD'])) <= NEW_REPO_COMMITS
  } catch {
    return true
  }
}

/** 新仓库还没接入时给 agent 的话：照接入说明配好，默认落地前跑全部测试，不用问用户。 */
export const NEW_REPO =
  '这是个新仓库，还没接入 testpace（根目录没有 testpace.json）。建项目时一起接入：照 testpace:setup 技能配好 testpace.json 和三条命令，' +
  '落地前跑全部检查和全部测试，这是约定，不用问用户；配完跑 testpace verify 核对。'

/** 这个插件里的 testpace 命令：没有固定入口时，插件 bin 目录不在 PATH 上的 agent 只能用完整路径。 */
const PLUGIN_BIN = fileURLToPath(new URL('../../bin/testpace', import.meta.url))

/** 各 agent 自己的前提（AGENTS 表里的沙箱、固定入口）。 */
function agentNotes(agent: AgentKind): string[] {
  const { name, sandbox, needsEntry } = AGENTS[agent]
  const notes: string[] = []
  if (sandbox) notes.push(`在 ${name} 里：testpace 的命令要写 .git/testpace/、项目的测试常要开端口和网络，在沙箱里跑不了，每次申请提权在沙箱外跑。`)
  if (needsEntry && entryState() !== 'installed') {
    notes.push(
      `这台机器还没放 testpace 的固定命令入口（${entryPath()}），${name} 的命令里找不到 testpace，合并门的 git 钩子也找不到它（找不到就不检查）。` +
        `这是全局安装，先问用户；同意后${sandbox ? '在沙箱外' : ''}跑 ${PLUGIN_BIN} install。在那之前用 ${PLUGIN_BIN} 代替 testpace。`,
    )
  }
  return notes
}

/** 给 agent 的会话说明；testpace.json 有问题、合并门没在把关时加上原因，再加各模块的提醒（比如时好时坏的测试）和这个 agent 自己的前提。 */
function told(repo: Repo, agent: AgentKind, label?: string): string {
  const problems = loadContract(repo.root)?.problems ?? []
  const broken = problems.length ? `${CONTRACT_FILE} 有问题：${problems.join('；')}。` : undefined
  const gate = gateProblem(repo.root)
  const alerts = modules().flatMap(module => module.alerts?.(repo) ?? [])
  return [sessionBrief(label, repo), ...(broken ? [broken] : []), ...(gate ? [gate] : []), ...alerts, ...agentNotes(agent)].join('\n')
}

/** 这些目录所在的、接入了 testpace 的仓库（工作区根目录有 testpace.json），按根目录去重。 */
function contractRepos(dirs: Iterable<string>): Repo[] {
  const roots = new Map<string, Repo>()
  for (const dir of new Set(dirs)) {
    const repo = openRepo(dir)
    if (repo && !roots.has(repo.root) && joined(repo.root)) roots.set(repo.root, repo)
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
    const state = repo.store.session(sessionId, now, () => defaultTips(repo))
    if (!state.rhythm) untold.push({ repo, state })
  }
  return untold
}

/** agent：hook 来自哪个 agent（入口参数说明），决定要补充哪些前提。 */
export function handle(input: HookInput, now: number, agent: AgentKind): unknown {
  const cwd = input.cwd ?? process.cwd()
  const event = input.hook_event_name
  const sessionId = input.session_id ?? 'unknown'
  // 只认执行命令的工具：Codex 改文件的 apply_patch 输入里也有字符串的 command（补丁正文），不能当命令解析
  const shell = input.tool_name?.toLowerCase() === 'bash'

  if (event === 'SessionStart') {
    // 会话所在目录的仓库，加上会话之前碰过的仓库（压缩、恢复后重新开始时上下文里的节奏说明可能没了）。
    const hereRepo = openRepo(cwd)
    const here = hereRepo?.root
    const repos = contractRepos([cwd, ...sessionRepos(sessionId)])
    const fresh = hereRepo && !joined(hereRepo.root) && isNewRepo(hereRepo.root) ? hereRepo : undefined
    if (repos.length === 0 && !fresh) return undefined
    // 用得上合并门的会话里自动配上它，只告诉用户一声
    const notice = ensureGate((repos[0] ?? fresh)!.root)
    for (const repo of repos) {
      const state = repo.store.session(sessionId, now, () => defaultTips(repo))
      repo.store.saveSession(sessionId, { ...state, rhythm: true })
      noteSession(repo, sessionId)
    }
    noteSessionRepos(sessionId, repos.map(repo => repo.root), now)
    const context = [
      ...repos.map(repo => (repo.root === here ? told(repo, agent) : told(repo, agent, `${repo.root} 这个仓库`))),
      ...(fresh ? [NEW_REPO] : []),
    ].join('\n\n')
    return {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
      ...(notice ? { systemMessage: notice } : {}),
    }
  }

  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : undefined
  if (event === 'PreToolUse' && shell && command) {
    // 记下会话第一次出现的时间：停止门只管这之后起的整组。会话不在仓库里开始（SessionStart 没说节奏）时，
    // 第一次碰到接入的仓库就补说一次。
    const untold = untoldRepos(command, cwd, sessionId, now)
    for (const { repo, state } of untold) {
      repo.store.saveSession(sessionId, { ...state, rhythm: true })
      noteSession(repo, sessionId)
    }
    const hints = modules().flatMap(module => module.beforeCommand?.(command, cwd) ?? [])
    const context = [...untold.map(({ repo }) => told(repo, agent, `${repo.root} 这个仓库`)), ...hints].join('\n\n')
    if (context) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }
    return undefined
  }

  // 命令退出码非零时 Claude Code 发的是 PostToolUseFailure：整组失败的输出 agent 同样看到了
  if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && shell && command) {
    // 在前台跑完 testpace full，agent 已经看到了结果；放到后台的（Claude Code 的 run_in_background）要等它看 testpace status
    const background =
      input.tool_input?.run_in_background === true ||
      typeof (input.tool_response as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId === 'string'
    if (background) return undefined
    for (const call of invocations(command, cwd)) {
      if (basename(call.argv[0] ?? '') !== 'testpace' || call.argv[1] !== 'full') continue
      const repo = openRepo(call.cwd)
      if (repo) repo.store.markRead(sessionId, repo.root, now, () => defaultTips(repo))
    }
    return undefined
  }

  if (event === 'Stop') {
    // 会话所在目录的仓库和会话碰过的仓库都查；不是所在目录的，话里写上是哪个仓库。
    const here = openRepo(cwd)?.root
    const blocks: string[] = []
    const warns: string[] = []
    for (const repo of contractRepos([cwd, ...sessionRepos(sessionId)])) {
      const result = stopCheck({ sessionId, cwd: repo.root, now, named: repo.root !== here })
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
