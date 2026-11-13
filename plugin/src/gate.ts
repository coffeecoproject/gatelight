// 合并门：agent 的 git 命令要移动默认分支时，git 的 reference-transaction 钩子把分支要指向的提交交给
// testpace gate；那份代码没有 testpace full 的通过记录，就取消这次更新，默认分支不动。
// 判断发生在 git 更新分支的那一刻，按实际要落地的提交算，不管命令是怎么写的：
// commit、merge、cherry-pick、rebase、reset、脚本里调的 git 都一样。
// 只管 Claude Code 里的命令（钩子脚本看 CLAUDECODE 环境变量），用户自己在终端里的操作不管。
// 不经过本地默认分支的落地（git push 别的分支:main、gh pr merge）不在这里拦，由停止门事后提示。
// 管不管、按哪些 ignore 判断，都看提交里的 testpace.json，不看工作区里的文件：
// 默认分支现在的代码或要落地的代码里有它就管，ignore 取要落地的那份。

import { CONFIG_FILE } from './config.ts'
import { short } from './format.ts'
import { commitOf, configuredHooks, configValue, defaultBranch, git, hasFile, hasRemote, isAncestor, onRemoteBranch, treeOf, workTreeId } from './git.ts'
import { contractAt, coverageOf, openRepo } from './repo.ts'

/** 合并门在 git 配置里的钩子：hook.testpace.event、hook.testpace.command。 */
const HOOK = 'testpace'
const EVENT = 'reference-transaction'

const NO_TESTPACE = 'testpace 合并门：找不到 testpace 命令（插件没启用），这次没有检查。'
const OLD_TESTPACE = 'testpace 合并门：这个会话用的 testpace 是旧版本，没有合并门的检查，这次没有检查。插件更新后，开着的会话要重开才换成新版本。'

/**
 * 钩子命令，写在全局 git 配置里，所有仓库都跑它。git 用 sh 运行，把钩子参数接在命令后面，
 * 所以写成一个函数，最后一个词是函数名，参数交给它。
 * 判断都在 testpace gate 里，这里不放规则：升级插件不用重配。
 * - 只管 Claude Code 里的命令（CLAUDECODE），用户自己在终端里的操作不管。
 * - 没有分支要动（只是远程跟踪分支、HEAD）的不调用 testpace：agent 每次更新引用都会经过这里，不用每次启动 node。
 * - 找不到 testpace 命令时不挡；仓库里有 testpace.json（钩子在工作区根目录运行）才说一句，别的仓库不打扰。
 * - testpace gate 只用退出码 0（放行）和 1（拦下）。2 是还没有 gate 命令的旧版 testpace
 *   （插件更新后，开着的会话要重开才换成新版本）：和找不到 testpace 一样处理。
 */
export const HOOK_COMMAND = [
  'testpace_gate() {',
  '[ "$1" = prepared ] && [ -n "$CLAUDECODE" ] || return 0;',
  `testpace_refs=$(cat); case $testpace_refs in *' refs/heads/'*) ;; *) return 0 ;; esac;`,
  `command -v testpace >/dev/null 2>&1 || { [ ! -f testpace.json ] || echo '${NO_TESTPACE}' >&2; return 0; };`,
  `testpace_msg=$(printf '%s\\n' "$testpace_refs" | testpace gate 2>&1); testpace_code=$?;`,
  `if [ "$testpace_code" = 2 ]; then [ ! -f testpace.json ] || echo '${OLD_TESTPACE}' >&2; return 0; fi;`,
  `[ -z "$testpace_msg" ] || printf '%s\\n' "$testpace_msg" >&2;`,
  'return "$testpace_code";',
  '}; testpace_gate',
].join(' ')

type HookState =
  | { kind: 'installed' }
  /** 配了，但命令不是这一版的。 */
  | { kind: 'outdated' }
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
  return configValue(root, `hook.${HOOK}.command`) === HOOK_COMMAND ? { kind: 'installed' } : { kind: 'outdated' }
}

/** 合并门没在把关时的说明；在把关返回 undefined。status、会话说明和 install 共用。 */
function hookProblem(state: HookState): string | undefined {
  switch (state.kind) {
    case 'installed':
      return undefined
    case 'oldGit':
      return `这台机器的 git（${state.version}）不认配置里声明的钩子，合并门没有生效。要 git 2.54 以上：告诉用户升级 git（比如 brew upgrade git），不要自己装。`
    case 'missing':
      return `合并门还没配，提交、合并到默认分支时不会检查。跑 testpace install：在全局 git 配置里加上合并门的钩子，这台机器上所有仓库都生效。改的是用户的全局配置，先问用户。`
    case 'disabled':
      return `git 配置把合并门的钩子关掉了（hook.${HOOK}.enabled = false），合并门没有生效。`
    case 'outdated':
      return `git 配置里合并门的钩子命令（hook.${HOOK}.command）不是这一版的，跑 testpace install 更新。`
  }
}

/** 合并门没在把关时给 agent 的说明；在把关返回 undefined。 */
export function gateProblem(root: string): string | undefined {
  if (!defaultBranch(root)) {
    return '找不到默认分支（没有 origin/HEAD，本地也没有 main、master），合并门没有生效。设好 origin/HEAD（git remote set-head origin --auto）后才会检查。'
  }
  return hookProblem(hookState(root))
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

/**
 * git 钩子交来的引用更新（每行 "<旧值> <新值> <引用>"）：要移动默认分支、而且落地的代码没有整组通过记录时，
 * 返回拒绝的原因。
 */
export function checkRefUpdates(cwd: string, input: string): string | undefined {
  const repo = openRepo(cwd)
  const branch = repo && defaultBranch(repo.root)
  if (!repo || !branch) return undefined
  const root = repo.root
  const updates = input.split('\n').map(line => {
    const [, next = '', ref = ''] = line.split(' ')
    return { next, ref }
  })
  // 同一次更新里远程默认分支（refs/remotes/<远程>/<分支>）的新位置：git fetch <远程> main:main 这类，
  // 本地分支和远程跟踪分支一起动，这时远程跟踪分支还没更新到位
  const fetched = updates.filter(({ ref }) => /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)?.[1] === branch).map(({ next }) => next)
  for (const { next, ref } of updates) {
    // 删除分支（新值全是 0）、符号引用不管
    if (ref !== `refs/heads/${branch}` || /^0+$/.test(next) || next.startsWith('ref:')) continue
    // 接入了约定的仓库才管：默认分支现在的代码或要落地的代码里有 testpace.json
    const incoming = contractAt(repo, next)
    if (!incoming && !hasFile(root, `refs/heads/${branch}`, CONFIG_FILE)) continue
    const config = incoming?.config ?? { ignore: [] }
    const current = commitOf(root, `refs/heads/${branch}`)
    // 退回默认分支以前的提交，或同步远程默认分支已有的提交：没有新内容落地
    if (current && isAncestor(root, next, current)) continue
    if (onRemoteBranch(root, branch, next) || fetched.some(tip => isAncestor(root, next, tip))) continue
    const tree = treeOf(root, next)
    if (!tree) throw new Error(`读不到提交 ${next} 的内容`)
    if (coverageOf(repo, config, tree).kind !== 'none') continue
    const worktree = workTreeId(root)
    const notes = !incoming
      ? // 要落地的提交接在默认分支现在的提交后面：是这些提交删掉了它；不然是接入之前分出去的分支，本来就没有
        current && isAncestor(root, current, next)
        ? [`要落地的提交删掉了 ${CONFIG_FILE}，拿不到整组通过记录。要退出接入，由用户自己在终端里提交；不是要退出，就把它恢复回来。`]
        : [`要落地的代码里没有 ${CONFIG_FILE}（${branch} 上有），拿不到整组通过记录：这个分支是接入之前分出去的。把 ${branch} 合进这个分支再测。`]
      : !incoming.config?.full
        ? [`要落地的代码里的 ${CONFIG_FILE} 有问题：${incoming.problems.join('；')}。testpace full 跑不了，拿不到整组通过记录：先修好它，在改好的代码上跑整组。`]
        : worktree !== tree && coverageOf(repo, config, worktree).kind !== 'none'
        ? ['工作区的整组通过了，但要落地的内容和工作区不一样：还有没提交的改动或未跟踪的文件。把它们一起提交，或者删掉、加进 .gitignore 后重跑整组。']
        : [
            '先在要落地的这份代码上跑 testpace full（放后台），通过后再落地；几个分支一起合用 testpace:merge 技能，在合并分支上测过再快进。',
            ...(hasRemote(root) ? [`只是同步远程的 ${branch} 的话：先 git fetch <远程>，再把 ${branch} 快进到 <远程>/${branch}。`] : []),
          ]
    return [
      `testpace 合并门：这次要把 ${branch} 更新到 ${short(next)}，那份代码（${short(tree)}）没有整组通过记录，${branch} 没有更新。`,
      ...notes,
      '工作区和暂存区里可能留着这次操作带来的改动，用 git status 看；cherry-pick、rebase、revert 这类停在半路的操作先 --abort。',
    ].join('\n')
  }
  return undefined
}
