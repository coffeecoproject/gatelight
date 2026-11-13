// 命令行和 hook 共用的部分：找到仓库、读约定、判断通过记录、跑命令并记录。

import { readFileSync } from 'node:fs'
import type { CommandKey, Config, LoadedConfig } from './config.ts'
import { CONFIG_FILE, readConfig } from './config.ts'
import { type Coverage, findCoverage } from './coverage.ts'
import { failureExcerpt } from './excerpt.ts'
import { type Execution, execute } from './execute.ts'
import { duration, when } from './format.ts'
import { changedPaths, commonDir, currentBranch, defaultBranch, fileAt, headCommit, refTip, repoRoot } from './git.ts'
import { matcher } from './glob.ts'
import { newRunId, processAlive, type RunningMarker, type RunRecord, Store } from './store.ts'

export interface Repo {
  root: string
  store: Store
}

export function openRepo(cwd: string): Repo | undefined {
  const root = repoRoot(cwd)
  return root ? { root, store: new Store(commonDir(root)) } : undefined
}

/**
 * 一个提交自己带的约定（提交里的 testpace.json）；提交里没有这个文件返回 undefined。
 * 合并门、停止门判断落到默认分支的代码时用它，不看工作区里的文件：工作区里没提交的改动、
 * 别的分支检出的旧文件都不该影响判断。写坏了的，problems 里是原因；没有 config 时按没有 ignore 算
 * （要内容完全一致的通过记录）。
 */
export function contractAt(repo: Repo, rev: string): LoadedConfig | undefined {
  const text = fileAt(repo.root, rev, CONFIG_FILE)
  return text === undefined ? undefined : readConfig(text)
}

/**
 * 约定里 ignore 的路径。testpace.json 自己不算：通过记录只在约定相同的代码之间沿用，
 * 改了约定（包括改 ignore）要在改完的代码上重跑整组。
 */
export function ignoredBy(config: Config): (path: string) => boolean {
  const ignored = matcher(config.ignore)
  return path => path !== CONFIG_FILE && ignored(path)
}

export function coverageOf(repo: Repo, config: Config, tree: string, runs: RunRecord[] = repo.store.readRuns()): Coverage {
  return findCoverage(tree, runs, ignoredBy(config), (from, to) => changedPaths(repo.root, from, to))
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
  /** 这次运行的记录；被中断（execution.interrupted）的不写进记录。 */
  record: RunRecord
  execution: Execution
}

/** 本地和远程（origin）默认分支现在指向的提交，按引用名。找不到默认分支时为空。 */
export function defaultTips(repo: Repo): Record<string, string> {
  const branch = defaultBranch(repo.root)
  const tips: Record<string, string> = {}
  for (const ref of branch ? [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`] : []) {
    const tip = refTip(repo.root, ref)
    if (tip) tips[ref] = tip.commit
  }
  return tips
}

/** 在跑的那次是什么时候、哪个进程起的。testpace 被强杀后测试可能还在跑，说清楚怎么停。 */
export function started(marker: RunningMarker): string {
  const owner = processAlive(marker.pid)
    ? `进程 ${marker.pid}`
    : `起它的 testpace 已经退出，测试进程组 ${marker.group} 还在跑，不要了用 kill -- -${marker.group} 停掉`
  return `开始于 ${when(marker.startedAt)}，${owner}`
}

/** 因为这个工作区已经在跑测试而不跑时的说明。 */
export function busyText(marker: RunningMarker, tree: string): string {
  const what = marker.kind === 'full' ? '整组' : ` ${marker.kind} `
  const stale = marker.kind === 'full' && marker.tree !== tree ? '那次整组开始后代码改过，它跑完的结果不算当前代码的记录。' : ''
  return `这个工作区正在跑${what}（${started(marker)}），同一个工作区一次只跑一轮测试，等它结束再跑。${stale}`
}

/**
 * 占住这个工作区跑一次项目的命令，不记录。同一个工作区一次只跑一轮测试（两轮同时跑会抢端口、测试库这些资源，
 * 失败了也分不清是谁的问题）：已经有在跑的，不跑，返回它。
 */
export async function runClaimed(
  repo: Repo,
  kind: Exclude<CommandKey, 'full'>,
  command: string,
  args: string[],
  tree: string,
): Promise<{ id: string; startedAt: number; log: string; execution: Execution } | { busy: RunningMarker }> {
  const startedAt = Date.now()
  const id = newRunId(startedAt)
  const log = repo.store.logPath(id)
  const busy = repo.store.claim({ id, kind, pid: process.pid, worktree: repo.root, tree, startedAt, log })
  if (busy) return { busy }
  try {
    const execution = await execute(command, args, repo.root, log, group => repo.store.update(repo.root, id, { group }))
    return { id, startedAt, log, execution }
  } finally {
    repo.store.release(repo.root, id)
  }
}

/**
 * 跑 fast 或 files 并记一条记录（见 runClaimed）。
 * 这两种不检查跑的过程中代码改没改：它们只用于开发中的反馈和计时，通过记录只认 full。
 */
export async function runRecorded(
  repo: Repo,
  kind: Exclude<CommandKey, 'full'>,
  command: string,
  args: string[],
  tree: string,
): Promise<Recorded | { busy: RunningMarker }> {
  const run = await runClaimed(repo, kind, command, args, tree)
  if ('busy' in run) return run
  const { id, startedAt, log, execution } = run
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
    result: execution.exitCode === 0 ? 'pass' : 'fail',
    ...(kind === 'files' ? { files: args } : {}),
    log,
  }
  if (!execution.interrupted) repo.store.appendRun(record)
  return { record, execution }
}

/** 命令为什么算失败：退出码、信号，或没能启动。 */
export function failureCause(execution: Execution): string {
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
