// testpace run node-test：用 node:test 跑测试文件，守 files 的约定。在临时目录里放测试文件，跑真实的命令。

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { before, describe, test } from 'node:test'
import { BIN, ENV, sampleRepo, setConfig, tempDir, testpace, type Result } from './helpers.ts'

const PASSING = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('一加一', () => assert.equal(1 + 1, 2))\n"

describe('testpace run node-test', () => {
  let dir: string
  /** 只给这些命令用的临时目录：看 testpace 有没有把自己的临时文件删干净。 */
  let tmp: string
  const run = (...args: string[]): Result => {
    const r = spawnSync(BIN, ['run', 'node-test', ...args], { cwd: dir, env: { ...ENV, TMPDIR: tmp }, encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
  }

  before(() => {
    dir = tempDir('testpace-run-')
    tmp = join(dir, 'tmp')
    mkdirSync(tmp)
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'ok.test.mjs'), PASSING)
    writeFileSync(join(dir, 'empty.test.mjs'), "import { test } from 'node:test'\n")
    writeFileSync(join(dir, 'broken.test.mjs'), "throw new Error('加载就出错')\n")
    writeFileSync(join(dir, 'skipped.test.mjs'), "import { test } from 'node:test'\ntest('先不跑', { skip: true }, () => {})\n")
    writeFileSync(join(dir, 'partly.test.mjs'), `${PASSING}test('这个先不跑', { skip: true }, () => {})\n`)
    writeFileSync(join(dir, 'failing.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('算错', () => assert.equal(1 + 1, 3))\n")
    writeFileSync(join(dir, 'global.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('预加载过', () => assert.equal(globalThis.preloaded, true))\n")
    writeFileSync(join(dir, 'setup.mjs'), 'globalThis.preloaded = true\n')
  })

  test('文件不存在或不是文件时退出码 2，一个测试都不跑', () => {
    const r = run('ok.test.mjs', 'nope.test.mjs', 'sub')
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /找不到测试文件：nope\.test\.mjs、sub/)
    assert.doesNotMatch(r.out, /一加一/)
  })

  test('文件里一个测试都没有、或没加载起来时失败并点名，同批的文件照样跑', () => {
    const r = run('empty.test.mjs', 'broken.test.mjs', 'ok.test.mjs')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✔ 一加一/)
    assert.match(r.out, /一个测试都没跑到（没加载起来，或里面没有测试）：empty\.test\.mjs、broken\.test\.mjs\n/)
  })

  test('测试没过时失败，也点名没跑到测试的文件', () => {
    assert.equal(run('failing.test.mjs').code, 1)
    const r = run('failing.test.mjs', 'empty.test.mjs')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✖ 算错/)
    assert.match(r.out, /一个测试都没跑到（没加载起来，或里面没有测试）：empty\.test\.mjs\n/)
  })

  test('测试全被跳过不算失败，但要说一句', () => {
    const r = run('skipped.test.mjs', 'partly.test.mjs')
    assert.equal(r.code, 0, r.out)
    // 只跳过了一部分的不算
    assert.match(r.out, /这些文件的测试这次全被跳过，什么都没验证：skipped\.test\.mjs\n/)
  })

  test('认 文件:行号 和 文件:行号:列号：整个文件跑一次，说一句', () => {
    const r = run('ok.test.mjs:3', 'ok.test.mjs:3:1', 'ok.test.mjs')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /node:test 不能按行跑，这些整个文件跑：ok\.test\.mjs:3、ok\.test\.mjs:3:1\n/)
    assert.equal(r.out.match(/✔ 一加一/g)?.length, 1, r.out)
  })

  test('--cwd 换 node 的目录，文件仍按当前目录算；--node-arg 交给 node', () => {
    const r = run('--cwd', 'sub', '--node-arg=--import=../setup.mjs', 'global.test.mjs')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /✔ 预加载过/)
  })

  test('不认识的选项、没给文件、--cwd 目录不存在时退出码 2', () => {
    assert.equal(run('--bogus', 'ok.test.mjs').code, 2)
    assert.equal(run().code, 2)
    assert.equal(run('--cwd').code, 2)
    const r = run('--cwd', 'nowhere', 'ok.test.mjs')
    assert.equal(r.code, 2)
    assert.match(r.out, /--cwd 给的目录不存在：nowhere/)
  })

  test('跑完不留临时文件', () => {
    assert.deepEqual(readdirSync(tmp), [])
  })

  test('被中断时停掉 node、删掉临时文件，退出码 130', async () => {
    const pidFile = join(dir, 'node.pid')
    writeFileSync(join(dir, 'slow.test.mjs'), `import { test } from 'node:test'\nimport { writeFileSync } from 'node:fs'\ntest('很慢', async () => {\n  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n  await new Promise(resolve => setTimeout(resolve, 60_000))\n})\n`)
    const child = spawn(BIN, ['run', 'node-test', 'slow.test.mjs'], { cwd: dir, env: { ...ENV, TMPDIR: tmp }, stdio: 'ignore' })
    const closed = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
    while (!existsSync(pidFile)) await sleep(50)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    child.kill('SIGTERM')
    // 测试要等一分钟才结束：testpace 没把 node 停掉，就等不到它在几秒内退出
    const code = await Promise.race([closed, sleep(10_000, 'timeout' as const, { ref: false })])
    if (code === 'timeout') {
      for (const stray of [pid, child.pid!]) process.kill(stray, 'SIGKILL')
      assert.fail('testpace 被中断后 10 秒还没退出，跑测试的 node 没停')
    }
    assert.equal(code, 130)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, '跑测试的 node 也停了')
    assert.deepEqual(readdirSync(tmp), [])
  })
})

describe('files 里写 testpace run', () => {
  test('PATH 上没有 testpace 也找得到：跑项目命令时用的就是正在跑的这一版', () => {
    const repo = sampleRepo()
    setConfig(repo, { files: 'testpace run node-test' })
    const path = (ENV.PATH ?? '').split(delimiter).filter(entry => !existsSync(join(entry, 'testpace'))).join(delimiter)
    const env = { ...ENV, PATH: path }
    const status = testpace(repo, ['status'], env)
    assert.match(status.out, /files: testpace run node-test\n/, status.out)
    const r = testpace(repo, ['files', 'tests/price.test.mjs:1'], env)
    assert.equal(r.code, 0, r.out)
  })
})
