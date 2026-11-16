// 在示例项目的副本上跑真实的 testpace 命令：git 仓库、记录、计时、精简输出。

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import { landings } from '../src/git.ts'
import { BIN, ENV, gatedRepo, globalGitConfig, runs, sampleRepo, setConfig as setConfigWith, sh, tempDir, testpace as run } from './helpers.ts'

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
    assert.match(r.out, /^整组通过 · 2 个测试文件 · 用时 \d+秒 · 代码 [0-9a-f]{10}\n日志：.+\.log\n$/)
    const [record] = runs(repo)
    assert.equal(record!.kind, 'full')
    assert.equal(record!.result, 'pass')
    assert.equal(record!.tests, 2)
    assert.equal(record!.tree, record!.treeAtEnd)
    assert.equal(record!.tree, sh(repo, 'git rev-parse HEAD^{tree}').trim(), '没改动时记录的就是提交的树')
    // 先跑 full（测试以外的检查），再把 tests 规则找到的全部测试交给 files
    const log = readFileSync(record!.log as string, 'utf8')
    assert.match(log, /===== testpace 整组的检查（full）：node scripts\/full\.mjs\n[\s\S]*===== testpace 全部测试（2 个文件）：node scripts\/test-files\.mjs\n[\s\S]*(# pass 4|ℹ pass 4)/)
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
    assert.match(r.out, /^整组失败：全部测试（2 个文件）没通过（退出码 1）· 用时 \d+秒\n--- 输出节选 ---\n/)
    assert.match(r.out, /yuan shows two decimals/)
    assert.match(r.out, /完整日志：.+\.log\n$/)
    assert.equal(runs(repo).at(-1)!.result, 'fail')
  })

  test('status 说明当前代码没有通过记录、最近一次失败', () => {
    const r = testpace(repo, 'status')
    assert.equal(r.code, 0)
    assert.match(r.out, /^当前代码（[0-9a-f]{10}）：没有整组通过记录\n最近一次整组：失败（.+，是当前代码）\n  日志：/)
    assert.match(r.out, /配置（testpace\.json）：正常\n  fast: node scripts\/check\.mjs\n  files: node scripts\/test-files\.mjs\n  full: node scripts\/full\.mjs\n  tests: tests\/\*\*\/\*\.test\.mjs  → 找到 2 个测试文件，整组时全部交给 files\n  ignore: docs\/\*\*/)
  })
})

describe('结果的可信度', () => {
  test('跑的过程中代码改过，通过也不算记录', () => {
    const repo = sampleRepo()
    setConfig(repo, 'node scripts/full.mjs && echo changed > src/touched.mjs')
    sh(repo, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm config')
    const r = testpace(repo, 'full')
    assert.equal(r.code, 1)
    assert.match(r.out, /^整组通过，但跑的过程中代码改过，这次不算通过记录。变了的文件：src\/touched\.mjs\n是整组自己生成的文件，就加进 \.gitignore 或让它写到仓库外/)
    const status = testpace(repo, 'status')
    assert.match(status.out, /最近一次整组：通过，但跑的过程中代码改过/)
  })

  test('同一份代码先失败后通过，报告列出来和失败的日志', () => {
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
    assert.match(report.out, /先失败后通过：1 份代码整组先失败、后通过。[\s\S]*失败日志 .+\.log/)
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

  test('同时起两个整组，只有一个跑', async () => {
    const repo = sampleRepo()
    const go = join(tempDir('testpace-go-'), 'go')
    setConfig(repo, `while [ ! -f '${go}' ]; do sleep 0.1; done; node scripts/full.mjs`)
    sh(repo, `git add -A && git -c user.name=t -c user.email=t@t commit -qm slow`)
    const start = (): Promise<number | null> =>
      new Promise(resolve => spawn(BIN, ['full'], { cwd: repo, env: ENV }).on('close', resolve))
    const both = [start(), start()]
    await new Promise(r => setTimeout(r, 1500))
    writeFileSync(go, '')
    assert.deepEqual((await Promise.all(both)).sort(), [0, 3])
  })

  test('testpace 被强杀后测试还在跑，这个工作区照样算在跑，说清楚怎么停', { timeout: 60_000 }, async () => {
    const repo = sampleRepo()
    const go = join(tempDir('testpace-go-'), 'go')
    setConfig(repo, `while [ ! -f '${go}' ]; do sleep 0.1; done; node scripts/full.mjs`)
    sh(repo, `git add -A && git -c user.name=t -c user.email=t@t commit -qm slow`)
    const first = spawn(BIN, ['full'], { cwd: repo, env: ENV })
    const running = join(repo, '.git', 'testpace', 'running')
    const group = async (): Promise<boolean> => /"group"/.test(sh(running, 'cat *.json 2>/dev/null || true'))
    for (let i = 0; i < 100 && !(existsSync(running) && (await group())); i++) await new Promise(r => setTimeout(r, 50))
    first.kill('SIGKILL')
    await new Promise(resolve => first.on('close', resolve))
    const second = testpace(repo, 'full')
    assert.equal(second.code, 3)
    assert.match(second.out, /起它的 testpace 已经退出，测试进程组 (\d+) 还在跑，不要了用 kill -- -\1 停掉/)
    writeFileSync(go, '')
    for (let i = 0; i < 100 && testpace(repo, 'status').out.includes('正在跑'); i++) await new Promise(r => setTimeout(r, 100))
    assert.equal(testpace(repo, 'full').code, 0, '测试进程组结束后可以再跑')
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
    assert.match(r.out, /^整组失败：整组的检查（full）没通过，后面的没有跑（被信号 SIGKILL 终止）/)
  })

  test('被中断时停掉子进程，不记录结果', async () => {
    const repo = sampleRepo()
    setConfig(repo, 'sleep 37')
    const child = spawn(BIN, ['full'], { cwd: repo, env: ENV })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    const running = join(repo, '.git', 'testpace', 'running')
    // 登记里有了子进程组，中断处理才挂好；在这之前发信号，测的就不是中断处理了
    const started = () =>
      existsSync(running) &&
      readdirSync(running).some(name => name.endsWith('.json') && 'group' in JSON.parse(readFileSync(join(running, name), 'utf8')))
    for (let i = 0; i < 200 && !started(); i++) await new Promise(r => setTimeout(r, 50))
    assert.ok(started(), '整组没起来')
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

  test('files 的路径按当前目录算', () => {
    const repo = sampleRepo()
    const r = testpace(join(repo, 'tests'), 'files', 'format.test.mjs:5')
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(runs(repo).at(-1)!.files, ['tests/format.test.mjs:5'])
  })

  test('落地统计里的中文路径原样读出', () => {
    const repo = sampleRepo()
    writeFileSync(join(repo, 'tests', '价格.test.mjs'), 'a\nb\n')
    // 提交时间放在很久以前：从 0 起算的统计也要读到它（git 的 --since 会把 0 当成"现在"）
    sh(repo, 'git add -A && GIT_COMMITTER_DATE=@1000000000 git -c user.name=t -c user.email=t@t commit -qm zh')
    const files = landings(sh(repo, 'git rev-parse --show-toplevel').trim(), 'main', 0)[0]!.files
    assert.deepEqual(files, [{ path: 'tests/价格.test.mjs', added: 2 }])
  })

  test('report 的 --days 要是正整数', () => {
    const repo = sampleRepo()
    assert.equal(testpace(repo, 'report', '--days', 'x').code, 2)
  })
})

describe('testpace verify', () => {
  test('守约定的项目：各项都通过，不记进运行记录', () => {
    const repo = gatedRepo()
    const r = testpace(repo, 'verify', 'tests/price.test.mjs')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^通过　testpace\.json 写得对\n通过　找得到 fast 的命令（node scripts\/check\.mjs）\n通过　找得到 files 的命令[\s\S]*\n通过　合并门在把关\n通过　tests 规则找到测试文件（2 个）\n通过　整组会跑到 tests\/price\.test\.mjs\n/)
    assert.match(r.out, /\n通过　files 给了不存在的文件要失败（testpace-verify-no-such-file\.test\.js）\n通过　files 跑 tests\/price\.test\.mjs 要通过\n通过　tests\/price\.test\.mjs 里混进一个不存在的路径要失败\n通过　文件:行号 要能用（tests\/price\.test\.mjs:5）\n通过　文件:行号:列号 要能用（tests\/price\.test\.mjs:5:1）\n没查　整组（node scripts\/full\.mjs，再加上 tests 找到的全部测试）/)
    assert.match(r.out, /\n接入核对：查了的都通过，1 项没查。\n$/)
    assert.deepEqual(runs(repo), [], '核对跑的 files 不算开发中的测试')
    // 路径按当前目录算
    assert.equal(run(join(repo, 'tests'), ['verify', 'price.test.mjs']).code, 0)
  })

  test('没给测试文件：只查不存在的文件，说清楚其余没查', () => {
    const r = testpace(gatedRepo(), 'verify')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /通过　files 给了不存在的文件要失败[\s\S]*没查　其余几项要测试文件：testpace verify <测试文件>\.\.\.，每种测试[\s\S]*接入核对：查了的都通过，2 项没查。/)
  })

  test('files 不守约定时逐项说出来', () => {
    const repo = gatedRepo()
    // 只跑找得到的文件、找不到的悄悄跳过：给了不存在的文件也报通过
    writeFileSync(join(repo, 'scripts', 'lax.mjs'), "import { spawnSync } from 'node:child_process'\nimport { existsSync } from 'node:fs'\nconst files = process.argv.slice(2).filter(f => existsSync(f))\nprocess.exit(files.length ? spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' }).status : 0)\n")
    setConfigWith(repo, { files: 'node scripts/lax.mjs' })
    const lax = testpace(repo, 'verify', 'tests/price.test.mjs')
    assert.equal(lax.code, 1)
    assert.match(lax.out, /没通过　files 给了不存在的文件要失败（testpace-verify-no-such-file\.test\.js）：实际通过了，日志 .+\.log/)
    assert.match(lax.out, /没通过　tests\/price\.test\.mjs 里混进一个不存在的路径要失败：实际通过了/)
    // 文件都要在，但不认 文件:行号
    writeFileSync(join(repo, 'scripts', 'strict.mjs'), "import { spawnSync } from 'node:child_process'\nimport { existsSync } from 'node:fs'\nconst files = process.argv.slice(2)\nif (files.some(f => !existsSync(f))) process.exit(2)\nprocess.exit(spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' }).status)\n")
    setConfigWith(repo, { files: 'node scripts/strict.mjs' })
    const strict = testpace(repo, 'verify', 'tests/price.test.mjs')
    assert.equal(strict.code, 1)
    assert.match(strict.out, /通过　tests\/price\.test\.mjs 里混进一个不存在的路径要失败\n没通过　文件:行号 要能用（tests\/price\.test\.mjs:5）：实际失败了（退出码 2）/)
    assert.match(strict.out, /接入核对：2 项没通过，1 项没查。/)
  })

  test('给的测试文件本身不通过：后面几项不查；文件不存在是用法问题', () => {
    const repo = gatedRepo()
    writeFileSync(join(repo, 'tests', 'broken.test.mjs'), "import { test } from 'node:test'\ntest('坏的', () => { throw new Error('x') })\n")
    const r = testpace(repo, 'verify', 'tests/broken.test.mjs')
    assert.equal(r.code, 1)
    assert.match(r.out, /没通过　files 跑 tests\/broken\.test\.mjs 要通过：实际失败了[\s\S]*没查　tests\/broken\.test\.mjs 的其余几项要这个文件先能通过/)
    const missing = testpace(repo, 'verify', 'tests/nope.test.mjs')
    assert.equal(missing.code, 2)
    assert.match(missing.out, /找不到测试文件 tests\/nope\.test\.mjs/)
    const outside = join(tempDir('testpace-outside-'), 'x.test.mjs')
    writeFileSync(outside, '')
    assert.equal(testpace(repo, 'verify', outside).code, 2, '仓库外的文件不算')
  })

  test('几个测试文件：逐个核对，再核对一起交给 files；一个不通过不影响别的', () => {
    const repo = gatedRepo()
    const r = testpace(repo, 'verify', 'tests/price.test.mjs', 'tests/format.test.mjs', 'tests/price.test.mjs')
    assert.equal(r.code, 0, r.out)
    assert.equal(r.out.split('files 跑 tests/price.test.mjs 要通过').length, 2, '重复给的文件只核对一次')
    assert.match(r.out, /通过　文件:行号:列号 要能用（tests\/price\.test\.mjs:5:1）\n通过　files 跑 tests\/format\.test\.mjs 要通过\n通过　tests\/format\.test\.mjs 里混进一个不存在的路径要失败\n/)
    assert.match(r.out, /\n通过　几个文件一起交给 files 要通过（tests\/price\.test\.mjs tests\/format\.test\.mjs）\n没查　整组/)
    assert.match(r.out, /接入核对：查了的都通过，1 项没查。/)

    writeFileSync(join(repo, 'tests', 'broken.test.mjs'), "import { test } from 'node:test'\ntest('坏的', () => { throw new Error('x') })\n")
    const broken = testpace(repo, 'verify', 'tests/broken.test.mjs', 'tests/price.test.mjs')
    assert.equal(broken.code, 1)
    assert.match(broken.out, /没查　tests\/broken\.test\.mjs 的其余几项要这个文件先能通过[^\n]*\n通过　files 跑 tests\/price\.test\.mjs 要通过\n/)
    assert.doesNotMatch(broken.out, /几个文件一起/, '能通过的只剩一个，不用一起交')

    // 一次只接得住一个文件：分开核对都对，一起交给它就失败
    writeFileSync(join(repo, 'scripts', 'single.mjs'), "import { spawnSync } from 'node:child_process'\nimport { existsSync } from 'node:fs'\nconst args = process.argv.slice(2)\nconst file = (args[0] ?? '').replace(/(:\\d+){1,2}$/, '')\nif (args.length !== 1 || !existsSync(file)) process.exit(2)\nprocess.exit(spawnSync(process.execPath, ['--test', file], { stdio: 'inherit' }).status)\n")
    setConfigWith(repo, { files: 'node scripts/single.mjs' })
    const single = testpace(repo, 'verify', 'tests/price.test.mjs', 'tests/format.test.mjs')
    assert.equal(single.code, 1, single.out)
    assert.match(single.out, /没通过　几个文件一起交给 files 要通过（tests\/price\.test\.mjs tests\/format\.test\.mjs）：实际失败了（退出码 2）/)
    assert.match(single.out, /接入核对：1 项没通过，1 项没查。/)
  })

  test('合并门没在把关、testpace.json 有问题都算没通过', () => {
    const r = testpace(sampleRepo(), 'verify', 'tests/price.test.mjs')
    assert.equal(r.code, 1)
    assert.match(r.out, /没通过　合并门在把关：合并门没配/)
    const repo = gatedRepo()
    setConfigWith(repo, { extra: 'x' })
    const extra = testpace(repo, 'verify')
    assert.equal(extra.code, 1)
    assert.match(extra.out, /^没通过　testpace\.json 写得对：未知字段 "extra"\n/)
    assert.match(extra.out, /接入核对：1 项没通过，2 项没查。/)
  })
})

describe('整组跑 tests 规则找到的全部测试', () => {
  test('新加的测试文件不用改配置，整组就会跑到它', () => {
    const repo = sampleRepo()
    writeFileSync(join(repo, 'tests', 'new.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('new rule', () => assert.equal(1, 2))\n")
    const r = testpace(repo, 'full')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^整组失败：全部测试（3 个文件）没通过/)
    assert.match(r.out, /new rule/)
    assert.equal(runs(repo).at(-1)!.tests, 3)
  })

  test('以 ! 开头的规则排除的文件不跑', () => {
    const repo = sampleRepo()
    writeFileSync(join(repo, 'tests', 'slow.test.mjs'), "import { test } from 'node:test'\ntest('slow', () => { throw new Error('不该跑') })\n")
    setConfigWith(repo, { tests: ['tests/**/*.test.mjs', '!tests/slow.test.mjs'] })
    const r = testpace(repo, 'full')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^整组通过 · 2 个测试文件/)
    assert.doesNotMatch(readFileSync(runs(repo).at(-1)!.log as string, 'utf8'), /slow/)
  })

  test('规则一个测试都没找到、或没写 tests：不跑，不留记录', () => {
    const repo = sampleRepo()
    setConfigWith(repo, { tests: ['spec/**/*.test.mjs'] })
    const none = testpace(repo, 'full')
    assert.equal(none.code, 2, none.out)
    assert.match(none.out, /按 tests 规则（spec\/\*\*\/\*\.test\.mjs）在工作区里没找到测试文件/)
    const config = JSON.parse(readFileSync(join(repo, 'testpace.json'), 'utf8'))
    delete config.tests
    writeFileSync(join(repo, 'testpace.json'), JSON.stringify(config))
    const missing = testpace(repo, 'full')
    assert.equal(missing.code, 2, missing.out)
    assert.match(missing.out, /缺少 "tests"/)
    assert.deepEqual(runs(repo), [])
  })

  test('verify：给的测试文件不在 tests 规则里，整组跑不到它这一类', () => {
    const repo = gatedRepo()
    setConfigWith(repo, { tests: ['tests/format.test.mjs'] })
    const r = testpace(repo, 'verify', 'tests/price.test.mjs')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /\n没通过　整组会跑到 tests\/price\.test\.mjs：它不在 tests 规则里/)
  })
})

describe('附加检查', () => {
  const withChecks = (...checks: string[]): NodeJS.ProcessEnv => {
    const env = { ...ENV, GIT_CONFIG_GLOBAL: globalGitConfig() }
    for (const check of checks) sh(process.cwd(), `git config --file '${env.GIT_CONFIG_GLOBAL}' --add testpace.check '${check}'`)
    return env
  }

  test('先依次跑本机登记的附加检查，再跑整组，都过了才算通过', () => {
    const repo = sampleRepo()
    const env = withChecks('echo 第一条', 'echo 第二条')
    const r = run(repo, ['full'], env)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /附加检查通过：echo 第一条、echo 第二条/)
    const record = runs(repo).at(-1)!
    assert.equal(record.result, 'pass')
    assert.deepEqual(record.checks, ['echo 第一条', 'echo 第二条'])
    const text = readFileSync(record.log as string, 'utf8')
    assert.match(text, /===== testpace 附加检查：echo 第二条\n第二条/)
    assert.ok(text.indexOf('第二条') < text.indexOf('===== testpace 整组的检查（full）：'), text)
    assert.match(text, /===== testpace 全部测试（2 个文件）：[^\n]*\n(.*\n)*# pass/)
    assert.match(run(repo, ['status'], env).out, /附加检查（全局 git 配置 testpace\.check）：echo 第一条、echo 第二条，整组之前先跑/)
  })

  test('附加检查没过：不跑整组，不算通过，合并门照常拦', () => {
    const repo = sampleRepo()
    const env = withChecks('echo 放水了 && exit 1')
    const r = run(repo, ['full'], env)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^整组失败：附加检查 echo 放水了 && exit 1 没通过，后面的没有跑/)
    assert.match(r.out, /输出节选 ---\n(.*\n)*放水了/)
    const record = runs(repo).at(-1)!
    assert.equal(record.result, 'fail')
    assert.doesNotMatch(readFileSync(record.log as string, 'utf8'), /===== testpace (整组的检查|全部测试)|# pass/)
    assert.match(run(repo, ['status'], env).out, /没有整组通过记录/)
  })

  test('前一条附加检查没过、后一条过了：照样不算通过，后一条不再跑', () => {
    const repo = sampleRepo()
    const env = withChecks('exit 1', 'echo 后一条')
    const r = run(repo, ['full'], env)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /附加检查 exit 1 没通过/)
    const record = runs(repo).at(-1)!
    assert.equal(record.result, 'fail')
    assert.doesNotMatch(readFileSync(record.log as string, 'utf8'), /后一条\n/)
  })

  test('登记的命令找不到：说明怎么取消登记', () => {
    const repo = sampleRepo()
    const r = run(repo, ['full'], withChecks('testpace-no-such-check'))
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /命令找不到.*unset-all testpace\.check 'testpace-no-such-check'/)
  })

  test('附加检查过了、整组失败：不算通过，节选是整组的输出；没登记时照旧', () => {
    const repo = sampleRepo()
    setConfig(repo, 'echo 整组输出 && exit 1')
    const r = run(repo, ['full'], withChecks('echo 检查输出'))
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^整组失败：整组的检查（full）没通过，后面的没有跑/)
    const excerpt = r.out.split('输出节选')[1] as string
    assert.match(excerpt, /整组输出/)
    assert.doesNotMatch(excerpt, /检查输出/)
    assert.equal(runs(repo).at(-1)!.result, 'fail')
    assert.match(run(repo, ['status']).out, /附加检查（全局 git 配置 testpace\.check）：没有/)
  })
})
