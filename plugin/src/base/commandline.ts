// 三条命令（testpace、modwall、testcraft）的入口共用的一层：在 agent 的沙箱里跑不了的子命令事先拒绝，写入被拒时说清楚。
// 各命令只说哪些子命令在沙箱里跑不了、要做什么（outside）；怎么认沙箱、怎么说、退出码是什么都在这里，三个入口都经过它。

import { AGENTS, currentAgent } from './agent.ts'
import { EXIT } from './exit.ts'

/** 跑这条命令的 agent：会话号、在不在沙箱里。用户在终端里跑的没有。 */
export const AGENT = currentAgent()

export interface CommandLine {
  /** 命令名：提示里用。 */
  name: string
  /**
   * 这次调用在 agent 的沙箱里跑不了时，说它要做什么（接在"它要"后面）；跑得了的返回 undefined，没有这样的子命令的不填。
   * 算跑不了的：要写项目目录以外的地方（.git/testpace/ 的记录、LayerMap 存在项目外面的地图），或者要跑项目的命令（常要端口、网络）。
   * 沙箱里这些会被拒，得出的是假结论（测试假失败、检查假的没通过），所以不跑，不等它失败。
   * 仓库在沙箱放行的位置（比如 /tmp）时记录目录也写得进去，所以不能只靠写不写得进去判断。
   * git 钩子调用的子命令不算在里面：在这里拒绝不是检查结论，钩子会当成没检查而放行。
   */
  outside?(argv: string[]): string | undefined
  run(argv: string[]): number | Promise<number>
}

/** 跑一条命令，返回退出码。 */
export async function runCommandLine(line: CommandLine, argv: string[]): Promise<number> {
  const needs = AGENT?.sandboxed ? line.outside?.(argv) : undefined
  if (AGENT && needs) {
    console.error(`${line.name} 要在 ${AGENTS[AGENT.kind].name} 的沙箱外跑：它要${needs}，在沙箱里会被拒、结果不准。申请提权（在沙箱外）重新运行这条命令。`)
    return EXIT.usage
  }
  try {
    return await line.run(argv)
  } catch (error) {
    // 写入被拒（记录目录 .git/testpace、项目里的文件）：多半是在 agent 的沙箱里，说清楚，不只抛一句写入被拒
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EROFS') throw error
    console.error(`${line.name} 写不了 ${(error as NodeJS.ErrnoException).path ?? '记录目录'}（${code}）。在 agent 的沙箱里时，申请提权（在沙箱外）重新运行这条命令。`)
    return EXIT.usage
  }
}
