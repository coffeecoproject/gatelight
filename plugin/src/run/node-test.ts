// testpace run node-test：用项目的 node（PATH 上的）以 node:test 跑给定的测试文件，守 testpace 对 files 的约定。
// node:test 不能按行跑：带行号的整个文件跑，说一句。不加 --test-only，留着的 .only 不起作用。
// 屏幕上照常是 spec 输出；另用插件的计数报告器把跑完的每个测试记进临时文件，跑完逐个文件核对。

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTargets, type Ran, tally } from './targets.ts'

export const NODE_TEST_USAGE = 'testpace run node-test [--cwd 目录] [--node-arg 参数]... 文件[:行号[:列号]]...'

const REPORTER = fileURLToPath(new URL('./node-test-reporter.mjs', import.meta.url))

/** 退出码：0 通过；1 测试没过或有文件没跑到测试（node 自己的非零退出码照传）；2 用法问题、文件或 --cwd 目录不存在、找不到 node；130 被中断。 */
export async function nodeTest(argv: string[]): Promise<number> {
  const options = parseOptions(argv)
  if (typeof options === 'string') {
    console.error(`${options}\n用法：${NODE_TEST_USAGE}`)
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
  const byLine = targets.flatMap(target => target.lines)
  if (byLine.length > 0) console.log(`[testpace] node:test 不能按行跑，这些整个文件跑：${byLine.join('、')}`)

  const dir = mkdtempSync(join(tmpdir(), 'testpace-run-'))
  try {
    const record = join(dir, 'ran.jsonl')
    const args = [
      ...options.nodeArgs,
      '--test',
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      `--test-reporter=${REPORTER}`, `--test-reporter-destination=${record}`,
      ...targets.map(target => target.path),
    ]
    const run = await spawnNode(args, cwd)
    if (run.kind === 'error') {
      console.error(`[testpace] 没能起 node：${run.message}`)
      return 2
    }
    if (run.kind === 'interrupted') return 130

    // node 没过也照样核对：没加载起来、没有测试的文件一并说出来
    const ran: Ran[] = existsSync(record)
      ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Ran)
      : []
    const { empty, allSkipped } = tally(targets, ran)
    if (allSkipped.length > 0) console.log(`[testpace] 这些文件的测试这次全被跳过，什么都没验证：${allSkipped.map(t => t.file).join('、')}`)
    if (empty.length > 0) console.error(`[testpace] 这些文件一个测试都没跑到（没加载起来，或里面没有测试）：${empty.map(t => t.file).join('、')}`)
    if (run.code !== 0) return run.code
    return empty.length > 0 ? 1 : 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

interface Options {
  cwd: string
  nodeArgs: string[]
  files: string[]
}

/** 选项在前，文件在后；`--` 之后都当文件。出错时返回说明。 */
function parseOptions(argv: string[]): Options | string {
  const options: Options = { cwd: '.', nodeArgs: [], files: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--') {
      options.files.push(...argv.slice(i + 1))
      break
    }
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    if (name === '--cwd' || name === '--node-arg') {
      const value = inline ?? argv[++i]
      if (value === undefined || value === '') return `${name} 后面要跟一个值`
      if (name === '--cwd') options.cwd = value
      else options.nodeArgs.push(value)
    } else if (arg.startsWith('-')) {
      return `不认识的选项 "${arg}"`
    } else {
      options.files.push(arg)
    }
  }
  if (options.files.length === 0) return '没有给测试文件'
  return options
}

type NodeRun = { kind: 'done'; code: number } | { kind: 'error'; message: string } | { kind: 'interrupted' }

/** 起 node，输出直通。testpace 被中断时把信号转给 node，等它退出（临时目录由调用方删）。 */
function spawnNode(args: string[], cwd: string): Promise<NodeRun> {
  const child = spawn('node', args, { cwd, stdio: 'inherit' })
  let interrupted = false
  const forward = (signal: NodeJS.Signals): void => {
    interrupted = true
    child.kill(signal)
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  for (const signal of signals) process.on(signal, forward)
  return new Promise(resolvePromise => {
    let done = false
    const finish = (run: NodeRun): void => {
      if (done) return // 启动失败时 error 和 close 都会来
      done = true
      for (const signal of signals) process.off(signal, forward)
      resolvePromise(interrupted ? { kind: 'interrupted' } : run)
    }
    child.on('error', error => finish({ kind: 'error', message: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'PATH 上找不到 node' : error.message }))
    // 被信号终止（不是 testpace 转过去的）算没过
    child.on('close', code => finish({ kind: 'done', code: code ?? 1 }))
  })
}
