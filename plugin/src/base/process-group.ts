// 在自己的进程组里起子进程，testpace 被中断时停掉整个组：它起的进程一起收到信号，不靠它转告；不肯退出的，过一会儿强杀整个组。
// 跑项目命令（execute.ts）和 testpace run 起框架（run/runner.ts）共用。

import { type StdioOptions, spawn } from 'node:child_process'

/** 跑项目命令时，中断后等子进程组自己退出的时间，过了就强杀。 */
export const COMMAND_KILL_AFTER_MS = 10_000
/**
 * testpace run 起框架时的。要比跑项目命令的短：testpace run 写在项目命令里，是那个进程组里的一个进程，
 * 框架却在自己的组里，强杀项目命令的组碰不到它。testpace run 先强杀框架，自己才不会被强杀时把框架留下。
 */
export const FRAMEWORK_KILL_AFTER_MS = COMMAND_KILL_AFTER_MS - 2_000

export interface GroupOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: StdioOptions
  /** testpace 被中断时（不管收到的是哪个信号）给整个组发的信号。 */
  stopSignal: NodeJS.Signals
  killAfterMs: number
  /** 子进程起来、中断处理挂好之后调用，拿到进程组的 id。 */
  onStart?: (group: number) => void
}

export interface GroupRun {
  /** 正常退出时的退出码；被信号终止或没能启动时为 null。 */
  exitCode: number | null
  /** 子进程被信号终止时的信号名。 */
  signal: NodeJS.Signals | null
  /** testpace 自己被中断。 */
  interrupted: boolean
  /** 没能启动。 */
  error?: NodeJS.ErrnoException
}

export function spawnGroup(program: string, args: string[], options: GroupOptions): Promise<GroupRun> {
  const child = spawn(program, args, { cwd: options.cwd, env: options.env, stdio: options.stdio, detached: true })
  let interrupted = false
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      // 已经退出
    }
  }
  // 每次收到都转给整个组（比如再按一次 Ctrl-C，框架会当成要它马上退）；强杀的计时只从第一次算
  const stop = (): void => {
    if (!interrupted) setTimeout(() => signalGroup('SIGKILL'), options.killAfterMs).unref()
    interrupted = true
    signalGroup(options.stopSignal)
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  for (const signal of signals) process.on(signal, stop)
  if (child.pid !== undefined) options.onStart?.(child.pid)

  return new Promise(resolve => {
    let done = false
    const finish = (run: Omit<GroupRun, 'interrupted'>): void => {
      if (done) return // 启动失败时 error 和 close 都会来
      done = true
      for (const signal of signals) process.off(signal, stop)
      resolve({ ...run, interrupted })
    }
    child.on('error', error => finish({ exitCode: null, signal: null, error }))
    child.on('close', (exitCode, signal) => finish({ exitCode, signal }))
  })
}
