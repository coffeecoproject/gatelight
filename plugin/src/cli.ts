// testpace 命令行：focused、files、full、status、report。

import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { COMMAND_KEYS, commandExists, CONFIG_FILE, loadConfig } from './config.ts'
import { execute } from './execute.ts'
import { askLayermap, fullReasons, LAYERMAP_HINT } from './focused.ts'
import { duration, short, when } from './format.ts'
import { checkRefUpdates, gateProblem, hookInWorktree, installGate } from './gate.ts'
import { commitOf, currentBranch, defaultBranch, headCommit, landings, mergeBase, workTreeId } from './git.ts'
import { matcher } from './glob.ts'
import { renderReport } from './report.ts'
import { busyText, coverageOf, defaultTips, describeCoverage, failureText, openRepo, type Repo, runRecorded, started } from './repo.ts'
import { LOCATED, newRunId } from './store.ts'

const USAGE = `用法：
  testpace focused [--base REF]  改完先跑：fast，再跑 layermap 选出的相关测试。默认对比和默认分支的分叉点；在默认分支上选测靠不住时建议跑整组
  testpace files PATH[:行号]...  只跑给定的测试文件（testpace.json 的 files）；文件:行号 只跑那一行的测试，比如重跑失败的测试
  testpace full                  跑整组（testpace.json 的 full），按当前工作区完整内容记录结果。适合放到后台跑
  testpace status                当前代码有没有整组通过记录、有没有正在跑的整组、最近一次结果、配置检查
  testpace report [--days N]     计时诊断，默认最近 28 天
  testpace install               装上合并门的 git 钩子：agent 移动默认分支时，要求落地的代码有整组通过记录`

/**
 * 退出码：0 通过；1 失败或没得到通过记录（gate：拒绝这次更新）；2 用法或配置问题；
 * 3 这个工作区已有测试在跑，或别处在跑同一份代码的整组；4 在默认分支上，跑了的都通过，但选测靠不住，应当跑整组；130 被中断。
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

  // Claude Code 给 agent 的命令带上会话号：停止门只拦起这次整组的会话，和等着用它结果的会话
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID
  const elsewhere = ctx.store.running().find(marker => marker.kind === 'full' && marker.tree === tree && marker.worktree !== ctx.root)
  if (elsewhere) {
    console.log(`工作区 ${elsewhere.worktree} 正在跑同一份代码的整组（${started(elsewhere)}）。等它结束后用 testpace status 看结果。`)
    return EXIT.busy
  }

  const startedAt = Date.now()
  const id = newRunId(startedAt)
  const log = ctx.store.logPath(id)
  const session = sessionId ? { session: sessionId } : {}
  const busy = ctx.store.claim({ id, kind: 'full', pid: process.pid, worktree: ctx.root, tree, startedAt, ...session, log })
  if (busy?.kind === 'full') {
    if (sessionId) ctx.store.waitOn(busy, sessionId)
    console.log(`这个工作区已有整组在跑（${started(busy)}）。等它结束后用 testpace status 看结果。`)
    return EXIT.busy
  }
  if (busy) {
    console.log(busyText(busy, tree))
    return EXIT.busy
  }

  let execution
  let waiting: string[]
  try {
    execution = await execute(config.full, [], ctx.root, log, group => ctx.store.update(ctx.root, id, { group }))
  } finally {
    waiting = ctx.store.release(ctx.root, id)
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
    ...session,
    ...(waiting.length ? { waiting } : {}),
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
  if ('busy' in fast) {
    console.log(busyText(fast.busy, tree))
    return EXIT.busy
  }
  if (fast.execution.interrupted) return EXIT.interrupted
  if (fast.record.result === 'fail') {
    console.log(failureText('fast 失败', fast.record.log, fast.execution))
    return EXIT.fail
  }
  lines.push(`fast 通过 · 用时 ${duration(fast.execution.durationMs)}`)

  // 对比和默认分支的分叉点：分支上已经提交的改动也算这次的改动。
  const branch = defaultBranch(ctx.root)
  // 不在默认分支上（包括分离的 HEAD）：要落地还得合并，合并前的整组兜底，选测靠不住也不用现在跑整组
  const onBranch = branch !== undefined && currentBranch(ctx.root) !== branch
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
    if ('busy' in related) {
      console.log([...lines, busyText(related.busy, tree)].join('\n'))
      return EXIT.busy
    }
    if (related.execution.interrupted) return EXIT.interrupted
    if (related.record.result === 'fail') {
      console.log([...lines, failureText('相关测试失败', related.record.log, related.execution)].join('\n'))
      return EXIT.fail
    }
    lines.push(`相关测试通过 · 用时 ${duration(related.execution.durationMs)}`)
  }
  if (reasons.length > 0 && onBranch) {
    lines.push(`这次选测不完全可靠：${reasons.join('；')}。在分支上不用现在跑整组，合回 ${branch} 时的整组会覆盖。`)
  } else if (reasons.length > 0) {
    lines.push(`建议跑整组（testpace full，放后台）：${reasons.join('；')}。`)
    code = EXIT.fullNeeded
  }
  if (reasons.length > 0 && selection.kind === 'unavailable' && selection.missing) lines.push(LAYERMAP_HINT)
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
  const tree = workTreeId(ctx.root)
  // 路径按当前目录算，交给项目命令时换成相对仓库根目录（项目命令在根目录跑）；文件:行号 的行号原样带上
  const targets = paths.map(path => {
    const location = LOCATED.exec(path)?.[0] ?? ''
    return relative(ctx.root, resolve(path.slice(0, path.length - location.length))) + location
  })
  const run = await runRecorded(ctx, 'files', config.files, targets, tree)
  if ('busy' in run) {
    console.log(busyText(run.busy, tree))
    return EXIT.busy
  }
  // 文件:行号 只跑那一行的测试
  const what = targets.some(target => LOCATED.test(target)) ? `${targets.length} 处测试` : `${targets.length} 个测试文件`
  if (run.execution.interrupted) return EXIT.interrupted
  if (run.record.result === 'fail') {
    console.log(failureText(`${what}失败`, run.record.log, run.execution))
    return EXIT.fail
  }
  console.log(`${what}通过 · 用时 ${duration(run.execution.durationMs)}`)
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
      lines.push(`正在跑：${marker.kind}，${started(marker)}（已 ${duration(Date.now() - marker.startedAt)}），${changed}`)
    }

    const last = runs.filter(run => run.kind === 'full' && run.worktree === ctx.root).sort((a, b) => b.startedAt - a.startedAt)[0]
    if (last) {
      const outcome = last.result === 'pass' ? '通过' : '失败'
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
  if (config) lines.push(`合并门：${gateProblem(ctx.root) ?? '已装上，agent 移动默认分支时检查'}`)
  // 版本太旧不在这里查：focused 读输出时会说
  lines.push(`layermap：${commandExists(ctx.root, 'layermap') ? '找到' : `找不到，focused 没法按改动选测试，每次都会建议跑整组。${LAYERMAP_HINT}`}`)

  console.log(lines.join('\n'))
  // 停止门据此判断这个会话有没有看过整组的结果；不在 Claude Code 里（没有会话号）不记
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID
  if (sessionId) ctx.store.markRead(sessionId, ctx.root, Date.now(), () => defaultTips(ctx))
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

function install(): number {
  const ctx = context()
  if (!ctx) return EXIT.usage
  const state = installGate(ctx.root)
  if (state.kind === 'foreign') {
    console.error(`${state.path} 已经有别的 reference-transaction 钩子，没有覆盖。要用合并门，把 testpace 的检查合进那个钩子（内容见 testpace 插件的 src/gate.ts 里的 HOOK_SCRIPT）。`)
    return EXIT.usage
  }
  const commit = hookInWorktree(ctx.root, state.path) ? '\n这个钩子在项目目录里（core.hooksPath），和 testpace.json 一样要提交进仓库。' : ''
  console.log(`合并门已装上：${state.path}${commit}`)
  const problem = gateProblem(ctx.root)
  if (problem) console.log(problem)
  return EXIT.ok
}

/** git 的 reference-transaction 钩子调用：标准输入是要更新的引用，拒绝时退出码非零，git 就取消这次更新。 */
function gate(): number {
  try {
    const reason = checkRefUpdates(process.cwd(), readFileSync(0, 'utf8'))
    if (!reason) return EXIT.ok
    console.error(reason)
  } catch (error) {
    console.error(`testpace 合并门：没能确认要落地的代码测过（${(error as Error).message.split('\n')[0]}），这次不更新。`)
  }
  return EXIT.fail
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
    case 'install':
      return install()
    case 'gate':
      return gate()
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
