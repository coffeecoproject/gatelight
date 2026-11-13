// 在示例项目的副本上跑真实的 testpace 命令：git 仓库、记录、计时、精简输出。

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import { BIN, ENV, runs, sampleRepo, setConfig as setConfigWith, sh, tempDir, testpace as run } from './helpers.ts'

const testpace = (cwd: string, ...args: string[]) => run(cwd, args)
const setConfig = (repo: string, full: string): void => setConfigWith(repo, { full })

describe('testpace full', () => {
  let repo: string
  before(() => {
    repo = sampleRepo()
  })

  test('整组通过时记下结果、用时和日志，输出只有结论', () => {
    const r = testpace(repo, 'full')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^整组通过 · 用时 \d+秒 · 代码 [0-9a-f]{10}\n日志：.+\.log\n$/)
    const [record] = runs(repo)
    assert.equal(record!.kind, 'full')
    assert.equal(record!.result, 'pass')
    assert.equal(record!.tree, record!.treeAtEnd)
    assert.equal(record!.tree, sh(repo, 'git rev-parse HEAD^{tree}').trim(), '没改动时记录的就是提交的树')
    assert.match(readFileSync(record!.log as string, 'utf8'), /# pass 4|ℹ pass 4/)
  })

  test('同一份代码不重跑', () => {
    const r = testpace(repo, 'full')
    assert.equal(r.code, 0)
    assert.match(r.out, /^这份代码有整组通过记录（.+），不重跑。/)
    assert.equal(runs(repo).length, 1)
  })

  test('只改了 ignore 里的路径，记录继续有效', () => {
    writeFileSync(join(repo, 'docs', 'README.md'), '# 改过的说明\n')
    const r = testpace(repo, 'full')
    assert.match(r.out, /相对那次只改了忽略路径：docs\/README\.md，不重跑/)
    assert.equal(runs(repo).length, 1)
  })

  test('新加未跟踪的文件也算改动，要重跑', () => {
    writeFileSync(join(repo, 'src', 'extra.mjs'), 'export const x = 1\n')
    const r = testpace(repo, 'full')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^整组通过/)
    assert.equal(runs(repo).length, 2)
    assert.equal(sh(repo, 'git status --porcelain'), ' M docs/README.md\n?? src/extra.mjs\n', '不动真实索引')
  })

  test('整组失败时给出失败节选和日志路径，退出码非零', () => {
    writeFileSync(join(repo, 'src', 'format.mjs'), 'export function yuan(amount) {\n  return `¥${amount}`\n}\n')
    const r = testpace(repo, 'full')
    assert.equal(r.code, 1)
    assert.match(r.out, /^整组失败（退出码 1）· 用时 \d+秒\n--- 输出节选 ---\n/)
    assert.match(r.out, /yuan shows two decimals/)
    assert.match(r.out, /完整日志：.+\.log\n$/)
    assert.equal(runs(repo).at(-1)!.result, 'fail')
  })

  test('status 说明当前代码没有通过记录、最近一次失败', () => {
    const r = testpace(repo, 'status')
    assert.equal(r.code, 0)
    assert.match(r.out, /^当前代码（[0-9a-f]{10}）：没有整组通过记录\n最近一次整组：失败（.+，是当前代码）\n  日志：/)
    assert.match(r.out, /配置（testpace\.json）：正常\n  fast: node scripts\/check\.mjs\n  files: node scripts\/test-files\.mjs\n  full: node scripts\/full\.mjs\n  ignore: docs\/\*\*/)
  })
})

describe('结果的可信度', () => {
  test('跑的过程中代码改过，通过也不算记录', () => {
    const repo = sampleRepo()
    setConfig(repo, 'node scripts/full.mjs && echo changed > src/touched.mjs')
    sh(repo, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm config')
    const r = testpace(repo, 'full')
    assert.equal(r.code, 1)
    assert.match(r.out, /^整组通过，但跑的过程中代码改过，这次不算通过记录/)
    const status = testpace(repo, 'status')
    assert.match(status.out, /最近一次整组：通过，但跑的过程中代码改过/)
  })

  test('同一份代码先失败后通过，报告标为不稳定', () => {
    const repo = sampleRepo()
    const flag = join(tempDir('testpace-flag-'), 'ok')
    setConfig(repo, `node scripts/full.mjs && test -f '${flag}'`)
    assert.equal(testpace(repo, 'full').code, 1)
    writeFileSync(flag, '')
    assert.equal(testpace(repo, 'full').code, 0)
    const report = testpace(repo, 'report')
    assert.equal(report.code, 0)
    assert.match(report.out, /full\s+2\s+1\s+1/)
    assert.match(report.out, /整组失败 1 次；失败后平均重跑 1\.0 轮才通过/)
    assert.match(report.out, /不稳定：1 份代码整组先失败、后通过/)
  })

  test('有整组在跑时 status 显示出来，同一工作区、别的工作区的同一份代码都不再起第二个', async () => {
    const repo = sampleRepo()
    const go = join(tempDir('testpace-go-'), 'go')
    const other = join(tempDir('testpace-wt-'), 'wt')
    setConfig(repo, `while [ ! -f '${go}' ]; do sleep 0.1; done; node scripts/full.mjs`)
    sh(repo, `git add -A && git -c user.name=t -c user.email=t@t commit -qm slow && git worktree add -q --detach '${other}'`)
    const first = spawn(BIN, ['full'], { cwd: repo, env: ENV })
    let out = ''
    first.stdout.on('data', chunk => (out += chunk))
    const running = join(repo, '.git', 'testpace', 'running')
    for (let i = 0; i < 100 && !(existsSync(running) && sh(running, 'ls').trim()); i++) await new Promise(r => setTimeout(r, 50))

    assert.match(testpace(repo, 'status').out, /正在跑：full，开始于 .+，开始后代码没改过/)
    const second = testpace(repo, 'full')
    assert.equal(second.code, 3)
    assert.match(second.out, /^这个工作区已有整组在跑/)
    const elsewhere = testpace(other, 'full')
    assert.equal(elsewhere.code, 3)
    assert.match(elsewhere.out, /^工作区 .+ 正在跑同一份代码的整组/)

    writeFileSync(go, '')
    const code = await new Promise(resolve => first.on('close', resolve))
    assert.equal(code, 0, out)
    assert.doesNotMatch(testpace(repo, 'status').out, /正在跑/)
    // 记录所有工作区共用：另一个工作区里同一份代码直接算通过
    assert.match(testpace(other, 'full').out, /^这份代码有整组通过记录/)
  })

  test('同一个工作区一次只跑一轮：整组在跑时 files、focused 不跑，files 在跑时整组不跑', { timeout: 60_000 }, async () => {
    const repo = sampleRepo()
    const go = join(tempDir('testpace-go-'), 'go')
    const wait = `while [ ! -f '${go}' ]; do sleep 0.1; done;`
    setConfigWith(repo, { full: `${wait} node scripts/full.mjs`, files: `${wait} node scripts/test-files.mjs` })
    sh(repo, `git add -A && git -c user.name=t -c user.email=t@t commit -qm slow`)
    const running = join(repo, '.git', 'testpace', 'running')
    const started = async (): Promise<void> => {
      for (let i = 0; i < 100 && !(existsSync(running) && sh(running, 'ls').trim()); i++) await new Promise(r => setTimeout(r, 50))
    }

    const full = spawn(BIN, ['full'], { cwd: repo, env: ENV })
    await started()
    const files = testpace(repo, 'files', 'tests/format.test.mjs')
    assert.equal(files.code, 3)
    assert.match(files.out, /^这个工作区正在跑整组（开始于 .+，进程 \d+），同一个工作区一次只跑一轮测试，等它结束再跑。$/m)
    writeFileSync(join(repo, 'src', 'extra.mjs'), 'export const x = 1\n')
    const focused = testpace(repo, 'focused')
    assert.equal(focused.code, 3)
    assert.match(focused.out, /那次整组开始后代码改过，它跑完的结果不算当前代码的记录。/)
    assert.deepEqual(runs(repo), [], '没跑的不留记录')
    writeFileSync(go, '')
    await new Promise(resolve => full.on('close', resolve))

    rmSync(go)
    const slowFiles = spawn(BIN, ['files', 'tests/format.test.mjs'], { cwd: repo, env: ENV })
    await started()
    assert.match(testpace(repo, 'status').out, /正在跑：files/)
    const second = testpace(repo, 'full')
    assert.equal(second.code, 3)
    assert.match(second.out, /^这个工作区正在跑 files （开始于/)
    writeFileSync(go, '')
    assert.equal(await new Promise(resolve => slowFiles.on('close', resolve)), 0)
    assert.equal(sh(running, 'ls').trim(), '', 'files 跑完删掉在跑的记录')
  })

  test('标了 assume-unchanged 的文件改了也算改动', () => {
    const repo = sampleRepo()
    assert.equal(testpace(repo, 'full').code, 0)
    sh(repo, 'git update-index --assume-unchanged src/format.mjs')
    writeFileSync(join(repo, 'src', 'format.mjs'), 'export function yuan(amount) {\n  return `¥${amount}`\n}\n')
    assert.equal(sh(repo, 'git status --porcelain'), '', 'git 自己看不到这个改动')
    assert.match(testpace(repo, 'status').out, /^当前代码（[0-9a-f]{10}）：没有整组通过记录/)
    assert.equal(sh(repo, 'git ls-files -v src/format.mjs'), 'h src/format.mjs\n', '不动真实索引的标记')
  })

  test('整组被信号终止时说明是哪个信号', () => {
    const repo = sampleRepo()
    setConfig(repo, 'kill -KILL $$')
    const r = testpace(repo, 'full')
    assert.equal(r.code, 1)
    assert.match(r.out, /^整组失败（被信号 SIGKILL 终止）/)
  })

  test('被中断时停掉子进程，不记录结果', async () => {
    const repo = sampleRepo()
    setConfig(repo, 'sleep 37')
    const child = spawn(BIN, ['full'], { cwd: repo, env: ENV })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    const running = join(repo, '.git', 'testpace', 'running')
    for (let i = 0; i < 100 && !(existsSync(running) && sh(running, 'ls').trim()); i++) await new Promise(r => setTimeout(r, 50))
    // bin/testpace 用 exec 换成 node，pid 就是 testpace 进程
    child.kill('SIGTERM')
    const code = await new Promise(resolve => child.on('close', resolve))
    assert.equal(code, 130)
    assert.match(out, /^整组被中断，没有记录结果/)
    assert.deepEqual(runs(repo), [])
    assert.equal(sh(repo, "pgrep -f 'sleep 37' || true").trim(), '', '子进程组一起停了')
  })
})

describe('配置和报告', () => {
  test('没有 testpace.json 时说明原因', () => {
    const repo = sampleRepo()
    rmSync(join(repo, 'testpace.json'))
    const r = testpace(repo, 'full')
    assert.equal(r.code, 2)
    assert.match(r.out, /没法跑整组：仓库根目录没有 testpace\.json/)
    assert.match(testpace(repo, 'status').out, /配置（testpace\.json）：仓库根目录没有 testpace\.json/)
    // 指到插件里的接入说明，路径要真的存在
    const guide = /接入说明见 (\S+SKILL\.md)/.exec(r.out)?.[1]
    assert.ok(guide && existsSync(guide), r.out)
  })

  test('status 标出找不到的命令', () => {
    const repo = sampleRepo()
    setConfig(repo, 'no-such-tool-xyz run')
    assert.match(testpace(repo, 'status').out, /full: no-such-tool-xyz run {2}← 找不到这个命令/)
  })

  test('在子目录里运行也找到仓库根目录', () => {
    const repo = sampleRepo()
    const r = testpace(join(repo, 'src'), 'full')
    assert.equal(r.code, 0, r.out)
  })

  test('不在 git 仓库里时说明', () => {
    const dir = tempDir('testpace-nogit-')
    const r = testpace(dir, 'status')
    assert.equal(r.code, 2)
    assert.match(r.out, /testpace 要在 git 仓库里运行/)
  })

  test('报告统计默认分支落地的测试行和主代码行', () => {
    const repo = sampleRepo()
    testpace(repo, 'full')
    const r = testpace(repo, 'report', '--days', '7')
    assert.equal(r.code, 0)
    assert.match(r.out, /^testpace 报告 · 最近 7 天 · /)
    assert.match(r.out, /full\s+1\s+1\s+0/)
    // 示例项目：src 两个文件 9 行，tests 两个文件 22 行，scripts 三个文件也是主代码
    assert.match(r.out, /测试量和整组耗时（按周，落地到 main/)
    assert.match(r.out, /\d{4}-\d{2}-\d{2}\s+1\s+22\s+\d+\s+\d\.\d\d\s+1\s+\d+秒/)
  })

  test('示例项目的 files 符合约定：只跑给定文件，文件不存在或没跑到测试时非零', () => {
    const repo = sampleRepo()
    const files = (...args: string[]): number | null =>
      spawnSync(process.execPath, ['scripts/test-files.mjs', ...args], { cwd: repo, env: ENV }).status
    writeFileSync(join(repo, 'tests', 'empty.test.mjs'), "import { test } from 'node:test'\n")
    assert.equal(files('tests/format.test.mjs'), 0)
    assert.equal(files('tests/missing.test.mjs'), 2)
    assert.equal(files('tests/format.test.mjs', 'tests/empty.test.mjs'), 1)
    // 文件:行号：node --test 不能按行跑，跑整个文件；文件不存在照样失败
    assert.equal(files('tests/format.test.mjs:5'), 0)
    assert.equal(files('tests/missing.test.mjs:5'), 2)
  })

  test('files 接受 文件:行号，原样交给项目的命令并记下', () => {
    const repo = sampleRepo()
    const r = testpace(repo, 'files', 'tests/format.test.mjs:5', 'tests/price.test.mjs:9:1')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^2 处测试通过 · 用时/)
    assert.deepEqual(runs(repo).at(-1)!.files, ['tests/format.test.mjs:5', 'tests/price.test.mjs:9:1'])
    assert.match(readFileSync(runs(repo).at(-1)!.log as string, 'utf8'), /不能按行跑，这些跑整个文件：tests\/format.test.mjs:5/)
  })

  test('report 的 --days 要是正整数', () => {
    const repo = sampleRepo()
    assert.equal(testpace(repo, 'report', '--days', 'x').code, 2)
  })
})
