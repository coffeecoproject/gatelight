// testpace 命令行：focused、files、full、status、report、verify、install，以及 git 钩子调用的 gate。

import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { CHECK_KEY, extraChecks } from './checks.ts'
import { COMMAND_KEYS, commandExists, CONFIG_FILE, configExists, loadConfig } from './config.ts'
import { type Execution, execute } from './execute.ts'
import { askLayermap, fullReasons, LAYERMAP_HINT } from './focused.ts'
import { duration, short, when } from './format.ts'
import { checkRefUpdates, gateProblem, installGate } from './gate.ts'
import { changedPaths, commitOf, currentBranch, defaultBranch, headCommit, landings, mergeBase, workTreeId } from './git.ts'
import { renderReport } from './report.ts'
import { busyText, coverageOf, defaultTips, describeCoverage, failureText, ignoredBy, openRepo, type Repo, runRecorded, started } from './repo.ts'
import { LOCATED, newRunId } from './store.ts'
import { findTests, testMatcher } from './tests.ts'
import { verifyFiles } from './verify.ts'

const USAGE = `用法：
  testpace focused [--base REF]  改完先跑：fast，再跑 layermap 选出的相关测试。默认对比和默认分支的分叉点；在默认分支上选测靠不住时建议跑整组
  testpace files PATH[:行号]...  只跑给定的测试文件（testpace.json 的 files）；文件:行号 只跑那一行的测试，比如重跑失败的测试
  testpace full                  跑整组：附加检查、full（测试以外的检查），再把 tests 规则找到的全部测试交给 files，按当前工作区完整内容记录结果。适合放到后台跑
  testpace status                当前代码有没有整组通过记录、有没有正在跑的整组、最近一次结果、配置检查
  testpace report [--days N]     计时诊断，默认最近 28 天
  testpace verify [测试文件...]  核对接入守不守约定：三条命令找得到、合并门在把关、files 对不存在的文件报失败、认 文件:行号；每种测试各给一个文件
  testpace install               在全局 git 配置里配上合并门（这台机器配一次）：agent 移动默认分支时，要求落地的代码有整组通过记录`

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
  if (!config?.full || !config.files || problems.length > 0) {
    console.error(`没法跑整组：${problems.join('；')}`)
    return EXIT.usage
  }
  const tests = findTests(ctx.root, config.tests)
  if (tests.length === 0) {
    console.error(`没法跑整组：按 tests 规则（${config.tests.join('、')}）在工作区里没找到测试文件。`)
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

  // 依次跑，便宜的在前，一段没过就停：本机登记的附加检查，整组里测试以外的检查（full），
  // 最后把 tests 规则找到的全部测试文件交给 files。都过了才算整组通过
  const checks = extraChecks(ctx.root)
  const steps = [
    ...checks.map(check => ({ title: `附加检查 ${check}`, header: `附加检查：${check}`, command: check, args: [] as string[], check })),
    { title: '整组的检查（full）', header: `整组的检查（full）：${config.full}`, command: config.full, args: [] as string[] },
    { title: `全部测试（${tests.length} 个文件）`, header: `全部测试（${tests.length} 个文件）：${config.files}`, command: config.files, args: tests },
  ]
  const onStart = (group: number) => ctx.store.update(ctx.root, id, { group })
  const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0)
  let failed: (typeof steps)[number] | undefined
  // 失败节选从没通过的那一段的输出开始
  let excerptFrom = 0
  let execution: Execution | undefined
  let waiting: string[]
  try {
    for (const step of steps) {
      excerptFrom = sizeOf(log)
      appendFileSync(log, `===== testpace ${step.header}\n`)
      const part = await execute(step.command, step.args, ctx.root, log, onStart)
      execution = execution ? { ...part, durationMs: execution.durationMs + part.durationMs } : part
      if (part.interrupted || part.exitCode !== 0) {
        failed = step
        break
      }
    }
  } finally {
    waiting = ctx.store.release(ctx.root, id)
  }
  if (!execution) throw new Error('整组没有运行')

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
    ...(checks.length ? { checks } : {}),
    tests: tests.length,
    log,
  })

  const took = duration(execution.durationMs)
  if (result === 'pass' && tree === treeAtEnd) {
    const extra = checks.length ? `\n附加检查通过：${checks.join('、')}` : ''
    console.log(`整组通过 · ${tests.length} 个测试文件 · 用时 ${took} · 代码 ${short(tree)}${extra}\n日志：${log}`)
    return EXIT.ok
  }
  if (result === 'pass') {
    const changed = changedPaths(ctx.root, tree, treeAtEnd)
    const more = changed.length > 5 ? ` 等 ${changed.length} 个` : ''
    console.log(
      [
        `整组通过，但跑的过程中代码改过，这次不算通过记录。变了的文件：${changed.slice(0, 5).join('、')}${more}`,
        '是整组自己生成的文件，就加进 .gitignore 或让它写到仓库外；是别处改的，代码不再改动时重跑 testpace full。',
        `用时 ${took} · 日志：${log}`,
      ].join('\n'),
    )
    return EXIT.fail
  }
  const check = failed && 'check' in failed ? failed.check : undefined
  const what = failed?.title ?? '整组'
  const gap = /[A-Za-z0-9]$/.test(what) ? ' ' : ''
  console.log(failureText(`整组失败：${what}${gap}没通过${failed === steps.at(-1) ? '' : '，后面的没有跑'}`, log, execution, excerptFrom))
  if (check && execution.exitCode === 127) {
    console.log(`附加检查的命令找不到（登记它的插件停用了或没装好）。重新装好它；不再用的话取消登记：git config --global --fixed-value --unset-all ${CHECK_KEY} '${check}'`)
  }
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
  // 相关测试只从整组的测试里选，tests 规则写坏了就没法选
  if (!config?.fast || !config.files || config.tests.length === 0) {
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
  const isIgnored = ignoredBy(config)
  const selection = askLayermap(ctx.root, base, isIgnored, new Set(findTests(ctx.root, config.tests)), testMatcher(config.tests))
  const reasons = fullReasons(selection)

  let code: number = EXIT.ok
  if (selection.kind === 'selected' && selection.changed.length === 0) {
    lines.push(`相对 ${short(base)} 没有改动，不用跑测试。`)
  } else if (selection.kind === 'selected' && selection.nothingToTest) {
    lines.push(selection.changed.every(isIgnored) ? '改动只涉及 ignore 里的路径，不用跑测试。' : '改动里没有整组要跑的东西（只有 ignore 里的路径、tests 规则外或删掉的测试），不用跑测试。')
  } else if (selection.kind === 'selected' && selection.tests.length > 0) {
    const shown = selection.tests.slice(0, 10).map(test => `  ${test}`)
    if (selection.tests.length > 10) shown.push(`  等 ${selection.tests.length} 个`)
    const indirect = selection.indirect ? `；另有 ${selection.indirect} 个只是间接导入改动，没选` : ''
    const outside = selection.outside.length ? `；另有 ${selection.outside.length} 个不在 tests 规则里，整组不跑，没选` : ''
    lines.push(`相关测试 ${selection.tests.length} 个（对比 ${short(base)}${indirect}${outside}）：`, ...shown)
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
    if (config.tests.length) {
      const found = findTests(ctx.root, config.tests).length
      lines.push(`  tests: ${config.tests.join(', ')}  → 找到 ${found} 个测试文件，整组时全部交给 files${found ? '' : '  ← 一个都没找到'}`)
    }
    if (config.ignore.length) lines.push(`  ignore: ${config.ignore.join(', ')}`)
  }
  // 合并门看提交里的 testpace.json，工作区里这份写坏了它也照常把关
  if (configExists(ctx.root)) lines.push(`合并门：${gateProblem(ctx.root) ?? '已装上，agent 移动默认分支时检查'}`)
  const checks = extraChecks(ctx.root)
  lines.push(`附加检查（全局 git 配置 testpace.check）：${checks.length ? `${checks.join('、')}，整组之前先跑` : '没有'}`)
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

/** 由程序核对这个项目的接入守不守约定（见 verify.ts）。整组太长，不在这里跑。 */
async function verify(args: string[]): Promise<number> {
  const ctx = context()
  if (!ctx) return EXIT.usage
  const { config, problems } = loadConfig(ctx.root)
  if (!config) {
    console.error(`${CONFIG_FILE} 读不出来，先修好：${problems.join('；')}`)
    return EXIT.usage
  }
  const tests: { path: string; text: string }[] = []
  for (const arg of args) {
    const absolute = resolve(arg)
    const path = relative(ctx.root, absolute)
    if (!existsSync(absolute) || !statSync(absolute).isFile() || path.startsWith('..')) {
      console.error(`找不到测试文件 ${arg}（要是这个仓库里的文件）`)
      return EXIT.usage
    }
    if (!tests.some(test => test.path === path)) tests.push({ path, text: readFileSync(absolute, 'utf8') })
  }

  const say = (line: string): void => console.log(line)
  let failed = problems.length > 0 ? 1 : 0
  say(problems.length > 0 ? `没通过　${CONFIG_FILE} 写得对：${problems.join('；')}` : `通过　${CONFIG_FILE} 写得对`)
  for (const key of COMMAND_KEYS) {
    // 没写的命令上一行已经算过
    const command = config[key]
    if (command === undefined) continue
    const found = commandExists(ctx.root, command)
    if (!found) failed += 1
    say(found ? `通过　找得到 ${key} 的命令（${command}）` : `没通过　找得到 ${key} 的命令：找不到 ${command}`)
  }
  const gate = gateProblem(ctx.root)
  if (gate) failed += 1
  say(gate ? `没通过　合并门在把关：${gate}` : '通过　合并门在把关')
  // 整组跑的测试是 tests 规则找到的文件：给的测试文件不在里面，整组就跑不到它这一类
  if (config.tests.length) {
    const found = findTests(ctx.root, config.tests)
    if (found.length === 0) failed += 1
    say(found.length ? `通过　tests 规则找到测试文件（${found.length} 个）` : `没通过　tests 规则找到测试文件：按 ${config.tests.join('、')} 一个都没找到`)
    const selected = testMatcher(config.tests)
    for (const test of tests) {
      const covered = selected(test.path)
      if (!covered) failed += 1
      say(covered ? `通过　整组会跑到 ${test.path}` : `没通过　整组会跑到 ${test.path}：它不在 tests 规则里，整组跑不到这一类测试`)
    }
  }

  if (!config.files) {
    say(`接入核对：${failed} 项没通过；${CONFIG_FILE} 里没有 files，其余没法查。`)
    return EXIT.fail
  }
  const tree = workTreeId(ctx.root)
  const result = await verifyFiles(ctx, config.files, tree, tests, say)
  if (result.kind === 'busy') {
    console.log(busyText(result.marker, tree))
    return EXIT.busy
  }
  if (result.kind === 'interrupted') return EXIT.interrupted
  failed += result.failed
  say(`没查　整组（${config.full ?? `${CONFIG_FILE} 里没有 full`}，再加上 tests 找到的全部测试）：太长不在这里跑；能不能通过用 testpace full 看。`)

  const notChecked = result.skipped + 1
  say(failed > 0 ? `接入核对：${failed} 项没通过，${notChecked} 项没查。` : `接入核对：查了的都通过，${notChecked} 项没查。`)
  return failed > 0 ? EXIT.fail : EXIT.ok
}

function install(): number {
  const ctx = context()
  if (!ctx) return EXIT.usage
  const { ok, problem } = installGate(ctx.root)
  if (!ok) {
    console.error(`没有配好：${problem}`)
    return EXIT.usage
  }
  console.log('合并门已配好：全局 git 配置里的 hook.testpace，这台机器上 agent 在所有仓库里移动默认分支时都检查（只管接入了 testpace 的仓库）。')
  const rest = gateProblem(ctx.root)
  if (rest) console.log(rest)
  return EXIT.ok
}

/**
 * git 的 reference-transaction 钩子调用：标准输入是要更新的引用，拒绝时退出码 1，git 就取消这次更新。
 * 只用 0 和 1：钩子把退出码 2 当成还没有 gate 命令的旧版 testpace，放行。
 */
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
    case 'verify':
      return verify(rest)
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
