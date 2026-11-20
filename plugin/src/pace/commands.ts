// "跑测试"的命令：focused、files、report、verify、run。命令行入口（src/cli.ts）分发到这里。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { context } from '../base/commands.ts'
import { CONTRACT_FILE } from '../base/contract.ts'
import { EXIT } from '../base/exit.ts'
import { duration, short } from '../base/format.ts'
import { gateProblem } from '../base/gate.ts'
import { currentBranch, defaultBranch, forkPoint, landings, workTreeId } from '../base/git.ts'
import { busyText, failureText, ignoredBy } from '../base/repo.ts'
import { commandExists, COMMAND_KEYS, loadConfig } from './config.ts'
import { askLayermap, BRANCH_CAP, fullReasons, INDIRECT_RANK, LAYERMAP_HINT, NEARBY_RANK, outsideNote } from './focused.ts'
import { paceRuns, runRecorded } from './record.ts'
import { renderReport } from './report.ts'
import { PROVE_RUNS, provenFixed, type TestResult } from './results.ts'
import { nodeTest } from './run/node-test.ts'
import { playwright } from './run/playwright.ts'
import { type Framework, runFramework } from './run/runner.ts'
import { vitest } from './run/vitest.ts'
import { flakyTests, LOCATED, testKey } from './testlist.ts'
import { findTests, testMatcher } from './tests.ts'
import { verifyFiles } from './verify.ts'

export async function focused(args: string[], usage: string): Promise<number> {
  const at = args.indexOf('--base')
  if (at === -1 ? args.length > 0 : args.length !== 2 || at !== 0) {
    console.error(usage)
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

  // 对比和默认分支的分叉点：分支上已经提交的改动也算这次的改动。算不出分叉点时只比没提交的改动。
  const branch = defaultBranch(ctx.root)
  // 不在默认分支上（包括分离的 HEAD）：要落地还得合并，合并前的整组兜底，选测靠不住也不用现在跑整组
  const onBranch = branch !== undefined && currentBranch(ctx.root) !== branch
  const base = at !== -1 ? args[at + 1]! : (forkPoint(ctx.root).commit ?? 'HEAD')
  const isIgnored = ignoredBy(config.ignore)
  // 在分支上只跑这次改到的测试，加上最相关的几个；其余留给合并时的整组
  const selection = askLayermap(ctx.root, base, isIgnored, new Set(findTests(ctx.root, config.tests)), testMatcher(config.tests), onBranch ? NEARBY_RANK : INDIRECT_RANK, onBranch ? BRANCH_CAP : Infinity)
  const reasons = fullReasons(selection)

  let code: number = EXIT.ok
  if (selection.kind === 'selected' && selection.changed.length === 0) {
    lines.push(`相对 ${short(base)} 没有改动，不用跑测试。`)
  } else if (selection.kind === 'selected' && selection.nothingToTest) {
    lines.push(selection.changed.every(isIgnored) ? '改动只涉及 ignore 里的路径，不用跑测试。' : '改动里没有整组要跑的东西（只有 ignore 里的路径、tests 规则外或删掉的测试），不用跑测试。')
  } else if (selection.kind === 'selected' && selection.tests.length > 0) {
    const shown = selection.tests.slice(0, 10).map(test => `  ${test}`)
    if (selection.tests.length > 10) shown.push(`  等 ${selection.tests.length} 个`)
    const indirect = selection.indirect ? (onBranch ? `；另有 ${selection.indirect} 个相关的留给合并时的整组` : `；另有 ${selection.indirect} 个只是间接导入改动，没选`) : ''
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

export async function files(argv: string[], usage: string): Promise<number> {
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
    console.error(usage)
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
  else if (times >= PROVE_RUNS && flakyTests(ctx.store).length > 0) {
    notes.push('连跑的过程中代码或工作区变了（比如测试生成了没被 .gitignore 忽略的文件），这次不算证明时好时坏的测试修好了，名单没动。')
  }
  const how = times > 1 ? `连跑 ${times} 次都通过 · 共用时 ${duration(took)}` : `通过 · 用时 ${duration(took)}`
  console.log([`${what}${how}`, ...notes].join('\n'))
  return EXIT.ok
}

export function report(args: string[]): number {
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
      runs: paceRuns(ctx.store),
      defaultBranch: branch,
      landings: branch ? landings(ctx.root, branch, now - days * 24 * 3600 * 1000) : [],
    }),
  )
  return EXIT.ok
}

/** 由程序核对这个项目的接入守不守约定（见 verify.ts）。整组太长，不在这里跑。 */
export async function verify(args: string[]): Promise<number> {
  const ctx = context()
  if (!ctx) return EXIT.usage
  const { config, problems } = loadConfig(ctx.root)
  if (!config) {
    console.error(`${CONTRACT_FILE} 读不出来，先修好：${problems.join('；')}`)
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
  say(problems.length > 0 ? `没通过　${CONTRACT_FILE} 写得对：${problems.join('；')}` : `通过　${CONTRACT_FILE} 写得对`)
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
    say(`接入核对：${failed} 项没通过；${CONTRACT_FILE} 里没有 files，其余没法查。`)
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
  say(`没查　整组（${config.full ?? `${CONTRACT_FILE} 里没有 full`}，再加上 tests 找到的全部测试）：太长不在这里跑；能不能通过用 testpace full 看。`)

  const notChecked = result.skipped + 1
  say(failed > 0 ? `接入核对：${failed} 项没通过，${notChecked} 项没查。` : `接入核对：查了的都通过，${notChecked} 项没查。`)
  return failed > 0 ? EXIT.fail : EXIT.ok
}

/** testpace run 认的框架。 */
export const FRAMEWORKS = new Map<string, Framework>([['node-test', nodeTest], ['vitest', vitest], ['playwright', playwright]])

/** testpace run <框架>：按框架跑测试文件、守 files 的约定。 */
export function run(rest: string[]): Promise<number> | number {
  const [name, ...args] = rest
  const framework = name === undefined ? undefined : FRAMEWORKS.get(name)
  if (framework) return runFramework(framework, args)
  console.error(`${name === undefined ? '没有给框架' : `不认识的框架 "${name}"`}\n用法：\n${[...FRAMEWORKS.values()].map(f => `  ${f.usage}`).join('\n')}`)
  return EXIT.usage
}
