// 执行项目的命令：从仓库根目录用 sh 跑，输出全部写进日志文件，计时。
// testpace 自己被中断时，把整个子进程组一起停掉；不肯退出的，过一会儿强杀（见 process-group.ts）。

import { closeSync, openSync } from 'node:fs'
import { delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMAND_KILL_AFTER_MS, spawnGroup } from './process-group.ts'

/**
 * 整组起附加检查时，在这个环境变量里给这一轮的运行 id（登记的 RunMarker.id），只给附加检查。
 * testpace hold 见到它和这个工作区的登记一样就不另占：附加检查在测试之前跑，那时工作区里还没有测试在跑，工作区已经是这一轮的。
 * 别的项目命令（fast、files、full 和整组跑测试的那一段）跑的就是测试，在里面借用工作区要被挡，不给。
 */
export const RUN_ENV = 'TESTPACE_RUN'

/**
 * 跑项目命令的环境：testpace 自己的命令目录放在 PATH 最前面。项目命令和脚本里调的 testpace（比如 files 里的
 * testpace run）就是正在跑的这一版，Claude Code、Codex、合并门的钩子里都一样，不靠 PATH 上碰巧有哪一版。
 * 从外面继承来的 RUN_ENV 去掉（比如附加检查里又调了 testpace files）：它只认起它的那一轮，附加检查由 execute 的 env 按这一轮重新给。
 */
const { [RUN_ENV]: _inheritedRun, ...inherited } = process.env
export const PROJECT_ENV: NodeJS.ProcessEnv = {
  ...inherited,
  PATH: [fileURLToPath(new URL('../bin', import.meta.url)), process.env.PATH].filter(Boolean).join(delimiter),
}

export interface Execution {
  /** 正常退出时的退出码；被信号终止或没能启动时为 null。 */
  exitCode: number | null
  /** 子进程被信号终止时的信号名（不是 testpace 自己被中断）。 */
  signal: NodeJS.Signals | null
  /** testpace 自己被中断。 */
  interrupted: boolean
  durationMs: number
}

/**
 * onStart 在子进程起来、中断处理挂好之后调用，拿到子进程组的 id：登记在跑的是哪个进程组。
 * env 是另加给项目命令的环境变量（比如交每个测试结果的位置，见 results.ts）。
 */
export async function execute(
  command: string,
  args: string[],
  cwd: string,
  logPath: string,
  onStart?: (group: number) => void,
  env: Record<string, string> = {},
): Promise<Execution> {
  const started = Date.now()
  const log = openSync(logPath, 'a')
  // 额外参数（测试文件路径）用 "$@" 传，不拼进命令字符串，避免路径里的特殊字符被 shell 解释。
  const script = args.length > 0 ? `${command} "$@"` : command
  try {
    const { exitCode, signal, interrupted } = await spawnGroup('/bin/sh', ['-c', script, 'sh', ...args], {
      cwd,
      env: { ...PROJECT_ENV, ...env },
      stdio: ['ignore', log, log],
      stopSignal: 'SIGTERM',
      killAfterMs: COMMAND_KILL_AFTER_MS,
      onStart,
    })
    return { exitCode, signal, interrupted, durationMs: Date.now() - started }
  } finally {
    closeSync(log)
  }
}
