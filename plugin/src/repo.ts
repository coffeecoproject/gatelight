// 命令行和 hook 共用的部分：找到仓库、读约定、判断通过记录、跑命令并记录。

import { readFileSync } from 'node:fs'
import type { CommandKey, Config } from './config.ts'
import { loadConfig } from './config.ts'
import { type Coverage, findCoverage } from './coverage.ts'
import { failureExcerpt } from './excerpt.ts'
import { type Execution, execute } from './execute.ts'
import { duration, when } from './format.ts'
import { changedPaths, commonDir, currentBranch, headCommit, repoRoot } from './git.ts'
import { matcher } from './glob.ts'
import { newRunId, type RunRecord, Store } from './store.ts'

export interface Repo {
  root: string
  store: Store
}

export function openRepo(cwd: string): Repo | undefined {
  const root = repoRoot(cwd)
  return root ? { root, store: new Store(commonDir(root)) } : undefined
}

/** 按项目约定接入了 testpace 的仓库：有能用的 testpace.json。 */
export function contractOf(repo: Repo): Config | undefined {
  return loadConfig(repo.root).config
}

export function coverageOf(repo: Repo, config: Config, tree: string, runs: RunRecord[] = repo.store.readRuns()): Coverage {
  return findCoverage(tree, runs, matcher(config.ignore), (from, to) => changedPaths(repo.root, from, to))
}

export function describeCoverage(coverage: Coverage): string {
  if (coverage.kind === 'none') return '没有整组通过记录'
  const run = coverage.run
  const base = `有整组通过记录（${when(run.startedAt)}，用时 ${duration(run.durationMs)}）`
  if (coverage.kind === 'exact') return base
  const sample = coverage.changed.slice(0, 3).join('、')
  const more = coverage.changed.length > 3 ? ` 等 ${coverage.changed.length} 个` : ''
  return `${base}；相对那次只改了忽略路径：${sample}${more}`
}

export interface Recorded {
  record: RunRecord
  execution: Execution
}

/**
 * 跑 fast 或 files 并记一条记录。这两种不检查跑的过程中代码改没改：
 * 它们只用于开发中的反馈和计时，通过记录只认 full。
 */
export async function runRecorded(repo: Repo, kind: Exclude<CommandKey, 'full'>, command: string, args: string[], tree: string): Promise<Recorded> {
  const startedAt = Date.now()
  const id = newRunId(startedAt)
  const log = repo.store.logPath(id)
  const execution = await execute(command, args, repo.root, log)
  const record: RunRecord = {
    id,
    kind,
    worktree: repo.root,
    branch: currentBranch(repo.root),
    head: headCommit(repo.root),
    tree,
    treeAtEnd: tree,
    startedAt,
    durationMs: execution.durationMs,
    exitCode: execution.exitCode,
    result: execution.interrupted ? 'interrupted' : execution.exitCode === 0 ? 'pass' : 'fail',
    ...(kind === 'files' ? { files: args } : {}),
    log,
  }
  if (!execution.interrupted) repo.store.appendRun(record)
  return { record, execution }
}

function failureCause(execution: Execution): string {
  if (execution.exitCode !== null) return `退出码 ${execution.exitCode}`
  return execution.signal ? `被信号 ${execution.signal} 终止` : '命令没能启动'
}

/** 失败时的输出：结论、节选和日志路径。 */
export function failureText(title: string, log: string, execution: Execution): string {
  return [
    `${title}（${failureCause(execution)}）· 用时 ${duration(execution.durationMs)}`,
    '--- 输出节选 ---',
    ...failureExcerpt(readFileSync(log, 'utf8')),
    '---',
    `完整日志：${log}`,
  ].join('\n')
}
