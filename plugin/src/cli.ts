// testpace 命令行入口：focused、files、full、status、hold、release、report、verify、install、run，以及 git 钩子调用的 gate。
// 这里只做装配和分发：底座的命令在 base/commands.ts、base/full.ts，"跑测试"的命令在 pace/commands.ts；
// status 把底座和各模块的情况合在一起说，也放在这里。这个文件的路径不能变：bin/testpace 和固定入口都按它找。

import './modules.ts'
import { AGENT, runCommandLine } from './base/commandline.ts'
import { context, gate, hold, install, release } from './base/commands.ts'
import { CONTRACT_FILE, joined } from './base/contract.ts'
import { ENTRY_COMMANDS, type EntryState, entryDir, entryState } from './base/entry.ts'
import { EXIT } from './base/exit.ts'
import { duration, short, when } from './base/format.ts'
import { full } from './base/full.ts'
import { danglingNote, gateProblem } from './base/gate.ts'
import { workTreeId } from './base/git.ts'
import { coverageOf, defaultTips, describeCoverage, runningText, started } from './base/repo.ts'
import { isHold } from './base/store.ts'
import { files, focused, report, run, verify } from './pace/commands.ts'
import { commandExists, COMMAND_KEYS, loadConfig } from './pace/config.ts'
import { LAYERMAP_HINT } from './pace/focused.ts'
import { flakyStatus } from './pace/results.ts'
import { nodeTest } from './pace/run/node-test.ts'
import { playwright } from './pace/run/playwright.ts'
import { vitest } from './pace/run/vitest.ts'
import { flakyTests } from './pace/testlist.ts'
import { findTests } from './pace/tests.ts'

const USAGE = `用法：
  testpace focused [--base REF]  改完先跑：fast，再跑 layermap 选出的相关测试。默认对比和默认分支的分叉点；在默认分支上选测靠不住时建议跑整组
  testpace files [--repeat N] PATH[:行号]...
                                 只跑给定的测试文件（testpace.json 的 files）；文件:行号 只跑那一行的测试，比如重跑失败的测试。
                                 --repeat N 连跑 N 次、没过就停：造出时好时坏的测试的失败，或修好后连跑 3 次证明
  testpace full                  跑整组：接入了的检查（modwall check、testcraft checklist）、full（测试以外的检查），再把 tests 规则找到的全部测试交给 files，
                                 一段没过就停，按当前工作区完整内容记录结果。要跑几分钟，能放到后台的就放后台
  testpace status                当前代码有没有整组通过记录、有没有正在跑的整组、最近一次结果、配置检查
  testpace hold PID 说明         借用这个工作区（比如要复制一份工作区的工具）：占着时别的 testpace 命令不跑，说明是谁占着。
                                 PID 是借用的那个进程，它不在了占用就作废。占上时输出这次的 id，退出码 0；有在跑的、占着的，说明是谁，退出码 3。
                                 整组里要建副本的检查带着这一轮的 TESTPACE_RUN，工作区已经是这一轮的，不另占、什么也不输出，退出码 0
  testpace release ID            放开 hold 占的工作区
  testpace report [--days N]     计时诊断，默认最近 28 天
  testpace verify [测试文件...]  核对接入守不守约定：三条命令找得到、合并门在把关、files 对不存在的文件报失败、认 文件:行号；每种测试各给一个文件
  testpace install               这台机器配一次：在全局 git 配置里配上合并门（agent 移动默认分支时，要求落地的代码有整组通过记录），
                                 并在 ~/.local/bin 放上 testpace、modwall、testcraft 的固定命令入口（Codex 的命令和合并门的钩子靠它们找到这几条命令）
  ${nodeTest.usage}
  ${vitest.usage}
  ${playwright.usage}
                                 写在 testpace.json 的 files 里（或项目的 files 脚本里）：用项目的测试框架跑测试文件，守 files 的约定：
                                 文件不存在、给的文件或行上一个测试都没跑到时失败，选中的测试全被跳过时说一句。
                                 node:test 不能按行跑，按行给的整个文件跑，跑完照样核对那一行`

function status(): number {
  const ctx = context()
  if (!ctx) return EXIT.usage
  const lines: string[] = []
  const { config, problems } = loadConfig(ctx.root)

  if (config) {
    const tree = workTreeId(ctx.root)
    const runs = ctx.store.readRuns()
    lines.push(`当前代码（${short(tree)}）：${describeCoverage(coverageOf(ctx, config.ignore, tree, runs))}`)

    for (const marker of ctx.store.running().filter(m => m.worktree === ctx.root)) {
      if (isHold(marker)) {
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

  lines.push(...flakyStatus(flakyTests(ctx.store)))
  lines.push(`配置（${CONTRACT_FILE}）：${problems.length ? problems.join('；') : '正常'}`)
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
    if (config.deferredIgnore?.length) lines.push(`  ignore 里新加的 ${config.deferredIgnore.join(', ')} 合并后才生效，这次改动仍按没有它判`)
  }
  // 合并门看提交里的 testpace.json，工作区里这份写坏了它也照常把关
  if (joined(ctx.root)) lines.push(`合并门：${gateProblem(ctx.root) ?? '已装上，agent 移动默认分支时检查'}`)
  const dangling = joined(ctx.root) ? danglingNote(ctx.root) : undefined
  if (dangling) lines.push(`  ${dangling}`)
  lines.push(`固定命令入口（${entryDir()}）：${entryLine()}`)
  // 版本太旧不在这里查：focused 读输出时会说
  lines.push(`layermap：${commandExists(ctx.root, 'layermap') ? '找到' : `找不到，focused 没法按改动选测试，每次都会建议跑整组。${LAYERMAP_HINT}`}`)

  console.log(lines.join('\n'))
  // 停止门据此判断这个会话有没有看过整组的结果；不在 agent 里（没有会话号）不记
  const sessionId = AGENT?.session
  if (sessionId) ctx.store.markRead(sessionId, ctx.root, Date.now(), () => defaultTips(ctx))
  return config ? EXIT.ok : EXIT.usage
}

const ENTRY_STATES = {
  installed: '已放好',
  outdated: '是旧版本放的，跑 testpace install 更新',
  missing: '没放：插件的 bin 目录不在 PATH 上的地方（Codex 的命令、合并门的钩子）找不到。用户同意后跑 testpace install 放上',
  foreign: '那里是别的文件，没有放',
} as const

/** 各条命令的固定入口放得怎样，状态一样的并在一起说：testpace 已放好；modwall、testcraft 没放：…… */
function entryLine(): string {
  const states = Object.keys(ENTRY_STATES) as EntryState[]
  return states
    .map(state => ({ state, commands: ENTRY_COMMANDS.filter(command => entryState(command) === state) }))
    .filter(({ commands }) => commands.length > 0)
    .map(({ state, commands }) => `${commands.join('、')} ${ENTRY_STATES[state]}`)
    .join('；')
}

/**
 * 在 agent 的沙箱里不跑的子命令：跑项目命令的，和记下会话看过结果的 status（写不进 .git 时停止门还会再拦）。
 * 测试在沙箱里会因为端口、网络被拒跑出假失败，记进去后 report 会当成测试不稳定。
 * gate 不在里面：它由 git 钩子调用，在这里拒绝不是检查结论，钩子会当成没检查而放行。
 */
const OUTSIDE_SANDBOX = new Set(['focused', 'files', 'full', 'verify', 'status'])

/** 整组：底座编排，起它的 agent 会话记进记录（停止门只拦起它的会话和等着用它结果的会话）。 */
async function runFull(): Promise<number> {
  const ctx = context()
  return ctx ? full(ctx, AGENT?.session) : EXIT.usage
}

async function dispatch([command, ...rest]: string[]): Promise<number> {
  switch (command) {
    case 'focused':
      return focused(rest, USAGE)
    case 'files':
      return files(rest, USAGE)
    case 'full':
      return runFull()
    case 'status':
      return status()
    case 'hold':
      return hold(rest, USAGE)
    case 'release':
      return release(rest, USAGE)
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

process.exitCode = await runCommandLine(
  {
    name: 'testpace',
    outside: ([command]) => (command && OUTSIDE_SANDBOX.has(command) ? '写 .git/testpace/ 的记录，测试还常要开端口和网络' : undefined),
    run: dispatch,
  },
  process.argv.slice(2),
)
