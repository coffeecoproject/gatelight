// 底座的命令：借用工作区（hold、release）、这台机器配一次（install）、git 钩子调的 gate。
// 命令行入口（src/cli.ts）分发到这里；各模块的命令在各自的目录里。

import { readFileSync } from 'node:fs'
import { ENTRY_COMMANDS, entryDir, entryPath, installEntries } from './entry.ts'
import { EXIT } from './exit.ts'
import { checkRefUpdates, GATE_REJECT, GATE_UNCHECKED, gateProblem, installGate } from './gate.ts'
import { borrow, giveBack, openRepo, type Repo, runningText } from './repo.ts'
import { processAlive } from './store.ts'

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
  const { refused } = installEntries()
  const placed = ENTRY_COMMANDS.filter(command => !refused.includes(command))
  if (placed.length) console.log(`固定命令入口已放好：${entryDir()} 下的 ${placed.join('、')}，运行时转给这台机器上装着的最高版本的插件里同名的命令。`)
  if (refused.length) {
    console.error(`固定命令入口没放上：${refused.map(entryPath).join('、')} 已经有别的文件，没有覆盖。确认不要它后删掉，再跑 testpace install。`)
    return EXIT.usage
  }
  return EXIT.ok
}

/**
 * git 的 reference-transaction 钩子调用：标准输入是要更新的引用。放行退出码 0；拒绝退出码 GATE_REJECT，
 * git 就取消这次更新；这次没有检查、要当场说一句的退出码 GATE_UNCHECKED，钩子放行并转达。
 * 检查时出错也拒绝：已经在检查了，确认不了要落地的代码测过就不放。
 */
export function gate(): number {
  try {
    const answer = checkRefUpdates(process.cwd(), readFileSync(0, 'utf8'))
    if (!answer) return EXIT.ok
    if ('unchecked' in answer) {
      console.error(answer.unchecked)
      return GATE_UNCHECKED
    }
    console.error(answer.reject)
  } catch (error) {
    console.error(`testpace 合并门：没能确认要落地的代码测过（${(error as Error).message.split('\n')[0]}），这次不更新。`)
  }
  return GATE_REJECT
}
