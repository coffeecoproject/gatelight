// 接入核对：由程序实际跑几次项目的 files 命令，看它守不守约定，不靠 agent 说"检查过了"。
// 这几次运行不记进 runs.jsonl（不是开发中的测试，不该算进报告），但和别的测试一样占住工作区。

import { failureCause, type Repo, runClaimed } from './repo.ts'
import type { RunningMarker } from './store.ts'

/** 核对时交给 files 的不存在的路径。 */
export const MISSING = 'testpace-verify-no-such-file.test.js'

/**
 * 测试声明的开头：test(、it(、describe( 和它们的 .only、.skip、.each 这类写法（不含 beforeEach、use 这些钩子和配置，
 * 按行跑时那一行没有测试），Python 的 def test_，Go 的 func Test。
 */
const TEST_DECLARATION = /^(\s*)(?:(?:test|it|describe)(?:\.(?:only|skip|todo|fixme|fail|slow|each|concurrent|sequential|serial|parallel|describe))*\s*\(|def test_|func Test)/

/** 文件里第一个测试声明所在的行和列（都从 1 起）；找不到返回 undefined。 */
export function firstTest(text: string): { line: number; column: number } | undefined {
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    const match = TEST_DECLARATION.exec(line)
    if (match) return { line: index + 1, column: match[1]!.length + 1 }
  }
  return undefined
}

export type VerifyResult =
  | { kind: 'done'; failed: number; skipped: number }
  | { kind: 'busy'; marker: RunningMarker }
  | { kind: 'interrupted' }

class Stopped {
  readonly result: VerifyResult
  constructor(result: VerifyResult) {
    this.result = result
  }
}

/**
 * 核对 files 命令：不存在的文件要失败；给了测试文件（相对仓库根目录）时，再核对它能通过、混进不存在的路径要失败、
 * 文件:行号 和 文件:行号:列号 能用。text 是那个文件的内容。每项结果交给 say。
 */
export async function verifyFiles(
  repo: Repo,
  command: string,
  tree: string,
  test: { path: string; text: string } | undefined,
  say: (line: string) => void,
): Promise<VerifyResult> {
  let failed = 0
  let skipped = 0
  const probe = async (title: string, args: string[], shouldPass: boolean): Promise<boolean> => {
    const run = await runClaimed(repo, 'files', command, args, tree)
    if ('busy' in run) throw new Stopped({ kind: 'busy', marker: run.busy })
    if (run.execution.interrupted) throw new Stopped({ kind: 'interrupted' })
    const passed = run.execution.exitCode === 0
    const ok = passed === shouldPass
    if (!ok) failed += 1
    say(ok ? `通过　${title}` : `没通过　${title}：实际${passed ? '通过了' : `失败了（${failureCause(run.execution)}）`}，日志 ${run.log}`)
    return ok
  }
  const skip = (text: string): void => {
    skipped += 1
    say(`没查　${text}`)
  }

  try {
    await probe(`files 给了不存在的文件要失败（${MISSING}）`, [MISSING], false)
    if (!test) {
      skip('其余几项要一个测试文件：testpace verify <测试文件>，挑一个跑得快、不依赖外部服务的')
      return { kind: 'done', failed, skipped }
    }
    if (!(await probe(`files 跑 ${test.path} 要通过`, [test.path], true))) {
      skip('其余几项要这个文件先能通过：先看日志，或换一个能通过的测试文件')
      return { kind: 'done', failed, skipped }
    }
    await probe('真文件里混进一个不存在的路径要失败', [test.path, MISSING], false)
    const at = firstTest(test.text)
    if (!at) {
      skip(`文件:行号：${test.path} 里没找到测试声明（test(、it(、describe(、def test_、func Test），换一个测试文件`)
    } else {
      await probe(`文件:行号 要能用（${test.path}:${at.line}）`, [`${test.path}:${at.line}`], true)
      await probe(`文件:行号:列号 要能用（${test.path}:${at.line}:${at.column}）`, [`${test.path}:${at.line}:${at.column}`], true)
    }
    return { kind: 'done', failed, skipped }
  } catch (error) {
    if (error instanceof Stopped) return error.result
    throw error
  }
}
