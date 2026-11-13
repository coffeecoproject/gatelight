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
 * 在一份真实索引的副本上做事，不动真实索引。副本带着暂存区的内容和文件状态缓存。
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
  // -z：路径原样输出（不加引号、不转义中文）。每个提交是一个 "<id> <时间>" 字段，后面跟着它的 "新增\t删除\t路径" 字段
  const out = gitOrUndefined(root, [
    'log',
    '--first-parent',
    '--diff-merges=first-parent',
    '--no-renames',
    '--numstat',
    '-z',
    '--format=%H %ct',
    `--since=${Math.floor(sinceMs / 1000)}`,
    `refs/heads/${branch}`,
    '--',
  ])
  if (!out) return []
  const result: Landing[] = []
  for (const field of out.split('\0')) {
    const header = /^\n?([0-9a-f]{40,64}) (\d+)$/.exec(field)
    if (header) {
      result.push({ commit: header[1]!, time: Number(header[2]) * 1000, files: [] })
      continue
    }
    const stat = /^\n?(\d+|-)\t(?:\d+|-)\t(.+)$/s.exec(field)
    if (!stat || stat[1] === '-') continue
    result.at(-1)?.files.push({ path: stat[2]!, added: Number(stat[1]) })
  }
  return result
}

/** 一个提交（或分支、标签）的树；找不到返回 undefined。 */
export function treeOf(root: string, rev: string): string | undefined {
  return gitOrUndefined(root, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`])
}

export function commitOf(root: string, rev: string): string | undefined {
  return gitOrUndefined(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
}

/** 提交（或分支）里有没有这个文件（path 相对仓库根目录）。 */
export function hasFile(root: string, rev: string, path: string): boolean {
  return gitOrUndefined(root, ['cat-file', '-e', `${rev}:${path}`]) !== undefined
}

/** 提交（或分支）里这个文件的内容（path 相对仓库根目录）；没有这个文件返回 undefined。 */
export function fileAt(root: string, rev: string, path: string): string | undefined {
  return gitOrUndefined(root, ['cat-file', 'blob', `${rev}:${path}`])
}

/** 这个路径（相对仓库根目录）被 .gitignore 忽略，进不了版本库。 */
export function isIgnored(root: string, path: string): boolean {
  return gitOrUndefined(root, ['check-ignore', '-q', '--', path]) !== undefined
}

export function hasRemote(root: string): boolean {
  return (gitOrUndefined(root, ['remote']) ?? '') !== ''
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

/** 一个引用（比如 refs/heads/main、refs/remotes/origin/main）指向的提交和它的树；引用不存在返回 undefined。 */
export function refTip(root: string, ref: string): { commit: string; tree: string } | undefined {
  const out = gitOrUndefined(root, ['log', '-1', '--format=%H %T', ref, '--'])
  if (!out) return undefined
  const [commit = '', tree = ''] = out.split(' ')
  return { commit, tree }
}

/** git 钩子所在的目录（考虑了 core.hooksPath），所有 worktree 共用。 */
export function hooksDir(root: string): string {
  return git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'])
}

/** 远程上的同名分支（refs/remotes/<远程>/<分支>）里有没有一个已经包含这个提交。 */
export function onRemoteBranch(root: string, branch: string, commit: string): boolean {
  const refs = gitOrUndefined(root, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${branch}`])
  return (refs ?? '').split('\n').filter(Boolean).some(ref => isAncestor(root, commit, ref))
}
