// 结果记录：放在仓库共用的 .git/testpace/ 下，不进版本库，也不影响工作区内容哈希。
//   runs.jsonl   每次运行一行，只追加
//   running/     正在跑的命令，每个一份，结束时删掉
//   logs/        每次运行的完整输出

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandKey } from './config.ts'

export type RunResult = 'pass' | 'fail' | 'interrupted'

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
  /** files 命令跑的测试文件。 */
  files?: string[]
  /** 起这次整组的 Claude Code 会话；不是从 Claude Code 里起的没有。 */
  session?: string
  /** 想跑整组时发现它已经在跑、等着用它结果的其他会话。 */
  waiting?: string[]
  log: string
}

export interface RunningMarker {
  id: string
  kind: CommandKey
  pid: number
  worktree: string
  tree: string
  startedAt: number
  /** 同 RunRecord.session。 */
  session?: string
  /** 同 RunRecord.waiting。 */
  waiting?: string[]
  log: string
}

export interface SessionState {
  startedAt: number
  /** 会话开始时默认分支的最新提交：之后变了才检查有没有绕过合并门。 */
  tipAtStart?: string
  /** 已经提示过的、没有整组通过记录的默认分支提交。 */
  warned: string[]
  /** 已经给这个会话说过这个仓库的测试节奏。 */
  rhythm?: boolean
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

  markRunning(marker: RunningMarker): void {
    mkdirSync(this.runningDir, { recursive: true })
    writeFileSync(join(this.runningDir, `${marker.id}.json`), JSON.stringify(marker))
  }

  /** 记下这个会话在等正在跑的那次结果。那次已经结束（记录删了）就不记。 */
  waitOn(id: string, session: string): void {
    const path = join(this.runningDir, `${id}.json`)
    let marker: RunningMarker
    try {
      marker = JSON.parse(readFileSync(path, 'utf8')) as RunningMarker
    } catch {
      return
    }
    if (marker.session === session || marker.waiting?.includes(session)) return
    writeFileSync(path, JSON.stringify({ ...marker, waiting: [...(marker.waiting ?? []), session] }))
  }

  clearRunning(id: string): void {
    rmSync(join(this.runningDir, `${id}.json`), { force: true })
  }

  /** agent 最近一次看到整组结果的时间（跑了 testpace status，或在前台等到了 testpace full）。 */
  markRead(worktree: string, at: number): void {
    const dir = join(this.dir, 'read')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, worktreeKey(worktree)), String(at))
  }

  readAt(worktree: string): number {
    const path = join(this.dir, 'read', worktreeKey(worktree))
    return existsSync(path) ? Number(readFileSync(path, 'utf8')) || 0 : 0
  }

  /** 会话第一次被 testpace 看到时的状态。第一次读时记下现在和 tip() 给的默认分支最新提交。 */
  session(id: string, now: number, tip: () => string | undefined = () => undefined): SessionState {
    const dir = join(this.dir, 'sessions')
    const path = join(dir, `${id.replace(/[^\w.-]/g, '_')}.json`)
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as SessionState
      } catch {
        // 写坏了就重新开始
      }
    }
    mkdirSync(dir, { recursive: true })
    for (const name of readdirSync(dir)) {
      const file = join(dir, name)
      try {
        if (now - (JSON.parse(readFileSync(file, 'utf8')) as SessionState).startedAt > SESSION_KEEP_MS) rmSync(file, { force: true })
      } catch {
        rmSync(file, { force: true })
      }
    }
    const tipAtStart = tip()
    const state: SessionState = { startedAt: now, ...(tipAtStart ? { tipAtStart } : {}), warned: [] }
    writeFileSync(path, JSON.stringify(state))
    return state
  }

  saveSession(id: string, state: SessionState): void {
    const dir = join(this.dir, 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id.replace(/[^\w.-]/g, '_')}.json`), JSON.stringify(state))
  }

  /** 正在跑的命令；进程已经不在的（被强杀、机器重启）顺手清掉。 */
  running(): RunningMarker[] {
    if (!existsSync(this.runningDir)) return []
    const markers: RunningMarker[] = []
    for (const name of readdirSync(this.runningDir)) {
      const path = join(this.runningDir, name)
      let marker: RunningMarker
      try {
        marker = JSON.parse(readFileSync(path, 'utf8')) as RunningMarker
      } catch {
        continue
      }
      if (processAlive(marker.pid)) markers.push(marker)
      else rmSync(path, { force: true })
    }
    return markers
  }
}

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
