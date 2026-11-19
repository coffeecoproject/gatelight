// 在示例项目的副本上跑真实的 testpace 命令：git 仓库、记录、计时、精简输出。

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import { landings } from '../src/base/git.ts'
import { BIN, commit, ENV, gatedRepo, globalGitConfig, runs, sampleRepo, setConfig as setConfigWith, sh, tempDir, testpace as run } from './helpers.ts'

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
    commit(repo, '配置')
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
    commit(repo, '配置')
    const r = testpace(repo, 'full')
    assert.equal(r.code, 1)
    assert.match(r.out, /^整组失败：整组的检查（full）没通过，后面的没有跑（被信号 SIGKILL 终止）/)
  })

  test('被中断时停掉子进程，不记录结果', async () => {
    const repo = sampleRepo()
    setConfig(repo, 'sleep 37')
    commit(repo, '配置')
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

  test('被中断时等子进程组都退完才退出：组里有进程收到信号后过一会儿才退，testpace 退出时它也已经不在了', async () => {
    const repo = sampleRepo()
    const pidFile = join(tempDir('testpace-linger-'), 'pid')
    // full 的命令：起一个同组的子进程，它收到 TERM 后过 1 秒才退（记下它的进程号）；命令自己收到 TERM 马上退
    writeFileSync(
      join(repo, 'scripts', 'linger.mjs'),
      [
        "import { spawn } from 'node:child_process'",
        "import { writeFileSync } from 'node:fs'",
        `const slow = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1000)); setInterval(() => {}, 1000); console.log('ready')"`,
        "const child = spawn(process.execPath, ['-e', slow], { stdio: ['ignore', 'pipe', 'ignore'] })",
        "process.on('SIGTERM', () => process.exit(0))",
        '// 子进程挂好信号处理以后才记下进程号：在这之前发信号，它会直接被停掉',
        "child.stdout.once('data', () => writeFileSync(process.env.LINGER_PID, String(child.pid)))",
        'setInterval(() => {}, 1000)',
        '',
      ].join('\n'),
    )
    setConfig(repo, 'node scripts/linger.mjs')
    commit(repo, '配置')
    const child = spawn(BIN, ['full'], { cwd: repo, env: { ...ENV, LINGER_PID: pidFile }, stdio: 'ignore' })
    const closed = new Promise<number | null>(resolve => child.on('close', resolve))
    for (let i = 0; i < 400 && !existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 50))
    assert.ok(existsSync(pidFile), '整组的命令没起来')
    const lingering = Number(readFileSync(pidFile, 'utf8'))
    child.kill('SIGTERM')
    assert.equal(await closed, 130)
    // 不等：testpace 说自己被中断、退出了，它起的进程就都该不在了（不然这个工作区还占着端口、测试库，下一轮会撞上）
    assert.throws(() => process.kill(lingering, 0), { code: 'ESRCH' }, '收到信号后过一会儿才退的进程，testpace 退出时还在')
  })
})

describe('testpace hold / release：借用这个工作区（比如 testcraft 建副本），查和占是同一步', () => {
  /** 在 repo 里起一次停在那里的 files（等 go 文件出现才跑），等它登记好测试的进程组，返回登记的运行 id。 */
  const slowFiles = async (repo: string): Promise<{ id: string; go: () => void; done: Promise<unknown>; kill: () => void }> => {
    const go = join(tempDir('testpace-go-'), 'go')
    setConfigWith(repo, { files: `while [ ! -f '${go}' ]; do sleep 0.1; done; node scripts/test-files.mjs` })
    sh(repo, 'git add -A && git -c user.name=t -c user.email=t@t commit -qm slow')
    const child = spawn(BIN, ['files', 'tests/format.test.mjs'], { cwd: repo, env: ENV })
    const done = new Promise(resolve => child.on('close', resolve))
    const running = join(repo, '.git', 'testpace', 'running')
    const marker = (): { id: string; group?: number } | undefined => {
      const file = existsSync(running) ? readdirSync(running).find(name => name.endsWith('.json')) : undefined
      return file ? JSON.parse(readFileSync(join(running, file), 'utf8')) : undefined
    }
    for (let i = 0; i < 100 && marker()?.group === undefined; i++) await new Promise(r => setTimeout(r, 50))
    return { id: marker()!.id, go: () => writeFileSync(go, ''), done, kill: () => child.kill('SIGKILL') }
  }
  const files = (repo: string) => testpace(repo, 'files', 'tests/format.test.mjs')
  /** 用这个测试进程借用：占上时返回这次的 id。 */
  const holdHere = (repo: string): string => {
    const r = testpace(repo, 'hold', String(process.pid), 'testcraft', '建副本')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^\S+\n$/, '只输出这次的 id')
    return r.out.trim()
  }

  test('占着时 files、focused、full 都被挡，说明是谁占着、等它放开；status 也看得到；放开后照常跑', () => {
    const repo = sampleRepo()
    const id = holdHere(repo)
    const said = new RegExp(`^这个工作区正被 testcraft 建副本 占着（开始于 [^，]+，进程 ${process.pid}），占着时不跑测试，等它放开再跑。\n$`, 'm')
    for (const r of [files(repo), testpace(repo, 'focused'), testpace(repo, 'full')]) {
      assert.equal(r.code, 3, r.out)
      assert.match(r.out, said)
    }
    assert.equal(runs(repo).length, 0, '被挡的没有记录')
    assert.match(testpace(repo, 'status').out, new RegExp(`这个工作区正被 testcraft 建副本 占着（开始于 [^，]+，进程 ${process.pid}），已 `))
    assert.equal(testpace(repo, 'release', id).code, 0)
    assert.equal(files(repo).code, 0)
  })

  test('借用的进程被杀了，占用跟着作废：下一次命令照常跑', async () => {
    const repo = sampleRepo()
    const borrower = spawn('sleep', ['60'])
    const r = testpace(repo, 'hold', String(borrower.pid), 'testcraft 建副本')
    assert.equal(r.code, 0, r.out)
    assert.equal(files(repo).code, 3)
    const gone = new Promise(resolve => borrower.on('close', resolve))
    borrower.kill('SIGKILL')
    await gone
    const after = files(repo)
    assert.equal(after.code, 0, after.out)
  })

  test('有测试在跑：不占，说明在跑什么，退出码 3；跑完就占得上', { timeout: 60_000 }, async () => {
    const repo = sampleRepo()
    const slow = await slowFiles(repo)
    const r = testpace(repo, 'hold', String(process.pid), 'testcraft 建副本')
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /^这个工作区正在跑 files （开始于 .+，进程 \d+）。\n$/)
    slow.go()
    assert.equal(await slow.done, 0)
    testpace(repo, 'release', holdHere(repo))
  })

  test('已经被借用着：再借不占，说明是谁占着', () => {
    const repo = sampleRepo()
    const id = holdHere(repo)
    const r = testpace(repo, 'hold', String(process.pid), '别的工具')
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /^这个工作区正被 testcraft 建副本 占着/)
    testpace(repo, 'release', id)
  })

  test('别的工作区在跑的不挡', { timeout: 60_000 }, async () => {
    const repo = sampleRepo()
    const other = join(tempDir('testpace-wt-'), 'wt')
    sh(repo, `git worktree add -q --detach '${other}'`)
    const slow = await slowFiles(repo)
    const r = testpace(other, 'hold', String(process.pid), 'testcraft 建副本')
    assert.equal(r.code, 0, r.out)
    testpace(other, 'release', r.out.trim())
    slow.go()
    await slow.done
  })

  test('带着在跑那一轮的 TESTPACE_RUN 借用（整组的附加检查）：不另占、什么也不输出；别的运行 id 照样被挡', { timeout: 60_000 }, async () => {
    const repo = sampleRepo()
    const slow = await slowFiles(repo)
    const own = run(repo, ['hold', String(process.pid), 'testcraft 建副本'], { ...ENV, TESTPACE_RUN: slow.id })
    assert.equal(own.code, 0, own.out)
    assert.equal(own.out, '')
    assert.equal(run(repo, ['hold', String(process.pid), 'testcraft 建副本'], { ...ENV, TESTPACE_RUN: `${slow.id}-别的` }).code, 3)
    slow.go()
    assert.equal(await slow.done, 0, '在跑的那一轮没被换掉')
  })

  test('release 只放借用的：给在跑的命令的 id 不放开它', { timeout: 60_000 }, async () => {
    const repo = sampleRepo()
    const slow = await slowFiles(repo)
    assert.equal(testpace(repo, 'release', slow.id).code, 0)
    assert.equal(files(repo).code, 3)
    slow.go()
    await slow.done
  })

  // files 命令先打出看到的运行 id、借用一次，再跑测试
  const probe = 'echo "运行 id：[$TESTPACE_RUN]"; testpace hold $$ 测试里; node scripts/test-files.mjs'

  test('files 跑的测试里借用被挡；外面带着 TESTPACE_RUN 来跑 files，里面也看不到它', () => {
    const repo = sampleRepo()
    setConfigWith(repo, { files: probe })
    const r = run(repo, ['files', 'tests/format.test.mjs'], { ...ENV, TESTPACE_RUN: '外面的运行 id' })
    assert.equal(r.code, 0, r.out)
    const log = readFileSync(runs(repo).at(-1)!.log as string, 'utf8')
    assert.match(log, /运行 id：\[\]\n这个工作区正在跑 files （开始于/)
  })

  test('整组跑测试的那一段里借用被挡', () => {
    const repo = sampleRepo()
    setConfigWith(repo, { files: probe })
    commit(repo, '配置')
    const r = testpace(repo, 'full')
    assert.equal(r.code, 0, r.out)
    const log = readFileSync(runs(repo).at(-1)!.log as string, 'utf8')
    assert.match(log, /===== testpace 全部测试（2 个文件）：[^\n]*\n运行 id：\[\]\n这个工作区正在跑整组（开始于/)
  })

  test('testpace 被强杀、测试进程组还在跑：照样不占，说清楚怎么停', { timeout: 60_000 }, async () => {
    const repo = sampleRepo()
    const slow = await slowFiles(repo)
    slow.kill()
    await slow.done
    const hold = () => testpace(repo, 'hold', String(process.pid), 'testcraft 建副本')
    const r = hold()
    assert.equal(r.code, 3, r.out)
    assert.match(r.out, /起它的 testpace 已经退出，测试进程组 (\d+) 还在跑，不要了用 kill -- -\1 停掉/)
    slow.go()
    let after = hold()
    for (let i = 0; i < 100 && after.code === 3; i++) {
      await new Promise(r => setTimeout(r, 100))
      after = hold()
    }
    assert.equal(after.code, 0, '测试进程组结束后就占得上')
    testpace(repo, 'release', after.out.trim())
  })

  test('参数不对：说用法，退出码 2', () => {
    const repo = sampleRepo()
    assert.equal(testpace(repo, 'hold').code, 2)
    assert.equal(testpace(repo, 'hold', 'abc', '说明').code, 2)
    assert.equal(testpace(repo, 'hold', String(process.pid)).code, 2)
    const gone = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim()
    const dead = testpace(repo, 'hold', gone, 'testcraft 建副本')
    assert.equal(dead.code, 2, dead.out)
    assert.match(dead.out, new RegExp(`进程 ${gone} 不在`))
    assert.equal(files(repo).code, 0, '没占上')
    assert.equal(testpace(repo, 'release').code, 2)
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
    commit(repo, '配置')
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
    // 每段各记一条用时，按跑的顺序，加起来就是整组的用时
    const steps = record.steps as Array<{ kind: string; check?: string; durationMs: number }>
    assert.deepEqual(steps.map(({ kind, check }) => [kind, check]), [['check', 'echo 第一条'], ['check', 'echo 第二条'], ['full', undefined], ['tests', undefined]])
    assert.equal(steps.reduce((sum, step) => sum + step.durationMs, 0), record.durationMs)
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
    // 只有跑到的那一段有用时
    assert.deepEqual((record.steps as Array<{ kind: string }>).map(step => step.kind), ['check'])
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

  test('附加检查拿得到这一轮的运行 id（TESTPACE_RUN），在里面借用工作区不另占；整组接着跑完测试、通过', () => {
    const repo = sampleRepo()
    const r = run(repo, ['full'], withChecks('echo "运行 $TESTPACE_RUN" && testpace hold $$ testcraft 建副本 && echo 借到了'))
    assert.equal(r.code, 0, r.out)
    const record = runs(repo).at(-1)!
    assert.equal(record.result, 'pass')
    assert.equal(record.tests, 2)
    assert.match(readFileSync(record.log as string, 'utf8'), new RegExp(`运行 ${record.id}\\n借到了\\n`))
    assert.equal(readdirSync(join(repo, '.git', 'testpace', 'running')).filter(name => name.endsWith('.json')).length, 0, '整组的登记照常放开')
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
    commit(repo, '配置')
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
