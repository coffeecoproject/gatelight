// 一次性副本：把工作区（含装好的依赖，不含 .git 和别的 worktree）复制一份，在副本里换文件、跑测试，用完删掉。
// testcraft 自己只写副本，不写 agent 正在用的工作区。Mac 的磁盘支持克隆（cp -c），几秒完成、几乎不占空间；
// Linux 用 --reflink=auto，文件系统不支持时退回普通复制。
// 符号链接原样复制（不跟进）：指向工作区里面的照常用（绝对路径的在副本里仍指回工作区），指向仓库外面的
// （Python 虚拟环境的解释器、nix 的 result）照常指过去，副本里的命令往那里写也会写到外面。
// 链接的第一跳或最终目标落在本仓库其他工作目录（主目录、别的 worktree）或仓库的 git 目录里的，不建副本、直接报错：
// 副本里装依赖时会顺着这种链接改写那边的文件（CrocWork 出过：worktree 的 node_modules 链到主目录，副本里 pnpm 把主目录的依赖链接
// 改成指向副本，副本删掉后主目录的依赖全断）。这种链接本来就不该有，让 agent 先在自己的工作区里装好依赖。
// 被 git 忽略的文件也照样复制（装好的依赖、项目的本地配置都靠这个），所以工作区里有测试在跑时不建副本：
// 跑到一半的状态（项目脚本放的进程锁、写了一半的构建产物）会一起带进副本，副本里的测试被锁挡住、读到半截的文件，
// 又会被当成副本的环境有问题（CrocWork 出过：e2e 脚本的进程锁 e2e/.run.lock 带进副本，副本里的 e2e 拒绝开跑）。
// 复制的那几秒向底座借用工作区（base/repo.ts 的 borrow）：查有没有在跑和占上是同一步，占着时别的 testpace 命令不跑、
// 说明是 testcraft 在建副本，问完到复制完之间不会有新起的插进来；复制完马上放开，证明时的测试在副本里跑，不碰工作区。
// 登记的是 testcraft 自己的进程，testcraft 被杀了占用跟着作废，不会把工作区永远锁住。
// testcraft check 是整组（testpace full）里测试之前的一段，工作区已经被那一轮占着，底座认得出是自己，不另占。
// 只认得经 testpace 起的命令：直接跑项目脚本留下的锁，testpace 看不见。
// 副本有自己的版本库，和工作区停在同一处：对象借原仓库的读（alternates，不复制），本地分支、标签、HEAD 和索引照工作区。
// 项目脚本读提交号、分支名、标签（比如打包时把版本号写进页面）照常能读；找仓库根目录时停在副本里，不会找到外面的仓库；
// 副本里的 git 操作只写副本自己的 .git，原仓库不动。换回旧代码证明时 HEAD 还是当前提交，只有文件换了。
// 副本放在系统临时目录、不放在 .git 里：路径里带 .git 的文件，Vite 这类开发服务器默认不给读，页面打不开。
// 每个工作区的副本固定在同一个位置：按目录区分环境的工具（napbox 按 worktree 起服务）每次认出的是同一个，
// 不会每证明一次就多起一套服务。同一个工作区同时只能有一个副本，另一个 testcraft 在用就报错。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { commonDir, git, gitOr, otherWorktrees } from '../base/git.ts'
import { borrow, giveBack, type Repo, runningText } from '../base/repo.ts'
import { hash } from './store.ts'

const live = new Set<Copy>()
process.on('exit', () => {
  for (const copy of live) copy.dispose()
})

/** 这个工作区的副本放在哪。 */
export function copyDirOf(root: string): string {
  const full = resolve(root)
  return join(tmpdir(), 'testcraft', `${basename(full)}-${hash(full).slice(0, 12)}`)
}

export class Copy {
  readonly dir: string
  private readonly root: string

  private constructor(root: string, dir: string) {
    this.root = root
    this.dir = dir
  }

  static create(repo: Repo): Copy {
    const root = repo.root
    const dir = copyDirOf(root)
    const owner = `${dir}.owner`
    // 先扫链接（只读），查占用和写 owner 紧挨着，两个 testcraft 不会都看到没人占用
    const worktrees = otherWorktrees(root).map(path => resolve(path))
    const skip = new Set([resolve(root, '.git'), ...worktrees])
    const crossing = crossingLinks(resolve(root), worktrees, commonDir(root), skip)
    if (crossing.length) {
      throw new CopyRefused(
        [
          '工作区里有符号链接指向本仓库的其他工作目录（主目录或别的 worktree）或仓库的 git 目录，没建副本：',
          ...crossing.map(link => `  ${link.path} → ${link.target}${link.gitDir ? '（仓库的 git 目录）' : ''}`),
          '副本里跑的命令会顺着这些链接改到那边的文件（比如装依赖时改写那边的 node_modules），副本删掉后那边就坏了。',
          '先在自己的工作区里装好依赖，或者去掉这些链接，再跑。',
        ].join('\n'),
      )
    }
    const release = holdWorkspace(repo)
    let copy: Copy | undefined
    try {
      const holder = existsSync(owner) ? Number(readFileSync(owner, 'utf8')) : undefined
      if (holder !== undefined && holder !== process.pid && alive(holder)) {
        throw new CopyRefused(`另一个 testcraft（进程 ${holder}）正在用这个工作区的副本，等它结束再跑`)
      }
      mkdirSync(dirname(dir), { recursive: true })
      writeFileSync(owner, String(process.pid))
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir)
      copy = new Copy(root, dir)
      live.add(copy)
      copyTree(resolve(root), dir, skip)
      linkRepo(resolve(root), dir)
      return copy
    } finally {
      release()
    }
  }

  /** 把副本里的这个文件换成给定内容；undefined 表示删掉。 */
  put(path: string, content: Buffer | string | undefined): void {
    const target = join(this.dir, path)
    if (content === undefined) {
      rmSync(target, { force: true })
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }

  /** 把副本里的这个文件换回工作区里的样子。 */
  restore(path: string): void {
    const source = join(this.root, path)
    this.put(path, existsSync(source) ? readFileSync(source) : undefined)
  }

  dispose(): void {
    if (!live.delete(this)) return
    rmSync(this.dir, { recursive: true, force: true })
    rmSync(`${this.dir}.owner`, { force: true })
  }
}

/**
 * 副本的版本库：新建，借原仓库的对象，本地分支和标签照抄，HEAD 和索引放到工作区的当前位置。
 * 分支和标签直接写成文件，不经 git 的引用更新：全局配置里管分支更新的钩子（比如 testpace 的合并门）不会因为建副本而跑。
 * 所以新建时定下引用存成文件（全局配置可能默认用 reftable）。git init 建 HEAD 本身会经过引用钩子，那一下不是分支更新。
 */
function linkRepo(root: string, dir: string): void {
  const head = git(root, ['rev-parse', 'HEAD'])
  const branch = gitOr(root, ['symbolic-ref', '-q', 'HEAD'])
  const refs = git(root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags'])
  git(dir, ['-c', 'init.defaultRefFormat=files', 'init', '-q'])
  const gitDir = join(dir, '.git')
  writeFileSync(join(gitDir, 'objects/info/alternates'), `${join(commonDir(root), 'objects')}\n`)
  writeFileSync(join(gitDir, 'packed-refs'), refs ? `${refs}\n` : '')
  writeFileSync(join(gitDir, 'HEAD'), branch ? `ref: ${branch}\n` : `${head}\n`)
  git(dir, ['read-tree', 'HEAD'])
}

interface Crossing {
  /** 工作区里的相对路径 */
  path: string
  /** 落在别处的那个目标（第一跳或最终目标） */
  target: string
  /** 目标在仓库的 git 目录里 */
  gitDir: boolean
}

/**
 * 工作区里指向本仓库别处的符号链接。不跟进链接，跳过的范围和复制时一样。
 * 每个链接看两个目标：按链接文字算的第一跳，和顺着链接一直走到底的最终目标（链接套链接时，副本里写的是第一跳那边、
 * 读的是最终那边，两边都不能是别人的）。目标在 root、其他 worktree、git 目录里找包含它的最深的那个，不是 root 就算：
 * root 是主目录里的 worktree、或主目录里嵌着别的 worktree（主目录的 git 目录也在主目录里），几种嵌套都对。
 * 指向 root 里面的、和本仓库无关的外面位置的不算。
 */
function crossingLinks(root: string, worktrees: string[], gitDir: string, skip: Set<string>): Crossing[] {
  const self = realish(root)
  const git = realish(gitDir)
  const dirs = [self, git, ...worktrees.map(realish)]
  const ownerOf = (target: string): string | undefined => {
    let owner: string | undefined
    for (const d of dirs) if ((target === d || target.startsWith(d + sep)) && (owner === undefined || d.length > owner.length)) owner = d
    return owner
  }
  const found: Crossing[] = []
  const walk = (dir: string): void => {
    for (const entry of unreadable(root, dir, () => readdirSync(dir, { withFileTypes: true }))) {
      // 只给目录和链接拼路径：普通文件占绝大多数，拼了也用不上
      if (entry.isDirectory()) {
        const path = join(dir, entry.name)
        if (!skip.has(path)) walk(path)
      } else if (entry.isSymbolicLink()) {
        const path = join(dir, entry.name)
        if (skip.has(path)) continue
        const text = unreadable(root, path, () => readlinkSync(path))
        const raw = resolve(dir, text)
        const first = join(realish(dirname(raw)), basename(raw))
        for (const target of new Set([first, realish(path)])) {
          const owner = ownerOf(target)
          if (owner === undefined || owner === self) continue
          found.push({ path: relative(root, path), target, gitDir: owner === git })
          break
        }
      }
    }
  }
  walk(root)
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

/** 扫描途中读不了（没权限、被删了）就不建副本，说清楚哪个路径、为什么。 */
function unreadable<T>(root: string, path: string, read: () => T): T {
  try {
    return read()
  } catch (error) {
    throw new CopyRefused(`建副本前查工作区里的符号链接时读不了 ${relative(root, path) || '.'}（${(error as Error).message}），没建副本。`)
  }
}

/**
 * 真实路径：存在的部分做 realpath，不存在的部分原样接在后面。用系统的 realpath：
 * macOS 的 /var 和 /private/var 对得上，大小写不敏感的盘上大小写也换成盘上的写法（git 给的路径是盘上的写法）。
 */
function realish(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(realish(parent), basename(path))
  }
}

/** 复制 from 到 to（to 已存在且为空目录），跳过 skip 里的路径。 */
function copyTree(from: string, to: string, skip: Set<string>): void {
  for (const name of readdirSync(from)) {
    const source = join(from, name)
    if (skip.has(source)) continue
    const target = join(to, name)
    const holdsSkipped = [...skip].some(path => path.startsWith(source + sep))
    if (holdsSkipped && statSync(source).isDirectory()) {
      mkdirSync(target)
      copyTree(source, target, skip)
    } else {
      clone(source, to)
    }
  }
}

function clone(source: string, intoDir: string): void {
  const args = process.platform === 'darwin' ? ['-c', '-R', '-P', source, intoDir] : ['--reflink=auto', '-R', '-P', source, intoDir]
  try {
    execFileSync('cp', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch {
    execFileSync('cp', ['-R', '-P', source, intoDir], { stdio: 'ignore' })
  }
}

/**
 * 借用这个工作区来复制，返回放开它的函数。有 testpace 的命令在跑、已经被借用着的，不建副本，说明是谁占着。
 * 在整组里（工作区已经是这一轮的）底座不另占，也就没有要放开的。
 */
function holdWorkspace(repo: Repo): () => void {
  const held = borrow(repo, process.pid, 'testcraft 建副本')
  if ('busy' in held) {
    throw new CopyRefused(`${runningText(held.busy)}。\n没建副本：工作区里跑到一半的状态（比如测试的进程锁）会一起复制进副本，副本里的测试跑不起来。等它结束再跑。`)
  }
  const { id } = held
  return () => {
    if (id) giveBack(repo, id)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 副本建不了：同一个工作区的副本正被别的 testcraft 用着，工作区里有测试在跑或被借用着，或工作区里有链接指向本仓库其他工作目录。 */
export class CopyRefused extends Error {}
