// testpace run playwright 的计数报告器：经 PW_TEST_REPORTER 加在项目自己的报告器后面（不换掉它们），
// 每跑完一个测试往 TESTPACE_REPORT 写一行 {file, skipped}，testpace 跑完按文件核对。
// 由项目的 Playwright 加载，写成 .mjs，不靠 node 直接运行 TypeScript。
import { appendFileSync } from 'node:fs'

export default class TestpaceCount {
  // 不往屏幕上写：Playwright 见所有报告器都不写屏幕时会自己补一个，加了它不改变项目原来的输出
  printsToStdio() {
    return false
  }

  onTestEnd(test, result) {
    appendFileSync(process.env.TESTPACE_REPORT, `${JSON.stringify({ file: test.location.file, skipped: result.status === 'skipped' })}\n`)
  }
}
