// agent hook 的判断：会话开始时给节奏说明，执行命令之前补说节奏和软提示，改文件之前问各模块这次拦不拦，
// 命令执行完记下 agent 在前台看到了整组结果，要结束这一轮时跑停止门。
// 这里只看内部事件、只给结论（judge）；各 agent 的输入输出长什么样在 hookformat.ts，这里不出现它们的字段名。
// 合并门不在这里：它是 git 的钩子（gate.ts），git 移动默认分支时检查。
// 入口在 plugin/hooks/testpace.ts，由它说明是哪个 agent。

import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS, type AgentKind } from './agent.ts'
import { CONFIRM_TOOL } from './confirm.ts'
import { CONTRACT_FILE, joined, loadContract } from './contract.ts'
import { entriesNotPlaced, entryDir, refreshEntries } from './entry.ts'
import { ensureGate, gateProblem } from './gate.ts'
import { git } from './git.ts'
import type { HookEvent, HookVerdict } from './hookformat.ts'
import { modules } from './module.ts'
import { defaultTips, openRepo, type Repo } from './repo.ts'
import { noteSessionRepos, sessionRepos } from './sessions.ts'
import { invocations } from './shell.ts'
import { PLUGIN_NAME } from './version.ts'
import { stopCheck } from './stop.ts'
import type { SessionState } from './store.ts'

/** 落地的规矩：底座自己的一句，跟在各模块的会话说明后面。 */
export const LANDING_RULE =
  '落到默认分支的代码必须有整组通过记录：合并门在 git 移动默认分支时检查，没测过的提交、合并、cherry-pick、reset 都会被取消。直接跑项目自己的测试、检查命令不留记录。'

/** 会话说明：各模块的规矩（module.ts 的 brief），加上落地的规矩。会话从仓库外（比如上一级目录）开始时，说明里写上是哪个仓库。 */
export function sessionBrief(label = '这个仓库', repo?: Repo): string {
  return [...modules().flatMap(module => module.brief?.(label, repo) ?? []), LANDING_RULE].join('\n')
}

/**
 * 会话碰到了这个工作区：让各模块记下自己要记的（会话起点，见 baseline.ts）。会话开始、每条命令之前、每次改文件之前都来，
 * 模块只记第一次。哪个模块出错不挡别的，也不挡会话说明。
 */
function noteSession(repo: Repo, sessionId: string): void {
  for (const module of modules()) {
    try {
      module.onSession?.(repo, sessionId)
    } catch {
      // 记不下只是停止门少一个参照，不挡 agent
    }
  }
}

/**
 * 这个会话在这个工作区干活（会话所在目录的工作区，或用改文件的工具改了那里的文件）：记进会话状态，停止门只为这些工作区问各模块（stop.ts）。
 * 起点照样在会话第一次碰到工作区时记（命令里 cd 进去也记）：会话后来在那里动手改了，它进去之后命令里写的东西也算它的。
 */
function noteWorking(repo: Repo, sessionId: string, now: number): void {
  const state = repo.store.session(sessionId, now, () => defaultTips(repo))
  if (state.worked?.includes(repo.root)) return
  repo.store.saveSession(sessionId, { ...state, worked: [...(state.worked ?? []), repo.root] })
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
  '这是个新仓库，还没接入 testpace（根目录没有 testpace.json）。建项目时一起接入：照 gatelight:setup 技能配好 testpace.json 和三条命令，' +
  '落地前跑全部检查和全部测试，这是约定，不用问用户；配完跑 testpace verify 核对。'

/** 这个插件放命令的目录：没有固定入口时，插件 bin 目录不在 PATH 上的 agent 只能用完整路径。 */
const PLUGIN_BIN = fileURLToPath(new URL('../../bin', import.meta.url))

/** 各 agent 自己的前提（AGENTS 表里的沙箱、固定入口）。 */
function agentNotes(agent: AgentKind): string[] {
  const { name, leaveSandbox, needsEntry, confirmCall } = AGENTS[agent]
  const sandbox = leaveSandbox !== undefined
  const notes: string[] = []
  if (sandbox) notes.push(`在 ${name} 里：testpace 的命令要写 .git/testpace/、项目的测试常要开端口和网络，在沙箱里跑不了，每次${leaveSandbox}。`)
  if (confirmCall) notes.push(`在 ${name} 里，${PLUGIN_NAME} 的 ${CONFIRM_TOOL} 工具${confirmCall(CONFIRM_TOOL)}。`)
  const absent = needsEntry ? entriesNotPlaced() : []
  if (absent.length) {
    const gate = absent.includes('testpace') ? '合并门的 git 钩子也找不到 testpace（找不到就不检查）。' : ''
    notes.push(
      `这台机器还没放 ${absent.join('、')} 的固定命令入口（放在 ${entryDir()}），${name} 的命令里找不到${absent.length > 1 ? '它们' : '它'}。${gate}` +
        `这是全局安装，先问用户；同意后${sandbox ? '在沙箱外' : ''}跑 ${join(PLUGIN_BIN, 'testpace')} install。在那之前用 ${PLUGIN_BIN} 下的同名文件代替。`,
    )
  }
  return notes
}

/**
 * 结论里提到的技能（插件名:技能名）按这个 agent 的叫法写（AGENTS 表的 skill），没有换法的照原样。
 * 钩子说的话都在这里换，判断各处照 Claude Code 的叫法写；命令自己的输出（合并门、modwall 的话）不经过这里，照原样。
 */
function inAgentWords(verdict: HookVerdict, agent: AgentKind): HookVerdict {
  const skill = AGENTS[agent].skill
  if (!skill) return verdict
  const pattern = new RegExp(`\\b${PLUGIN_NAME}:([a-z][a-z-]*)`, 'g')
  return Object.fromEntries(Object.entries(verdict).map(([key, text]) => [key, text.replace(pattern, (_: string, name: string) => skill(name))]))
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
 * 每个仓库都记下会话，插件数据目录里记下会话碰过它；每个工作区都让各模块记下会话在那里的起点（节奏按仓库说一次，起点按工作区各记一份：
 * 同一个仓库的另一个工作区不会再说节奏，起点照样要记）。会话所在目录的工作区记成它干活的地方；cd 进去的不算（noteWorking）。
 * 返回还没给这个会话说过节奏的。
 * 已知的缺口：会话没进某个工作区、从外面按路径往里写了文件（cp、重定向这类），这里看不到，那个工作区的起点要到会话进去时才记，
 * 已经带着它写的东西；停止门不提醒这一部分，合并前的整组照样查。
 * 试过按字面认命令里别的工作区的路径来补：相对路径、软链认不出，只提到路径也会提前记起点成误报；每条命令前后各比一次各工作区又拖慢每条命令，所以不补。
 */
function untoldRepos(command: string, cwd: string, sessionId: string, now: number): Array<{ repo: Repo; state: SessionState }> {
  const repos = contractRepos([cwd, ...invocations(command, cwd).map(call => call.cwd)])
  noteSessionRepos(sessionId, repos.map(repo => repo.root), now)
  const here = openRepo(cwd)?.root
  const home = repos.find(repo => repo.root === here)
  if (home) noteWorking(home, sessionId, now)
  const untold: Array<{ repo: Repo; state: SessionState }> = []
  for (const repo of repos) {
    const state = repo.store.session(sessionId, now, () => defaultTips(repo))
    noteSession(repo, sessionId)
    if (!state.rhythm) untold.push({ repo, state })
  }
  return untold
}

/**
 * 会话要用改文件的工具改这个工作区的文件：改之前先记起点（先用改文件的工具改、后来才在这个工作区跑命令的，起点也得是改之前的样子），
 * 记下会话碰过它（改的可以是会话所在目录以外的工作区，停止门才查得到那里），记成会话干活的工作区。
 */
function noteEditing(repo: Repo, sessionId: string, now: number): void {
  noteSession(repo, sessionId)
  noteSessionRepos(sessionId, [repo.root], now)
  noteWorking(repo, sessionId, now)
}

/**
 * 要改的文件在哪个接入了的仓库里、相对仓库根目录的路径。目标可以不在会话所在的仓库里，按它自己所在的仓库算；
 * 还不存在的文件按最近的已有目录找仓库。不在接入的仓库里时没有。
 */
function editTarget(cwd: string, target: string): { repo: Repo; path: string } | undefined {
  if (target === '') return undefined
  const file = isAbsolute(target) ? target : resolve(cwd, target)
  let dir = dirname(file)
  while (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    const up = dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
  const repo = openRepo(dir)
  if (!repo || !joined(repo.root)) return undefined
  // git 给的是真实路径（软链展开了，比如 macOS 的 /var 是 /private/var），目标路径也按真实路径算
  const path = relative(repo.root, join(realpathSync(dir), relative(dir, file))).split('\\').join('/')
  if (path === '' || path.startsWith('../')) return undefined
  return { repo, path }
}

/** 改文件之前：问各模块拦不拦（module.ts 的 beforeEdit），有一个说了原因就拒绝。text 是这次要写进文件的新文字。 */
function editRefusal({ repo, path }: { repo: Repo; path: string }, text: string | undefined): string | undefined {
  for (const module of modules()) {
    const reason = module.beforeEdit?.(repo, path, text)
    if (reason) return reason
  }
  return undefined
}

/**
 * 判断：只看内部事件（hookformat.ts 的 HookEvent），只给结论。agent：hook 来自哪个 agent（入口参数说明），决定会话说明里要补充哪些前提。
 * 什么都不用说、不用拦时返回 undefined。
 */
export function judge(event: HookEvent, now: number, agent: AgentKind): HookVerdict | undefined {
  const { cwd, sessionId } = event

  // 确认工具：用户当场在弹窗里看到原文、点了同意才执行。没填原文的不弹空窗，拒掉让 agent 照检查输出填
  if (event.kind === 'confirm') {
    return event.text?.trim() ? { ask: event.text } : { deny: `${CONFIRM_TOOL} 的 text 没填：照要求确认的那条检查输出的原样填。` }
  }

  if (event.kind === 'start') {
    // 旧版本放的固定入口先换成这一版的：下面的会话说明、之后的命令和合并门的钩子都靠它们找到命令
    refreshEntries()
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
      if (repo.root === here) noteWorking(repo, sessionId, now)
    }
    noteSessionRepos(sessionId, repos.map(repo => repo.root), now)
    const context = [
      ...repos.map(repo => (repo.root === here ? told(repo, agent) : told(repo, agent, `${repo.root} 这个仓库`))),
      ...(fresh ? [NEW_REPO] : []),
    ].join('\n\n')
    return { context, ...(notice ? { notice } : {}) }
  }

  if (event.kind === 'edit') {
    const target = editTarget(cwd, event.file)
    if (!target) return undefined
    noteEditing(target.repo, sessionId, now)
    const deny = editRefusal(target, event.text)
    return deny ? { deny } : undefined
  }

  // 补丁：只记下改到的工作区（起点、碰过、干活的地方）。改文件之前的检查（beforeEdit）不接：一段补丁里有几个文件，修改的部分只有差异
  if (event.kind === 'patch') {
    for (const path of event.files) {
      const target = editTarget(cwd, path)
      if (target) noteEditing(target.repo, sessionId, now)
    }
    return undefined
  }

  if (event.kind === 'command') {
    // 记下会话第一次出现的时间：停止门只管这之后起的整组。会话不在仓库里开始（会话开始时没说节奏）时，
    // 第一次碰到接入的仓库就补说一次。
    const untold = untoldRepos(event.command, cwd, sessionId, now)
    for (const { repo, state } of untold) repo.store.saveSession(sessionId, { ...state, rhythm: true })
    const briefs = untold.map(({ repo }) => told(repo, agent, `${repo.root} 这个仓库`))
    let hints = modules().flatMap(module => module.beforeCommand?.(event.command, cwd) ?? [])
    if (AGENTS[agent].hooks.beforeCommand === 'refuse') {
      // 只能拒绝的 agent：说过节奏的会话不会再补说，提示（比如直接跑 full 的命令）却每次都有，同一段提示一个会话只拦一次，
      // 拦过的记在会话所在工作区的会话状态里；会话不在接入的仓库里时没处记，提示就不说（不拦）
      const repo = openRepo(cwd)
      const state = repo && joined(repo.root) ? repo.store.session(sessionId, now, () => defaultTips(repo)) : undefined
      hints = state ? hints.filter(hint => !state.refused?.includes(hint)) : []
      if (repo && state && hints.length > 0) repo.store.saveSession(sessionId, { ...state, refused: [...(state.refused ?? []), ...hints] })
      const reason = [...briefs, ...hints].join('\n\n')
      return reason ? { deny: `${reason}\n\n（这条命令被 gatelight 拦了一次，只为了把上面的话交给你；看过后照它做，要跑的话再跑一次，同样的话不会再拦。）` } : undefined
    }
    const context = [...briefs, ...hints].join('\n\n')
    return context ? { context } : undefined
  }

  if (event.kind === 'ran') {
    // 在前台跑完 testpace full，agent 已经看到了结果（失败的也是）；放到后台的要等它看 testpace status
    if (event.background) return undefined
    for (const call of invocations(event.command, cwd)) {
      if (basename(call.argv[0] ?? '') !== 'testpace' || call.argv[1] !== 'full') continue
      const repo = openRepo(call.cwd)
      if (repo) repo.store.markRead(sessionId, repo.root, now, () => defaultTips(repo))
    }
    return undefined
  }

  // 要结束这一轮：会话所在目录的仓库和会话碰过的仓库都查；不是所在目录的，话里写上是哪个仓库。
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
    ...(blocks.length ? { block: blocks.join('\n') } : {}),
    ...(warns.length ? { notice: warns.join('\n') } : {}),
  }
}

/** 一次 hook：把 agent 的输入读成内部事件，判断，把结论写成这个 agent 的输出。读写用哪一组看 AGENTS 表。没有要输出的返回 undefined。 */
export function handle(input: unknown, now: number, agent: AgentKind): unknown {
  const format = AGENTS[agent].hooks
  const event = format.read(input)
  const verdict = event && judge(event, now, agent)
  return event && verdict ? format.write(event, inAgentWords(verdict, agent)) : undefined
}
