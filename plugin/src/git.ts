// 和 git 打交道的部分：仓库位置、工作区内容哈希、默认分支、落地历史。

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync('git', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\n$/, '')
}

function gitOrUndefined(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args)
  } catch {
    return undefined
  }
}

/** 当前目录所在仓库（或 worktree）的根目录；不在仓库里返回 undefined。 */
export function repoRoot(cwd: string): string | undefined {
  return gitOrUndefined(cwd, ['rev-parse', '--show-toplevel'])
}

/** 所有 worktree 共用的 .git 目录。记录放这里：同一份内容在哪个 worktree 测过都算数。 */
export function commonDir(root: string): string {
  return git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
}

/**
 * 在一份临时索引上做事，不动真实索引。复制真实索引只为复用其中的文件状态缓存，
 * 内容以 fn 里的 git add 为准。
 */
function withTempIndex<T>(root: string, fn: (env: Record<string, string>) => T): T {
  const index = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  const dir = mkdtempSync(join(tmpdir(), 'testpace-index-'))
  const tmpIndex = join(dir, 'index')
  try {
    if (existsSync(index)) copyFileSync(index, tmpIndex)
    return fn({ GIT_INDEX_FILE: tmpIndex })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 工作区完整内容的哈希：已跟踪文件的当前内容加上未跟踪、未被 .gitignore 忽略的文件。
 * 结果就是 git 的树对象 id，和"把这些内容提交后的提交树"是同一个值。
 */
export function workTreeId(root: string): string {
  return withTempIndex(root, env => {
    // 标了 assume-unchanged 的文件，git add 会当它没改；先在临时索引里去掉这个标记。
    // skip-worktree（稀疏检出）不动：那些文件不在磁盘上，去掉标记会被当成删除。
    const assumed = git(root, ['ls-files', '-v', '-z'], env)
      .split('\0')
      .filter(entry => /^[a-z] /.test(entry))
      .map(entry => entry.slice(2))
    if (assumed.length > 0) {
      execFileSync('git', ['update-index', '--no-assume-unchanged', '-z', '--stdin'], {
        cwd: root,
        env: { ...process.env, ...env },
        input: `${assumed.join('\0')}\0`,
        stdio: ['pipe', 'ignore', 'pipe'],
      })
    }
    git(root, ['add', '--all', '--', '.'], env)
    return git(root, ['write-tree'], env)
  })
}

/** 两棵树之间改动过的文件路径（相对仓库根目录）。 */
export function changedPaths(root: string, from: string, to: string): string[] {
  const out = git(root, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to])
  return out.split('\0').filter(Boolean)
}

export function currentBranch(root: string): string | undefined {
  return gitOrUndefined(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
}

export function headCommit(root: string): string | undefined {
  return gitOrUndefined(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
}

/** 默认分支：先看 origin/HEAD，再看本地有没有 main、master。 */
export function defaultBranch(root: string): string | undefined {
  const remoteHead = gitOrUndefined(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (remoteHead) return remoteHead.replace(/^origin\//, '')
  for (const name of ['main', 'master']) {
    if (gitOrUndefined(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) return name
  }
  return undefined
}

export interface LandingFile {
  path: string
  added: number
}

export interface Landing {
  commit: string
  time: number
  files: LandingFile[]
}

/** 默认分支上每次落地（第一父链上的提交，合并按相对第一父的改动算）新增的行数。 */
export function landings(root: string, branch: string, sinceMs: number): Landing[] {
  const out = gitOrUndefined(root, [
    'log',
    '--first-parent',
    '--diff-merges=first-parent',
    '--no-renames',
    '--numstat',
    '--format=%x00%H %ct',
    `--since=${Math.floor(sinceMs / 1000)}`,
    `refs/heads/${branch}`,
    '--',
  ])
  if (!out) return []
  const result: Landing[] = []
  for (const chunk of out.split('\0').filter(Boolean)) {
    const [header = '', ...lines] = chunk.split('\n')
    const [commit = '', seconds = '0'] = header.split(' ')
    const files: LandingFile[] = []
    for (const line of lines) {
      const [added, , path] = line.split('\t')
      if (path === undefined || added === undefined || added === '-') continue
      files.push({ path, added: Number(added) })
    }
    result.push({ commit, time: Number(seconds) * 1000, files })
  }
  return result
}

/** 真实索引（暂存区）的树：不带 -a 的 git commit 会提交的内容。不改索引。 */
export function indexTree(root: string): string {
  return git(root, ['write-tree'])
}

/**
 * 暂存区加上已跟踪文件的改动：git commit -a 会提交的内容。
 * 和 git commit -a 一样不管 assume-unchanged 的文件。
 */
export function indexWithTrackedTree(root: string): string {
  return withTempIndex(root, env => {
    git(root, ['add', '--update', '--', '.'], env)
    return git(root, ['write-tree'], env)
  })
}

/** 一个提交（或分支、标签）的树；找不到返回 undefined。 */
export function treeOf(root: string, rev: string): string | undefined {
  return gitOrUndefined(root, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`])
}

export function commitOf(root: string, rev: string): string | undefined {
  return gitOrUndefined(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
}

export function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  try {
    git(root, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

export function mergeBase(root: string, a: string, b: string): string | undefined {
  return gitOrUndefined(root, ['merge-base', a, b])
}

/** 把 rev 合进 HEAD 的结果树；有冲突（合并会停下来等解决）时返回 undefined。 */
export function mergedTree(root: string, rev: string): string | undefined {
  const out = gitOrUndefined(root, ['merge-tree', '--write-tree', 'HEAD', rev])
  return out?.split('\n')[0]
}

/** 分支最新提交的 id、提交时间和树。 */
export function branchTip(root: string, branch: string): { commit: string; time: number; tree: string } | undefined {
  const out = gitOrUndefined(root, ['log', '-1', '--format=%H %ct %T', `refs/heads/${branch}`, '--'])
  if (!out) return undefined
  const [commit = '', seconds = '0', tree = ''] = out.split(' ')
  return { commit, time: Number(seconds) * 1000, tree }
}

/** 远程上的同名分支（refs/remotes/<远程>/<分支>）里有没有一个已经包含这个提交。 */
export function onRemoteBranch(root: string, branch: string, commit: string): boolean {
  const refs = gitOrUndefined(root, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${branch}`])
  return (refs ?? '').split('\n').filter(Boolean).some(ref => isAncestor(root, commit, ref))
}
