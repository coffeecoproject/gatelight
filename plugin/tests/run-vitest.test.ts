// testpace run vitest：用项目装的 Vitest 跑测试文件，守 files 的约定。临时项目里的 vitest 链接到这个仓库装的那份。
// 选项解析、文件不存在、临时文件这些各框架共用的在 run.test.ts 测，这里只测 Vitest 自己的。

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { before, describe, test } from 'node:test'
import { BIN, ENV, tempDir, type Result } from './helpers.ts'

const VITEST = dirname(createRequire(import.meta.url).resolve('vitest/package.json'))

describe('testpace run vitest', () => {
  /** 跑命令的目录（仓库根目录）；Vitest 项目在它下面的 app。 */
  let dir: string
  let app: string
  let tmp: string
  const run = (...args: string[]): Result => {
    const r = spawnSync(BIN, ['run', 'vitest', '--cwd', 'app', ...args], { cwd: dir, env: { ...ENV, TMPDIR: tmp }, encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  const write = (name: string, text: string): void => writeFileSync(join(app, name), text)

  before(() => {
    dir = tempDir('testpace-vitest-')
    app = join(dir, 'app')
    tmp = join(dir, 'tmp')
    mkdirSync(join(app, 'node_modules'), { recursive: true })
    mkdirSync(tmp)
    symlinkSync(VITEST, join(app, 'node_modules', 'vitest'))
    write('package.json', '{ "type": "module" }\n')
    // 项目的配置只认 .test.ts 和 .test.tsx：给 .test.mjs 的文件 Vitest 会悄悄不跑
    write('vitest.config.mjs', "export default { test: { include: ['**/*.test.ts', '**/*.test.tsx'] } }\n")
    write('pick.test.ts', "import { expect, test } from 'vitest'\n\ntest('对', () => {\n  expect(1 + 1).toBe(2)\n})\n\ntest('错', () => {\n  expect(1 + 1).toBe(3)\n})\n")
    write('empty.test.ts', "import { test } from 'vitest'\n")
    write('skipped.test.ts', "import { test } from 'vitest'\ntest.skip('先不跑', () => {})\n")
    write('partly.test.ts', "import { expect, test } from 'vitest'\ntest('对', () => { expect(1).toBe(1) })\ntest.skip('先不跑', () => {})\n")
    write('excluded.test.mjs', "import { expect, test } from 'vitest'\ntest('对', () => { expect(1).toBe(1) })\n")
    write('ok.test.ts', "import { expect, test } from 'vitest'\ntest('对', () => { expect(1).toBe(1) })\n")
    write('ok.test.tsx', "import { expect, test } from 'vitest'\ntest('也对', () => { expect(1).toBe(1) })\n")
    write('nested.test.ts', "import { describe, expect, test } from 'vitest'\ndescribe('外层', () => {\n  describe('内层', () => {\n    test('对', () => { expect(1).toBe(1) })\n  })\n})\n")
    // 另一份配置带着项目自己的报告器：testpace 不能把它换掉
    write('own-reporter.mjs', "export default class { onTestRunEnd() { console.log('项目自己的报告器跑过了') } }\n")
    write('own.config.mjs', "export default { test: { include: ['**/*.test.ts'], reporters: ['default', './own-reporter.mjs'] } }\n")
    write('broken.config.mjs', "throw new Error('配置写错了')\n")
  })

  test('按行跑只跑那几行；同一个文件也给了整个文件时整个跑', () => {
    const one = run('app/pick.test.ts:3')
    assert.equal(one.code, 0, '只跑了第 3 行的测试，第 7 行没过的那个没跑')
    assert.doesNotMatch(one.out, /不能按行跑/)
    assert.equal(run('app/pick.test.ts:3:1', 'app/pick.test.ts:3').code, 0)
    const r = run('app/pick.test.ts:3', 'app/pick.test.ts')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /错/)
  })

  test('给的行上没有测试、文件里没有测试时失败并点名，不说成全被跳过', () => {
    const r = run('app/pick.test.ts:4', 'app/empty.test.ts', 'app/ok.test.ts')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /一个测试都没跑到（[^）]+）：app\/pick\.test\.ts:4、app\/empty\.test\.ts\n/)
    assert.doesNotMatch(r.out, /全被跳过/)
  })

  test('给的文件被项目配置排除、Vitest 悄悄不跑时算失败', () => {
    const r = run('app/excluded.test.mjs', 'app/ok.test.ts')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /一个测试都没跑到（[^）]+）：app\/excluded\.test\.mjs\n/)
  })

  test('测试全被跳过不算失败，但要说一句；只跳过一部分的不说', () => {
    const r = run('app/skipped.test.ts', 'app/partly.test.ts')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /这些给的文件或行上的测试这次全被跳过，什么都没验证：app\/skipped\.test\.ts\n/)
  })

  test('按名字片段还跑了没给的文件时说一句', () => {
    const r = run('app/ok.test.ts')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /框架还跑了这些没给的文件（[^）]+）：app\/ok\.test\.tsx\n/)
  })

  test('按行给外层分组的行，跑组里的测试，不算没跑到', () => {
    const r = run('app/nested.test.ts:2')
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /没跑到|全被跳过/)
  })

  test('项目配置里的报告器照常起作用', () => {
    const r = run('--vitest-arg=--config=own.config.mjs', 'app/ok.test.ts')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /项目自己的报告器跑过了/)
  })

  test('Vitest 不认的参数、testpace 不支持的参数（另起分支、不跑一次就结束的）退出码 2', () => {
    const unknown = run('--vitest-arg=--fooBar=1', 'app/ok.test.ts')
    assert.equal(unknown.code, 2, unknown.out)
    assert.match(unknown.out, /Vitest 不认这些参数/)
    const watch = run('--vitest-arg=--watch', 'app/ok.test.ts')
    assert.equal(watch.code, 2, watch.out)
    assert.match(watch.out, /testpace run vitest 不支持这些参数：--watch/)
    // 没跑测试，不再逐个核对
    assert.doesNotMatch(unknown.out + watch.out, /没跑到/)
  })

  test('配置写错（选测试之前就停了）时失败，不逐个核对', () => {
    const r = run('--vitest-arg=--config=broken.config.mjs', 'app/ok.test.ts')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /Startup Error[\s\S]*配置写错了/)
    assert.doesNotMatch(r.out, /没跑到/)
  })

  test('--vitest-arg 交给 Vitest', () => {
    const r = run('--vitest-arg=--testNamePattern=对', 'app/pick.test.ts')
    assert.equal(r.code, 0, r.out)
  })

  test('目录里找不到项目装的 vitest 时退出码 2，说清楚', () => {
    const r = spawnSync(BIN, ['run', 'vitest', 'app/ok.test.ts'], { cwd: dir, env: ENV, encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(r.stdout + r.stderr, /找不到项目装的 vitest/)
  })

  test('被中断时停掉 Vitest 和它跑测试的子进程、删掉临时文件，退出码 130', async () => {
    const pidFile = join(dir, 'worker.pid')
    // 跑测试的子进程一直忙着（同步地跑，不回头处理消息）：Vitest 退出时转告不到它，要 testpace 给整个进程组发信号才停得下来
    write('slow.test.ts', `import { expect, test } from 'vitest'\nimport { writeFileSync } from 'node:fs'\ntest('很慢', () => {\n  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n  const end = Date.now() + 60_000\n  while (Date.now() < end) {}\n  expect(1).toBe(1)\n}, 120_000)\n`)
    const child = spawn(BIN, ['run', 'vitest', '--cwd', 'app', 'app/slow.test.ts'], { cwd: dir, env: { ...ENV, TMPDIR: tmp }, stdio: 'ignore' })
    const closed = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
    while (!existsSync(pidFile)) await sleep(50)
    const worker = Number(readFileSync(pidFile, 'utf8'))
    // 只给 testpace 发：跑测试的子进程收不到这个信号，要靠 testpace 转给整个进程组
    child.kill('SIGTERM')
    const code = await Promise.race([closed, sleep(10_000, 'timeout' as const, { ref: false })])
    if (code === 'timeout') {
      for (const stray of [worker, child.pid!]) process.kill(stray, 'SIGKILL')
      assert.fail('testpace 被中断后 10 秒还没退出')
    }
    assert.equal(code, 130)
    // 子进程在 Vitest 退出后自己收尾，给它几秒
    let alive = true
    for (let i = 0; i < 50 && alive; i += 1) {
      try {
        process.kill(worker, 0)
        await sleep(100)
      } catch {
        alive = false
      }
    }
    if (alive) process.kill(worker, 'SIGKILL')
    assert.equal(alive, false, '跑测试的子进程没停')
    assert.deepEqual(readdirSync(tmp), [])
  })
})
