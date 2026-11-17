// testpace run playwright：用项目自己装的 Playwright（从 --cwd 找 @playwright/test）跑给定的测试文件，守 testpace 对 files 的约定。
// 项目配置里的报告器（比如断言检查）照常起作用：计数报告器经 PW_TEST_REPORTER 加在它们后面，不用命令行的 --reporter（会把配置里的换掉）。
// Playwright 把文件参数当正则，路径里的 ( + . 这些先转义。按行给的交给它按行跑（同一个文件也给了整个文件时整个跑，见 selectors）。
// Playwright 只在一个测试都没选到时才失败：给的行上没有测试、文件里没有测试、文件被配置排除了，只要别的文件有测试就照样通过。
// 这些靠逐个文件核对查出来；没被选中的测试它不报，全被跳过不会误判。依赖的准备项目（setup）里的测试会算成没给、也跑了的文件。

import { fileURLToPath } from 'node:url'
import { type Framework, projectBin } from './runner.ts'
import { readRanLines, selectors } from './targets.ts'

const REPORTER = fileURLToPath(new URL('./playwright-reporter.mjs', import.meta.url))

const escape = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const playwright: Framework = {
  usage: 'testpace run playwright [--cwd 目录] [--playwright-arg 参数]... 文件[:行号[:列号]]...',
  argOption: '--playwright-arg',
  byLine: true,
  command(targets, args, cwd, report) {
    const bin = projectBin(cwd, '@playwright/test', 'playwright')
    if (typeof bin === 'string') return bin
    return {
      program: 'node',
      args: [
        bin.path,
        'test',
        ...args,
        ...selectors(targets, target => escape(target.path)),
      ],
      env: { PW_TEST_REPORTER: REPORTER, TESTPACE_REPORT: report },
    }
  },
  read: readRanLines,
}
