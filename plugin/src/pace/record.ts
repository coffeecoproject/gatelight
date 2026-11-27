// "跑测试"自己的运行记录：底座的记录（base/store.ts 的 RunRecord）加上这个模块的字段；跑 fast、files 并记一条。

import { type Repo, runClaimed, runner } from '../base/repo.ts'
import type { Execution } from '../base/execute.ts'
import { currentBranch, headCommit, workTreeId } from '../base/git.ts'
import type { RunMarker, RunRecord, Store } from '../base/store.ts'
import type { CommandKey } from './config.ts'
import { failedTests, noteResults, reached, readResults, RESULTS_ENV, resultsFile, type TestResult, unreported, unreportedText, wholeFiles } from './results.ts'
import type { TestId } from './testlist.ts'

/** 这个模块跑的命令的记录：fast、files，和整组（full，底座跑的，带着这个模块加的字段）。 */
export interface PaceRun extends RunRecord {
  kind: CommandKey
  /** files 命令的参数：测试文件，或 文件:行号。 */
  files?: string[]
  /** 整组：tests 规则找到、交给 files 跑的测试文件数。 */
  tests?: number
  /** 没过的测试（经 testpace run 跑、交回了每个测试结果的才有）。 */
  failed?: TestId[]
  /** 交给 files 的测试文件里一条结果都没交回的（没跑到），见 results.ts 的 unreported。 */
  notRun?: string[]
  /** testpace files --repeat 连跑的第几次（从 1 起）、共几次。 */
  repeat?: { index: number; of: number }
}

/** 全部运行记录，按这个模块的字段读。 */
export function paceRuns(store: Store): PaceRun[] {
  return store.readRuns() as PaceRun[]
}

export interface Recorded {
  /** 这次运行的记录；被中断（execution.interrupted）的不写进记录。 */
  record: PaceRun
  execution: Execution
  /** 命令里的 testpace run 交回的每个测试的结果；没经 testpace run 跑的为空。 */
  results: TestResult[]
  /** 看这些结果要说给 agent 的话：没跑到的、时好时坏、几轮没过（见 results.ts）。 */
  notes: string[]
}

/**
 * 跑 fast 或 files 并记一条记录（见 runClaimed），收回每个测试的结果、看有没有时好时坏和几轮没过的（见 results.ts）。
 * files 还核对交给它的每个测试文件都交回了结果：命令通过、却有没跑到的，这次算没过；命令没过的，照样点名没跑到的。
 * 跑完重算一次代码（treeAtEnd）：认时好时坏要"同一份代码"，跑的过程中代码改过的不算。通过记录只认 full。
 */
export async function runRecorded(
  repo: Repo,
  kind: Exclude<CommandKey, 'full'>,
  command: string,
  args: string[],
  tree: string,
  options: { repeat?: PaceRun['repeat']; passedEarlier?: Map<string, string> } = {},
): Promise<Recorded | { busy: RunMarker }> {
  const file = resultsFile()
  try {
    const run = await runClaimed(repo, kind, command, args, tree, { [RESULTS_ENV]: file.path })
    if ('busy' in run) return run
    const { id, startedAt, log, execution } = run
    const results = execution.interrupted ? [] : readResults(file.path, repo.root)
    const failed = failedTests(results)
    const silent = kind === 'files' && !execution.interrupted ? unreported(args, results) : []
    const unreached = unreportedText(command, silent, reached(results).length, execution.exitCode !== 0)
    const record: PaceRun = {
      id,
      kind,
      worktree: repo.root,
      branch: currentBranch(repo.root),
      head: headCommit(repo.root),
      tree,
      treeAtEnd: execution.interrupted ? tree : workTreeId(repo.root),
      startedAt,
      durationMs: execution.durationMs,
      exitCode: execution.exitCode,
      result: execution.exitCode === 0 && !unreached ? 'pass' : 'fail',
      ...(kind === 'files' ? { files: args } : {}),
      ...(results.length > 0 ? { failed } : {}),
      ...(silent.length > 0 ? { notRun: silent } : {}),
      ...(options.repeat ? { repeat: options.repeat } : {}),
      ...runner(),
      log,
    }
    if (execution.interrupted) return { record, execution, results, notes: [] }
    const before = paceRuns(repo.store)
    repo.store.appendRun(record)
    const notes = [...(unreached ? [unreached] : []), ...noteResults(repo, { record, results, before, whole: wholeFiles(args), ...(options.passedEarlier ? { passedEarlier: options.passedEarlier } : {}) })]
    return { record, execution, results, notes }
  } finally {
    file.dispose()
  }
}
