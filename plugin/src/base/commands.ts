// 底座的命令：借用工作区（hold、release）、这台机器配一次（install）、git 钩子调的 gate。
// 命令行入口（src/cli.ts）分发到这里；各模块的命令在各自的目录里。

import { readFileSync } from 'node:fs'
import { AGENTS, currentAgent } from './agent.ts'
import { entryPath, installEntry } from './entry.ts'
import { EXIT } from './exit.ts'
import { checkRefUpdates, GATE_REJECT, gateProblem, installGate } from './gate.ts'
import { borrow, giveBack, openRepo, type Repo, runningText } from './repo.ts'
import { processAlive } from './store.ts'

/** 跑这条命令的 agent：会话号、在不在沙箱里。用户在终端里跑的没有。 */
export const AGENT = currentAgent()

/**
 * 在 agent 的沙箱里不跑：测试会因为端口、网络被拒跑出假失败，记进去后 report 会当成测试不稳定；
 * status 要记下这个会话看过结果，写不进 .git 时停止门还会再拦。
 * 仓库在沙箱放行的位置（比如 /tmp）时记录目录也写得进去，所以不能只靠写不写得进去判断。
 */
export function sandboxRefusal(): number | undefined {
  if (!AGENT?.sandboxed) return undefined
  console.error(`testpace 要在 ${AGENTS[AGENT.kind].name} 的沙箱外跑：它要写 .git/testpace/ 的记录，测试还常要开端口和网络，在沙箱里会被拒、结果不准。申请提权（在沙箱外）重新运行这条命令。`)
  return EXIT.usage
}

/** 命令所在的仓库；不在 git 仓库里时说一句。 */
export function context(): Repo | undefined {
  const repo = openRepo(process.cwd())
  if (!repo) console.error('testpace 要在 git 仓库里运行。')
  return repo
}

/** testpace hold：别的工具借用这个工作区（见 repo.ts 的 borrow）。占上了输出借用的 id，放开时用。 */
export function hold(args: string[], usage: string): number {
  const [pid, ...what] = args
  const by = what.join(' ').trim()
  if (!pid || !/^[1-9]\d*$/.test(pid) || !by) {
    console.error(usage)
    return EXIT.usage
  }
  // 进程不在了的登记马上作废，调用方会以为占上了
  if (!processAlive(Number(pid))) {
    console.error(`进程 ${pid} 不在，借用要登记正在用工作区的那个进程。`)
    return EXIT.usage
  }
  const ctx = context()
  if (!ctx) return EXIT.usage
  const held = borrow(ctx, Number(pid), by)
  if ('busy' in held) {
    console.log(`${runningText(held.busy)}。`)
    return EXIT.busy
  }
  if (held.id) console.log(held.id)
  return EXIT.ok
}

/** testpace release：放开 hold 占的工作区。 */
export function release(args: string[], usage: string): number {
  const [id] = args
  if (!id || args.length !== 1) {
    console.error(usage)
    return EXIT.usage
  }
  const ctx = context()
  if (!ctx) return EXIT.usage
  giveBack(ctx, id)
  return EXIT.ok
}

export function install(): number {
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
export function gate(): number {
  try {
    const reason = checkRefUpdates(process.cwd(), readFileSync(0, 'utf8'))
    if (!reason) return EXIT.ok
    console.error(reason)
  } catch (error) {
    console.error(`testpace 合并门：没能确认要落地的代码测过（${(error as Error).message.split('\n')[0]}），这次不更新。`)
  }
  return GATE_REJECT
}
