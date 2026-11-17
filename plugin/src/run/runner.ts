// testpace run 各框架共用的跑法：解析选项和测试文件、起框架、跑完逐个文件核对、说明、退出码。
// 各框架只管怎么起（命令和参数，报告写到哪）和怎么读报告，各一个文件（node-test.ts、vitest.ts、playwright.ts）。

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { parseTargets, type Ran, type Target, tally } from './targets.ts'

export interface Framework {
  /** 用法里的一行，比如 testpace run node-test [--cwd 目录] [--node-arg 参数]... 文件[:行号[:列号]]... */
  usage: string
  /** 原样交给框架的参数用的选项名，比如 --node-arg。 */
  argOption: string
  /** 能按行跑。不能的，按行给的整个文件跑，runner 说一句。 */
  byLine: boolean
  /**
   * 怎么起：程序、参数，要另加的环境变量。cwd 是框架的工作目录，report 是给框架写报告的临时文件，args 是用户交给框架的参数。
   * 起不了（比如项目里没装这个框架）时返回说明。
   */
  command(targets: Target[], args: string[], cwd: string, report: string): Command | string
  /** 读报告：每个跑完的测试。报告没写出来（框架起来就出错）时返回空。 */
  read(report: string): Ran[]
}

export interface Command {
  program: string
  args: string[]
  env?: Record<string, string>
}

/** 项目在 cwd 装的包里的命令（package.json 的 bin）的路径；找不到这个包时返回说明。框架用项目自己装的那份，testpace 不带框架。 */
export function projectBin(cwd: string, pkg: string, bin: string): { path: string } | string {
  let manifest: string
  try {
    manifest = createRequire(join(cwd, 'package.json')).resolve(`${pkg}/package.json`)
  } catch {
    return `在 ${cwd} 找不到项目装的 ${pkg}：在装了它的目录下跑，或用 --cwd 指过去`
  }
  const bins = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> }).bin
  return { path: join(dirname(manifest), bins[bin]!) }
}

/** 退出码：0 通过；1 测试没过或有文件没跑到测试（框架自己的非零退出码照传）；2 用法问题、文件或目录不存在、起不了框架；130 被中断。 */
export async function runFramework(framework: Framework, argv: string[]): Promise<number> {
  const options = parseOptions(argv, framework.argOption)
  if (typeof options === 'string') {
    console.error(`${options}\n用法：${framework.usage}`)
    return 2
  }
  const cwd = resolve(options.cwd)
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`[testpace] --cwd 给的目录不存在：${options.cwd}`)
    return 2
  }
  const { targets, missing } = parseTargets(options.files, process.cwd())
  if (missing.length > 0) {
    console.error(`[testpace] 找不到测试文件：${missing.join('、')}`)
    return 2
  }

  const located = targets.flatMap(target => target.located.map(({ text }) => text))
  if (!framework.byLine && located.length > 0) console.log(`[testpace] 这个框架不能按行跑，这些整个文件跑：${located.join('、')}`)

  const dir = mkdtempSync(join(tmpdir(), 'testpace-run-'))
  try {
    const report = join(dir, 'report')
    const command = framework.command(targets, options.args, cwd, report)
    if (typeof command === 'string') {
      console.error(`[testpace] ${command}`)
      return 2
    }
    const run = await spawnFramework(command, cwd)
    if (run.kind === 'error') {
      console.error(`[testpace] 没能起 ${command.program}：${run.message}`)
      return 2
    }
    if (run.kind === 'interrupted') return 130

    // 框架没过也照样核对：没跑到测试的文件一并说出来
    const { empty, allSkipped, others } = tally(targets, framework.read(report))
    const names = (list: Target[]) => list.map(target => target.file).join('、')
    if (others.length > 0) console.log(`[testpace] 框架还跑了这些没给的文件（名字片段匹配到的，或给的测试依赖的准备项目）：${others.map(file => relative(process.cwd(), file)).join('、')}`)
    if (allSkipped.length > 0) console.log(`[testpace] 这些文件的测试这次全被跳过，什么都没验证：${names(allSkipped)}`)
    if (empty.length > 0) console.error(`[testpace] 这些文件一个测试都没跑到（没加载起来、里面没有测试、给的行上没有测试，或被框架的配置排除了）：${names(empty)}`)
    if (run.code !== 0) return run.code
    return empty.length > 0 ? 1 : 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

interface Options {
  cwd: string
  args: string[]
  files: string[]
}

/** 选项在前，文件在后；`--` 之后都当文件。出错时返回说明。 */
function parseOptions(argv: string[], argOption: string): Options | string {
  const options: Options = { cwd: '.', args: [], files: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--') {
      options.files.push(...argv.slice(i + 1))
      break
    }
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    if (name === '--cwd' || name === argOption) {
      const value = inline ?? argv[++i]
      if (value === undefined || value === '') return `${name} 后面要跟一个值`
      if (name === '--cwd') options.cwd = value
      else options.args.push(value)
    } else if (arg.startsWith('-')) {
      return `不认识的选项 "${arg}"`
    } else {
      options.files.push(arg)
    }
  }
  if (options.files.length === 0) return '没有给测试文件'
  return options
}

type FrameworkRun = { kind: 'done'; code: number } | { kind: 'error'; message: string } | { kind: 'interrupted' }

/**
 * 起框架，输出直通。testpace 被中断时给框架发 SIGINT（不管 testpace 收到的是哪个信号）：
 * 框架都把它当成 Ctrl-C，停下并收拾自己起的进程；Vitest 5.0 及以前收到 SIGTERM 时会把跑测试的子进程丢下不管。等它退出再返回。
 */
function spawnFramework({ program, args, env }: Command, cwd: string): Promise<FrameworkRun> {
  const child = spawn(program, args, { cwd, stdio: 'inherit', ...(env ? { env: { ...process.env, ...env } } : {}) })
  let interrupted = false
  const forward = (): void => {
    interrupted = true
    child.kill('SIGINT')
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  for (const signal of signals) process.on(signal, forward)
  return new Promise(resolvePromise => {
    let done = false
    const finish = (run: FrameworkRun): void => {
      if (done) return // 启动失败时 error 和 close 都会来
      done = true
      for (const signal of signals) process.off(signal, forward)
      resolvePromise(interrupted ? { kind: 'interrupted' } : run)
    }
    child.on('error', error => finish({ kind: 'error', message: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'PATH 上找不到它' : error.message }))
    // 被信号终止（不是 testpace 转过去的）算没过
    child.on('close', code => finish({ kind: 'done', code: code ?? 1 }))
  })
}
