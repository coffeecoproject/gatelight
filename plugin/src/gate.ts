// 合并门：agent 的 git 命令要移动默认分支时，git 的 reference-transaction 钩子把分支要指向的提交交给
// testpace gate；那份代码没有 testpace full 的通过记录，就取消这次更新，默认分支不动。
// 判断发生在 git 更新分支的那一刻，按实际要落地的提交算，不管命令是怎么写的：
// commit、merge、cherry-pick、rebase、reset、脚本里调的 git 都一样。
// 只管 Claude Code 里的命令（钩子脚本看 CLAUDECODE 环境变量），用户自己在终端里的操作不管。
// 不经过本地默认分支的落地（git push 别的分支:main、gh pr merge）不在这里拦，由停止门事后提示。

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { short } from './format.ts'
import { commitOf, defaultBranch, hooksDir, isAncestor, onRemoteBranch, treeOf, workTreeId } from './git.ts'
import { contractOf, coverageOf, openRepo } from './repo.ts'

const HOOK_NAME = 'reference-transaction'
const MARK = '# testpace 合并门'

export const HOOK_SCRIPT = `#!/bin/sh
${MARK}（testpace install 写入，会被覆盖，不要手改）
# Claude Code 里的命令要移动分支时交给 testpace gate 检查；它拒绝，git 就取消这次更新。
# 用户自己在终端里的操作（没有 CLAUDECODE 环境变量）不管。
[ "$1" = prepared ] && [ -n "$CLAUDECODE" ] || exit 0
updates=
while read -r line; do
  case $line in
    *' refs/heads/'*) updates="$updates$line
" ;;
  esac
done
[ -n "$updates" ] || exit 0
if ! command -v testpace >/dev/null 2>&1; then
  echo 'testpace 合并门：找不到 testpace 命令（插件没启用），这次没有检查。' >&2
  exit 0
fi
printf '%s' "$updates" | testpace gate
`

export type GateState =
  | { kind: 'installed'; path: string }
  /** 装的是旧版本的钩子。 */
  | { kind: 'outdated'; path: string }
  /** 那个位置已经有别的 reference-transaction 钩子。 */
  | { kind: 'foreign'; path: string }
  | { kind: 'missing'; path: string }

function gateState(root: string): GateState {
  const path = join(hooksDir(root), HOOK_NAME)
  if (!existsSync(path)) return { kind: 'missing', path }
  const content = readFileSync(path, 'utf8')
  if (content === HOOK_SCRIPT) return { kind: 'installed', path }
  return content.includes(MARK) ? { kind: 'outdated', path } : { kind: 'foreign', path }
}

/** 装上（或更新）合并门的钩子。那个位置已经有别人的钩子时不覆盖，返回 foreign。 */
export function installGate(root: string): GateState {
  const state = gateState(root)
  if (state.kind === 'foreign' || state.kind === 'installed') return state
  mkdirSync(join(state.path, '..'), { recursive: true })
  writeFileSync(state.path, HOOK_SCRIPT)
  chmodSync(state.path, 0o755)
  return { kind: 'installed', path: state.path }
}

/** 钩子在工作区里（项目自己的 core.hooksPath 目录）时，它是项目文件，要提交。 */
export function hookInWorktree(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !rel.startsWith('..') && !rel.startsWith('.git/') && rel !== '.git'
}

/** 合并门没在把关时给 agent 的说明；在把关返回 undefined。 */
export function gateProblem(root: string): string | undefined {
  if (!defaultBranch(root)) {
    return '找不到默认分支（没有 origin/HEAD，本地也没有 main、master），合并门没有生效。设好 origin/HEAD（git remote set-head origin --auto）后才会检查。'
  }
  const state = gateState(root)
  if (state.kind === 'installed') return undefined
  if (state.kind === 'foreign') return `${state.path} 已经有别的 reference-transaction 钩子，合并门没装上。告诉用户，把 testpace 的检查合进那个钩子。`
  const what = state.kind === 'outdated' ? '是旧版本' : '还没装'
  return `合并门的 git 钩子${what}，提交、合并到默认分支时不会检查。跑 testpace install 装上。`
}

/**
 * git 钩子交来的引用更新（每行 "<旧值> <新值> <引用>"）：要移动默认分支、而且落地的代码没有整组通过记录时，
 * 返回拒绝的原因。
 */
export function checkRefUpdates(cwd: string, input: string): string | undefined {
  const repo = openRepo(cwd)
  const config = repo && contractOf(repo)
  const branch = repo && config && defaultBranch(repo.root)
  if (!repo || !config || !branch) return undefined
  const root = repo.root
  for (const line of input.split('\n')) {
    const [, next = '', ref] = line.split(' ')
    // 删除分支（新值全是 0）、符号引用不管
    if (ref !== `refs/heads/${branch}` || /^0+$/.test(next) || next.startsWith('ref:')) continue
    const current = commitOf(root, `refs/heads/${branch}`)
    // 退回默认分支以前的提交，或同步远程默认分支已有的提交：没有新内容落地
    if (current && isAncestor(root, next, current)) continue
    if (onRemoteBranch(root, branch, next)) continue
    const tree = treeOf(root, next)
    if (!tree) throw new Error(`读不到提交 ${next} 的内容`)
    if (coverageOf(repo, config, tree).kind !== 'none') continue
    const worktree = workTreeId(root)
    const note =
      worktree !== tree && coverageOf(repo, config, worktree).kind !== 'none'
        ? '工作区的整组通过了，但要落地的内容和工作区不一样：还有没提交的改动或未跟踪的文件。把它们一起提交，或者删掉、加进 .gitignore 后重跑整组。'
        : '先在要落地的这份代码上跑 testpace full（放后台），通过后再落地；几个分支一起合用 testpace:merge 技能，在合并分支上测过再快进。'
    return [
      `testpace 合并门：这次要把 ${branch} 更新到 ${short(next)}，那份代码（${short(tree)}）没有整组通过记录，${branch} 没有更新。`,
      note,
      '工作区和暂存区里可能留着这次操作带来的改动，用 git status 看；cherry-pick、rebase、revert 这类停在半路的操作先 --abort。',
    ].join('\n')
  }
  return undefined
}
