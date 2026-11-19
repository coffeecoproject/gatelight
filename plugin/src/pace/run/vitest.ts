// testpace run vitest：用项目自己装的 Vitest（从 --cwd 找）跑给定的测试文件，守 testpace 对 files 的约定。
// 经插件的启动脚本（vitest-launcher.mjs）用 Vitest 的 Node 接口照 `vitest run` 跑：项目配置里的报告器、屏幕输出照旧，
// 跑完把每个测试的记录写进报告文件，逐个文件、逐行核对。按行给的交给 Vitest 按行跑（同一个文件也给了整个文件时整个跑，见 selectors）。
// Vitest 自己就把这几种算失败：文件里没有测试、给的行上没有测试。这里补上它放过的：给的文件被配置排除了
// （它悄悄不跑、照样通过），选中的测试全被跳过（说一句）。它把文件参数当名字片段，可能顺带跑别的文件，也说一句。

import { fileURLToPath } from 'node:url'
import { type Framework, projectBin } from './runner.ts'
import { selectors } from './targets.ts'

const LAUNCHER = fileURLToPath(new URL('./vitest-launcher.mjs', import.meta.url))

export const vitest: Framework = {
  usage: 'testpace run vitest [--cwd 目录] [--vitest-arg 参数]... 文件[:行号[:列号]]...',
  argOption: '--vitest-arg',
  byLine: true,
  command(targets, args, cwd, report) {
    const bin = projectBin(cwd, 'vitest', 'vitest')
    if (typeof bin === 'string') return bin
    return { program: 'node', args: [LAUNCHER, report, bin.path, '--', ...args, ...selectors(targets)] }
  },
}
