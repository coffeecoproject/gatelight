// 执行项目的命令：从仓库根目录用 sh 跑，输出全部写进日志文件，计时。
// testpace 自己被中断时，把整个子进程组一起停掉；不肯退出的，过一会儿强杀。

import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'

export interface Execution {
  /** 正常退出时的退出码；被信号终止或没能启动时为 null。 */
  exitCode: number | null
  /** 子进程被信号终止时的信号名（不是 testpace 自己被中断）。 */
  signal: NodeJS.Signals | null
  /** testpace 自己被中断。 */
  interrupted: boolean
  durationMs: number
}

/** 中断后等子进程组自己退出的时间，过了就强杀。 */
const KILL_AFTER_MS = 10_000

/** onStart 在子进程起来、中断处理挂好之后调用，拿到子进程组的 id：登记在跑的是哪个进程组。 */
export function execute(command: string, args: string[], cwd: string, logPath: string, onStart?: (group: number) => void): Promise<Execution> {
  const started = Date.now()
  const log = openSync(logPath, 'a')
  // 额外参数（测试文件路径）用 "$@" 传，不拼进命令字符串，避免路径里的特殊字符被 shell 解释。
  const script = args.length > 0 ? `${command} "$@"` : command
  const child = spawn('/bin/sh', ['-c', script, 'sh', ...args], {
    cwd,
    stdio: ['ignore', log, log],
    detached: true,
  })

  let interrupted = false
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      // 已经退出
    }
  }
  const stop = (): void => {
    interrupted = true
    signalGroup('SIGTERM')
    setTimeout(() => signalGroup('SIGKILL'), KILL_AFTER_MS).unref()
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  for (const signal of signals) process.on(signal, stop)
  if (child.pid !== undefined) onStart?.(child.pid)

  return new Promise(resolve => {
    let done = false
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (done) return // 启动失败时 error 和 close 都会来
      done = true
      for (const s of signals) process.off(s, stop)
      closeSync(log)
      resolve({ exitCode, signal, interrupted, durationMs: Date.now() - started })
    }
    child.on('error', () => finish(null, null))
    child.on('close', (code, signal) => finish(code, signal))
  })
}
