// 合并门（方案 5.3）：agent 的提交、合并、推送或 gh pr merge 要落到默认分支时，
// 算出落地后的代码内容，必须有一次 testpace full 通过的记录，否则拒绝。
// 工作区分支上的提交、用户自己在终端里的操作都不管。

import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import type { Config } from './config.ts'
import { short } from './format.ts'
import {
  commitOf,
  currentBranch,
  defaultBranch,
  commitTree,
  indexTree,
  isAncestor,
  mergedTree,
  onRemoteBranch,
  repoRoot,
  treeOf,
  workTreeId,
} from './git.ts'
import { contractOf, coverageOf, openRepo, type Repo } from './repo.ts'
import { gitSubcommand, type Invocation, invocations, runsCommand, splitArgs } from './shell.ts'

export interface GateResult {
  /** 拒绝的原因；没有就放行。 */
  deny?: string
  /** 放行时附给 agent 的提示。 */
  context?: string
}

/** 一条要落到默认分支的操作：落地后的代码内容（树），或者为什么没法放行。 */
type Landing =
  | { kind: 'none' }
  | { kind: 'tree'; repo: Repo; config: Config; branch: string; action: string; tree: string; note?: string }
  | { kind: 'deny'; reason: string }

const COMMIT_VALUES = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '-t', '--template',
  '--author', '--date', '--cleanup', '--fixup', '--squash', '--trailer',
])
const COMMIT_PARTIAL = new Set(['-p', '--patch', '--interactive', '-i', '--include', '-o', '--only', '--pathspec-from-file'])
const MERGE_VALUES = new Set(['-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--into-name'])
const PUSH_VALUES = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const GH_MERGE_VALUES = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit', '-R', '--repo'])
const ADD_VALUES = new Set(['--chmod', '--pathspec-from-file'])
const ADD_INTERACTIVE = new Set(['-p', '--patch', '-i', '--interactive', '-e', '--edit', '--pathspec-from-file'])

/**
 * 同一条命令里排在一次落地前面的命令。合并门在整条命令执行前判断，
 * 只算得出 git add 的效果；前面有别的命令时，落到默认分支的操作要拆开单独执行。
 */
interface Chain {
  /** 前面的 git add：提交时在临时索引上预演。 */
  adds: Array<{ cwd: string; args: string[] }>
  /** 前面别的命令（git add 和已放行的提交、合并之外）。 */
  others: Invocation[]
  /** 前面已放行、落到默认分支的提交或合并：仓库根目录 → 落地后默认分支的内容。 */
  landed: Map<string, string>
}

/** 接入了约定、而且当前在默认分支上的仓库。 */
function contracted(cwd: string): { repo: Repo; config: Config; branch: string } | undefined {
  const repo = openRepo(cwd)
  if (!repo) return undefined
  const config = contractOf(repo)
  const branch = config && defaultBranch(repo.root)
  return config && branch ? { repo, config, branch } : undefined
}

/** 会换分支的命令：之后的提交、合并落到哪个分支，执行前看不出来。 */
function switchesBranch(call: Invocation): boolean {
  const git = gitSubcommand(call)
  if (git) return git.sub === 'checkout' || git.sub === 'switch'
  const [program, area, action] = call.argv
  return basename(program ?? '') === 'gh' && area === 'pr' && action === 'checkout'
}

/** 落地前面连着算不出效果的命令：要拆开执行。 */
function split(chain: Chain, branch: string, action: string): Landing {
  const first = chain.others[0]
  const what = first ? first.argv.slice(0, 3).join(' ') : '前面的提交或合并'
  const space = /[A-Za-z0-9]$/.test(action) ? ' ' : ''
  return {
    kind: 'deny',
    reason: `这次${action}${space}要落到 ${branch}，但前面还连着别的命令（${what}）。合并门在整条命令执行前判断，算不出那些命令执行后落地的内容。先单独执行前面的命令，再单独${action}；落到 ${branch} 的命令前面只能连 cd 和 git add。`,
  }
}

function commitLanding(cwd: string, args: string[], chain: Chain): Landing {
  const target = contracted(cwd)
  if (!target) return { kind: 'none' }
  const root = target.repo.root
  const { options, positionals } = splitArgs(args, COMMIT_VALUES)
  if (options.includes('--dry-run')) return { kind: 'none' }
  if (currentBranch(root) !== target.branch && !chain.others.some(switchesBranch)) return { kind: 'none' }
  if (chain.others.length > 0 || chain.landed.size > 0) return split(chain, target.branch, '提交')
  if (positionals.length > 0 || options.some(option => COMMIT_PARTIAL.has(option))) {
    return {
      kind: 'deny',
      reason: `提交到 ${target.branch} 时没法确定带路径或 -p 这类提交的内容。先把要提交的内容全部加进暂存区，再不带路径地 git commit。`,
    }
  }
  const adds = chain.adds.filter(add => repoRoot(add.cwd) === root)
  if (adds.some(add => splitArgs(add.args, ADD_VALUES).options.some(option => ADD_INTERACTIVE.has(option)))) {
    return { kind: 'deny', reason: `git add -p 这类要交互的写法没法预演。先单独执行 git add，再提交到 ${target.branch}。` }
  }
  const all = options.includes('-a') || options.includes('--all')
  const tree = commitTree(root, adds, all)
  // 工作区整组通过了、但提交的内容和工作区不一样时，说清楚差在哪
  const worktree = workTreeId(root)
  const note =
    worktree !== tree && coverageOf(target.repo, target.config, worktree).kind !== 'none'
      ? '工作区的整组通过了，但这次提交的内容和工作区不一样：还有没加进暂存区的改动或未跟踪的文件。把它们一起提交，或者删掉、加进 .gitignore 后重跑整组。'
      : undefined
  return { kind: 'tree', ...target, action: '提交', tree, ...(note ? { note } : {}) }
}

function mergeLanding(cwd: string, args: string[], chain: Chain): Landing {
  const target = contracted(cwd)
  if (!target) return { kind: 'none' }
  const root = target.repo.root
  const { options, positionals } = splitArgs(args, MERGE_VALUES)
  if (['--abort', '--quit', '--no-commit', '--squash'].some(option => options.includes(option))) return { kind: 'none' }
  if (currentBranch(root) !== target.branch && !chain.others.some(switchesBranch)) return { kind: 'none' }
  if (chain.others.length > 0 || chain.landed.size > 0) return split(chain, target.branch, '合并')
  if (options.includes('--continue')) return { kind: 'tree', ...target, action: '合并', tree: indexTree(root) }
  if (positionals.length > 1) return { kind: 'deny', reason: `合并到 ${target.branch} 请一次合并一个分支，每次合并后的内容都要有整组通过记录。` }
  const rev = positionals[0] ?? '@{upstream}'
  const commit = commitOf(root, rev)
  if (!commit || isAncestor(root, commit, 'HEAD')) return { kind: 'none' }
  const fastForward = isAncestor(root, 'HEAD', commit)
  // 快进到远程默认分支已有的提交（同步远程）不是新落地
  if (fastForward && onRemoteBranch(root, target.branch, commit)) return { kind: 'none' }
  const tree = fastForward ? treeOf(root, commit) : mergedTree(root, commit)
  // 有冲突时合并会停下来，解决冲突后的提交还会经过合并门
  return tree ? { kind: 'tree', ...target, action: `合并 ${rev}`, tree } : { kind: 'none' }
}

function pushLanding(cwd: string, args: string[], chain: Chain): Landing {
  const target = contracted(cwd)
  if (!target) return { kind: 'none' }
  const root = target.repo.root
  const { options, positionals } = splitArgs(args, PUSH_VALUES)
  if (['-n', '--dry-run', '-d', '--delete'].some(option => options.includes(option))) return { kind: 'none' }
  const current = currentBranch(root)
  let source: string | undefined
  if (['--all', '--branches', '--mirror'].some(option => options.includes(option))) {
    source = `refs/heads/${target.branch}`
  } else if (positionals.length <= 1) {
    if (current === target.branch) source = 'HEAD'
  } else {
    for (const refspec of positionals.slice(1)) {
      const spec = refspec.replace(/^\+/, '')
      const [src = '', dst = src] = spec.includes(':') ? spec.split(':') : [spec, spec === 'HEAD' ? (current ?? '') : spec]
      if (src !== '' && dst.replace(/^refs\/heads\//, '') === target.branch) source = src
    }
  }
  if (chain.others.length > 0 && (source || chain.others.some(switchesBranch))) return split(chain, target.branch, '推送')
  if (!source) return { kind: 'none' }
  // 推送前面刚放行的提交或合并：默认分支落地后的内容已经检查过
  const landed = chain.landed.get(root)
  if (landed && ['HEAD', target.branch, `refs/heads/${target.branch}`].includes(source)) {
    return { kind: 'tree', ...target, action: '推送', tree: landed }
  }
  const commit = commitOf(root, source)
  // 远程默认分支已经有这个提交：没有新内容落地
  if (!commit || onRemoteBranch(root, target.branch, commit)) return { kind: 'none' }
  const tree = treeOf(root, commit)
  return tree ? { kind: 'tree', ...target, action: '推送', tree } : { kind: 'none' }
}

function prMergeLanding(cwd: string, args: string[], chain: Chain): Landing {
  const target = contracted(cwd)
  if (!target) return { kind: 'none' }
  const root = target.repo.root
  const { options, positionals } = splitArgs(args, GH_MERGE_VALUES)
  if (options.includes('--disable-auto')) return { kind: 'none' }
  const repoAt = args.findIndex(arg => arg === '-R' || arg === '--repo')
  const view = ['pr', 'view', ...positionals.slice(0, 1), '--json', 'baseRefName,headRefOid', ...(repoAt !== -1 ? ['--repo', args[repoAt + 1] ?? ''] : [])]
  let pr: { baseRefName: string; headRefOid: string }
  try {
    pr = JSON.parse(execFileSync('gh', view, { cwd, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch (error) {
    const detail = String((error as { stderr?: unknown }).stderr ?? (error as Error).message).trim().split('\n')[0]
    return { kind: 'deny', reason: `合并 PR 前要确认合并后的内容测过，但读不到 PR 的信息（${detail}）。` }
  }
  if (pr.baseRefName !== target.branch) return { kind: 'none' }
  // 前面的命令可能改了 PR（比如推送了新提交），这里读到的是执行前的 PR
  if (chain.others.length > 0 || chain.landed.size > 0) return split(chain, target.branch, '合并 PR')
  const head = commitOf(root, pr.headRefOid)
  if (!head) return { kind: 'deny', reason: `本地没有 PR 的最新提交 ${short(pr.headRefOid)}，先 git fetch，在这份代码上跑过整组再合并。` }
  const base = commitOf(root, `refs/remotes/origin/${target.branch}`) ?? commitOf(root, `refs/heads/${target.branch}`)
  if (base && !isAncestor(root, base, head)) {
    return {
      kind: 'deny',
      reason: `PR 分支没有包含最新的 ${target.branch}，合并后的内容和测过的不一样。先把 ${target.branch} 合进 PR 分支，跑过整组、推送后再合并。`,
    }
  }
  const tree = treeOf(root, head)
  return tree ? { kind: 'tree', ...target, action: '合并 PR', tree } : { kind: 'none' }
}

function landingOf(invocation: Invocation, chain: Chain): Landing {
  const git = gitSubcommand(invocation)
  if (git?.sub === 'commit') return commitLanding(git.cwd, git.args, chain)
  if (git?.sub === 'merge') return mergeLanding(git.cwd, git.args, chain)
  if (git?.sub === 'push') return pushLanding(git.cwd, git.args, chain)
  const [program, area, action, ...rest] = invocation.argv
  if (basename(program ?? '') === 'gh' && area === 'pr' && action === 'merge') return prMergeLanding(invocation.cwd, rest, chain)
  return { kind: 'none' }
}

function judge(landing: Landing): string | undefined {
  if (landing.kind === 'none') return undefined
  if (landing.kind === 'deny') return `testpace 合并门：${landing.reason}`
  if (coverageOf(landing.repo, landing.config, landing.tree).kind !== 'none') return undefined
  return [
    `testpace 合并门：这次${landing.action}${/[A-Za-z0-9]$/.test(landing.action) ? ' ' : ''}要落到 ${landing.branch} 的代码（${short(landing.tree)}）没有整组通过记录。`,
    landing.note ?? '先跑 testpace full（放后台），通过后再落地。',
    '整组记录的是跑的那一刻工作区的全部内容（含未提交、未跟踪的文件），落地的内容要和它完全一致。',
  ].join('')
}

/** PreToolUse 对一条 Bash 命令的判断。 */
export function checkCommand(command: string, cwd: string): GateResult {
  const calls = invocations(command, cwd)
  const chain: Chain = { adds: [], others: [], landed: new Map() }
  for (const call of calls) {
    const git = gitSubcommand(call)
    if (git?.sub === 'add') {
      chain.adds.push({ cwd: git.cwd, args: git.args })
      continue
    }
    let reason: string | undefined
    try {
      const landing = landingOf(call, chain)
      reason = judge(landing)
      if (!reason && landing.kind === 'tree' && (git?.sub === 'commit' || git?.sub === 'merge')) chain.landed.set(landing.repo.root, landing.tree)
      else chain.others.push(call)
    } catch (error) {
      reason = `testpace 合并门：没能确认这条命令落地的内容测过（${(error as Error).message.split('\n')[0]}），先不放行。`
    }
    // agent 容易以为前面的 git add 这类命令已经执行了
    if (reason) return { deny: `${reason}整条命令都没有执行。` }
  }
  // 直接跑配置里的整组命令不会留下记录，合并门不认
  const repo = openRepo(cwd)
  const config = repo && contractOf(repo)
  const runsTestpace = calls.some(call => basename(call.argv[0] ?? '') === 'testpace')
  if (config?.full && !runsTestpace && runsCommand(command, config.full, cwd)) {
    return { context: '这是 testpace.json 里的整组命令。直接跑不会留下通过记录，合并门不认；改用 testpace full（放后台跑），结果会按当前代码记录。' }
  }
  return {}
}
