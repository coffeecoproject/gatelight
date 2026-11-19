// 和 git 打交道的部分：仓库位置、工作区内容哈希、默认分支、落地历史。

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync('git', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\n$/, '')
}

/** 跑一条 git 命令；它失败时返回 undefined。 */
export function gitOr(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args)
  } catch {
    return undefined
  }
}

/**
 * 配置里给这个钩子事件声明的钩子（git hook list），每个一行，被关掉的写成 "disabled\t<名字>"；
 * 没有任何钩子时是空的。git 太旧、没有 hook list 时返回 undefined。
 */
export function configuredHooks(root: string, event: string): string[] | undefined {
  const r = spawnSync('git', ['hook', 'list', event], { cwd: root, encoding: 'utf8' })
  // 没有任何钩子时退出码 1；git 太旧时是用法错误
  if (r.status !== 0 && r.status !== 1) return undefined
  return r.stdout.split('\n').filter(Boolean)
}

/** git 配置里这一项的值（各层配置合起来）；没有返回 undefined。 */
export function configValue(root: string, key: string): string | undefined {
  return gitOr(root, ['config', '--get', key])
}

/** 当前目录所在仓库（或 worktree）的根目录；不在仓库里返回 undefined。 */
export function repoRoot(cwd: string): string | undefined {
  return gitOr(cwd, ['rev-parse', '--show-toplevel'])
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
  return gitOr(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
}

export function headCommit(root: string): string | undefined {
  return gitOr(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
}

function refExists(root: string, ref: string): boolean {
  return gitOr(root, ['rev-parse', '--verify', '--quiet', ref]) !== undefined
}

const ORIGIN = 'refs/remotes/origin/'

export type DefaultBranch =
  | {
      branch: string
      /** origin/HEAD 指着一个不存在的分支（远程改了默认分支的名字，本地还是旧的）：它指的是谁。这时默认分支是按 main、master 认的。 */
      dangling?: string
    }
  | { branch?: undefined; problem: string }

/**
 * 默认分支，认不出时说明原因。只在这里认，合并门、停止门、选测试的对比、报告都用这一个结果。
 * origin/HEAD 指的分支在 origin 上确实有才信它：指着不存在的分支时照没有 origin/HEAD 认，
 * 不然合并门守的是一个不存在的分支，真正的默认分支没人管。
 * 没有可信的 origin/HEAD 时看 main、master，本地有或 origin 上有都算。
 */
export function findDefaultBranch(root: string): DefaultBranch {
  const head = gitOr(root, ['symbolic-ref', '--quiet', `${ORIGIN}HEAD`])
  const target = head?.startsWith(ORIGIN) ? head.slice(ORIGIN.length) : head
  if (target && head?.startsWith(ORIGIN) && refExists(root, head)) return { branch: target }
  for (const name of ['main', 'master']) {
    if (refExists(root, `refs/heads/${name}`) || refExists(root, `${ORIGIN}${name}`)) return { branch: name, ...(target ? { dangling: target } : {}) }
  }
  return {
    problem: target ? `origin/HEAD 指着不存在的分支 ${target}，本地和 origin 上也没有 main、master` : '没有 origin/HEAD，本地和 origin 上也没有 main、master',
  }
}

export function defaultBranch(root: string): string | undefined {
  return findDefaultBranch(root).branch
}

export type ForkPoint =
  | {
      /** 分叉点的提交。 */
      commit: string
      /** 和哪个默认分支比的。 */
      branch: string
    }
  | { commit?: undefined; problem: string }

/**
 * 这次改动从哪里算起：当前提交和默认分支的分叉点（本地的默认分支，没有就用 origin 上的）。直接在默认分支上就是当前提交。
 * 只在这里算，选测试的对比、评判用的配置读哪一版（judging.ts）都用这一个结果。算不出时说明原因。
 */
export function forkPoint(root: string): ForkPoint {
  const found = findDefaultBranch(root)
  if ('problem' in found) return { problem: `认不出默认分支：${found.problem}` }
  const { branch } = found
  if (!headCommit(root)) return { problem: '仓库还没有提交' }
  const commit = mergeBase(root, 'HEAD', `refs/heads/${branch}`) ?? mergeBase(root, 'HEAD', `${ORIGIN}${branch}`)
  return commit ? { commit, branch } : { problem: `当前提交和 ${branch} 没有共同的祖先` }
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
  const out = gitOr(root, [
    'log',
    '--first-parent',
    '--diff-merges=first-parent',
    '--no-renames',
    '--numstat',
    '-z',
    '--format=%H %ct',
    // --since 把很小的数（0、86400 这类）当成"现在"；--max-age 直接按秒算
    `--max-age=${Math.floor(sinceMs / 1000)}`,
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
  return gitOr(root, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`])
}

export function commitOf(root: string, rev: string): string | undefined {
  return gitOr(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
}

/** 提交（或分支）里有没有这个文件（path 相对仓库根目录）。 */
export function hasFile(root: string, rev: string, path: string): boolean {
  return gitOr(root, ['cat-file', '-e', `${rev}:${path}`]) !== undefined
}

/** 提交（或分支）里这个文件原样的内容（path 相对仓库根目录，末尾的换行不去掉，能和工作区里的直接比）；没有这个文件返回 undefined。 */
export function fileAt(root: string, rev: string, path: string): string | undefined {
  return blobAt(root, rev, path)?.toString('utf8')
}

/** 提交（或分支）里这个目录下的全部文件（路径相对仓库根目录）；没有这个目录时为空。 */
export function filesAt(root: string, rev: string, dir: string): string[] {
  // -z：路径原样输出，不转义中文
  const out = gitOr(root, ['ls-tree', '-r', '-z', '--name-only', rev, '--', `${dir.replace(/\/+$/, '')}/`])
  return (out ?? '').split('\0').filter(Boolean)
}

/** 工作区里这个文件现在的内容。只读普通文件（跟着软链走）；目录、不存在的都是 undefined。 */
export function fileNow(root: string, path: string): string | undefined {
  const full = join(root, path)
  return statSync(full, { throwIfNoEntry: false })?.isFile() ? readFileSync(full, 'utf8') : undefined
}

/** 工作区里这个目录下现有的文件：跟踪的，加上没跟踪、没被 .gitignore 忽略的；删掉了的不算。 */
export function filesNow(root: string, dir: string): string[] {
  const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', `${dir.replace(/\/+$/, '')}/`])
  return [...new Set(out.split('\0').filter(Boolean))].filter(path => statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true)
}

/** 提交（或分支）里这个文件原样的字节（二进制文件也行）；没有这个文件返回 undefined。 */
export function blobAt(root: string, rev: string, path: string): Buffer | undefined {
  try {
    return execFileSync('git', ['cat-file', 'blob', `${rev}:${path}`], { cwd: root, maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

/** 这个提交里，这个路径是普通文件（不是目录）。 */
export function isFileAt(root: string, rev: string, path: string): boolean {
  return gitOr(root, ['cat-file', '-t', `${rev}:${path}`]) === 'blob'
}

/** 工作区里的文件：跟踪的，加上没跟踪、没被 .gitignore 忽略的。 */
export function trackedFiles(root: string): string[] {
  return git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean)
}

/** 这次改动里的一个文件。 */
export interface Change {
  status: 'A' | 'M' | 'D' | 'R'
  path: string
  /** 改名前的路径（status 为 R）。 */
  oldPath?: string
}

/** 工作区和 base（一般是分叉点）比，改了哪些文件，含没提交的。改名照内容认；没跟踪的新文件算新增。只在这里算，各模块都用这一份。 */
export function changesSince(root: string, base: string): Change[] {
  const out = git(root, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', base])
  const parts = out.split('\0').filter(part => part !== '')
  const changes: Change[] = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++] as string
    const letter = status[0]
    if (letter === 'R') {
      const oldPath = parts[i++] as string
      const path = parts[i++] as string
      changes.push({ status: 'R', path, oldPath })
    } else if (letter === 'C') {
      i++
      changes.push({ status: 'A', path: parts[i++] as string })
    } else if (letter === 'A' || letter === 'M' || letter === 'D' || letter === 'T') {
      changes.push({ status: letter === 'T' ? 'M' : letter, path: parts[i++] as string })
    } else {
      i++
    }
  }
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  for (const path of untracked) changes.push({ status: 'A', path })
  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

export interface DiffLines {
  /** 新版里加上或改过的行：行号从 1 起。 */
  added: Array<{ line: number; text: string }>
  removed: string[]
}

/** 一个文件这次改了哪些行（和 base 比）。新文件整份算加上的。按文本比，不认 .gitattributes 的二进制标记和 textconv：标成 -diff 就看不到改了的行。 */
export function diffLines(root: string, base: string, change: Change): DiffLines {
  if (change.status === 'A') {
    const text = fileNow(root, change.path) ?? ''
    return { added: text.split('\n').map((line, index) => ({ line: index + 1, text: line })), removed: [] }
  }
  if (change.status === 'D') {
    return { added: [], removed: (fileAt(root, base, change.path) ?? '').split('\n') }
  }
  const paths = change.oldPath ? [change.oldPath, change.path] : [change.path]
  const out = gitOr(root, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--text', '--no-textconv', base, '--', ...paths]) ?? ''
  const added: DiffLines['added'] = []
  const removed: string[] = []
  let next = 0
  for (const line of out.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      next = Number(hunk[1])
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added.push({ line: next++, text: line.slice(1) })
    else if (line.startsWith('-')) removed.push(line.slice(1))
  }
  return { added, removed }
}

/** 仓库里另外的 worktree（比如 .claude/worktrees 下 agent 的工作区）。 */
export function otherWorktrees(root: string): string[] {
  const out = gitOr(root, ['worktree', 'list', '--porcelain']) ?? ''
  return out
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
    .filter(path => resolve(path) !== resolve(root))
}

export function hasRemote(root: string): boolean {
  return (gitOr(root, ['remote']) ?? '') !== ''
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
  return gitOr(root, ['merge-base', a, b])
}

/** 一个引用（比如 refs/heads/main、refs/remotes/origin/main）指向的提交和它的树；引用不存在返回 undefined。 */
export function refTip(root: string, ref: string): { commit: string; tree: string } | undefined {
  const out = gitOr(root, ['log', '-1', '--format=%H %T', ref, '--'])
  if (!out) return undefined
  const [commit = '', tree = ''] = out.split(' ')
  return { commit, tree }
}

/** 远程上的同名分支（refs/remotes/<远程>/<分支>）里有没有一个已经包含这个提交。 */
export function onRemoteBranch(root: string, branch: string, commit: string): boolean {
  const refs = gitOr(root, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${branch}`])
  return (refs ?? '').split('\n').filter(Boolean).some(ref => isAncestor(root, commit, ref))
}
