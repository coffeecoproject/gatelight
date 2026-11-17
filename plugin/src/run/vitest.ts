// testpace run vitest：用项目自己装的 Vitest（从 --cwd 找）跑给定的测试文件，守 testpace 对 files 的约定。
// 按行给的交给 Vitest 按行跑；同一个文件也给了整个文件时整个跑（Vitest 见到行号就只跑那几行）。
// 屏幕上是 Vitest 的 default 输出；另加一份 JSON 报告写进报告文件，跑完逐个文件核对。
// Vitest 自己就把这几种算失败：文件里没有测试、给的行上没有测试。这里补上它放过的：给的文件被配置排除了
// （它悄悄不跑、照样通过），文件的测试全被跳过（说一句）。它把文件参数当名字片段，可能顺带跑别的文件，也说一句。

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Framework } from './runner.ts'
import type { Ran } from './targets.ts'

interface JsonReport {
  testResults: Array<{ name: string; status: string; assertionResults: Array<{ status: string }> }>
}

const RAN = new Set(['passed', 'failed'])

export const vitest: Framework = {
  usage: 'testpace run vitest [--cwd 目录] [--vitest-arg 参数]... 文件[:行号[:列号]]...',
  argOption: '--vitest-arg',
  byLine: true,
  command(targets, args, cwd, report) {
    let manifest: string
    try {
      manifest = createRequire(join(cwd, 'package.json')).resolve('vitest/package.json')
    } catch {
      return `在 ${cwd} 找不到项目装的 vitest：在装了 vitest 的目录下跑，或用 --cwd 指过去`
    }
    const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> }
    return {
      program: 'node',
      args: [
        join(dirname(manifest), bin.vitest!),
        'run',
        '--reporter=default', '--reporter=json', `--outputFile.json=${report}`,
        ...args,
        ...targets.flatMap(target => (target.whole ? [target.path] : target.lines.map(line => `${target.path}:${line}`))),
      ],
    }
  },
  read(report) {
    if (!existsSync(report)) return []
    const { testResults } = JSON.parse(readFileSync(report, 'utf8')) as JsonReport
    // 文件本身失败、又一个测试都没跑（没加载起来、给的行上没有测试）：它报上来的测试都只是没被选中，不算
    return testResults
      .filter(file => file.status !== 'failed' || file.assertionResults.some(test => RAN.has(test.status)))
      .flatMap(file => file.assertionResults.map(test => ({ file: file.name, skipped: !RAN.has(test.status) })))
  },
}
