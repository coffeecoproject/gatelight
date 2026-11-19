// 计时诊断：只汇总和报告，不替项目改任何东西。

import { AGENTS } from './agent.ts'
import { COMMAND_KEYS } from './config.ts'
import { isValidPass } from './coverage.ts'
import { duration, day, short, when } from './format.ts'
import type { Landing } from './git.ts'
import { type RunRecord, testFile } from './store.ts'

/** fast 平均超过这个时长，提示它可能不是增量的。 */
export const FAST_SLOW_MS = 20_000

const WEEK_MS = 7 * 24 * 3600 * 1000
/** 报告里最多列出几份先失败后通过的代码。 */
const SHOWN_RETRIED = 5

export interface CommandStats {
  count: number
  pass: number
  fail: number
  totalMs: number
}

export function commandStats(runs: RunRecord[]): Map<string, CommandStats> {
  const stats = new Map<string, CommandStats>()
  for (const run of runs) {
    const s = stats.get(run.kind) ?? { count: 0, pass: 0, fail: 0, totalMs: 0 }
    s.count += 1
    s.totalMs += run.durationMs
    if (run.result === 'pass') s.pass += 1
    else s.fail += 1
    stats.set(run.kind, s)
  }
  return stats
}

/** 谁跑的：agent 的名字；记了版本却没有 agent 的是用户在终端里跑的；版本也没有的是旧版本写的，不知道谁跑的。 */
function runnerOf(run: RunRecord): string {
  if (run.agent) return AGENTS[run.agent].name
  return run.version ? '终端' : '未记录（旧版本）'
}

/** 按谁跑的分开：次数、合计用时、整组次数，多的在前。只有一种时返回空：不用分。 */
export function byRunner(runs: RunRecord[]): Array<{ runner: string; count: number; totalMs: number; fulls: number }> {
  const rows = new Map<string, { runner: string; count: number; totalMs: number; fulls: number }>()
  for (const run of runs) {
    const runner = runnerOf(run)
    const row = rows.get(runner) ?? { runner, count: 0, totalMs: 0, fulls: 0 }
    row.count += 1
    row.totalMs += run.durationMs
    if (run.kind === 'full') row.fulls += 1
    rows.set(runner, row)
  }
  return rows.size > 1 ? [...rows.values()].sort((a, b) => b.totalMs - a.totalMs) : []
}

/** 测试文件被 files 跑了多少次，多的在前。 */
export function repeatedFiles(runs: RunRecord[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const run of runs) {
    // 连跑（--repeat）是有意的，不算反复跑
    if (run.kind !== 'files' || run.repeat) continue
    // 文件:行号 算那个文件；一次里给了同一文件的几行，算跑了一次
    for (const file of new Set((run.files ?? []).map(testFile))) counts.set(file, (counts.get(file) ?? 0) + 1)
  }
  return [...counts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** 每个工作区里，整组失败后连续又跑了几轮才通过。 */
export function rerunsAfterFailure(runs: RunRecord[]): number[] {
  const byWorktree = new Map<string, RunRecord[]>()
  for (const run of runs) {
    if (run.kind !== 'full') continue
    const list = byWorktree.get(run.worktree) ?? []
    list.push(run)
    byWorktree.set(run.worktree, list)
  }
  const rounds: number[] = []
  for (const list of byWorktree.values()) {
    let failures = 0
    for (const run of list.sort((a, b) => a.startedAt - b.startedAt)) {
      if (run.result === 'fail') failures += 1
      else if (isValidPass(run)) {
        if (failures > 0) rounds.push(failures)
        failures = 0
      }
    }
  }
  return rounds
}

/** 同一份代码整组先失败、后通过：可能是测试不稳定，也可能是环境问题（数据库没起来这类），要看失败的日志才分得清。 */
export interface FailedThenPassed {
  tree: string
  failed: RunRecord
  passed: RunRecord
}

/** 同一份代码内容，整组先失败、后通过。只看跑的过程中代码没改过的运行。 */
export function failedThenPassed(runs: RunRecord[]): FailedThenPassed[] {
  const byTree = new Map<string, RunRecord[]>()
  for (const run of runs) {
    if (run.kind !== 'full' || run.tree !== run.treeAtEnd) continue
    const list = byTree.get(run.tree) ?? []
    list.push(run)
    byTree.set(run.tree, list)
  }
  const found: FailedThenPassed[] = []
  for (const [tree, list] of byTree) {
    const failed = list.filter(run => run.result === 'fail').sort((a, b) => a.startedAt - b.startedAt)[0]
    if (!failed) continue
    const passed = list.find(run => run.result === 'pass' && run.startedAt > failed.startedAt)
    if (passed) found.push({ tree, failed, passed })
  }
  return found.sort((a, b) => b.passed.startedAt - a.passed.startedAt)
}

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'go', 'py', 'java', 'kt', 'kts', 'scala', 'swift', 'm', 'mm', 'rs', 'rb', 'php', 'cs',
  'c', 'cc', 'cpp', 'h', 'hpp', 'sql',
])

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'e2e', 'testdata'])
const TEST_NAMES = [/\.(test|spec)\.[^./]+$/, /_test\.(go|py)$/, /^test_[^/]*\.py$/, /Tests?\.(swift|java|kt)$/]

export type FileRole = 'test' | 'code' | 'other'

/** 按常见命名规则区分测试代码和主代码；非代码文件（文档、配置、锁文件）不算。 */
export function fileRole(path: string): FileRole {
  const parts = path.split('/')
  const name = parts.at(-1)!
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  if (!CODE_EXTENSIONS.has(ext)) return 'other'
  if (parts.slice(0, -1).some(part => TEST_DIRS.has(part))) return 'test'
  if (TEST_NAMES.some(re => re.test(name))) return 'test'
  return 'code'
}

export interface WeekRow {
  start: number
  landings: number
  testLines: number
  codeLines: number
  fullPasses: number
  fullMedianMs?: number
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** 按周汇总落地的测试行数、主代码行数，以及通过的整组耗时中位数。周从 since 开始算。 */
export function weekly(runs: RunRecord[], landingList: Landing[], since: number, now: number): WeekRow[] {
  const rows: WeekRow[] = []
  for (let start = since; start < now; start += WEEK_MS) {
    const end = start + WEEK_MS
    const row: WeekRow = { start, landings: 0, testLines: 0, codeLines: 0, fullPasses: 0 }
    for (const landing of landingList) {
      if (landing.time < start || landing.time >= end) continue
      row.landings += 1
      for (const file of landing.files) {
        const role = fileRole(file.path)
        if (role === 'test') row.testLines += file.added
        else if (role === 'code') row.codeLines += file.added
      }
    }
    const passes = runs.filter(run => isValidPass(run) && run.startedAt >= start && run.startedAt < end)
    row.fullPasses = passes.length
    row.fullMedianMs = median(passes.map(run => run.durationMs))
    rows.push(row)
  }
  return rows
}

/**
 * 平均每次落地花在测试上的时间和整组次数：看工作方式（比如攒几个分支一起合）有没有降下测试成本。
 * 落地从这段时间里 testpace 第一次运行算起，接入前的落地不摊；分支上跑了、还没落地的也算在里面。
 */
export function landingCost(runs: RunRecord[], landings: Landing[], branch: string | undefined): string | undefined {
  if (!branch || runs.length === 0) return undefined
  const from = Math.min(...runs.map(run => run.startedAt))
  const landed = landings.filter(landing => landing.time >= from).length
  if (landed === 0) return undefined
  const total = runs.reduce((sum, run) => sum + run.durationMs, 0)
  const fulls = runs.filter(run => run.kind === 'full').length
  return `落地到 ${branch} ${landed} 次，平均每次落地跑测试 ${duration(total / landed)}、整组 ${(fulls / landed).toFixed(1)} 次（从这段时间第一次运行算起，含分支上还没落地的）`
}

export interface ReportInput {
  repo: string
  days: number
  now: number
  runs: RunRecord[]
  defaultBranch?: string
  landings: Landing[]
}

export interface StepStats {
  /** 哪一段：附加检查写登记的命令。 */
  step: string
  /** 跑到这一段的整组次数（前面一段没过的，后面的没有跑）。 */
  count: number
  totalMs: number
}

/**
 * 整组的时间花在哪一段：每条附加检查、整组的检查（full）、全部测试，各跑了几次、共多久。按第一次出现的顺序。
 * 只算记了分段的整组（旧版本写的记录没有分段）；fulls 是这样的整组有几次。
 */
export function fullSteps(runs: RunRecord[]): { fulls: number; steps: StepStats[] } {
  const stats = new Map<string, StepStats>()
  let fulls = 0
  for (const run of runs) {
    if (run.kind !== 'full' || !run.steps) continue
    fulls += 1
    for (const step of run.steps) {
      const name = step.kind === 'check' ? `附加检查 ${step.check}` : step.kind === 'full' ? '整组的检查（full）' : '全部测试'
      const s = stats.get(name) ?? { step: name, count: 0, totalMs: 0 }
      s.count += 1
      s.totalMs += step.durationMs
      stats.set(name, s)
    }
  }
  return { fulls, steps: [...stats.values()] }
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map(row => displayWidth(row[col]!))))
  return rows.map(row => row.map((cell, col) => cell + ' '.repeat(widths[col]! - displayWidth(cell))).join('  ').trimEnd())
}

function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return width
}

export function renderReport(input: ReportInput): string {
  const since = input.now - input.days * 24 * 3600 * 1000
  const runs = input.runs.filter(run => run.startedAt >= since)
  const lines: string[] = [`testpace 报告 · 最近 ${input.days} 天 · ${input.repo}`]

  if (runs.length === 0) {
    lines.push('', '这段时间没有 testpace 跑过的命令。')
  } else {
    const stats = commandStats(runs)
    const rows = [['命令', '次数', '通过', '失败', '平均', '合计']]
    for (const key of COMMAND_KEYS) {
      const s = stats.get(key)
      if (!s) continue
      rows.push([key, String(s.count), String(s.pass), String(s.fail), duration(s.totalMs / s.count), duration(s.totalMs)])
    }
    lines.push('', ...table(rows))

    const runners = byRunner(runs)
    if (runners.length > 0) {
      const byAgent = [['谁跑的', '次数', '整组', '合计']]
      for (const row of runners) byAgent.push([row.runner, String(row.count), String(row.fulls), duration(row.totalMs)])
      lines.push('', ...table(byAgent))
    }

    const parts = fullSteps(runs)
    if (parts.fulls > 0) {
      const all = parts.steps.reduce((sum, step) => sum + step.totalMs, 0)
      const rows = [['整组的哪一段', '跑到', '平均', '合计', '占比']]
      for (const step of parts.steps) {
        rows.push([step.step, `${step.count} 次`, duration(step.totalMs / step.count), duration(step.totalMs), all > 0 ? `${Math.round((step.totalMs / all) * 100)}%` : '-'])
      }
      lines.push('', `整组的时间花在哪（${parts.fulls} 次整组；前一段没过，后面的不跑）：`, ...table(rows))
    }

    const notes: string[] = []
    const cost = landingCost(runs, input.landings, input.defaultBranch)
    if (cost) notes.push(cost)
    const full = stats.get('full')
    if (full && full.fail > 0) {
      const rounds = rerunsAfterFailure(runs)
      const average = rounds.length ? (rounds.reduce((a, b) => a + b, 0) / rounds.length).toFixed(1) : undefined
      notes.push(`整组失败 ${full.fail} 次` + (average ? `；失败后平均重跑 ${average} 轮才通过（${rounds.length} 次）` : '，之后还没有通过'))
    }
    const changedDuring = runs.filter(run => run.kind === 'full' && run.result === 'pass' && run.tree !== run.treeAtEnd).length
    if (changedDuring > 0) notes.push(`整组跑的过程中代码改过 ${changedDuring} 次，这些结果没算通过记录`)
    const retried = failedThenPassed(runs)
    if (retried.length > 0) {
      notes.push(
        [
          `先失败后通过：${retried.length} 份代码整组先失败、后通过。可能是测试不稳定，也可能是环境问题（比如数据库没起来），看失败的日志分辨：`,
          ...retried
            .slice(0, SHOWN_RETRIED)
            .map(({ tree, failed, passed }) => `  代码 ${short(tree)}（${when(failed.startedAt)}）：失败用时 ${duration(failed.durationMs)}，之后通过用时 ${duration(passed.durationMs)}，失败日志 ${failed.log}`),
          ...(retried.length > SHOWN_RETRIED ? [`  另有 ${retried.length - SHOWN_RETRIED} 份没列出`] : []),
        ].join('\n'),
      )
    }
    const fast = stats.get('fast')
    if (fast && fast.totalMs / fast.count > FAST_SLOW_MS) {
      notes.push(`fast 平均 ${duration(fast.totalMs / fast.count)}，超过 ${FAST_SLOW_MS / 1000} 秒，可能不是增量的`)
    }
    if (notes.length) lines.push('', ...notes)

    const repeated = repeatedFiles(runs).slice(0, 10)
    if (repeated.length > 0) {
      lines.push('', '反复跑的测试文件（前 10）：', ...repeated.map(([file, n]) => `  ${n} 次  ${file}`))
    }
  }

  const weeks = weekly(input.runs, input.landings, since, input.now)
  if (weeks.some(week => week.landings > 0 || week.fullPasses > 0)) {
    const branch = input.defaultBranch ? `落地到 ${input.defaultBranch}` : '没找到默认分支'
    const rows = [['周起始', '落地', '测试行', '主代码行', '测试/主代码', '整组通过', '整组耗时中位数']]
    for (const week of weeks) {
      rows.push([
        day(week.start),
        String(week.landings),
        String(week.testLines),
        String(week.codeLines),
        week.codeLines > 0 ? (week.testLines / week.codeLines).toFixed(2) : '-',
        String(week.fullPasses),
        week.fullMedianMs === undefined ? '-' : duration(week.fullMedianMs),
      ])
    }
    lines.push('', `测试量和整组耗时（按周，${branch}，行数为新增行，只看趋势）：`, ...table(rows))
  }
  return lines.join('\n')
}
