// testpace run node-test：用项目的 node（PATH 上的）以 node:test 跑给定的测试文件，守 testpace 对 files 的约定。
// node:test 不能按行跑：带行号的整个文件跑（runner 说一句），跑完照样核对给的行上有没有测试。不加 --test-only，留着的 .only 不起作用。
// 屏幕上照常是 spec 输出；另用插件的计数报告器把每个测试记进报告文件，跑完逐个文件、逐行核对。

import { fileURLToPath } from 'node:url'
import type { Framework } from './runner.ts'

const REPORTER = fileURLToPath(new URL('./node-test-reporter.mjs', import.meta.url))

export const nodeTest: Framework = {
  usage: 'testpace run node-test [--cwd 目录] [--node-arg 参数]... 文件[:行号[:列号]]...',
  argOption: '--node-arg',
  byLine: false,
  command(targets, args, _cwd, report) {
    return {
      program: 'node',
      args: [
        ...args,
        '--test',
        '--test-reporter=spec', '--test-reporter-destination=stdout',
        `--test-reporter=${REPORTER}`, `--test-reporter-destination=${report}`,
        ...targets.map(target => target.path),
      ],
    }
  },
}
