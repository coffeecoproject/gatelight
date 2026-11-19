// testpace 命令行：focused、files、full、status、hold、release、report、verify、install、run，以及 git 钩子调用的 gate。

import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { AGENTS, currentAgent } from './agent.ts'
import { CHECK_KEY, extraChecks } from './checks.ts'
import { COMMAND_KEYS, commandExists, CONFIG_FILE, configExists, loadConfig } from './config.ts'
import { type Execution, execute, RUN_ENV } from './execute.ts'
import { entryPath, entryState, installEntry } from './entry.ts'
import { askLayermap, fullReasons, LAYERMAP_HINT, outsideNote } from './focused.ts'
import { duration, short, when } from './format.ts'
import { checkRefUpdates, danglingNote, GATE_REJECT, gateProblem, installGate } from './gate.ts'
import { changedPaths, commitOf, currentBranch, defaultBranch, headCommit, landings, mergeBase, workTreeId } from './git.ts'
import { renderReport } from './report.ts'
import { nodeTest } from './run/node-test.ts'
import { playwright } from './run/playwright.ts'
import { type Framework, runFramework } from './run/runner.ts'
import { vitest } from './run/vitest.ts'
import { busyText, coverageOf, defaultTips, describeCoverage, failureText, ignoredBy, openRepo, type Repo, runner, runningText, runRecorded, started } from './repo.ts'
import { failedTests, flakyStatus, noteResults, PROVE_RUNS, provenFixed, readResults, RESULTS_ENV, resultsFile, type TestResult } from './results.ts'
import { LOCATED, newRunId, processAlive, type RunRecord, type RunStep, testKey } from './store.ts'
import { findTests, testMatcher } from './tests.ts'
import { verifyFiles } from './verify.ts'

const USAGE = `用法：
  testpace focused [--base REF]  改完先跑：fast，再跑 layermap 选出的相关测试。默认对比和默认分支的分叉点；在默认分支上选测靠不住时建议跑整组
  testpace files [--repeat N] PATH[:行号]...
                                 只跑给定的测试文件（testpace.json 的 files）；文件:行号 只跑那一行的测试，比如重跑失败的测试。
                                 --repeat N 连跑 N 次、没过就停：造出时好时坏的测试的失败，或修好后连跑 10 次证明
  testpace full                  跑整组：附加检查、full（测试以外的检查），再把 tests 规则找到的全部测试交给 files，按当前工作区完整内容记录结果。要跑几分钟，能放到后台的就放后台
  testpace status                当前代码有没有整组通过记录、有没有正在跑的整组、最近一次结果、配置检查
  testpace hold PID 说明         借用这个工作区（比如 testcraft 建副本）：占着时别的 testpace 命令不跑，说明是谁占着。
                                 PID 是借用的那个进程，它不在了占用就作废。占上时输出这次的 id，退出码 0；有在跑的、占着的，说明是谁，退出码 3。
                                 整组先跑的附加检查带着这一轮的 TESTPACE_RUN，工作区已经是这一轮的，不另占、什么也不输出，退出码 0
  testpace release ID            放开 hold 占的工作区
  testpace report [--days N]     计时诊断，默认最近 28 天
  testpace verify [测试文件...]  核对接入守不守约定：三条命令找得到、合并门在把关、files 对不存在的文件报失败、认 文件:行号；每种测试各给一个文件
  testpace install               这台机器配一次：在全局 git 配置里配上合并门（agent 移动默认分支时，要求落地的代码有整组通过记录），
                                 并放上固定命令入口 ~/.local/bin/testpace（Codex 的命令和合并门的钩子靠它找到 testpace）
  ${nodeTest.usage}
  ${vitest.usage}
  ${playwright.usage}
                                 写在 testpace.json 的 files 里（或项目的 files 脚本里）：用项目的测试框架跑测试文件，守 files 的约定：
                                 文件不存在、给的文件或行上一个测试都没跑到时失败，选中的测试全被跳过时说一句。
                                 node:test 不能按行跑，按行给的整个文件跑，跑完照样核对那一行`

/**
 * 退出码：0 通过；1 失败或没得到通过记录；2 用法或配置问题；
 * 3 这个工作区已有测试在跑或被借用着（hold：占不上），或别处在跑同一份代码的整组；4 在默认分支上，跑了的都通过，但选测靠不住，应当跑整组；130 被中断。
 * gate 拒绝时是 GATE_REJECT（见 gate.ts）。
 */
const EXIT = { ok: 0, fail: 1, usage: 2, busy: 3, fullNeeded: 4, interrupted: 130 } as const

type Context = Repo

/** 跑这条命令的 agent：会话号、在不在沙箱里。用户在终端里跑的没有。 */
const AGENT = currentAgent()

/**
 * 在 agent 的沙箱里不跑：测试会因为端口、网络被拒跑出假失败，记进去后 report 会当成测试不稳定；
 * status 要记下这个会话看过结果，写不进 .git 时停止门还会再拦。
 * 仓库在沙箱放行的位置（比如 /tmp）时记录目录也写得进去，所以不能只靠写不写得进去判断。
 */
function sandboxRefusal(): number | undefined {
  if (!AGENT?.sandboxed) return undefined
  console.error(`testpace 要在 ${AGENTS[AGENT.kind].name} 的沙箱外跑：它要写 .git/testpace/ 的记录，测试还常要开端口和网络，在沙箱里会被拒、结果不准。申请提权（在沙箱外）重新运行这条命令。`)
  return EXIT.usage
}

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

  // agent 给命令带上会话号：停止门只拦起这次整组的会话，和等着用它结果的会话
  const sessionId = AGENT?.session
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
    // 只有附加检查拿到这一轮的运行 id（见 RUN_ENV）：它们在测试之前跑，在里面借用工作区（testpace hold）不另占
    ...checks.map(check => ({ kind: 'check' as const, title: `附加检查 ${check}`, header: `附加检查：${check}`, command: check, args: [] as string[], check, env: { [RUN_ENV]: id } })),
    { kind: 'full' as const, title: '整组的检查（full）', header: `整组的检查（full）：${config.full}`, command: config.full, args: [] as string[] },
    { kind: 'tests' as const, title: `全部测试（${tests.length} 个文件）`, header: `全部测试（${tests.length} 个文件）：${config.files}`, command: config.files, args: tests },
  ]
  // 每段各用了多久：report 据此说整组的时间花在哪一段
  const timings: RunStep[] = []
  const onStart = (group: number) => ctx.store.update(ctx.root, id, { group })
  const resultsAt = resultsFile()
  const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0)
  let failed: (typeof steps)[number] | undefined
  // 失败节选从没通过的那一段的输出开始
  let excerptFrom = 0
  let execution: Execution | undefined
  let waiting: string[]
  let results: TestResult[]
  try {
    for (const step of steps) {
      excerptFrom = sizeOf(log)
      appendFileSync(log, `===== testpace ${step.header}\n`)
      const part = await execute(step.command, step.args, ctx.root, log, onStart, { [RESULTS_ENV]: resultsAt.path, ...('env' in step ? step.env : {}) })
      execution = execution ? { ...part, durationMs: execution.durationMs + part.durationMs } : part
      if (!part.interrupted) timings.push({ kind: step.kind, ...('check' in step ? { check: step.check } : {}), durationMs: part.durationMs })
      if (part.interrupted || part.exitCode !== 0) {
        failed = step
        break
      }
    }
  } finally {
    waiting = ctx.store.release(ctx.root, id)
    results = readResults(resultsAt.path, ctx.root)
    resultsAt.dispose()
  }
  if (!execution) throw new Error('整组没有运行')

  if (execution.interrupted) {
    console.log(`整组被中断，没有记录结果。日志：${log}`)
    return EXIT.interrupted
  }

  const treeAtEnd = workTreeId(ctx.root)
  const result = execution.exitCode === 0 ? 'pass' : 'fail'
  const before = ctx.store.readRuns()
  const record: RunRecord = {
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
    steps: timings,
    tests: tests.length,
    ...(results.length > 0 ? { failed: failedTests(results) } : {}),
    ...runner(),
    log,
  }
  ctx.store.appendRun(record)
  const notes = noteResults(ctx, { record, results, before, whole: tests })
  const say = (text: string): void => console.log([text, ...notes].join('\n'))

  const took = duration(execution.durationMs)
  if (result === 'pass' && tree === treeAtEnd) {
    const extra = checks.length ? `\n附加检查通过：${checks.join('、')}` : ''
    say(`整组通过 · ${tests.length} 个测试文件 · 用时 ${took} · 代码 ${short(tree)}${extra}\n日志：${log}`)
    return EXIT.ok
  }
  if (result === 'pass') {
    const changed = changedPaths(ctx.root, tree, treeAtEnd)
    const more = changed.length > 5 ? ` 等 ${changed.length} 个` : ''
    say(
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
  say(failureText(`整组失败：${what}${gap}没通过${failed === steps.at(-1) ? '' : '，后面的没有跑'}`, log, execution, excerptFrom))
  if (check && execution.exitCode === 127) {
    console.log(`附加检查的命令找不到（登记它的插件停用了或没装好）。重新装好它；不再用的话取消登记：git config --global --fixed-value --unset-all ${CHECK_KEY} '${check}'`)
  }
  return EXIT.fail
}

/**
 * 借用这个工作区（只占这个工作区，别的工作区不管）：要复制或接着用工作区的工具用，比如 testcraft 建副本。
 * 借用期间别的 testpace 命令不跑，免得跑到一半的状态（锁文件、临时文件）被带进副本。
 * 查有没有在跑的和占上是同一步（同 runClaimed 的登记），问完到用完之间不会有新起的插进来。
 * 登记的是借用的那个进程（pid）：它被杀了，占用跟着作废，不会把工作区永远锁住。
 * 在跑的正是调用它的这一轮（环境变量 RUN_ENV 里的运行 id 和登记的一样）时不另占：只有整组的附加检查拿得到它，
 * 那时还没有测试在跑，工作区已经是这一轮的。
 */
function hold(args: string[]): number {
  const [pid, ...what] = args
  const by = what.join(' ').trim()
  if (!pid || !/^[1-9]\d*$/.test(pid) || !by) {
    console.error(USAGE)
    return EXIT.usage
  }
  // 进程不在了的登记马上作废，调用方会以为占上了
  if (!processAlive(Number(pid))) {
    console.error(`进程 ${pid} 不在，借用要登记正在用工作区的那个进程。`)
    return EXIT.usage
  }
  const ctx = context()
  if (!ctx) return EXIT.usage
  const current = ctx.store.running().find(m => m.worktree === ctx.root)
  if (current && current.id === process.env[RUN_ENV]) return EXIT.ok
  const startedAt = Date.now()
  const id = newRunId(startedAt)
  const busy = ctx.store.claim({ id, kind: 'hold', by, pid: Number(pid), worktree: ctx.root, startedAt })
  if (busy) {
    console.log(`${runningText(busy)}。`)
    return EXIT.busy
  }
  console.log(id)
  return EXIT.ok
}

/** 放开 hold 占的工作区。只放借用的登记：跑着的命令自己结束时放开。已经放开、借用的进程已经不在的，什么也不做。 */
function release(args: string[]): number {
  const [id] = args
  if (!id || args.length !== 1) {
    console.error(USAGE)
    return EXIT.usage
  }
  const ctx = context()
  if (!ctx) return EXIT.usage
  const current = ctx.store.running().find(m => m.worktree === ctx.root)
  if (current?.kind === 'hold' && current.id === id) ctx.store.release(ctx.root, id)
  return EXIT.ok
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
    console.log([failureText('fast 失败', fast.record.log, fast.execution), ...fast.notes].join('\n'))
    return EXIT.fail
  }
  lines.push(`fast 通过 · 用时 ${duration(fast.execution.durationMs)}`, ...fast.notes)

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
    lines.push(`相关测试 ${selection.tests.length} 个（对比 ${short(base)}${indirect}）：`, ...shown)
    const related = await runRecorded(ctx, 'files', config.files, selection.tests, tree)
    if ('busy' in related) {
      console.log([...lines, busyText(related.busy, tree)].join('\n'))
      return EXIT.busy
    }
    if (related.execution.interrupted) return EXIT.interrupted
    if (related.record.result === 'fail') {
      console.log([...lines, failureText('相关测试失败', related.record.log, related.execution), ...related.notes].join('\n'))
      return EXIT.fail
    }
    lines.push(`相关测试通过 · 用时 ${duration(related.execution.durationMs)}`, ...related.notes)
  }
  const outside = outsideNote(selection)
  if (outside) lines.push(outside)
  if (reasons.length > 0 && onBranch) {
    lines.push(`这次选测不完全可靠：${reasons.join('；')}。在分支上不用现在跑整组，合回 ${branch} 时的整组会覆盖。`)
  } else if (reasons.length > 0) {
    lines.push(`建议跑整组（testpace full）：${reasons.join('；')}。`)
    code = EXIT.fullNeeded
  }
  if (reasons.length > 0 && selection.kind === 'unavailable' && selection.missing) lines.push(LAYERMAP_HINT)
  console.log(lines.join('\n'))
  return code
}

async function files(argv: string[]): Promise<number> {
  // --repeat N：连跑 N 次，没过就停。造出时好时坏的测试的失败，或证明修好了（见 results.ts 的 PROVE_RUNS）
  let times = 1
  let paths = argv
  const at = argv.indexOf('--repeat')
  if (at >= 0) {
    times = Number(argv[at + 1])
    paths = [...argv.slice(0, at), ...argv.slice(at + 2)]
    if (!Number.isInteger(times) || times < 1) {
      console.error('--repeat 要跟一个正整数')
      return EXIT.usage
    }
  }
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
  // 文件:行号 只跑那一行的测试
  const what = targets.some(target => LOCATED.test(target)) ? `${targets.length} 处测试` : `${targets.length} 个测试文件`
  const notes: string[] = []
  const passes: TestResult[][] = []
  // 连跑时前面通过的测试和那次的日志：后面没过就是时好时坏。只认同一份代码上的，代码一变就清掉
  const passedEarlier = new Map<string, string>()
  // 每次从上一次跑完时的代码开始；中途代码变过，这次连跑就不算证明修好了
  let current = tree
  let changed = false
  let took = 0
  for (let index = 1; index <= times; index += 1) {
    const repeat = times > 1 ? { repeat: { index, of: times }, passedEarlier } : {}
    const run = await runRecorded(ctx, 'files', config.files, targets, current, repeat)
    if ('busy' in run) {
      console.log([busyText(run.busy, current), ...notes].join('\n'))
      return EXIT.busy
    }
    if (run.execution.interrupted) {
      if (notes.length > 0) console.log(notes.join('\n'))
      return EXIT.interrupted
    }
    notes.push(...run.notes)
    const stayed = run.record.treeAtEnd === current
    if (!stayed) {
      changed = true
      current = run.record.treeAtEnd
      passedEarlier.clear()
    }
    took += run.execution.durationMs
    if (run.record.result === 'fail') {
      const which = times > 1 ? `连跑第 ${index} 次（共 ${times} 次）` : ''
      console.log([failureText(`${what}${which}失败`, run.record.log, run.execution), ...notes].join('\n'))
      return EXIT.fail
    }
    passes.push(run.results)
    if (stayed) {
      for (const test of run.results) if (test.status === 'passed' && !passedEarlier.has(testKey(test))) passedEarlier.set(testKey(test), run.record.log)
    }
  }
  // 证明修好了要代码一直没改
  if (!changed) notes.push(...provenFixed(ctx, passes))
  else if (times >= PROVE_RUNS && ctx.store.flaky().length > 0) {
    notes.push('连跑的过程中代码或工作区变了（比如测试生成了没被 .gitignore 忽略的文件），这次不算证明时好时坏的测试修好了，名单没动。')
  }
  const how = times > 1 ? `连跑 ${times} 次都通过 · 共用时 ${duration(took)}` : `通过 · 用时 ${duration(took)}`
  console.log([`${what}${how}`, ...notes].join('\n'))
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
      if (marker.kind === 'hold') {
        lines.push(`${runningText(marker)}，已 ${duration(Date.now() - marker.startedAt)}`)
        continue
      }
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

  lines.push(...flakyStatus(ctx.store.flaky()))
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
  const dangling = configExists(ctx.root) ? danglingNote(ctx.root) : undefined
  if (dangling) lines.push(`  ${dangling}`)
  lines.push(`固定命令入口（${entryPath()}）：${ENTRY_STATES[entryState()]}`)
  const checks = extraChecks(ctx.root)
  lines.push(`附加检查（全局 git 配置 testpace.check）：${checks.length ? `${checks.join('、')}，整组之前先跑` : '没有'}`)
  // 版本太旧不在这里查：focused 读输出时会说
  lines.push(`layermap：${commandExists(ctx.root, 'layermap') ? '找到' : `找不到，focused 没法按改动选测试，每次都会建议跑整组。${LAYERMAP_HINT}`}`)

  console.log(lines.join('\n'))
  // 停止门据此判断这个会话有没有看过整组的结果；不在 agent 里（没有会话号）不记
  const sessionId = AGENT?.session
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
  const entry = installEntry()
  if (!entry.ok) {
    console.error(`固定命令入口没放上：${entry.problem}`)
    return EXIT.usage
  }
  console.log(`固定命令入口已放好：${entryPath()}，运行时转给这台机器上装着的最高版本的 testpace。`)
  return EXIT.ok
}

/**
 * git 的 reference-transaction 钩子调用：标准输入是要更新的引用。放行退出码 0；拒绝退出码 GATE_REJECT，
 * 钩子只认它，git 就取消这次更新。检查时出错也拒绝：已经在检查了，确认不了要落地的代码测过就不放。
 */
function gate(): number {
  try {
    const reason = checkRefUpdates(process.cwd(), readFileSync(0, 'utf8'))
    if (!reason) return EXIT.ok
    console.error(reason)
  } catch (error) {
    console.error(`testpace 合并门：没能确认要落地的代码测过（${(error as Error).message.split('\n')[0]}），这次不更新。`)
  }
  return GATE_REJECT
}

/** testpace run 认的框架。 */
const FRAMEWORKS = new Map<string, Framework>([['node-test', nodeTest], ['vitest', vitest], ['playwright', playwright]])

/** testpace run <框架>：按框架跑测试文件、守 files 的约定。 */
function run(rest: string[]): Promise<number> | number {
  const [name, ...args] = rest
  const framework = name === undefined ? undefined : FRAMEWORKS.get(name)
  if (framework) return runFramework(framework, args)
  console.error(`${name === undefined ? '没有给框架' : `不认识的框架 "${name}"`}\n用法：\n${[...FRAMEWORKS.values()].map(f => `  ${f.usage}`).join('\n')}`)
  return EXIT.usage
}

const ENTRY_STATES = {
  installed: '已放好',
  outdated: '是旧版本放的，跑 testpace install 更新',
  missing: '没放：Codex 的命令和合并门的钩子在插件的 bin 目录不在 PATH 上时找不到 testpace。用户同意后跑 testpace install 放上',
  foreign: '那里是别的文件，没有放',
} as const

/**
 * 在 agent 的沙箱里不跑的子命令：跑项目命令的，和记下会话看过结果的 status。
 * gate 不在里面：它由 git 钩子调用，在这里拒绝不是检查结论，钩子会当成没检查而放行。
 */
const OUTSIDE_SANDBOX = new Set(['focused', 'files', 'full', 'verify', 'status'])

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command && OUTSIDE_SANDBOX.has(command)) {
    const refused = sandboxRefusal()
    if (refused !== undefined) return refused
  }
  try {
    return await dispatch(command, rest)
  } catch (error) {
    // 写不了记录目录（.git/testpace）：多半是在 agent 的沙箱里，说清楚，不只抛一句写入被拒
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EROFS') throw error
    console.error(`testpace 写不了 ${(error as NodeJS.ErrnoException).path ?? '记录目录'}（${code}）。在 agent 的沙箱里时，申请提权（在沙箱外）重新运行这条命令。`)
    return EXIT.usage
  }
}

async function dispatch(command: string | undefined, rest: string[]): Promise<number> {
  switch (command) {
    case 'focused':
      return focused(rest)
    case 'files':
      return files(rest)
    case 'full':
      return full()
    case 'status':
      return status()
    case 'hold':
      return hold(rest)
    case 'release':
      return release(rest)
    case 'report':
      return report(rest)
    case 'verify':
      return verify(rest)
    case 'install':
      return install()
    case 'gate':
      return gate()
    case 'run':
      return run(rest)
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
