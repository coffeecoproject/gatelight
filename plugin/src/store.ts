// 结果记录：放在仓库共用的 .git/testpace/ 下，不进版本库，也不影响工作区内容哈希。
//   runs.jsonl   每次运行一行，只追加
//   running/     每个工作区正在跑的命令一份，结束时删掉；等着用整组结果的会话另记一份
//   logs/        每次运行的完整输出
//   flaky/       时好时坏的测试的名单，一个测试一份（所有工作区共用）
//   rounds/      每个工作区里各测试连着几轮没过

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentKind } from './agent.ts'
import type { CommandKey } from './config.ts'

export type RunResult = 'pass' | 'fail'

/** files 的参数可以是 文件:行号，只跑那一行的测试；测试框架输出里常见的 文件:行号:列号 也算。 */
export const LOCATED = /:\d+(?::\d+)?$/

/** files 的一个参数对应的测试文件。 */
export function testFile(target: string): string {
  return target.replace(LOCATED, '')
}

export interface RunRecord {
  id: string
  kind: CommandKey
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
  /** files 命令的参数：测试文件，或 文件:行号。 */
  files?: string[]
  /** 起这次整组的 agent 会话；用户在终端里起的、或 agent 没给会话号的没有。 */
  session?: string
  /** 跑这次的 agent；用户在终端里跑的没有。旧版本写的记录也没有。 */
  agent?: AgentKind
  /** 跑这次的 testpace 版本。旧版本写的记录没有。 */
  version?: string
  /** 想跑整组时发现它已经在跑、等着用它结果的其他会话。 */
  waiting?: string[]
  /** 整组之前先跑的附加检查（本机登记的）。 */
  checks?: string[]
  /** 整组：tests 规则找到、交给 files 跑的测试文件数。 */
  tests?: number
  /** 没过的测试（经 testpace run 跑、交回了每个测试结果的才有）。 */
  failed?: TestId[]
  /** testpace files --repeat 连跑的第几次（从 1 起）、共几次。 */
  repeat?: { index: number; of: number }
  log: string
}

/** 一个测试：文件（相对仓库根目录）和带外层分组的名字认它；行号用来显示和重跑。 */
export interface TestId {
  file: string
  line?: number
  name: string
}

/** 时好时坏名单上的一个测试。 */
export interface FlakyTest extends TestId {
  /** 怎么认出来的：同一份代码上先没过后过了（或连跑时前面过了后面没过），还是框架重试后才过。 */
  how: 'reran' | 'retried'
  foundAt: number
  tree: string
  worktree: string
  /** 没过那次的日志。重试后才过的就是通过那次的日志。 */
  failLog: string
  passLog: string
  /** 认出它的 agent 会话。 */
  session?: string
}

/** 一个测试在一个工作区里连着几轮没过：每轮的代码、日志、时间。 */
export interface Rounds extends TestId {
  rounds: Array<{ tree: string; log: string; at: number }>
}

/** 名单、计数里认同一个测试用的键。 */
export function testKey(test: Pick<TestId, 'file' | 'name'>): string {
  return `${test.file}\0${test.name}`
}

/**
 * 起项目命令（fast、files、full 和整组的附加检查）时，在这个环境变量里给这一轮的运行 id（登记的 RunningMarker.id）。
 * testpace running 见到它和这个工作区的登记一样，就知道问的是这一轮自己起的命令，不算占用
 * （比如整组先跑的附加检查：那时工作区里还没有测试在跑）。
 */
export const RUN_ENV = 'TESTPACE_RUN'

export interface RunningMarker {
  id: string
  kind: CommandKey
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
  /** 停止门拦过的：running:<运行 id>（还在跑时拦过）、unread:<运行 id>（跑完没看结果时拦过）、flaky:<testKey>（认出的时好时坏测试）。每种只拦一次。 */
  blocked?: string[]
}

/** 会话记录留多久。 */
export const SESSION_KEEP_MS = 7 * 24 * 3600 * 1000

function worktreeKey(worktree: string): string {
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
  update(worktree: string, id: string, change: Partial<RunningMarker>): void {
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
  waitOn(marker: RunningMarker, session: string): void {
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

  private get flakyDir(): string {
    return join(this.dir, 'flaky')
  }

  private flakyPath(test: Pick<TestId, 'file' | 'name'>): string {
    return join(this.flakyDir, `${createHash('sha1').update(testKey(test)).digest('hex').slice(0, 16)}.json`)
  }

  /** 时好时坏的名单，先认出的在前。一个测试一份文件：几个工作区同时跑完时各写各的，不会互相覆盖。 */
  flaky(): FlakyTest[] {
    if (!existsSync(this.flakyDir)) return []
    const list: FlakyTest[] = []
    for (const name of readdirSync(this.flakyDir).filter(name => name.endsWith('.json'))) {
      try {
        list.push(JSON.parse(readFileSync(join(this.flakyDir, name), 'utf8')) as FlakyTest)
      } catch {
        // 写坏了的跳过
      }
    }
    return list.sort((a, b) => a.foundAt - b.foundAt)
  }

  addFlaky(test: FlakyTest): void {
    mkdirSync(this.flakyDir, { recursive: true })
    writeWhole(this.flakyPath(test), JSON.stringify(test))
  }

  removeFlaky(test: Pick<TestId, 'file' | 'name'>): void {
    rmSync(this.flakyPath(test), { force: true })
  }

  /** 这个工作区里连着没过的测试，按 testKey。同一个工作区一次只跑一轮，读写不会撞上。 */
  rounds(worktree: string): Record<string, Rounds> {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'rounds', `${worktreeKey(worktree)}.json`), 'utf8')) as Record<string, Rounds>
    } catch {
      return {}
    }
  }

  saveRounds(worktree: string, rounds: Record<string, Rounds>): void {
    mkdirSync(join(this.dir, 'rounds'), { recursive: true })
    writeWhole(join(this.dir, 'rounds', `${worktreeKey(worktree)}.json`), JSON.stringify(rounds))
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

/** testpace 进程或测试的进程组还有一个在。 */
function markerAlive(marker: RunningMarker): boolean {
  return processAlive(marker.pid) || (marker.group !== undefined && processAlive(-marker.group))
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
