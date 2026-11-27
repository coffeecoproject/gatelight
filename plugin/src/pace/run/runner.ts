// testpace run 各框架共用的跑法：解析选项和测试文件、起框架、跑完逐个文件核对、说明、退出码。
// 各框架只管怎么起（命令和参数，报告写到哪），各一个文件（node-test.ts、vitest.ts、playwright.ts）；报告都写成 targets.ts 的 Ran。

import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { RUN_ENV } from '../../base/execute.ts'
import { FRAMEWORK_KILL_AFTER_MS, type GroupRun, spawnGroup } from '../../base/process-group.ts'
import { RESULTS_ENV } from '../results.ts'
import { parseTargets, readRanLines, type Target, tally } from './targets.ts'

export interface Framework {
  /** 用法里的一行，比如 testpace run node-test [--cwd 目录] [--node-arg 参数]... 文件[:行号[:列号]]... */
  usage: string
  /** 原样交给框架的参数用的选项名，比如 --node-arg。 */
  argOption: string
  /** 能按行跑。不能的，按行给的整个文件跑，runner 说一句。 */
  byLine: boolean
  /**
   * 怎么起：程序、参数，要另加的环境变量。cwd 是框架的工作目录，args 是用户交给框架的参数。
   * report 是给框架写报告的临时文件：框架选好测试、跑完，把每个跑过或被跳过的测试写一行 Ran（见 targets.ts）；
   * 选测试之前就停了（参数不认、配置写错）不写。
   * 起不了（比如项目里没装这个框架）时返回说明。
   */
  command(targets: Target[], args: string[], cwd: string, report: string): Command | string
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
    if (run.interrupted) return 130
    if (run.error) {
      console.error(`[testpace] 没能起 ${command.program}：${run.error.code === 'ENOENT' ? 'PATH 上找不到它' : run.error.message}`)
      return 2
    }
    // 被信号终止（不是 testpace 转过去的）算没过
    const code = run.exitCode ?? 1

    const lines = readRanLines(report)
    // 没写报告：框架在选测试之前就停了，原因它已经说过，没有可核对的。退出码是 0 却没报告，什么都没验证到，不算通过
    if (lines === undefined) {
      if (code !== 0) return code
      console.error('[testpace] 框架退出了，却没写出跑了哪些测试，什么都没验证到')
      return 1
    }
    // 由 testpace 的 files、focused、full 起的：每个测试的结果交给它（没跑到的也交，它点名），认时好时坏和几轮没过（见 results.ts）
    const results = process.env[RESULTS_ENV]
    if (results) appendFileSync(results, lines.map(test => `${JSON.stringify(test)}\n`).join(''))
    const ran = lines.filter(test => test.status !== 'notrun')
    // 同一个文件里同名的（Playwright repeatEach 的拷贝）有一份跑了就不点名：和 testpace 那层按名字认一个测试一致（results.ts 的 distinct）
    const reachedNames = new Set(ran.map(test => `${test.file}\0${test.name}`))
    const unreached = lines.filter(test => test.status === 'notrun' && !reachedNames.has(`${test.file}\0${test.name}`))
    if (unreached.length > 0) {
      const shown = unreached.slice(0, 10).map(test => `${relative(process.cwd(), test.file)}${test.line === undefined ? '' : `:${test.line}`}`)
      console.error(`[testpace] 这些选中的测试没跑到（前面有测试没过，框架没接着跑，比如 serial 模式、max-failures）：${shown.join('、')}${unreached.length > 10 ? ` 等 ${unreached.length} 个` : ''}。重跑没过的测试时把它们一起带上`)
    }
    // 框架没过也照样核对：没跑到测试的文件和行一并说出来
    const { notRun, allSkipped, others, failed } = tally(targets, ran)
    if (others.length > 0) console.log(`[testpace] 框架还跑了这些没给的文件（名字片段匹配到的，或给的测试依赖的准备项目）：${others.map(file => relative(process.cwd(), file)).join('、')}`)
    if (allSkipped.length > 0) console.log(`[testpace] 这些给的文件或行上的测试这次全被跳过，什么都没验证：${allSkipped.join('、')}`)
    if (notRun.length > 0) {
      console.error(`[testpace] 这些给的文件或行上一个测试都没跑到（没加载起来、里面没有测试、给的行上没有测试，或被框架的配置排除了）：${notRun.join('、')}`)
      if (failed) console.error('[testpace] 这次已有测试没过，框架可能没跑到它们就停下了（比如 bail、max-failures、依赖的准备项目没过）：先修没过的测试，再看这几个')
    }
    if (code !== 0) return code
    return notRun.length > 0 ? 1 : 0
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

/**
 * 起框架，输出直通，不接输入（testpace 跑测试不回答框架的提问，比如 Vitest 问要不要装缺的包；框架在自己的进程组里，
 * 从终端读输入会被系统停住）。testpace 被中断时（不管收到的是哪个信号）给框架的整个进程组发 SIGINT：框架当成 Ctrl-C 停下，
 * 它起的跑测试的子进程也一起收到，不靠框架转告（Vitest 收到信号只管自己退出，跑测试的子进程要等手上的测试跑完才走）。
 */
function spawnFramework({ program, args, env }: Command, cwd: string): Promise<GroupRun> {
  // 交结果的位置只给这一层：测试自己再起的 testpace run（比如测 testpace 的测试）不往里写。
  // 整组给检查的运行 id 也不给测试：检查直接跑项目的测试命令时（比如 testcraft check 在副本里跑），测试不是那一段检查
  const { [RESULTS_ENV]: _, [RUN_ENV]: _run, ...inherited } = process.env
  return spawnGroup(program, args, {
    cwd,
    env: { ...inherited, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
    stopSignal: 'SIGINT',
    killAfterMs: FRAMEWORK_KILL_AFTER_MS,
  })
}
