// 结果记录：放在仓库共用的 .git/testpace/ 下，不进版本库，也不影响工作区内容哈希。
//   runs.jsonl   每次运行一行，只追加
//   running/     正在跑的命令，每个一份，结束时删掉
//   logs/        每次运行的完整输出

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
  log: string
}

export interface RunningMarker {
  id: string
  kind: CommandKey
  pid: number
  worktree: string
  tree: string
  startedAt: number
  log: string
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

  clearRunning(id: string): void {
    rmSync(join(this.runningDir, `${id}.json`), { force: true })
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
