// 跑项目的 files 命令（testpace.json）：从给定目录用 sh 跑，输出写进日志并留在内存里（太长只留末尾），计时，超时就停掉整个进程组。
// 结果分四种：通过；因为断言不成立而失败；没跑起来；别的失败（找不到页面元素、超时，环境问题）。
// 跑不过时从输出里找出是哪几个文件跑不过（failedFiles）。

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { PROJECT_ENV } from '../base/execute.ts'

/**
 * 跑一次测试的结果：通过；断言不成立；没跑起来（加载、编译失败，没找到测试）；别的失败（跑起来了，没到断言就出错、找不到页面元素、超时）。
 */
export type Outcome = 'pass' | 'assertion' | 'notStarted' | 'other'

export interface Run {
  outcome: Outcome
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  /** 输出（去掉颜色）。一般是全部，超过 KEEP_CHARS 只留末尾。 */
  output: string
  /** 输出太长，前面的去掉了：认不全跑不过的文件。 */
  truncated: boolean
}

/** 输出最多留多少字：认跑不过的文件要看整份（TAP、jest 的失败写在前面），留得下一般的大套件；超过了只留末尾。 */
const KEEP_CHARS = 20_000_000

export function runFiles(command: string, paths: string[], cwd: string, log: string, timeoutMs: number, label: string): Promise<Run> {
  const started = Date.now()
  appendFileSync(log, `\n===== ${label}：${command} ${paths.join(' ')}（在 ${cwd}）\n`)
  const child = spawn('/bin/sh', ['-c', `${command} "$@"`, 'sh', ...paths], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    // 和 testpace 跑项目命令时一样的环境：命令里调的 testpace（比如 testpace run）就是正在跑的这一版
    env: { ...PROJECT_ENV, CI: process.env.CI ?? '1' },
  })
  let output = ''
  let truncated = false
  const take = (chunk: string): void => {
    appendFileSync(log, chunk)
    output += chunk
    // 攒到两倍再截一次，不用每来一块都整段复制
    if (output.length > 2 * KEEP_CHARS) {
      output = output.slice(-KEEP_CHARS)
      truncated = true
    }
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', take)
  child.stderr.on('data', take)

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      // 已经退出
    }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    signalGroup('SIGTERM')
    setTimeout(() => signalGroup('SIGKILL'), 10_000).unref()
  }, timeoutMs)
  const stop = (): void => {
    signalGroup('SIGTERM')
    process.exit(130)
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  for (const signal of signals) process.on(signal, stop)

  return new Promise(resolve => {
    let done = false
    const finish = (exitCode: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      for (const signal of signals) process.off(signal, stop)
      if (output.length > KEEP_CHARS) {
        output = output.slice(-KEEP_CHARS)
        truncated = true
      }
      const text = stripAnsi(output)
      const durationMs = Date.now() - started
      appendFileSync(log, `\n===== 退出码 ${exitCode}${timedOut ? '（超时）' : ''}，用时 ${Math.round(durationMs / 1000)} 秒\n`)
      resolve({ outcome: classify(exitCode, timedOut, text), exitCode, timedOut, durationMs, output: text, truncated })
    }
    child.on('error', () => finish(null))
    child.on('close', code => finish(code))
  })
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

/** 断言不成立的输出。 */
const ASSERTION_FAILED =
  /AssertionError|\bexpect\((?:received|locator|page)?\)\.(?:not\.)?\w+\(|Expected[^\n]*:[^\n]*\n[^\n]*Received|assertion `[^`]*` failed|assertion failed|^E\s+assert\b|^\s+Error Trace:|XCTAssert\w* failed|^\s+--- FAIL: \S+ \(/m

/** 没跑到断言：加载、编译失败，没找到测试。有这些字样时，输出里就算有断言的样子也不算。 */
const NOT_REACHED =
  /Cannot find module|ERR_MODULE_NOT_FOUND|Failed to load url|Failed to resolve import|does not provide an export named|error TS\d+|\[build failed\]|\[setup failed\]|could not compile|ERROR collecting|No test files? found|no tests? (?:to run|found|ran)|Unknown file extension/i

/** 页面元素根本不存在：功能还没有，不算断言抓到。 */
const NO_ELEMENT = /element\(s\) not found/

/** 出错位置附近的代码片段（`  12 |   await expect(page)…`、` > 12 | …`、`     |   ^`）：里面的断言写法不是断言失败。 */
const CODE_FRAME = /^\s*>?\s*\d*\s*\|.*$/gm

/**
 * 断言不成立：输出里（去掉代码片段后）有断言失败的样子，且测试真跑起来了、不是找不到页面元素。
 * 别的失败（引用不存在的函数、读 undefined 的属性、连不上服务、点击和跳转超时、整个测试超时）没有断言的样子，自然不算；
 * 日志里顺带出现这些字样（比如 Playwright 每次断言都写的 waiting for locator）不影响断言失败的判断。
 */
export function classify(exitCode: number | null, timedOut: boolean, output: string): Outcome {
  if (exitCode === 0 && !timedOut) return 'pass'
  if (timedOut || NO_ELEMENT.test(output)) return 'other'
  const asserted = ASSERTION_FAILED.test(output.replace(CODE_FRAME, ''))
  // 没跑起来的字样和断言失败一起出现（几个文件一起跑，有的加载失败、有的断言不成立）：不算断言失败，也不算没跑起来
  if (NOT_REACHED.test(output)) return asserted ? 'other' : 'notStarted'
  return asserted ? 'assertion' : 'other'
}

/**
 * 失败的标记：Playwright 的 ✘、`1) …` 和汇总里的 `2 failed`（下面缩进的几行列出是哪几个）；mocha 的 `1) …`；
 * node:test 的 `test at 文件:行:列`（spec 的失败汇总，下一行是这个测试的 ✖）、TAP 的 `not ok`（文件在下面缩进的 location 里）；
 * jest、vitest 的 FAIL；pytest 的 FAILED、ERROR（收集失败）；go 的 FAIL。
 * 树上只写测试名的 ✖、×、✕ 不算标记：这几个框架另有带文件的那一行。
 */
const FAILURE = /^\s*(?:✘|\d+\)\s|not ok\b|\d+ failed$|test at\s|(?:--- )?FAIL(?:ED)?\b|ERROR\b)|ERROR collecting\b/

/**
 * 有失败但说不清是哪个测试的，或者提前停了、没跑到的文件不会出现在输出里：vitest 的 Unhandled Errors，Playwright 不属于任何测试的错、
 * interrupted、整轮超时，pytest 的 stopping after、Interrupted，bail、aborted 这类字样。
 */
const STOPPED = /\bUnhandled Errors?\b|errors? (?:was|were) not a part of any test|\binterrupted\b|stopping after|\bbail(?:ed|ing)?\b|\baborted\b|Timed out waiting [\d.]+m?s for the (?:entire )?test run/i

/**
 * 认得的汇总：Playwright 的 `N failed`、`N passed`，mocha 的 `N passing`、`N failing`，jest 的 `Test Suites:`，vitest 的 `Test Files`，
 * pytest 的 `=== 1 failed in 0.1s ===`，TAP 的 `# fail N`，node:test spec 的 `ℹ fail N`。一个也没有，说明没跑完（崩了、被杀了）。
 */
const SUMMARY =
  /^\s*\d+ (?:failed|passed|flaky|skipped|did not run|interrupted|passing|failing)\b|^\s*Test Suites:|^\s*Test Files\s|^=+ .*\b(?:failed|passed|errors?|skipped|no tests ran)\b.* =+$|^# fail \d+|^ℹ fail \d+/m

/** 像文件路径的：带 / 的，或带常见源码扩展名的。 */
const PATH_LIKE = /\/|\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|cs|php|feature)$/

/** 一行里提到的路径：去掉 file://、pytest 的 ::测试名、末尾的 :行:列。 */
function mentions(line: string): Array<{ path: string; line?: number }> {
  const found: Array<{ path: string; line?: number }> = []
  for (const token of line.match(/[^\s'"`()<>[\]{},;|›]+/g) ?? []) {
    const bare = token.replace(/^file:\/\//, '').replace(/::.*$/, '').replace(/:+$/, '')
    const at = /^(.+?)(?::(\d+))?(?::\d+)?$/.exec(bare)
    if (!at) continue
    const path = at[1] as string
    if (PATH_LIKE.test(path)) found.push({ path, ...(at[2] ? { line: Number(at[2]) } : {}) })
  }
  return found
}

/**
 * 输出里提到的路径对应给的哪些文件。按 / 分段从结尾对：Playwright 写相对配置目录的路径（给 `e2e/tests/x.spec.ts`，它写 `tests/x.spec.ts`），
 * TAP、调用栈写绝对路径；`a.spec.ts` 对不上 `aa.spec.ts`。对上几个都算（给了 `tests/x.spec.ts` 和 `e2e/tests/x.spec.ts` 时分不清是哪个）。
 */
function owners(mentioned: string, paths: string[]): string[] {
  return paths.filter(path => mentioned === path || mentioned.endsWith(`/${path}`) || path.endsWith(`/${mentioned}`))
}

export interface Failed {
  /** 跑不过的文件和跑不过的测试在第几行（各段里第一次提到的行号）。认不出时是给的全部文件。 */
  files: Map<string, number[]>
  /** 认出了是哪几个：认不出时是全部，再跑一次也一样。 */
  known: boolean
}

const indentOf = (line: string): number => (line.match(/^\s*/) as RegExpMatchArray)[0].length

/**
 * 一次没跑过的测试里，给的文件中哪几个跑不过。
 * 失败的一段是带失败标记的一行加上紧跟着缩进更深的几行（TAP 的 location、出错的调用栈），这段里提到的给的文件就算跑不过。
 * 认不准的都算全部跑不过（只会多跑，不会把没跑到的当成过了）：一个也没认出（比如 go 只写包名）；有一段里一个给的文件也没有
 * （Playwright 的登录预备项目 `tests/login.setup.ts`、mocha 段首只写测试名）；提前停了（STOPPED，jest、vitest 汇总的文件数比给的少，
 * Playwright 的 did not run 不全是认出的文件里串行模式跟着没跑的）；没见到认得的汇总（跑到一半崩了、被杀了，汇总没打出来）；超时；输出截掉了前面。
 */
export function failedFiles(run: Run, paths: string[]): Failed {
  const failed = new Map<string, number[]>()
  const { output } = run
  const lines = output.split('\n')
  const endOf = (start: number): number => {
    let end = start + 1
    while (end < lines.length && ((lines[end] as string).trim() === '' || indentOf(lines[end] as string) > indentOf(lines[start] as string))) end++
    return end
  }
  // 超时、输出截掉了前面：认不全
  let known = !run.timedOut && !run.truncated && !STOPPED.test(output) && SUMMARY.test(output)
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i] as string
    if (!FAILURE.test(head)) continue
    const start = i
    let end = endOf(i)
    // node:test 的 spec：`test at 文件:行:列` 下一行是这个测试的 ✖，算同一段（行号取声明那行，不取调用栈里的）
    if (/^\s*test at\s/.test(head) && /^\s*✖/.test(lines[end] ?? '')) {
      i = end
      end = endOf(end)
    }
    const seen = new Map<string, number | undefined>()
    for (const text of lines.slice(start, end)) {
      for (const { path, line } of mentions(text)) {
        for (const owner of owners(path, paths)) if (seen.get(owner) === undefined) seen.set(owner, line)
      }
    }
    if (seen.size === 0) known = false
    for (const [path, line] of seen) {
      const at = failed.get(path) ?? []
      if (line !== undefined && !at.includes(line)) at.push(line)
      failed.set(path, at)
    }
  }
  if (failed.size === 0 || !allRan(output, lines, paths, failed)) known = false
  return { files: known ? failed : new Map(paths.map(path => [path, failed.get(path) ?? []])), known }
}

/**
 * 给的文件都跑到了：jest、vitest 汇总的文件数不比给的少；Playwright 的 did not run 都打在认出的文件上（串行模式里一个没过，同一组后面的跟着不跑，
 * 列表里用 `-` 打出来），打出来的不比 did not run 的个数少。别的 `-` 行（跳过的测试）落在没认出的文件上时分不清，算没跑全。
 */
function allRan(output: string, lines: string[], paths: string[], failed: Map<string, number[]>): boolean {
  // jest：没跑全时写 `Test Suites: 1 failed, 1 of 3 total`
  for (const match of output.matchAll(/^\s*Test Suites:.*$/gm)) {
    const total = /(\d+) total/.exec(match[0])
    if (/\d+ of \d+ total/.test(match[0]) || !total || Number(total[1]) < paths.length) return false
  }
  // vitest：bail 取消的文件算进总数，却不算失败、通过、跳过（`Test Files  1 failed (3)`）
  for (const match of output.matchAll(/^\s*Test Files\s+(.*)\((\d+)\)\s*$/gm)) {
    const counted = [...(match[1] as string).matchAll(/(\d+) (?:failed|passed|expected fail|skipped|todo)\b/g)].reduce((sum, count) => sum + Number(count[1]), 0)
    if (counted < Number(match[2]) || Number(match[2]) < paths.length) return false
  }
  const notRun = [...output.matchAll(/^\s*(\d+) did not run$/gm)].reduce((sum, match) => sum + Number(match[1]), 0)
  if (notRun === 0) return true
  const dashed = lines.filter(line => /^\s*-\s+\d+\s/.test(line))
  const onFailed = dashed.filter(line => mentions(line).some(({ path }) => owners(path, paths).some(owner => failed.has(owner))))
  return onFailed.length === dashed.length && dashed.length >= notRun
}
