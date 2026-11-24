// 合并门：agent 的 git 命令要移动默认分支时，git 的 reference-transaction 钩子把分支要指向的提交交给
// testpace gate；那份代码没有 testpace full 的通过记录，就取消这次更新，默认分支不动。
// 判断发生在 git 更新分支的那一刻，按实际要落地的提交算，不管命令是怎么写的：
// commit、merge、cherry-pick、rebase、reset、脚本里调的 git 都一样。
// 只管 agent 的命令（钩子脚本看已接入的 agent 的标记变量，见 agent.ts 的 AGENTS），用户自己在终端里的操作不管。
// 不经过本地默认分支的落地（git push 别的分支:main、gh pr merge）不在这里拦，由停止门事后提示。
// 管不管、按哪些 ignore 判断，都看提交里的 testpace.json，不看工作区里的文件：
// 默认分支现在的代码或要落地的代码里有它就管，ignore 取要落地的那份。

import { AGENT_MARKERS } from './agent.ts'
import { contractAt, CONTRACT_FILE, effectiveIgnore } from './contract.ts'
import { short } from './format.ts'
import { commitOf, configuredHooks, configValue, FALLBACK_BRANCHES, findDefaultBranch, git, hasFile, hasRemote, isAncestor, onRemoteBranch, treeOf, workTreeId } from './git.ts'
import { coverageOf, openRepo, type Repo } from './repo.ts'
import { compareVersions, VERSION } from './version.ts'

/** 合并门在 git 配置里的钩子：hook.testpace.event、hook.testpace.command。 */
const HOOK = 'testpace'
const EVENT = 'reference-transaction'

/**
 * testpace gate 拒绝这次更新时的退出码。钩子只认它和 0：别的退出码都不是检查结论，放行。
 * 不和 node、sh 自己出错时的退出码（1、2、9、13、126、127、128 以上等）重合：
 * testpace 没能运行（找不到命令、插件没装全、找不到 node、崩了）时不会碰巧拿到它。
 */
export const GATE_REJECT = 20

/**
 * testpace gate 说"这次没有检查"时的退出码：认不出默认分支，这次更新却建出了 main、master（见 uncheckedNote）。
 * 钩子放行，原样转达它的话。和 GATE_REJECT 一样不和 node、sh 自己出错时的退出码重合。
 */
export const GATE_UNCHECKED = 21

const NOT_CHECKED = 'testpace 合并门：testpace 没有给出检查结论（退出码 %s），这次没有检查。可能是找不到 testpace 命令、插件没装全、找不到能运行它的 node，或会话里的 testpace 是旧版本（插件更新后，开着的会话要重开才换成新版本）。'

/**
 * 钩子命令，写在全局 git 配置里，所有仓库都跑它。git 用 sh 运行，把钩子参数接在命令后面，
 * 所以写成一个函数，最后一个词是函数名，参数交给它。
 * 判断都在 testpace gate 里，这里不放规则。
 * - 开头一句记下是哪一版 testpace 配的：不同 agent 里装的版本不同、命令正文也不同时，会话开始的自动更新只升不降，
 *   不来回覆盖。正文没变时不看这一句，发版不用重配。
 * - 只管 agent 的命令（命令环境里有已接入的 agent 的标记变量，见 agent.ts 的 AGENTS），用户自己在终端里的操作不管。
 * - 没有分支要动（只是远程跟踪分支、HEAD）的不调用 testpace：agent 每次更新引用都会经过这里，不用每次启动 node。
 * - 只有 testpace gate 明确拒绝（退出码 GATE_REJECT）才拦。它自己说这次没有检查的（退出码 GATE_UNCHECKED）放行，原样转达。
 *   别的都是没检查：放行，仓库里有 testpace.json（钩子在工作区根目录运行）才说一句、附上 testpace 的输出，别的仓库不打扰。
 */
const HOOK_BODY = [
  'testpace_gate() {',
  `[ "$1" = prepared ] && [ -n "${AGENT_MARKERS.map(name => `$${name}`).join('')}" ] || return 0;`,
  `testpace_refs=$(cat); case $testpace_refs in *' refs/heads/'*) ;; *) return 0 ;; esac;`,
  // printf 自己的报错不外露：testpace 起不来（找不到命令）时没人接这些内容，git 起钩子时又忽略 SIGPIPE，
  // printf 交不出去就会报一行 write error: Broken pipe，排在下面那句说明的前面
  `testpace_msg=$(printf '%s\\n' "$testpace_refs" 2>/dev/null | testpace gate 2>&1); testpace_code=$?;`,
  `[ "$testpace_code" != 0 ] || return 0;`,
  `if [ "$testpace_code" = ${GATE_REJECT} ]; then printf '%s\\n' "$testpace_msg" >&2; return 1; fi;`,
  `if [ "$testpace_code" = ${GATE_UNCHECKED} ]; then printf '%s\\n' "$testpace_msg" >&2; return 0; fi;`,
  `[ -f testpace.json ] || return 0;`,
  `printf '${NOT_CHECKED}\\n' "$testpace_code" >&2;`,
  `[ -z "$testpace_msg" ] || printf '%s\\n' "$testpace_msg" >&2;`,
  'return 0;',
  '}; testpace_gate',
].join(' ')

/** 钩子命令开头记版本的那一句。 */
const VERSION_TAG = /^: testpace (\S+); /

export const HOOK_COMMAND = `: testpace ${VERSION}; ${HOOK_BODY}`

type HookState =
  | { kind: 'installed' }
  /** 配了，但命令正文和这一版的不同，是更旧的版本配的。 */
  | { kind: 'outdated' }
  /** 配了，是更新的版本配的（比如另一个 agent 里装的 testpace 更新）：照常把关，不改回去。 */
  | { kind: 'newer'; version: string }
  | { kind: 'missing' }
  /** 配了，但这个仓库的 git 配置把它关了（hook.testpace.enabled = false）。 */
  | { kind: 'disabled' }
  /** git 太旧，不认配置里声明的钩子。 */
  | { kind: 'oldGit'; version: string }

/** 合并门的钩子在这个仓库里生没生效：git 认不认配置里的钩子，配没配，命令是不是这一版的。 */
function hookState(root: string): HookState {
  const hooks = configuredHooks(root, EVENT)
  if (!hooks) return { kind: 'oldGit', version: git(root, ['--version']).replace(/^git version /, '') }
  if (hooks.includes(`disabled\t${HOOK}`)) return { kind: 'disabled' }
  if (!hooks.includes(HOOK)) return { kind: 'missing' }
  const command = configValue(root, `hook.${HOOK}.command`) ?? ''
  // 只比命令正文：正文没变（只是发了新版）时不用重配
  if (command.replace(VERSION_TAG, '') === HOOK_BODY) return { kind: 'installed' }
  const version = VERSION_TAG.exec(command)?.[1]
  return version && compareVersions(version, VERSION) > 0 ? { kind: 'newer', version } : { kind: 'outdated' }
}

/** 合并门没在把关时的说明；在把关返回 undefined。status、会话说明和 install 共用。 */
function hookProblem(state: HookState): string | undefined {
  switch (state.kind) {
    case 'installed':
    case 'newer':
      return undefined
    case 'oldGit':
      return `这台机器的 git（${state.version}）不认配置里声明的钩子，合并门没有生效。要 git 2.54 以上：告诉用户升级 git（比如 brew upgrade git），不要自己装。`
    case 'missing':
      return `合并门没配（用户自己删掉了，或还没配过），提交、合并到默认分支时不会检查。用户要的话，跑 testpace install 在全局 git 配置里配上。`
    case 'disabled':
      return `git 配置把合并门的钩子关掉了（hook.${HOOK}.enabled = false），合并门没有生效。`
    case 'outdated':
      return `git 配置里合并门的钩子命令（hook.${HOOK}.command）不是这一版的，跑 testpace install 更新。`
  }
}

/** 合并门没在把关时给 agent 的说明；在把关返回 undefined。 */
export function gateProblem(root: string): string | undefined {
  const found = findDefaultBranch(root)
  if ('problem' in found) return `找不到默认分支（${found.problem}），合并门没有生效。设好 origin/HEAD（git remote set-head origin --auto）后才会检查。`
  return hookProblem(hookState(root))
}

/** origin/HEAD 指着不存在的分支时给用户的说明：合并门照常把关，守的是按 main、master 认出的那个。没有这回事返回 undefined。 */
export function danglingNote(root: string): string | undefined {
  const found = findDefaultBranch(root)
  if ('problem' in found || !found.dangling) return undefined
  return `origin/HEAD 指着不存在的分支 ${found.dangling}（远程可能改了默认分支的名字），默认分支按 ${found.branch} 算。用 git remote set-head origin --auto 更新。`
}

/**
 * 在全局 git 配置里配上合并门的钩子（这台机器配一次，所有仓库生效）。git 太旧时不配，返回原因；
 * 配好了还没生效（比如仓库自己的配置把它关了）也返回原因。
 */
export function installGate(root: string): { ok: boolean; problem?: string } {
  const before = hookState(root)
  if (before.kind === 'oldGit') return { ok: false, problem: hookProblem(before) }
  git(root, ['config', '--global', '--replace-all', `hook.${HOOK}.event`, EVENT])
  git(root, ['config', '--global', '--replace-all', `hook.${HOOK}.command`, HOOK_COMMAND])
  const problem = hookProblem(hookState(root))
  return problem ? { ok: false, problem: `全局 git 配置里配好了，但在这个仓库里没有生效：${problem}` } : { ok: true }
}

/** 自动配过合并门的记号（全局 git 配置）：之后钩子没了，是用户自己删的，不再自动配回去。 */
const AUTO_KEY = 'testpace.autoInstalled'

/**
 * 会话开始时自动配合并门：装了插件就当同意，不问，只告诉用户一声。
 * 没配过的配上；配过但命令是旧版本的更新；更新的版本配的、用户自己删掉的、git 太旧的、仓库把它关掉的不动。
 * 返回给用户看的说明，没动返回 undefined。
 */
export function ensureGate(root: string): string | undefined {
  const state = hookState(root)
  if (state.kind === 'outdated') {
    installGate(root)
    return undefined
  }
  if (state.kind !== 'missing' || configValue(root, AUTO_KEY) === 'true') return undefined
  const result = installGate(root)
  if (!result.ok) return undefined
  git(root, ['config', '--global', AUTO_KEY, 'true'])
  return [
    'testpace：在全局 git 配置里配上了合并门（这台机器上所有仓库生效）。',
    '它只在 agent 要把代码落到默认分支时检查有没有跑过全部测试，没接入 testpace 的仓库不受影响，你自己在终端里的操作也不管。',
    `不想要的话：git config --global --remove-section hook.${HOOK}，之后不会再自动配上。`,
  ].join('')
}

interface RefUpdate {
  next: string
  ref: string
}

/** 删除分支（新值全是 0）、符号引用：没有代码落地。 */
function landsNothing(next: string): boolean {
  return /^0+$/.test(next) || next.startsWith('ref:')
}

/**
 * 认不出默认分支时合并门没法把关。多数时候不用说（status 和会话说明里有），只有一种要当场说：这次更新建出了 main 或
 * master，建好以后它就是默认分支（比如没有远程的仓库把 main 删了再建），而那份代码接入了约定、又没有整组通过记录。
 * 不拦：建之前确实不知道该守哪个分支。
 */
function uncheckedNote(repo: Repo, updates: RefUpdate[], problem: string): string | undefined {
  for (const { next, ref } of updates) {
    const name = FALLBACK_BRANCHES.find(branch => ref === `refs/heads/${branch}`)
    if (!name || landsNothing(next)) continue
    const incoming = contractAt(repo.root, next)
    const tree = incoming && treeOf(repo.root, next)
    if (!tree || coverageOf(repo, effectiveIgnore(incoming, undefined), tree).kind !== 'none') continue
    return `testpace 合并门：这次建出了 ${name}，建之前认不出默认分支（${problem}），这次没有检查。它指向的代码（${short(tree)}）没有整组通过记录：在这份代码上跑 testpace full。`
  }
  return undefined
}

/** 合并门对一次引用更新的结论：reject 是拒绝的原因；unchecked 是这次没有检查、要当场说的话（放行）。 */
export type GateAnswer = { reject: string } | { unchecked: string }

/**
 * git 钩子交来的引用更新（每行 "<旧值> <新值> <引用>"）：要移动默认分支、而且落地的代码没有整组通过记录时，
 * 返回拒绝的原因。没有要说的返回 undefined。
 */
export function checkRefUpdates(cwd: string, input: string): GateAnswer | undefined {
  const repo = openRepo(cwd)
  if (!repo) return undefined
  const updates: RefUpdate[] = input.split('\n').map(line => {
    const [, next = '', ref = ''] = line.split(' ')
    return { next, ref }
  })
  const found = findDefaultBranch(repo.root)
  if ('problem' in found) {
    const unchecked = uncheckedNote(repo, updates, found.problem)
    return unchecked ? { unchecked } : undefined
  }
  const { branch } = found
  const root = repo.root
  // 同一次更新里远程默认分支（refs/remotes/<远程>/<分支>）的新位置：git fetch <远程> main:main 这类，
  // 本地分支和远程跟踪分支一起动，这时远程跟踪分支还没更新到位
  const fetched = updates.filter(({ ref }) => /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)?.[1] === branch).map(({ next }) => next)
  for (const { next, ref } of updates) {
    if (ref !== `refs/heads/${branch}` || landsNothing(next)) continue
    // 接入了约定的仓库才管：默认分支现在的代码或要落地的代码里有 testpace.json
    const incoming = contractAt(root, next)
    if (!incoming && !hasFile(root, `refs/heads/${branch}`, CONTRACT_FILE)) continue
    // ignore 按默认分支上原来那份认：这次要落地的代码里新加的规则，落地以后才生效
    const ignore = effectiveIgnore(incoming, contractAt(root, `refs/heads/${branch}`))
    const current = commitOf(root, `refs/heads/${branch}`)
    // 退回默认分支以前的提交，或同步远程默认分支已有的提交：没有新内容落地
    if (current && isAncestor(root, next, current)) continue
    if (onRemoteBranch(root, branch, next) || fetched.some(tip => isAncestor(root, next, tip))) continue
    const tree = treeOf(root, next)
    if (!tree) throw new Error(`读不到提交 ${next} 的内容`)
    if (coverageOf(repo, ignore, tree).kind !== 'none') continue
    const worktree = workTreeId(root)
    const notes = !incoming
      ? // 要落地的提交接在默认分支现在的提交后面：是这些提交删掉了它；不然是接入之前分出去的分支，本来就没有
        current && isAncestor(root, current, next)
        ? [`要落地的提交删掉了 ${CONTRACT_FILE}，拿不到整组通过记录。要退出接入，由用户自己在终端里提交；不是要退出，就把它恢复回来。`]
        : [`要落地的代码里没有 ${CONTRACT_FILE}（${branch} 上有），拿不到整组通过记录：这个分支是接入之前分出去的。把 ${branch} 合进这个分支再测。`]
      : incoming.problems.length > 0
        ? [`要落地的代码里的 ${CONTRACT_FILE} 有问题：${incoming.problems.join('；')}。testpace full 跑不了，拿不到整组通过记录：先修好它，在改好的代码上跑整组。`]
        : worktree !== tree && coverageOf(repo, ignore, worktree).kind !== 'none'
        ? ['工作区的整组通过了，但要落地的内容和工作区不一样：还有没提交的改动或未跟踪的文件。把它们一起提交，或者删掉、加进 .gitignore 后重跑整组。']
        : [
            '先在要落地的这份代码上跑 testpace full，通过后再落地；合并分支照 gatelight:merge 技能做，在合并分支上测过再快进。',
            ...(hasRemote(root) ? [`只是同步远程的 ${branch} 的话：先 git fetch <远程>，再把 ${branch} 快进到 <远程>/${branch}。`] : []),
          ]
    return {
      reject: [
        `testpace 合并门：这次要把 ${branch} 更新到 ${short(next)}，那份代码（${short(tree)}）没有整组通过记录，${branch} 没有更新。`,
        ...notes,
        '工作区和暂存区里可能留着这次操作带来的改动，用 git status 看；cherry-pick、rebase、revert 这类停在半路的操作先 --abort。',
      ].join('\n'),
    }
  }
  return undefined
}
