// testpace 命令行：full、status、report（focused 在第 3 期加）。

import { readFileSync } from 'node:fs'
import { COMMAND_KEYS, commandExists, type Config, CONFIG_FILE, loadConfig } from './config.ts'
import { type Coverage, findCoverage } from './coverage.ts'
import { failureExcerpt } from './excerpt.ts'
import { execute } from './execute.ts'
import { duration, short, when } from './format.ts'
import { changedPaths, commonDir, currentBranch, defaultBranch, headCommit, landings, repoRoot, workTreeId } from './git.ts'
import { matcher } from './glob.ts'
import { renderReport } from './report.ts'
import { newRunId, type RunRecord, Store } from './store.ts'

const USAGE = `用法：
  testpace full            跑整组（testpace.json 的 full），按当前工作区完整内容记录结果。适合放到后台跑
  testpace status          当前代码有没有整组通过记录、有没有正在跑的整组、最近一次结果、配置检查
  testpace report [--days N]  计时诊断，默认最近 28 天`

/** 退出码：0 通过；1 失败或没得到通过记录；2 用法或配置问题；3 已有整组在跑；130 被中断。 */
const EXIT = { ok: 0, fail: 1, usage: 2, busy: 3, interrupted: 130 } as const

interface Context {
  root: string
  store: Store
}

function context(): Context | undefined {
  const root = repoRoot(process.cwd())
  if (!root) {
    console.error('testpace 要在 git 仓库里运行。')
    return undefined
  }
  return { root, store: new Store(commonDir(root)) }
}

function coverageFor(ctx: Context, config: Config, tree: string, runs: RunRecord[]): Coverage {
  return findCoverage(tree, runs, matcher(config.ignore), (from, to) => changedPaths(ctx.root, from, to))
}

function describeCoverage(coverage: Coverage): string {
  if (coverage.kind === 'none') return '没有整组通过记录'
  const run = coverage.run
  const base = `有整组通过记录（${when(run.startedAt)}，用时 ${duration(run.durationMs)}）`
  if (coverage.kind === 'exact') return base
  const sample = coverage.changed.slice(0, 3).join('、')
  const more = coverage.changed.length > 3 ? ` 等 ${coverage.changed.length} 个` : ''
  return `${base}；相对那次只改了忽略路径：${sample}${more}`
}

async function full(): Promise<number> {
  const ctx = context()
  if (!ctx) return EXIT.usage
  const { config, problems } = loadConfig(ctx.root)
  if (!config?.full) {
    console.error(`没法跑整组：${problems.join('；')}`)
    return EXIT.usage
  }

  const tree = workTreeId(ctx.root)
  const coverage = coverageFor(ctx, config, tree, ctx.store.readRuns())
  if (coverage.kind !== 'none') {
    console.log(`这份代码${describeCoverage(coverage)}，不重跑。`)
    return EXIT.ok
  }

  const busy = ctx.store.running().find(marker => marker.kind === 'full' && (marker.worktree === ctx.root || marker.tree === tree))
  if (busy) {
    const where = busy.worktree === ctx.root ? '这个工作区已有整组在跑' : `工作区 ${busy.worktree} 正在跑同一份代码的整组`
    console.log(`${where}（开始于 ${when(busy.startedAt)}，进程 ${busy.pid}）。等它结束后用 testpace status 看结果。`)
    return EXIT.busy
  }

  const startedAt = Date.now()
  const id = newRunId(startedAt)
  const log = ctx.store.logPath(id)
  let execution
  try {
    execution = await execute(config.full, [], ctx.root, log, () =>
      ctx.store.markRunning({ id, kind: 'full', pid: process.pid, worktree: ctx.root, tree, startedAt, log }),
    )
  } finally {
    ctx.store.clearRunning(id)
  }

  if (execution.interrupted) {
    console.log(`整组被中断，没有记录结果。日志：${log}`)
    return EXIT.interrupted
  }

  const treeAtEnd = workTreeId(ctx.root)
  const result = execution.exitCode === 0 ? 'pass' : 'fail'
  ctx.store.appendRun({
    id,
    kind: 'full',
    worktree: ctx.root,
    branch: currentBranch(ctx.root),
    head: headCommit(ctx.root),
    tree,
    treeAtEnd,
    startedAt,
    durationMs: execution.durationMs,
    exitCode: execution.exitCode,
    result,
    log,
  })

  const took = duration(execution.durationMs)
  if (result === 'pass' && tree === treeAtEnd) {
    console.log(`整组通过 · 用时 ${took} · 代码 ${short(tree)}\n日志：${log}`)
    return EXIT.ok
  }
  if (result === 'pass') {
    console.log(`整组通过，但跑的过程中代码改过，这次不算通过记录。代码不再改动时重跑 testpace full。\n用时 ${took} · 日志：${log}`)
    return EXIT.fail
  }
  const code =
    execution.exitCode !== null ? `退出码 ${execution.exitCode}` : execution.signal ? `被信号 ${execution.signal} 终止` : '命令没能启动'
  const excerpt = failureExcerpt(readFileSync(log, 'utf8'))
  console.log([`整组失败（${code}）· 用时 ${took}`, '--- 输出节选 ---', ...excerpt, '---', `完整日志：${log}`].join('\n'))
  return EXIT.fail
}

function status(): number {
  const ctx = context()
  if (!ctx) return EXIT.usage
  const lines: string[] = []
  const { config, problems } = loadConfig(ctx.root)

  if (config) {
    const tree = workTreeId(ctx.root)
    const runs = ctx.store.readRuns()
    lines.push(`当前代码（${short(tree)}）：${describeCoverage(coverageFor(ctx, config, tree, runs))}`)

    for (const marker of ctx.store.running().filter(m => m.worktree === ctx.root)) {
      const changed = marker.tree === tree ? '开始后代码没改过' : '开始后代码改过，跑完的结果不算当前代码的记录'
      lines.push(`正在跑：${marker.kind}，开始于 ${when(marker.startedAt)}（已 ${duration(Date.now() - marker.startedAt)}），${changed}`)
    }

    const last = runs.filter(run => run.kind === 'full' && run.worktree === ctx.root).sort((a, b) => b.startedAt - a.startedAt)[0]
    if (last) {
      const outcome = { pass: '通过', fail: '失败', interrupted: '中断' }[last.result]
      const changed = last.result === 'pass' && last.tree !== last.treeAtEnd ? '，但跑的过程中代码改过' : ''
      const current = last.tree === tree ? '是当前代码' : '不是当前代码'
      lines.push(`最近一次整组：${outcome}${changed}（${when(last.startedAt)}，用时 ${duration(last.durationMs)}，${current}）`)
      if (last.result === 'fail') lines.push(`  日志：${last.log}`)
    } else {
      lines.push('最近一次整组：这个工作区还没用 testpace 跑过')
    }
  }

  lines.push(`配置（${CONFIG_FILE}）：${problems.length ? problems.join('；') : '正常'}`)
  if (config) {
    for (const key of COMMAND_KEYS) {
      const command = config[key]
      if (!command) continue
      lines.push(`  ${key}: ${command}${commandExists(ctx.root, command) ? '' : '  ← 找不到这个命令'}`)
    }
    if (config.ignore.length) lines.push(`  ignore: ${config.ignore.join(', ')}`)
  }

  console.log(lines.join('\n'))
  return config ? EXIT.ok : EXIT.usage
}

function report(args: string[]): number {
  let days = 28
  const at = args.indexOf('--days')
  if (at !== -1) {
    days = Number(args[at + 1])
    if (!Number.isInteger(days) || days <= 0) {
      console.error('--days 要跟一个正整数')
      return EXIT.usage
    }
  }
  const ctx = context()
  if (!ctx) return EXIT.usage
  const now = Date.now()
  const branch = defaultBranch(ctx.root)
  console.log(
    renderReport({
      repo: ctx.root,
      days,
      now,
      runs: ctx.store.readRuns(),
      defaultBranch: branch,
      landings: branch ? landings(ctx.root, branch, now - days * 24 * 3600 * 1000) : [],
    }),
  )
  return EXIT.ok
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'full':
      return full()
    case 'status':
      return status()
    case 'report':
      return report(rest)
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE)
      return command === undefined ? EXIT.usage : EXIT.ok
    default:
      console.error(`不认识的命令 "${command}"\n${USAGE}`)
      return EXIT.usage
  }
}

process.exitCode = await main(process.argv.slice(2))
