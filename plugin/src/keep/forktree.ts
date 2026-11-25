// 分叉点那一版的代码：比 eslint、tsconfig 生效的配置时，要在分叉点那一版上真的跑一遍工具（配置是代码，读不出来）。
// 在系统临时目录（仓库的 .git 之外）建一个分叉点的临时 worktree，把工作区里现有的 node_modules（根目录和各子包的）
// 链接到它的对应位置：工具、插件都用现在装着的那一份。工作区根目录没有自己的 node_modules、靠上层目录的
// （比如建在主目录里的 worktree），根目录链到 node 从工作区往上找到的那一份：临时 worktree 不在那条路上。用完 git worktree remove --force 并删目录；中途出错、被中断也收拾。
// 建 worktree 时不跑项目的 git 钩子（post-checkout 这类），也不碰任何分支（--detach）。

import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { filesNow } from '../base/git.ts'

export interface ForkTree {
  /** 临时 worktree 的根目录。 */
  root: string
}

const isDir = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true

/** 工作区里有 package.json 的目录（相对仓库根目录，根目录是 ''），不算 node_modules 里面的。 */
function packageDirs(root: string): string[] {
  const dirs = new Set([''])
  for (const path of filesNow(root)) {
    if (path === 'package.json' || path.endsWith('/package.json')) {
      if (!path.split('/').includes('node_modules')) dirs.add(path === 'package.json' ? '' : dirname(path))
    }
  }
  return [...dirs]
}

/** 子包 sub 用的 node_modules：它自己的；根目录没有自己的，用 node 从根目录往上找到的第一个。都没有是 undefined。 */
function modulesOf(root: string, sub: string): string | undefined {
  const own = join(root, sub, 'node_modules')
  if (isDir(own)) return own
  if (sub !== '') return undefined
  for (let dir = dirname(root); dir !== parse(dir).root; dir = dirname(dir)) {
    if (isDir(join(dir, 'node_modules'))) return join(dir, 'node_modules')
  }
  return undefined
}

function gitQuiet(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
}

/**
 * 在分叉点的临时 worktree 里做 fn，做完（不管成没成）都收掉。建不起来时抛错，由调用的地方当成"算不出来"。
 * 被 SIGINT、SIGTERM、SIGHUP 中断时先收掉再以 130 退出。
 */
export async function withForkTree<T>(root: string, fork: string, fn: (tree: ForkTree) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'codekeep-'))
  const tree = join(dir, 'tree')
  let added = false
  const cleanup = (): void => {
    if (added) {
      try {
        gitQuiet(root, ['worktree', 'remove', '--force', tree])
      } catch {
        // 下面删了目录，git 会在 worktree prune 时清掉登记
      }
      added = false
    }
    rmSync(dir, { recursive: true, force: true })
  }
  const interrupted = (): void => {
    cleanup()
    process.exit(130)
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  for (const signal of signals) process.on(signal, interrupted)
  try {
    added = true
    gitQuiet(root, ['worktree', 'add', '--detach', '--quiet', tree, fork])
    for (const sub of packageDirs(root)) {
      const source = modulesOf(root, sub)
      const target = join(tree, sub, 'node_modules')
      // 分叉点上没有这个目录（这次新加的包）就不用链；已经有的（提交进仓库的）不动
      if (!source || !isDir(join(tree, sub)) || lstatSync(target, { throwIfNoEntry: false })) continue
      symlinkSync(source, target, 'dir')
    }
    return await fn({ root: tree })
  } finally {
    for (const signal of signals) process.off(signal, interrupted)
    cleanup()
  }
}
