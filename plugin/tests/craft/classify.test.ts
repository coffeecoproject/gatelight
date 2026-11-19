import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { classify, failedFiles, type Run, runFiles } from '../../src/craft/run.ts'
import { tempDir } from './helpers.ts'

describe('分清失败的原因', () => {
  test('Playwright 断言失败：日志里带着 waiting for locator，照样算断言不成立', () => {
    const out = [
      'Error: expect(locator).toHaveText(expected) failed',
      '',
      'Locator: getByTestId(\'total\')',
      'Expected: "80"',
      'Received: "100"',
      'Call log:',
      "  - waiting for getByTestId('total')",
      "    - waiting for locator('[data-testid=total]')",
    ].join('\n')
    assert.equal(classify(1, false, out), 'assertion')
  })

  test('页面元素根本不存在、页面操作超时：不算', () => {
    const missing = 'Error: expect(locator).toBeVisible() failed\n\nLocator: getByText(\'会员价\')\nExpected: visible\nReceived: <element(s) not found>\n'
    assert.equal(classify(1, false, missing), 'other')
    const click = "Error: locator.click: Timeout 5000ms exceeded.\n  12 |   await expect(page).toHaveURL('/cart')\n"
    assert.equal(classify(1, false, click), 'other')
  })

  test('Playwright 没设操作超时，点不到元素等到整个测试超时：不算；出错位置附近代码里的断言写法也不算', () => {
    const out = [
      '  1) [chromium] › e2e/cart.spec.ts:8:5 › 会员价 ─────────',
      '',
      '    Test timeout of 60000ms exceeded.',
      '',
      "    Error: locator.click: Test timeout of 60000ms exceeded.",
      '    Call log:',
      "      - waiting for getByRole('button', { name: '会员价' })",
      '',
      "       9 |   await page.goto('/cart')",
      "    > 10 |   await page.getByRole('button', { name: '会员价' }).click()",
      '         |                                                     ^',
      "      11 |   await expect(page).toHaveURL('/cart/member')",
      "      12 |   await expect(page.getByTestId('total')).toHaveText('90')",
    ].join('\n')
    assert.equal(classify(1, false, out), 'other')
    const vitest = " FAIL  tests/price.test.ts > 满减\nTypeError: Cannot read properties of undefined (reading 'off')\n ❯ src/price.ts:3:20\n      2|   const off = coupon.rule.off\n      3|   expect(applyCoupon(100)).toBe(80)\n       |                    ^\n"
    assert.equal(classify(1, false, vitest), 'other')
  })

  test('Playwright 的断言失败带着代码片段：照样算', () => {
    const out = [
      "    Error: expect(locator).toHaveText(expected) failed",
      '',
      "    Locator: getByTestId('total')",
      '    Expected: "90"',
      '    Received: "100"',
      '',
      "    > 12 |   await expect(page.getByTestId('total')).toHaveText('90')",
    ].join('\n')
    assert.equal(classify(1, false, out), 'assertion')
  })

  test('应用日志里的连不上、测试名里的字样，不影响真断言失败', () => {
    const out = 'connect ECONNREFUSED 127.0.0.1:6379\nnot ok 1 - 传入的不是函数（is not a function）时报错\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n'
    assert.equal(classify(1, false, out), 'assertion')
  })

  test('引用不存在的函数、加载失败、超时：不算', () => {
    assert.equal(classify(1, false, 'TypeError: memberPrice is not a function\n'), 'other')
    assert.equal(classify(1, false, "SyntaxError: The requested module '../src/price.mjs' does not provide an export named 'memberPrice'\nAssertionError\n"), 'other')
    assert.equal(classify(null, true, 'AssertionError'), 'other')
    assert.equal(classify(0, false, ''), 'pass')
  })

  test('加载、编译就失败，又没有断言失败：算没跑起来；同时有断言失败、找不到页面元素或超时的，不算', () => {
    const setup = [
      '  1) [登录] › tests/login.setup.ts:4:1 › 开测试人事的账号 ─────────',
      "    Error: Cannot find module '/app/apps/server/dist/auth/cli.js'",
      '  1 failed',
      '  52 did not run',
    ].join('\n')
    assert.equal(classify(1, false, setup), 'notStarted')
    assert.equal(classify(1, false, "SyntaxError: The requested module '../src/price.mjs' does not provide an export named 'memberPrice'\n"), 'notStarted')
    assert.equal(classify(1, false, `${setup}\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n`), 'other')
    assert.equal(classify(1, false, `${setup}\nReceived: <element(s) not found>\n`), 'other')
    assert.equal(classify(null, true, setup), 'other')
  })
})

describe('找出跑不过的文件', () => {
  const ran = (output: string, more: Partial<Run> = {}): Run => ({ outcome: 'assertion', exitCode: 1, timedOut: false, durationMs: 0, output, truncated: false, ...more })
  /** 认出的跑不过的文件；认不出（算全部）时是 '全部'。 */
  const found = (output: string | Run, paths: string[]): Record<string, number[]> | '全部' => {
    const { files, known } = failedFiles(typeof output === 'string' ? ran(output) : output, paths)
    if (!known) {
      assert.deepEqual([...files.keys()].sort(), [...paths].sort())
      return '全部'
    }
    return Object.fromEntries(files)
  }

  test('Playwright：路径相对配置目录，按结尾对上给的文件，记下行号；串行模式里跟着没跑的打在认出的文件上，照常认', () => {
    const paths = ['e2e/tests/cart.spec.ts', 'e2e/tests/accounts.spec.ts', 'e2e/tests/orders.spec.ts']
    const out = [
      '  ✓  1 [页面] › tests/cart.spec.ts:12:5 › 建单 (2.1s)',
      '  ✘  2 [页面] › tests/accounts.spec.ts:79:7 › 新建 › 建号 (23.5s)',
      '  -  3 [页面] › tests/accounts.spec.ts:120:7 › 新建 › 改号',
      '  ✓  4 [页面] › tests/orders.spec.ts:8:5 › 下单 (1.0s)',
      '',
      '  1) [页面] › tests/accounts.spec.ts:79:7 › 新建 › 建号 ──────',
      '',
      '    Error: expect(locator).toContainText(expected) failed',
      '        4 × locator resolved to <section aria-label="记录">…</section>',
      '      at /private/var/folders/x/testcraft/copy/e2e/tests/accounts.spec.ts:94:39',
      '',
      '  1 failed',
      '    [页面] › tests/accounts.spec.ts:79:7 › 新建 › 建号 ──────',
      '  1 did not run',
      '  2 passed (8.1m)',
    ].join('\n')
    assert.deepEqual(found(out, paths), { 'e2e/tests/accounts.spec.ts': [79] })
  })

  test('按 / 分段对：只写文件名的输出里 aa.spec.ts 不会算到 a.spec.ts；一处对上几个给的文件都算', () => {
    assert.deepEqual(found('  ✘  1 aa.spec.ts:3:5 › 建号 (1.0s)\n  1 failed\n    aa.spec.ts:3:5 › 建号\n', ['a.spec.ts', 'aa.spec.ts']), { 'aa.spec.ts': [3] })
    assert.deepEqual(found('  ✘  1 [页面] › tests/login.spec.ts:3:5 › 登录 (1.0s)\n  1 failed\n    [页面] › tests/login.spec.ts:3:5 › 登录\n', ['tests/login.spec.ts', 'e2e/tests/login.spec.ts', 'e2e/tests/cart.spec.ts']), {
      'tests/login.spec.ts': [3],
      'e2e/tests/login.spec.ts': [3],
    })
  })

  test('Playwright 的预备项目（不在给的文件里）失败了、mocha 段里一个给的文件也没有：算全部', () => {
    const paths = ['e2e/tests/a.spec.ts', 'e2e/tests/orders.spec.ts']
    assert.equal(found('  ✘  1 [登录] › tests/login.setup.ts:4:1 › 开测试账号 (1.2s)\n  ✘  2 [页面] › tests/a.spec.ts:12:5 › 建单 (2.1s)\n  2 failed\n', paths), '全部')
    const mocha = ['  1) 满减', '       满额才减:', '     AssertionError: expected 80 to equal 90', '      at Context.<anonymous> (src/price.js:3:9)', '', '  2) 合计', '       空订单:', '      at Context.<anonymous> (test/total.spec.js:5:3)'].join('\n')
    assert.equal(found(mocha, ['test/price.spec.js', 'test/total.spec.js']), '全部')
  })

  test('提前停了、没跑到的文件不在输出里：算全部', () => {
    const paths = ['e2e/tests/a.spec.ts', 'e2e/tests/b.spec.ts', 'e2e/tests/c.spec.ts']
    const failedA = '  ✘  1 [页面] › tests/a.spec.ts:3:5 › 建单 (1.0s)\n  1 failed\n    [页面] › tests/a.spec.ts:3:5 › 建单\n'
    // maxFailures：没跑的不打出来
    assert.equal(found(`${failedA}  12 did not run\n`, paths), '全部')
    // 没跑的打出来了，却在没认出的文件上
    assert.equal(found(`${failedA}  -  2 [页面] › tests/b.spec.ts:3:5 › 改单\n  1 did not run\n`, paths), '全部')
    assert.equal(found(`${failedA}  1 interrupted\n`, paths), '全部')
    const pytest = 'FAILED tests/test_a.py::test_x - assert 1 == 2\n!!!!!!!!!!!!!!!!!!!!!!!!!! stopping after 1 failures !!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
    assert.equal(found(pytest, ['tests/test_a.py', 'tests/test_b.py']), '全部')
    // jest --bail：没跑全时写 1 of 3 total
    const jest = 'FAIL tests/a.test.js\n  ● 满减 › 满额才减\n\nTest Suites: 1 failed, 1 of 3 total\nTests:       1 failed, 1 total\n'
    const three = ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js']
    assert.equal(found(jest, three), '全部')
    assert.deepEqual(found(jest.replace('1 failed, 1 of 3 total', '1 failed, 2 passed, 3 total'), three), { 'tests/a.test.js': [] })
    // vitest --bail：取消的文件算进总数，不算失败、通过、跳过
    const vitest = ' FAIL  tests/a.test.ts > 满减\n Test Files  1 failed (3)\n      Tests  1 failed (1)\n'
    assert.equal(found(vitest, three.map(path => path.replace('.js', '.ts'))), '全部')
    assert.deepEqual(found(vitest.replace('1 failed (3)', '1 failed | 2 passed (3)'), three.map(path => path.replace('.js', '.ts'))), { 'tests/a.test.ts': [] })
  })

  test('node:test 的 TAP：文件和行号取 not ok 下面的 location，不取调用栈里的', () => {
    const out = [
      'TAP version 13',
      '# Subtest: 满额才减',
      'not ok 2 - 满额才减',
      '  ---',
      "  location: '/tmp/copy/tests/price.test.mjs:9:1'",
      "  failureType: 'testCodeFailure'",
      '  stack: |-',
      '    TestContext.<anonymous> (file:///tmp/copy/tests/price.test.mjs:10:10)',
      '    Test.runInAsyncScope (node:async_hooks:214:14)',
      '    Test.run (node:internal/test_runner/test:1047:25)',
      '  ...',
      '# Subtest: 合计',
      'ok 3 - 合计',
      '# Subtest: tests/broken.test.mjs',
      'not ok 4 - tests/broken.test.mjs',
      '  ---',
      "  location: '/tmp/copy/tests/broken.test.mjs:1:1'",
      '  ...',
      '# fail 2',
    ].join('\n')
    assert.deepEqual(found(out, ['tests/price.test.mjs', 'tests/total.test.mjs', 'tests/broken.test.mjs']), { 'tests/price.test.mjs': [9], 'tests/broken.test.mjs': [1] })
  })

  test('node:test 的 spec：失败汇总里的 test at 和下面的 ✖ 算一处，行号取声明那行；树上只写测试名的 ✖ 不管', () => {
    const out = [
      '✔ 合计 (0.3ms)',
      '✖ 满额才减 (0.3ms)',
      'ℹ fail 1',
      '',
      '✖ failing tests:',
      '',
      'test at tests/price.test.mjs:9:1',
      '✖ 满额才减 (0.3ms)',
      '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
      '      at TestContext.<anonymous> (file:///tmp/copy/tests/price.test.mjs:10:28)',
      '      at Test.run (node:internal/test_runner/test:1047:25)',
    ].join('\n')
    assert.deepEqual(found(out, ['tests/price.test.mjs', 'tests/total.test.mjs']), { 'tests/price.test.mjs': [9] })
  })

  test('vitest、jest 的 FAIL，pytest 的 FAILED 和收集失败的 ERROR', () => {
    const vitest = [
      ' ❯ tests/price.test.ts (2 tests | 1 failed) 3ms',
      '     × 满额才减 2ms',
      '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
      ' FAIL  tests/price.test.ts > 满减 > 满额才减',
      'AssertionError: expected 1 to be 2 // Object.is equality',
      ' FAIL  tests/load.test.ts [ tests/load.test.ts ]',
      "Error: Cannot find module './nope' imported from /tmp/copy/tests/load.test.ts",
      ' Test Files  2 failed | 1 passed (3)',
    ].join('\n')
    assert.deepEqual(found(vitest, ['tests/price.test.ts', 'tests/load.test.ts', 'tests/total.test.ts']), { 'tests/price.test.ts': [], 'tests/load.test.ts': [] })
    const jest = [
      'FAIL tests/price.test.js',
      '  满减',
      '    ✕ 满额才减 (3 ms)',
      '',
      '  ● 满减 › 满额才减',
      '',
      '      at Object.toBe (tests/price.test.js:3:15)',
      '',
      'PASS tests/total.test.js',
      'Test Suites: 1 failed, 1 passed, 2 total',
    ].join('\n')
    assert.deepEqual(found(jest, ['tests/price.test.js', 'tests/total.test.js']), { 'tests/price.test.js': [3] })
    const pytest = [
      'tests/test_price.py F.                                                   [100%]',
      '____________________ ERROR collecting tests/test_total.py _____________________',
      'tests/test_price.py:5: AssertionError',
      '=========================== short test summary info ============================',
      'FAILED tests/test_price.py::test_coupon - assert 80 == 90',
      'ERROR tests/test_total.py',
      '==================== 1 failed, 1 passed, 1 error in 0.05s =====================',
    ].join('\n')
    assert.deepEqual(found(pytest, ['tests/test_price.py', 'tests/test_total.py', 'tests/test_other.py']), { 'tests/test_price.py': [], 'tests/test_total.py': [] })
  })

  test('没见到认得的汇总（跑到一半崩了、被杀了）、超时、输出截掉了前面：算全部', () => {
    const paths = ['e2e/tests/a.spec.ts', 'e2e/tests/b.spec.ts']
    const out = '  ✘  1 [页面] › tests/a.spec.ts:3:5 › 建单 (1.0s)\n'
    assert.equal(found(out, paths), '全部')
    const summary = '  1 failed\n    [页面] › tests/a.spec.ts:3:5 › 建单\n  1 passed (2.0s)\n'
    assert.deepEqual(found(out + summary, paths), { 'e2e/tests/a.spec.ts': [3] })
    assert.equal(found(ran(out + summary, { timedOut: true, exitCode: null }), paths), '全部')
    assert.equal(found(ran(out + summary, { truncated: true }), paths), '全部')
  })

  test('认不出是哪个文件的：go 只写包名、一个也没认出、有不属于任何测试的错，都算全部', () => {
    const paths = ['price/price_test.go', 'cart/cart_test.go']
    const go = '--- FAIL: TestCoupon (0.00s)\n    price_test.go:12: got 90\nFAIL\nFAIL\texample.com/shop/price\t0.01s\nok  \texample.com/shop/cart\t0.01s\n'
    assert.equal(found(go, paths), '全部')
    assert.equal(found('Segmentation fault\n', paths), '全部')
    assert.equal(found(' FAIL  price/price_test.go > 满减\n⎯⎯⎯ Unhandled Errors ⎯⎯⎯\nVitest caught 1 unhandled error during the test run.\n', paths), '全部')
  })

  test('跑测试时留下整份输出：前面的失败不会因为后面输出多被截掉；太长截掉了前面的，记下来', async () => {
    const dir = tempDir('testcraft-run-')
    const log = join(dir, 'run.log')
    // 先打一处失败，再打 n 个字
    writeFileSync(join(dir, 'print.mjs'), "process.stdout.write(`not ok 1 - 满额才减\\n  ---\\n  location: '/tmp/copy/tests/a.test.mjs:9:1'\\n  ...\\n`)\nprocess.stdout.write('x'.repeat(Number(process.argv[2])) + '\\n# fail 1\\n')\nprocess.exitCode = 1\n")
    const long = await runFiles('node print.mjs 300000', [], dir, log, 30_000, '前面失败')
    assert.equal(long.truncated, false)
    assert.deepEqual(found(long, ['tests/a.test.mjs', 'tests/b.test.mjs']), { 'tests/a.test.mjs': [9] })
    const huge = await runFiles('node print.mjs 21000000', [], dir, log, 30_000, '输出太长')
    assert.equal(huge.truncated, true)
    assert.equal(found(huge, ['tests/a.test.mjs', 'tests/b.test.mjs']), '全部')
  })
})
