// testpace 命令行：focused、files、full、status、report。

import { COMMAND_KEYS, commandExists, CONFIG_FILE, loadConfig } from './config.ts'
import { execute } from './execute.ts'
import { askLayermap, fullReasons } from './focused.ts'
import { duration, short, when } from './format.ts'
import { commitOf, currentBranch, defaultBranch, headCommit, landings, mergeBase, workTreeId } from './git.ts'
import { matcher } from './glob.ts'
import { renderReport } from './report.ts'
import { coverageOf, describeCoverage, failureText, openRepo, type Repo, runRecorded } from './repo.ts'
import { newRunId } from './store.ts'

const USAGE = `用法：
  testpace focused [--base REF]  改完先跑：fast，再跑 layermap 选出的相关测试。默认对比和默认分支的分叉点
  testpace files PATH...         只跑给定的测试文件（testpace.json 的 files），比如重跑失败的文件
  testpace full                  跑整组（testpace.json 的 full），按当前工作区完整内容记录结果。适合放到后台跑
  testpace status                当前代码有没有整组通过记录、有没有正在跑的整组、最近一次结果、配置检查
  testpace report [--days N]     计时诊断，默认最近 28 天`

/**
 * 退出码：0 通过；1 失败或没得到通过记录；2 用法或配置问题；3 已有整组在跑；
 * 4 跑了的都通过，但选测靠不住，应当跑整组；130 被中断。
 */
const EXIT = { ok: 0, fail: 1, usage: 2, busy: 3, fullNeeded: 4, interrupted: 130 } as const

type Context = Repo

function context(): Context | undefined {
  const repo = openRepo(process.cwd())
  if (!repo) console.error('testpace 要在 git 仓库里运行。')
  return repo
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
  const coverage = coverageOf(ctx, config, tree)
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
  console.log(failureText('整组失败', log, execution))
  return EXIT.fail
}

async function focused(args: string[]): Promise<number> {
  const at = args.indexOf('--base')
  if (at === -1 ? args.length > 0 : args.length !== 2 || at !== 0) {
    console.error(USAGE)
    return EXIT.usage
  }
  const ctx = context()
  if (!ctx) return EXIT.usage
  const { config, problems } = loadConfig(ctx.root)
  if (!config?.fast || !config.files) {
    console.error(`没法跑 focused：${problems.join('；')}`)
    return EXIT.usage
  }

  const tree = workTreeId(ctx.root)
  const lines: string[] = []
  const fast = await runRecorded(ctx, 'fast', config.fast, [], tree)
  if (fast.record.result === 'interrupted') return EXIT.interrupted
  if (fast.record.result === 'fail') {
    console.log(failureText('fast 失败', fast.record.log, fast.execution))
    return EXIT.fail
  }
  lines.push(`fast 通过 · 用时 ${duration(fast.execution.durationMs)}`)

  // 对比和默认分支的分叉点：分支上已经提交的改动也算这次的改动。
  const branch = defaultBranch(ctx.root)
  const base = at !== -1 ? args[at + 1]! : (branch && commitOf(ctx.root, 'HEAD') && mergeBase(ctx.root, 'HEAD', `refs/heads/${branch}`)) || 'HEAD'
  const ignored = matcher(config.ignore)
  const selection = askLayermap(ctx.root, base, ignored)
  const reasons = fullReasons(selection)

  let code: number = EXIT.ok
  if (selection.kind === 'selected' && selection.changed.length === 0) {
    lines.push(`相对 ${short(base)} 没有改动，不用跑测试。`)
  } else if (selection.kind === 'selected' && selection.onlyIgnored) {
    lines.push('改动只涉及 ignore 里的路径，不用跑测试。')
  } else if (selection.kind === 'selected' && selection.tests.length > 0) {
    const shown = selection.tests.slice(0, 10).map(test => `  ${test}`)
    if (selection.tests.length > 10) shown.push(`  等 ${selection.tests.length} 个`)
    const indirect = selection.indirect ? `；另有 ${selection.indirect} 个只是间接导入改动，没选` : ''
    lines.push(`相关测试 ${selection.tests.length} 个（对比 ${short(base)}${indirect}）：`, ...shown)
    const related = await runRecorded(ctx, 'files', config.files, selection.tests, tree)
    if (related.record.result === 'interrupted') return EXIT.interrupted
    if (related.record.result === 'fail') {
      console.log([...lines, failureText('相关测试失败', related.record.log, related.execution)].join('\n'))
      return EXIT.fail
    }
    lines.push(`相关测试通过 · 用时 ${duration(related.execution.durationMs)}`)
  }
  if (reasons.length > 0) {
    lines.push(`建议跑整组（testpace full，放后台）：${reasons.join('；')}。`)
    code = EXIT.fullNeeded
  }
  console.log(lines.join('\n'))
  return code
}

async function files(paths: string[]): Promise<number> {
  if (paths.length === 0) {
    console.error(USAGE)
    return EXIT.usage
  }
  const ctx = context()
  if (!ctx) return EXIT.usage
  const { config, problems } = loadConfig(ctx.root)
  if (!config?.files) {
    console.error(`没法跑测试文件：${problems.join('；')}`)
    return EXIT.usage
  }
  const run = await runRecorded(ctx, 'files', config.files, paths, workTreeId(ctx.root))
  if (run.record.result === 'interrupted') return EXIT.interrupted
  if (run.record.result === 'fail') {
    console.log(failureText(`${paths.length} 个测试文件失败`, run.record.log, run.execution))
    return EXIT.fail
  }
  console.log(`${paths.length} 个测试文件通过 · 用时 ${duration(run.execution.durationMs)}`)
  return EXIT.ok
}

function status(): number {
  const ctx = context()
  if (!ctx) return EXIT.usage
  const lines: string[] = []
  const { config, problems } = loadConfig(ctx.root)

  if (config) {
    const tree = workTreeId(ctx.root)
    const runs = ctx.store.readRuns()
    lines.push(`当前代码（${short(tree)}）：${describeCoverage(coverageOf(ctx, config, tree, runs))}`)

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
  // 停止门据此判断 agent 有没有看过整组的结果
  ctx.store.markRead(ctx.root, Date.now())
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
    case 'focused':
      return focused(rest)
    case 'files':
      return files(rest)
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
