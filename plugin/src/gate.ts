// 合并门：agent 的 git 命令要移动默认分支时，git 的 reference-transaction 钩子把分支要指向的提交交给
// testpace gate；那份代码没有 testpace full 的通过记录，就取消这次更新，默认分支不动。
// 判断发生在 git 更新分支的那一刻，按实际要落地的提交算，不管命令是怎么写的：
// commit、merge、cherry-pick、rebase、reset、脚本里调的 git 都一样。
// 只管 Claude Code 里的命令（钩子脚本看 CLAUDECODE 环境变量），用户自己在终端里的操作不管。
// 不经过本地默认分支的落地（git push 别的分支:main、gh pr merge）不在这里拦，由停止门事后提示。
// 管不管、按哪些 ignore 判断，都看提交里的 testpace.json，不看工作区里的文件：
// 默认分支现在的代码或要落地的代码里有它就管，ignore 取要落地的那份。

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { CONFIG_FILE } from './config.ts'
import { short } from './format.ts'
import { commitOf, defaultBranch, hasFile, hasRemote, hooksDir, isAncestor, isIgnored, onRemoteBranch, treeOf, workTreeId } from './git.ts'
import { contractAt, coverageOf, openRepo } from './repo.ts'

const HOOK_NAME = 'reference-transaction'
const MARK = '# testpace 合并门'

export const HOOK_SCRIPT = `#!/bin/sh
${MARK}（testpace install 写入，会被覆盖，不要手改）
# Claude Code 里的命令要移动分支时交给 testpace gate 检查；它拒绝，git 就取消这次更新。
# 同一次更新里远程跟踪分支的新位置也带上：同步远程默认分支已有的提交不算新落地。
# 用户自己在终端里的操作（没有 CLAUDECODE 环境变量）不管。
[ "$1" = prepared ] && [ -n "$CLAUDECODE" ] || exit 0
updates=
heads=
while read -r line; do
  case $line in
    *' refs/heads/'*) heads=1; updates="$updates$line
" ;;
    *' refs/remotes/'*) updates="$updates$line
" ;;
  esac
done
[ -n "$heads" ] || exit 0
if ! command -v testpace >/dev/null 2>&1; then
  echo 'testpace 合并门：找不到 testpace 命令（插件没启用），这次没有检查。' >&2
  exit 0
fi
printf '%s' "$updates" | testpace gate
`

/** 那个位置已经有别的钩子时，把检查加进去的写法。 */
export const MERGE_HINT = `在那个钩子里加上这几行（放在它读标准输入之前，testpace gate 要读 git 给的引用更新）：
  if [ "$1" = prepared ] && [ -n "$CLAUDECODE" ] && command -v testpace >/dev/null 2>&1; then
    testpace gate || exit 1
  fi`

export type GateState =
  | { kind: 'installed'; path: string }
  /** 那个位置是别的钩子，它自己调用了 testpace gate。 */
  | { kind: 'merged'; path: string }
  /** 装的是旧版本的钩子。 */
  | { kind: 'outdated'; path: string }
  /** 那个位置已经有别的 reference-transaction 钩子，里面没有调用 testpace gate。 */
  | { kind: 'foreign'; path: string }
  | { kind: 'missing'; path: string }

function gateState(root: string): GateState {
  const path = join(hooksDir(root), HOOK_NAME)
  if (!existsSync(path)) return { kind: 'missing', path }
  const content = readFileSync(path, 'utf8')
  if (content === HOOK_SCRIPT) return { kind: 'installed', path }
  if (content.includes(MARK)) return { kind: 'outdated', path }
  const callsGate = content.split('\n').some(line => !line.trimStart().startsWith('#') && /\btestpace gate\b/.test(line))
  return { kind: callsGate ? 'merged' : 'foreign', path }
}

/** 装上（或更新）合并门的钩子。那个位置已经有别人的钩子时不动它，返回 merged 或 foreign。 */
export function installGate(root: string): GateState {
  const state = gateState(root)
  if (state.kind !== 'missing' && state.kind !== 'outdated') return state
  mkdirSync(join(state.path, '..'), { recursive: true })
  writeFileSync(state.path, HOOK_SCRIPT)
  chmodSync(state.path, 0o755)
  return { kind: 'installed', path: state.path }
}

/**
 * 钩子放在哪：git 自己的钩子目录（所有工作区共用）；项目的钩子目录（core.hooksPath 在工作区里），是项目文件，要提交；
 * 项目的钩子目录但被 .gitignore 忽略（比如 husky 的 .husky/_），进不了版本库，每个工作区各装一次。
 */
export function hookPlace(root: string, path: string): 'git' | 'project' | 'ignored' {
  const rel = relative(root, path)
  if (rel.startsWith('..') || rel.startsWith('.git/') || rel === '.git') return 'git'
  return isIgnored(root, rel) ? 'ignored' : 'project'
}

/** 合并门没在把关时给 agent 的说明；在把关返回 undefined。 */
export function gateProblem(root: string): string | undefined {
  const branch = defaultBranch(root)
  if (!branch) {
    return '找不到默认分支（没有 origin/HEAD，本地也没有 main、master），合并门没有生效。设好 origin/HEAD（git remote set-head origin --auto）后才会检查。'
  }
  const state = gateState(root)
  if (state.kind === 'installed' || state.kind === 'merged') return undefined
  if (state.kind === 'foreign') return `${state.path} 已经有别的 reference-transaction 钩子，合并门没装上。告诉用户，要在那个钩子里调用 testpace gate（写法跑 testpace install 看）。`
  if (state.kind === 'outdated') return '合并门的 git 钩子是旧版本，跑 testpace install 更新。'
  const rel = relative(root, state.path)
  const place = hookPlace(root, state.path)
  // 项目自己的钩子目录（core.hooksPath 是相对路径）跟着检出的分支走：默认分支上提交了钩子，这个分支还没有
  if (place === 'project' && hasFile(root, `refs/heads/${branch}`, rel)) {
    return `这个工作区检出的代码里还没有合并门的钩子（${rel}）：项目的钩子目录跟着分支走，${branch} 上已经有了，把 ${branch} 合进这个分支就有。在那之前，在这个工作区里移动 ${branch} 不会检查。`
  }
  const each = place === 'ignored' ? `这个项目的钩子目录（${dirname(rel)}）不进版本库，每个工作区要各装一次。` : ''
  return `合并门的 git 钩子还没装，提交、合并到默认分支时不会检查。${each}跑 testpace install 装上。`
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
    const config = incoming ?? { ignore: [] }
    const current = commitOf(root, `refs/heads/${branch}`)
    // 退回默认分支以前的提交，或同步远程默认分支已有的提交：没有新内容落地
    if (current && isAncestor(root, next, current)) continue
    if (onRemoteBranch(root, branch, next) || fetched.some(tip => isAncestor(root, next, tip))) continue
    const tree = treeOf(root, next)
    if (!tree) throw new Error(`读不到提交 ${next} 的内容`)
    if (coverageOf(repo, config, tree).kind !== 'none') continue
    const worktree = workTreeId(root)
    const notes = !incoming
      ? [`要落地的代码里没有 ${CONFIG_FILE}（${branch} 上有），拿不到整组通过记录。不是要退出接入，就把 ${branch} 合进这个分支再测；要退出接入，由用户自己在终端里提交。`]
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
