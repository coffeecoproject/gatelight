// testpace run playwright 的计数报告器：经 PW_TEST_REPORTER 加在项目自己的报告器后面（不换掉它们），
// 跑完把每个跑过或被跳过的测试往 TESTPACE_REPORT 写一行 {file, line, ancestors, name, status, retried}（见 targets.ts 的 Ran），testpace 按给的文件和行核对。
// 由项目的 Playwright 加载，写成 .mjs，不靠 node 直接运行 TypeScript。
//
// 配置写错时 Playwright 不起报告器，不写报告，testpace 不核对；全局准备（globalSetup）出错时选好了测试、一个没跑，照样写。
// 只算选中的测试（没被行选中的 Playwright 不放进来）。一个结果都没有的是没跑到（提前停下、依赖的准备项目没过）；
// 被跳过但本来要跑的（serial 模式里前面的没过，后面的就不跑了）也是没跑到，不算声明了跳过。
// 多个 project 时同一个测试各算一次，名字前带上 project 的名字；重试的按最后一次算，重试后才过的记 retried。
import { writeFileSync } from 'node:fs'

export default class TestpaceCount {
  // 不往屏幕上写：Playwright 见所有报告器都不写屏幕时会自己补一个，加了它不改变项目原来的输出
  printsToStdio() {
    return false
  }

  onBegin(_config, suite) {
    this.suite = suite
  }

  onEnd() {
    const lines = []
    for (const test of this.suite.allTests()) {
      const last = test.results.at(-1)
      if (!last) continue
      let status
      if (last.status === 'skipped') {
        if (test.expectedStatus !== 'skipped') continue
        status = 'skipped'
      } else {
        status = last.status === test.expectedStatus ? 'passed' : 'failed'
      }
      const ancestors = []
      const titles = [test.title]
      let parent = test.parent
      for (; parent?.type === 'describe'; parent = parent.parent) {
        ancestors.push(parent.location.line)
        titles.unshift(parent.title)
      }
      // 往上是文件，再往上是 project
      const project = parent?.parent?.type === 'project' ? parent.parent.title : ''
      const name = `${project ? `[${project}] ` : ''}${titles.join(' > ')}`
      const retried = status === 'passed' && test.outcome() === 'flaky'
      lines.push(JSON.stringify({ file: test.location.file, line: test.location.line, ancestors, name, status, ...(retried ? { retried } : {}) }))
    }
    writeFileSync(process.env.TESTPACE_REPORT, lines.map(line => `${line}\n`).join(''))
  }
}
