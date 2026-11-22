// 结果记录：放在仓库共用的 .git/testpace/ 下，不进版本库，也不影响工作区内容哈希。
//   runs.jsonl   每次运行一行，只追加
//   running/     每个工作区正在跑的命令（或借用工作区的工具，见 testpace hold）一份，结束时删掉；等着用整组结果的会话另记一份
//   logs/        每次运行的完整输出
//   flaky/       时好时坏的测试的名单，一个测试一份（所有工作区共用）
//   rounds/      每个工作区里各测试连着几轮没过

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentKind } from './agent.ts'

export type RunResult = 'pass' | 'fail'

/**
 * 一次运行的记录。这里是底座认的字段；模块跑的命令可以带自己的字段（见各模块自己的记录类型），底座原样存取。
 * kind 是跑的什么：整组是 full，别的由模块定。
 */
export interface RunRecord {
  id: string
  kind: string
  worktree: string
  branch?: string
  head?: string
  /** 开始跑时工作区完整内容的哈希（git 树 id）。 */
  tree: string
  /** 跑完时的哈希；和 tree 不同说明跑的过程中代码改过，这次结果不能当通过记录。 */
  treeAtEnd: string
  startedAt: number
  durationMs: number
  exitCode: number | null
  result: RunResult
  /** 起这次整组的 agent 会话；用户在终端里起的、或 agent 没给会话号的没有。 */
  session?: string
  /** 跑这次的 agent；用户在终端里跑的没有。旧版本写的记录也没有。 */
  agent?: AgentKind
  /** 跑这次的 testpace 版本。旧版本写的记录没有。 */
  version?: string
  /** 想跑整组时发现它已经在跑、等着用它结果的其他会话。 */
  waiting?: string[]
  /** 整组各段的耗时，按跑的顺序；一段没过，后面的没有跑，就没有。旧版本写的记录没有。 */
  steps?: RunStep[]
  log: string
}

/** 整组的一段：模块交的（kind、name 由模块定，见 module.ts 的 FullStep）。name 是耗时报告里的名字，旧版本写的记录没有。 */
export interface RunStep {
  kind: string
  name?: string
  durationMs: number
}

/** testpace 跑项目命令时占着工作区的登记。 */
export interface RunMarker {
  id: string
  /** 跑的什么：整组是 full，别的由模块定。不会是 hold。 */
  kind: string
  /** testpace 进程。 */
  pid: number
  /** 测试命令的进程组：testpace 被强杀后测试可能还在跑，看它才知道这个工作区是不是真的空出来了。 */
  group?: number
  worktree: string
  tree: string
  startedAt: number
  /** 同 RunRecord.session。 */
  session?: string
  log: string
}

/** 别的工具借用工作区时的登记（testpace hold），比如 testcraft 建副本：占着时不跑测试。 */
export interface HoldMarker {
  id: string
  kind: 'hold'
  /** 谁、为什么占着，比如"testcraft 建副本"。 */
  by: string
  /** 借用工作区的那个进程：它不在了，占用就作废。 */
  pid: number
  worktree: string
  startedAt: number
}

export type RunningMarker = RunMarker | HoldMarker

/** 这份登记是借用工作区的（testpace hold），不是在跑命令。 */
export function isHold(marker: RunningMarker): marker is HoldMarker {
  return marker.kind === 'hold'
}

export interface SessionState {
  startedAt: number
  /** 会话开始时本地和远程默认分支（引用 → 提交）：之后变了才检查落地的代码有没有整组通过记录。 */
  tipsAtStart: Record<string, string>
  /** 已经提示过的、没有整组通过记录的默认分支提交。 */
  warned: string[]
  /** 已经给这个会话说过这个仓库的测试节奏。 */
  rhythm?: boolean
  /** 这个会话在各工作区最近一次看到整组结果的时间（跑了 testpace status，或在前台等到了 testpace full）。 */
  read?: Record<string, number>
  /**
   * 这个会话在哪些工作区干活：会话所在目录的工作区，和用改文件的工具（Claude Code 的 Edit、Write、MultiEdit，Codex 的 apply_patch）改过文件的工作区。停止门只为这些工作区问各模块还有什么没处理完（stop.ts）；
   * 只在命令里 cd 进去看过的工作区不算，那里后来的改动是别的会话的。
   */
  worked?: string[]
  /** 停止门拦过的：running:<运行 id>（还在跑时拦过）、unread:<运行 id>（跑完没看结果时拦过）、flaky:<testKey>（认出的时好时坏测试）。每种只拦一次。 */
  blocked?: string[]
}

/** 会话记录留多久。 */
export const SESSION_KEEP_MS = 7 * 24 * 3600 * 1000

/** 按工作区存的文件用它当文件名。 */
export function worktreeKey(worktree: string): string {
  return createHash('sha1').update(worktree).digest('hex').slice(0, 16)
}

/** 日志文件名以开始时间开头，按名字排序就是按时间排序。 */
export const KEEP_LOGS = 200

export class Store {
  readonly dir: string

  constructor(gitCommonDir: string) {
    this.dir = join(gitCommonDir, 'testpace')
  }

  private get runsFile(): string {
    return join(this.dir, 'runs.jsonl')
  }

  private get runningDir(): string {
    return join(this.dir, 'running')
  }

  /** 新一次运行的日志路径。只留最近 KEEP_LOGS 份，更早的删掉；runs.jsonl 里的记录不删。 */
  logPath(id: string): string {
    const dir = join(this.dir, 'logs')
    mkdirSync(dir, { recursive: true })
    const logs = readdirSync(dir).filter(name => name.endsWith('.log')).sort()
    for (const name of logs.slice(0, Math.max(0, logs.length - (KEEP_LOGS - 1)))) rmSync(join(dir, name), { force: true })
    return join(dir, `${id}.log`)
  }

  appendRun(record: RunRecord): void {
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.runsFile, `${JSON.stringify(record)}\n`)
  }

  readRuns(): RunRecord[] {
    if (!existsSync(this.runsFile)) return []
    const runs: RunRecord[] = []
    for (const line of readFileSync(this.runsFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        runs.push(JSON.parse(line) as RunRecord)
      } catch {
        // 写到一半的行（进程被杀）跳过
      }
    }
    return runs
  }

  private markerPath(worktree: string): string {
    return join(this.runningDir, `${worktreeKey(worktree)}.json`)
  }

  /**
   * 占住这个工作区来跑 marker 这次命令：原子地创建这个工作区唯一的一份登记。
   * 已经有在跑的，返回它，不占；登记的进程都不在了的（被强杀、机器重启）清掉再占。
   */
  claim(marker: RunningMarker): RunningMarker | undefined {
    mkdirSync(this.runningDir, { recursive: true })
    const path = this.markerPath(marker.worktree)
    // 先写好一份完整的，再用 link 原子地放到位：别人看到的登记总是完整的，不会把写了一半的当成坏了清掉
    const ready = tempPath(path)
    writeFileSync(ready, JSON.stringify(marker))
    try {
      for (;;) {
        try {
          linkSync(ready, path)
          return undefined
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        const existing = readMarker(path)
        if (existing && markerAlive(existing)) return existing
        // 清掉过期的登记：先改名挪开再核对，挪走的要是别人刚占上的，放回去
        const moved = tempPath(path)
        try {
          renameSync(path, moved)
        } catch {
          continue
        }
        const taken = readMarker(moved)
        if (taken && markerAlive(taken)) {
          try {
            linkSync(moved, path)
          } catch {
            // 又有别人占上了，下一轮看它
          }
        }
        rmSync(moved, { force: true })
      }
    } finally {
      rmSync(ready, { force: true })
    }
  }

  /** 更新自己占着的登记（比如记下测试的进程组）。整份换掉，别人读不到写了一半的。 */
  update(worktree: string, id: string, change: Partial<RunMarker>): void {
    const path = this.markerPath(worktree)
    const marker = readMarker(path)
    if (marker?.id !== id) return
    writeWhole(path, JSON.stringify({ ...marker, ...change }))
  }

  /** 放开这个工作区，返回等着用这次结果的会话。 */
  release(worktree: string, id: string): string[] {
    const path = this.markerPath(worktree)
    // 先把等待名单整个挪走再放开工作区：放开之后下一次运行的等待记录写进新的名单，不会被这里删掉
    const waitingPath = this.waitingPath(worktree)
    const taken = tempPath(waitingPath)
    let lines: string[] = []
    try {
      renameSync(waitingPath, taken)
      lines = readFileSync(taken, 'utf8').split('\n')
      rmSync(taken, { force: true })
    } catch {
      // 没有人等
    }
    if (readMarker(path)?.id === id) rmSync(path, { force: true })
    const sessions = lines.filter(line => line.startsWith(`${id} `)).map(line => line.slice(id.length + 1))
    return [...new Set(sessions)]
  }

  /** 记下这个会话在等这个工作区正在跑的那次结果（只追加一行，不改登记）。 */
  waitOn(marker: RunMarker, session: string): void {
    if (marker.session === session) return
    appendFileSync(this.waitingPath(marker.worktree), `${marker.id} ${session}\n`)
  }

  private waitingPath(worktree: string): string {
    return join(this.runningDir, `${worktreeKey(worktree)}.waiting`)
  }

  /** 正在等这次运行结果的会话。 */
  waiting(marker: RunningMarker): string[] {
    const path = this.waitingPath(marker.worktree)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(line => line.startsWith(`${marker.id} `))
      .map(line => line.slice(marker.id.length + 1))
  }

  /** 这个会话看到了这个工作区的整组结果。 */
  markRead(id: string, worktree: string, at: number, tips: () => Record<string, string>): void {
    const state = this.session(id, at, tips)
    this.saveSession(id, { ...state, read: { ...state.read, [worktree]: at } })
  }

  /** 会话第一次被 testpace 看到时的状态。第一次读时记下现在和 tips() 给的默认分支最新提交。 */
  session(id: string, now: number, tips: () => Record<string, string> = () => ({})): SessionState {
    const dir = join(this.dir, 'sessions')
    const path = join(dir, `${id.replace(/[^\w.-]/g, '_')}.json`)
    if (existsSync(path)) {
      try {
        const state = JSON.parse(readFileSync(path, 'utf8')) as SessionState
        // 写坏了、或是旧版本的格式，就重新开始
        if (typeof state.tipsAtStart === 'object' && state.tipsAtStart !== null && Array.isArray(state.warned)) return state
      } catch {
        // 同上
      }
    }
    mkdirSync(dir, { recursive: true })
    // 只看 .json：别的进程正在写的临时文件不碰
    for (const name of readdirSync(dir).filter(name => name.endsWith('.json'))) {
      const file = join(dir, name)
      try {
        if (now - (JSON.parse(readFileSync(file, 'utf8')) as SessionState).startedAt > SESSION_KEEP_MS) rmSync(file, { force: true })
      } catch {
        rmSync(file, { force: true })
      }
    }
    const state: SessionState = { startedAt: now, tipsAtStart: tips(), warned: [] }
    writeWhole(path, JSON.stringify(state))
    return state
  }

  saveSession(id: string, state: SessionState): void {
    const dir = join(this.dir, 'sessions')
    mkdirSync(dir, { recursive: true })
    writeWhole(join(dir, `${id.replace(/[^\w.-]/g, '_')}.json`), JSON.stringify(state))
  }

  /** 各工作区正在跑的命令。进程都不在了的登记不算，留给下一次 claim 清掉。 */
  running(): RunningMarker[] {
    if (!existsSync(this.runningDir)) return []
    return readdirSync(this.runningDir)
      .filter(name => name.endsWith('.json'))
      .map(name => readMarker(join(this.runningDir, name)))
      .filter((marker): marker is RunningMarker => marker !== undefined && markerAlive(marker))
  }
}

/** 和 path 同目录、不会撞名的临时文件名（同目录才能原子地 rename、link）。 */
function tempPath(path: string): string {
  return `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
}

/**
 * 整份换掉一个文件：先写到同目录的临时文件再改名。同一会话的几个 hook 会同时读写这些状态文件，
 * 直接覆盖写时别人可能读到写了一半的，当成坏了重新开始。
 */
export function writeWhole(path: string, text: string): void {
  const next = tempPath(path)
  writeFileSync(next, text)
  renameSync(next, path)
}

function readMarker(path: string): RunningMarker | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunningMarker
  } catch {
    return undefined
  }
}

/** 登记的进程（testpace、借用工作区的进程）或测试的进程组还有一个在。 */
function markerAlive(marker: RunningMarker): boolean {
  return processAlive(marker.pid) || (!isHold(marker) && marker.group !== undefined && processAlive(-marker.group))
}

/** 进程（pid 为负时是进程组）还在。 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function newRunId(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
}
