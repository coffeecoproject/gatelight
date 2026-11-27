// 每个测试的结果：testpace 跑项目命令时在环境变量 RESULTS_ENV 里给一个文件，命令里的 testpace run 把每个测试的结果追加进去
// （见 run/runner.ts）。跑完由这里读出来：记下没过的测试，认出时好时坏的测试（记进名单、点名），数同一个测试连着几轮没过。
// 项目没经 testpace run 跑的测试交不回结果，这些都不做。

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { currentAgent } from '../base/agent.ts'
import { when } from '../base/format.ts'
import type { Repo } from '../base/repo.ts'
import type { Ran } from './run/targets.ts'
import type { PaceRun } from './record.ts'
import { addFlaky, type FlakyTest, flakyTests, LOCATED, readRounds, removeFlaky, saveRounds, type TestId, testFile, testKey } from './testlist.ts'

export const RESULTS_ENV = 'TESTPACE_RESULTS'

/** 连跑这么多次都过（代码没改），才算证明时好时坏的测试修好了，从名单上去掉。 */
export const PROVE_RUNS = 3

/** 同一个测试连着这么多轮（每轮改了代码）没过，就提醒 agent 先别接着试、回头找原因。只是提醒，不找用户。 */
export const STOP_ROUNDS = 3

/** 一个测试的结果，文件相对仓库根目录。 */
export interface TestResult extends TestId {
  status: Ran['status']
  retried?: boolean
}

/** 给一次运行准备交结果的文件。用完调 dispose。 */
export function resultsFile(): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'testpace-results-'))
  return { path: join(dir, 'results.jsonl'), dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 读交回的结果，路径换成相对仓库根目录；仓库外的文件不算。没交回任何结果时为空。 */
export function readResults(path: string, root: string): TestResult[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const base = realpathSync(root)
  const results: TestResult[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ran: Ran
    try {
      ran = JSON.parse(line) as Ran
    } catch {
      continue // 写到一半的（进程被杀）
    }
    const file = relative(base, ran.file)
    if (file.startsWith('..')) continue
    results.push({ file, ...(ran.line === undefined ? {} : { line: ran.line }), name: ran.name, status: ran.status, ...(ran.retried ? { retried: true } : {}) })
  }
  return results
}

/**
 * 这次运行里认得清的结果：一个测试只留一条。同一个文件里同名的测试、Playwright 的 repeatEach 拷贝会共用一个名字，
 * 一次运行里同一个名字既有过的又有没过的，分不清是哪个，不算（不记没过，不比时好时坏，不数轮数）。
 * 名字带 project 的（Vitest、Playwright 有多个 project 时）各算一个。
 */
/** 同名的几条里留哪条（没过的另算，见 distinct）：过了的胜过跳过的，跳过的胜过没跑到的（Playwright repeatEach 的拷贝有的跑了、有的没跑到）。 */
const STRENGTH: Record<TestResult['status'], number> = { notrun: 0, skipped: 1, passed: 2, failed: 3 }

function distinct(results: TestResult[]): TestResult[] {
  const byKey = new Map<string, TestResult>()
  const mixed = new Set<string>()
  for (const test of results) {
    const key = testKey(test)
    const seen = byKey.get(key)
    if (!seen) byKey.set(key, test)
    else if (seen.status !== test.status && (seen.status === 'failed' || test.status === 'failed')) mixed.add(key)
    else if (test.status === 'failed' || STRENGTH[test.status] > STRENGTH[seen.status]) byKey.set(key, test)
  }
  return [...byKey.values()].filter(test => !mixed.has(testKey(test)))
}

/** 没过的测试（见 distinct）。 */
export function failedTests(results: TestResult[]): TestId[] {
  return distinct(results)
    .filter(test => test.status === 'failed')
    .map(test => ({ file: test.file, ...(test.line === undefined ? {} : { line: test.line }), name: test.name }))
}

/** 说一个测试：文件:行号 「名字」。 */
export function describeTest(test: TestId): string {
  return `${test.line === undefined ? test.file : `${test.file}:${test.line}`} 「${test.name}」`
}

/** 给的参数里整个文件给的那些（不带行号）。 */
export function wholeFiles(args: string[]): string[] {
  return args.filter(arg => !LOCATED.test(arg))
}

/** 跑到了的测试（过、没过、跳过）：去掉 Playwright 记的没跑到（notrun，见 run/targets.ts 的 Ran）。 */
export function reached<T extends TestResult>(results: readonly T[]): T[] {
  return results.filter(test => test.status !== 'notrun')
}

/**
 * 交给 files 的测试文件里一条结果都没交回的（过、没过、跳过都算交回；按行给的看那个文件）。不读脚本：脚本漏跑了哪一类测试、
 * 跑到一半停了（比如分几批跑、一批没过后面的就不跑），结果里就少了那些文件。focused、files、整组都按这个核对。
 */
export function unreported(handed: readonly string[], results: readonly TestResult[]): string[] {
  const reported = new Set(reached(results).map(test => test.file))
  return [...new Set(handed.map(testFile))].filter(file => !reported.has(file))
}

/** 一次最多点名几个没交回结果的文件。 */
const NAMED = 10

/**
 * 说没交回结果的文件；没有要说的时为 undefined。命令没过、又一个结果都没交回的不说（多半是命令自己没起来，它的输出已经说了）。
 * 命令没过的，提醒没过的修好后要和没跑到的一起再跑：只重跑没过的，没跑到的就一直没验证。
 */
export function unreportedText(files: string, silent: readonly string[], results: number, failed: boolean): string | undefined {
  if (silent.length === 0 || (failed && results === 0)) return undefined
  const how = `node:test、Vitest、Playwright 的测试经 testpace run 跑（它会交回结果）；别的跑法自己往环境变量 ${RESULTS_ENV} 给的文件里，每个测试追加一行 JSON：{"file":"文件的绝对路径","name":"测试名","status":"passed、failed 或 skipped"}`
  if (results === 0) return `files 命令（${files}）跑完，一个测试结果都没交回，核对不了跑到了哪些测试。${how}。`
  const named = silent.slice(0, NAMED).join('、') + (silent.length > NAMED ? ` 等 ${silent.length} 个` : '')
  const head = `交给 files 命令（${files}）的测试文件里，这些一条结果都没交回：${named}。`
  if (failed) return `${head}这次没验证到它们：上面的输出没说原因的，多半是跑到一半停了（比如分批跑，一批没过后面的就不跑）。修好后用 testpace files 把没过的和这些一起再跑一遍。`
  return `${head}可能是 files 的脚本没把它们交给测试框架、被框架的配置排除了，或跑它们的那一路没交结果。${how}。`
}

export interface ResultsInput {
  /** 这次运行的记录，已经写进 runs.jsonl。 */
  record: PaceRun
  results: TestResult[]
  /** 这次运行之前的记录。 */
  before: PaceRun[]
  /** 整个文件跑的测试文件（相对仓库根目录）。 */
  whole: string[]
  /** 连跑时前面几次通过的测试，按 testKey，值是那次的日志。 */
  passedEarlier?: Map<string, string>
}

/**
 * 看这次运行的结果：
 * - 时好时坏：同一份代码上以前没过、这次过了；连跑时前面过了、这次没过；框架重试后才过。记进名单，点名。
 *   "同一份代码"要两次都是跑的过程中代码没改过的（tree 和 treeAtEnd 一样）。
 * - 名单上的测试不在了：在认出它的工作区里（或那个工作区已经删了）整个跑了它的文件、全部通过，
 *   文件里却没有这个名字（删掉或改了名），从名单上去掉。别的工作区的代码可能还没有这个测试，不算。
 * - 几轮没过：改了代码再跑还没过算一轮，过了清零；到 STOP_ROUNDS 轮提醒 agent 先找原因再改。
 * 返回要说给 agent 的话。
 */
export function noteResults(repo: Repo, input: ResultsInput): string[] {
  const { record } = input
  if (input.results.length === 0) return []
  const results = distinct(input.results)
  const notes: string[] = []

  // 选中了却没跑到的（Playwright 的 serial 模式里前面的没过，后面的不跑）：只重跑没过的那一行，它们还是不跑
  const unreached = results.filter(test => test.status === 'notrun')
  if (unreached.length > 0) {
    const named = unreached.slice(0, NAMED).map(describeTest).join('、') + (unreached.length > NAMED ? ` 等 ${unreached.length} 个` : '')
    notes.push(`这些测试没跑到（同一组里前面有测试没过，框架没接着跑）：${named}。这次没验证到它们：修好后用 testpace files 把没过的和它们（文件:行号）一起再跑一遍。`)
  }
  const listed = new Map(flakyTests(repo.store).map(test => [testKey(test), test]))
  const session = currentAgent()?.session

  // 认出的新的时好时坏测试，和说它的话。名单上已有的、这次已经认出的不再算
  const found: Array<{ test: FlakyTest; note: string }> = []
  const flag = (test: TestResult, how: FlakyTest['how'], failLog: string, passLog: string, note: string): void => {
    const key = testKey(test)
    if (listed.has(key) || found.some(other => testKey(other.test) === key)) return
    const flaky: FlakyTest = {
      file: test.file,
      ...(test.line === undefined ? {} : { line: test.line }),
      name: test.name,
      how,
      foundAt: record.startedAt,
      tree: record.tree,
      worktree: record.worktree,
      failLog,
      passLog,
      ...(session ? { session } : {}),
    }
    found.push({ test: flaky, note: `时好时坏：${describeTest(test)} ${note}` })
  }
  // 同一份代码上的、跑的过程中代码没改过的，近的在前。这次跑的过程中代码改过就不比
  const stable = record.treeAtEnd === record.tree
  const sameCode = input.before.filter(run => run.tree === record.tree && run.treeAtEnd === run.tree).sort((a, b) => b.startedAt - a.startedAt)
  for (const test of stable ? results : []) {
    if (test.status === 'passed' && test.retried) {
      flag(test, 'retried', record.log, record.log, '框架重试之后才过。')
    } else if (test.status === 'passed') {
      const failedRun = sameCode.find(run => run.failed?.some(other => testKey(other) === testKey(test)))
      if (failedRun) flag(test, 'reran', failedRun.log, record.log, `这次过了，同一份代码 ${when(failedRun.startedAt)} 却没过（那次的日志：${failedRun.log}）。`)
    } else if (test.status === 'failed') {
      const passLog = input.passedEarlier?.get(testKey(test))
      if (passLog) flag(test, 'reran', record.log, passLog, `这次没过，代码没改，连跑时前面却过了（过的那次的日志：${passLog}）。`)
    }
  }
  for (const { test } of found) addFlaky(repo.store, test)
  if (found.length > 0) {
    notes.push(
      ...found.map(({ note }) => note),
      `不要靠重跑过关：按 testcraft 写测试技能里"测试时好时坏"一节找原因修；和手上的活无关的，告诉用户是哪个测试、在哪次没过、日志在哪。修好后用 testpace files --repeat ${PROVE_RUNS} <文件:行号> 连跑证明，都过了才从时好时坏名单上去掉（名单用 testpace status 看）。`,
    )
  }

  // 名单上的测试不在了。整组被跳过的（node:test 只报组名）里面的测试不算不在
  if (record.result === 'pass') {
    const ranFiles = new Set(input.results.map(test => test.file))
    const names = new Set(input.results.map(testKey))
    const skippedGroups = input.results.filter(test => test.status === 'skipped')
    const inSkipped = (test: FlakyTest): boolean => skippedGroups.some(group => group.file === test.file && test.name.startsWith(`${group.name} > `))
    for (const test of listed.values()) {
      if (test.worktree !== record.worktree && existsSync(test.worktree)) continue
      if (!input.whole.includes(test.file) || !ranFiles.has(test.file) || names.has(testKey(test)) || inSkipped(test)) continue
      removeFlaky(repo.store, test)
      notes.push(`${describeTest(test)} 不在了（删掉或改了名），从时好时坏名单上去掉。`)
    }
  }

  // 几轮没过
  const rounds = readRounds(repo.store, record.worktree)
  let changed = false
  const stuck: string[] = []
  for (const test of results) {
    const key = testKey(test)
    if (test.status === 'passed') {
      if (rounds[key]) {
        delete rounds[key]
        changed = true
      }
      continue
    }
    if (test.status !== 'failed') continue
    const entry = rounds[key] ?? { file: test.file, name: test.name, rounds: [] }
    if (test.line !== undefined) entry.line = test.line
    if (entry.rounds.at(-1)?.tree !== record.tree) {
      entry.rounds.push({ tree: record.tree, log: record.log, at: record.startedAt })
      rounds[key] = entry
      changed = true
    }
    if (entry.rounds.length >= STOP_ROUNDS) {
      const logs = entry.rounds.slice(-STOP_ROUNDS).map(round => round.log)
      stuck.push(`${describeTest(entry)} 已经连着 ${entry.rounds.length} 轮改了代码还没过（最近 ${STOP_ROUNDS} 轮的日志：${logs.join('、')}）。`)
    }
  }
  if (changed) saveRounds(repo.store, record.worktree, rounds)
  if (stuck.length > 0) {
    notes.push(...stuck, '因为用户这次改了需求才不过、留到合并时再改的不用管。其余的先别接着试：回头读失败输出和它测的代码，找到原因再改；不要改测试凑通过。查出来是业务规则本身说不清或要变的，才问用户。')
  }
  return notes
}

/** 连跑全都过了（代码没改）：每次都过了的名单上的测试，从名单上去掉。 */
export function provenFixed(repo: Repo, runs: TestResult[][]): string[] {
  if (runs.length < PROVE_RUNS) return []
  const notes: string[] = []
  for (const test of flakyTests(repo.store)) {
    const key = testKey(test)
    if (!runs.every(results => results.some(result => testKey(result) === key && result.status === 'passed' && !result.retried))) continue
    removeFlaky(repo.store, test)
    notes.push(`${describeTest(test)} 连跑 ${runs.length} 次都过了，从时好时坏名单上去掉。`)
  }
  return notes
}

/** 时好时坏名单的说明：会话开始时告诉 agent。名单空时没有。 */
export function flakyBrief(list: FlakyTest[]): string | undefined {
  if (list.length === 0) return undefined
  const shown = list.slice(0, 5).map(describeTest).join('、')
  const more = list.length > 5 ? ` 等 ${list.length} 个` : ''
  return `时好时坏的测试（同一份代码时过时不过，testpace status 看详情）：${shown}${more}。它们没过时不要靠重跑过关，按 testcraft 写测试技能里"测试时好时坏"一节处理。`
}

/** testpace status 里的时好时坏名单。 */
export function flakyStatus(list: FlakyTest[]): string[] {
  if (list.length === 0) return ['时好时坏的测试：没有']
  return [
    `时好时坏的测试（${list.length} 个；修好后用 testpace files --repeat ${PROVE_RUNS} <文件:行号> 连跑证明，都过了才去掉）：`,
    ...list.flatMap(test => [
      `  ${describeTest(test)}：${when(test.foundAt)} ${test.how === 'retried' ? '框架重试之后才过' : '同一份代码先后一次没过、一次过了'}`,
      test.how === 'retried' ? `    日志：${test.passLog}` : `    没过那次的日志：${test.failLog}\n    过了那次的日志：${test.passLog}`,
    ]),
  ]
}
