// testpace run playwright：用项目装的 Playwright 跑测试文件，守 files 的约定。临时项目里的 @playwright/test 链接到这个仓库装的那份。
// 测试不开页面，不用浏览器。选项解析、文件不存在、中断、临时文件这些各框架共用的在 run.test.ts 测，这里只测 Playwright 自己的。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { before, describe, test } from 'node:test'
import { BIN, ENV, reported, tempDir, type Result } from './helpers.ts'

const PLAYWRIGHT = dirname(createRequire(import.meta.url).resolve('@playwright/test/package.json'))

describe('testpace run playwright', () => {
  /** 跑命令的目录（仓库根目录）；Playwright 项目在它下面的 e2e。 */
  let dir: string
  let e2e: string
  const run = (...args: string[]): Result => {
    const r = spawnSync(BIN, ['run', 'playwright', '--cwd', 'e2e', ...args], { cwd: dir, env: ENV, encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  const write = (name: string, text: string): void => {
    mkdirSync(dirname(join(e2e, name)), { recursive: true })
    writeFileSync(join(e2e, name), text)
  }
  const passing = (title: string) => `import { expect, test } from '@playwright/test'\ntest('${title}', () => { expect(1).toBe(1) })\n`

  before(() => {
    dir = tempDir('testpace-playwright-')
    e2e = join(dir, 'e2e')
    mkdirSync(join(e2e, 'node_modules', '@playwright'), { recursive: true })
    symlinkSync(PLAYWRIGHT, join(e2e, 'node_modules', '@playwright', 'test'))
    write('package.json', '{ "type": "module" }\n')
    // 项目自己的报告器：testpace 加计数报告器时不能把它换掉（比如项目靠它查每个测试都有断言）
    write('own-reporter.mjs', "export default class { onEnd() { console.log('项目自己的报告器跑过了') } }\n")
    // 配置排除 ignored 开头的文件：给了它 Playwright 也不跑
    write('playwright.config.mjs', "export default { testDir: './tests', testIgnore: /ignored/, reporter: [['list'], ['./own-reporter.mjs']] }\n")
    write('broken.config.mjs', "throw new Error('配置写错了')\n")
    write('tests/pick.spec.mjs', "import { expect, test } from '@playwright/test'\n\ntest('对', () => {\n  expect(1 + 1).toBe(2)\n})\n\ntest('错', () => {\n  expect(1 + 1).toBe(3)\n})\n")
    write('tests/ok.spec.mjs', passing('也对'))
    write('tests/empty.spec.mjs', "import { test } from '@playwright/test'\n")
    write('tests/ignored.spec.mjs', passing('被排除'))
    write('tests/skipped.spec.mjs', "import { test } from '@playwright/test'\ntest.skip('先不跑', () => {})\n")
    write('tests/t(1)+x/odd.spec.mjs', passing('路径怪'))
    write('tests/nested.spec.mjs', "import { expect, test } from '@playwright/test'\ntest.describe('外层', () => {\n  test('对', () => { expect(1).toBe(1) })\n})\n")
    // serial 模式：前一个没过，后一个就不跑了，Playwright 把它报成跳过
    write('tests/serial.spec.mjs', "import { expect, test } from '@playwright/test'\ntest.describe.configure({ mode: 'serial' })\ntest('先错', () => { expect(1).toBe(2) })\ntest('后面的', () => { expect(1).toBe(1) })\n")
    write('tests/a-fail.spec.mjs', "import { expect, test } from '@playwright/test'\ntest('错', () => { expect(1).toBe(2) })\n")
  })

  test('按行跑只跑那几行；同一个文件也给了整个文件时整个跑', () => {
    const one = run('e2e/tests/pick.spec.mjs:3:7')
    assert.equal(one.code, 0, one.out)
    assert.doesNotMatch(one.out, /不能按行跑/)
    const r = run('e2e/tests/pick.spec.mjs:3', 'e2e/tests/pick.spec.mjs')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /错/)
  })

  test('给的行上没有测试、文件里没有测试、文件被配置排除时算失败，哪怕别的文件跑了测试、Playwright 照样通过', () => {
    const r = run('e2e/tests/pick.spec.mjs:4', 'e2e/tests/empty.spec.mjs', 'e2e/tests/ignored.spec.mjs', 'e2e/tests/ok.spec.mjs')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /一个测试都没跑到（[^）]+）：e2e\/tests\/pick\.spec\.mjs:4、e2e\/tests\/empty\.spec\.mjs、e2e\/tests\/ignored\.spec\.mjs\n/)
  })

  test('同一个文件给两行、其中一行上没有测试时失败并点名这一行，哪怕 Playwright 照样通过', () => {
    const r = run('e2e/tests/pick.spec.mjs:3', 'e2e/tests/pick.spec.mjs:4')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /一个测试都没跑到（[^）]+）：e2e\/tests\/pick\.spec\.mjs:4\n/)
  })

  test('按行给分组的行，跑组里的测试，不算没跑到', () => {
    const r = run('e2e/tests/nested.spec.mjs:2')
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /没跑到|全被跳过/)
  })

  test('前面的没过、后面的就没跑（serial 模式）时算没跑到，不算跳过', () => {
    const r = run('e2e/tests/serial.spec.mjs:3', 'e2e/tests/serial.spec.mjs:4')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /一个测试都没跑到（[^）]+）：e2e\/tests\/serial\.spec\.mjs:4\n/)
    assert.doesNotMatch(r.out, /全被跳过/)
  })

  test('框架提前停下时，没跑到的照样点名，并提醒先修没过的', () => {
    const r = run('--playwright-arg=--max-failures=1', '--playwright-arg=--workers=1', 'e2e/tests/a-fail.spec.mjs', 'e2e/tests/ok.spec.mjs')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /一个测试都没跑到（[^）]+）：e2e\/tests\/ok\.spec\.mjs\n/)
    assert.match(r.out, /这次已有测试没过，框架可能没跑到它们就停下了/)
  })

  test('配置写错（选测试之前就停了）时失败，不逐个核对', () => {
    const r = run('--playwright-arg=--config=broken.config.mjs', 'e2e/tests/ok.spec.mjs')
    assert.notEqual(r.code, 0, r.out)
    assert.match(r.out, /配置写错了/)
    assert.doesNotMatch(r.out, /没跑到/)
  })

  test('项目配置里的报告器照常起作用', () => {
    const r = run('e2e/tests/ok.spec.mjs')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /项目自己的报告器跑过了/)
  })

  test('路径里有 Playwright 当成正则的字符时照样跑到', () => {
    for (const target of ['e2e/tests/t(1)+x/odd.spec.mjs', 'e2e/tests/t(1)+x/odd.spec.mjs:2']) {
      const r = run(target)
      assert.equal(r.code, 0, r.out)
      assert.match(r.out, /路径怪/)
    }
  })

  test('测试全被跳过不算失败，但要说一句', () => {
    const r = run('e2e/tests/skipped.spec.mjs', 'e2e/tests/ok.spec.mjs')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /这些给的文件或行上的测试这次全被跳过，什么都没验证：e2e\/tests\/skipped\.spec\.mjs\n/)
  })

  test('交回每个测试的结果：名字带外层分组，多个 project 时带上 project 名，重试之后才过的标出来', () => {
    write('tests/retry.spec.mjs', "import { expect, test } from '@playwright/test'\ntest.describe.configure({ retries: 1 })\ntest('第二次才过', ({}, info) => { expect(info.retry).toBe(1) })\n")
    const r = reported(dir, ['run', 'playwright', '--cwd', 'e2e', 'e2e/tests/retry.spec.mjs', 'e2e/tests/nested.spec.mjs'])
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(r.results, ['passed 外层 > 对', 'passed 重试后 第二次才过'])
    write('projects.config.mjs', "export default { testDir: './tests', projects: [{ name: '甲' }, { name: '乙' }] }\n")
    const projects = reported(dir, ['run', 'playwright', '--cwd', 'e2e', '--playwright-arg=--config=projects.config.mjs', 'e2e/tests/nested.spec.mjs'])
    assert.equal(projects.code, 0, projects.out)
    assert.deepEqual(projects.results, ['passed [乙] 外层 > 对', 'passed [甲] 外层 > 对'])
  })

  test('--playwright-arg 交给 Playwright', () => {
    const r = run('--playwright-arg=--grep=对', 'e2e/tests/pick.spec.mjs')
    assert.equal(r.code, 0, r.out)
  })

  test('目录里找不到项目装的 @playwright/test 时退出码 2，说清楚', () => {
    const r = spawnSync(BIN, ['run', 'playwright', 'e2e/tests/ok.spec.mjs'], { cwd: dir, env: ENV, encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(r.stdout + r.stderr, /找不到项目装的 @playwright\/test/)
  })
})
