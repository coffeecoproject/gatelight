// 时好时坏的测试和几轮没过（results.ts）：示例项目的 files 换成 testpace run node-test，跑真实的 testpace 命令。
// 测试时过时不过靠仓库外的计数文件：第几次调用没过由 FAIL_ON 给，计数不在工作区里，代码一直不变。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { handle } from '../src/hook.ts'
import { commit, ENV, runs, sampleRepo, setConfig, tempDir, testpace } from './helpers.ts'

/**
 * 第 FAIL_ON 里列的那几次调用（从 0 数）没过，其余都过。
 * 给了 TOUCH_ON_FAIL 时，没过的那次在仓库里写这个文件；给了 TOUCH_EACH 时每次都写（内容是第几次）：跑的过程中代码变了。
 */
const FLIP = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

test('时过时不过', () => {
  const n = Number(readFileSync(process.env.FLIP, 'utf8') || '0')
  writeFileSync(process.env.FLIP, String(n + 1))
  const failing = process.env.FAIL_ON.split(',').includes(String(n))
  if (failing && process.env.TOUCH_ON_FAIL) writeFileSync(process.env.TOUCH_ON_FAIL, 'x')
  if (process.env.TOUCH_EACH) writeFileSync(process.env.TOUCH_EACH, String(n))
  assert.ok(!failing, \`第 \${n} 次没过\`)
})
`

/** 接上 testpace run node-test 的示例项目，加一个时过时不过的测试；返回仓库和跑 testpace 用的环境。 */
function flipRepo(failOn: string): { repo: string; env: NodeJS.ProcessEnv } {
  const repo = sampleRepo()
  setConfig(repo, { files: 'testpace run node-test' })
  writeFileSync(join(repo, 'tests', 'flip.test.mjs'), FLIP)
  const counter = join(tempDir('testpace-flip-'), 'count')
  writeFileSync(counter, '0')
  return { repo, env: { ...ENV, FLIP: counter, FAIL_ON: failOn } }
}

const FLIP_TEST = /tests\/flip\.test\.mjs:5 「时过时不过」/

/** 先没过、再过，把 flip 测试记进名单。 */
function listFlip(repo: string, env: NodeJS.ProcessEnv): void {
  testpace(repo, ['files', 'tests/flip.test.mjs'], env)
  testpace(repo, ['files', 'tests/flip.test.mjs'], env)
  assert.match(testpace(repo, ['status'], env).out, /时好时坏的测试（1 个/)
}

const listed = (repo: string, env: NodeJS.ProcessEnv): string => testpace(repo, ['status'], env).out

describe('时好时坏的测试', () => {
  test('同一份代码先没过、再跑过了：点名、记进名单，status 和新会话开始时列出；再过一次不再点名', () => {
    const { repo, env } = flipRepo('0')
    const first = testpace(repo, ['files', 'tests/flip.test.mjs'], env)
    assert.equal(first.code, 1, first.out)
    assert.deepEqual(runs(repo)[0]!.failed, [{ file: 'tests/flip.test.mjs', line: 5, name: '时过时不过' }])
    assert.doesNotMatch(first.out, /时好时坏/)

    const second = testpace(repo, ['files', 'tests/flip.test.mjs'], env)
    assert.equal(second.code, 0, second.out)
    assert.match(second.out, new RegExp(`时好时坏：${FLIP_TEST.source} 这次过了，同一份代码 .+ 却没过（那次的日志：.+\\.log）`))
    assert.match(second.out, /不要靠重跑过关/)
    assert.match(second.out, /testpace files --repeat 10/)

    const status = testpace(repo, ['status'], env)
    assert.match(status.out, new RegExp(`时好时坏的测试（1 个[^\\n]*\\n  ${FLIP_TEST.source}：.+同一份代码先后一次没过、一次过了\\n    没过那次的日志：.+\\n    过了那次的日志：.+`))
    const start = handle({ hook_event_name: 'SessionStart', session_id: 'flaky-start', cwd: repo }, Date.now(), 'claude') as { hookSpecificOutput: { additionalContext: string } }
    assert.match(start.hookSpecificOutput.additionalContext, new RegExp(`时好时坏的测试（.+）：${FLIP_TEST.source}。它们没过时不要靠重跑过关`))

    const third = testpace(repo, ['files', 'tests/flip.test.mjs'], env)
    assert.equal(third.code, 0, third.out)
    assert.doesNotMatch(third.out, /时好时坏/, '名单上已有的不再点名')
    assert.match(testpace(repo, ['status'], env).out, /时好时坏的测试（1 个/, '再过一次也不从名单上去掉')
  })

  test('整组里没过、单独重跑过了也算；代码改了再过不算', () => {
    const { repo, env } = flipRepo('0')
    const full = testpace(repo, ['full'], env)
    assert.equal(full.code, 1, full.out)
    const rerun = testpace(repo, ['files', 'tests/flip.test.mjs:5'], env)
    assert.equal(rerun.code, 0, rerun.out)
    assert.match(rerun.out, new RegExp(`时好时坏：${FLIP_TEST.source} 这次过了`))

    const other = flipRepo('0')
    assert.equal(testpace(other.repo, ['files', 'tests/flip.test.mjs'], other.env).code, 1)
    writeFileSync(join(other.repo, 'src', 'extra.mjs'), 'export const x = 1\n')
    const changed = testpace(other.repo, ['files', 'tests/flip.test.mjs'], other.env)
    assert.equal(changed.code, 0, changed.out)
    assert.doesNotMatch(changed.out, /时好时坏/)
    assert.match(testpace(other.repo, ['status'], other.env).out, /时好时坏的测试：没有/)
  })

  test('没过的那次跑的过程中代码改了，之后代码回到原样再过，不算', () => {
    const { repo, env } = flipRepo('0')
    const touched = join(repo, 'src', 'touched.mjs')
    assert.equal(testpace(repo, ['files', 'tests/flip.test.mjs'], { ...env, TOUCH_ON_FAIL: touched }).code, 1)
    rmSync(touched)
    const again = testpace(repo, ['files', 'tests/flip.test.mjs'], env)
    assert.equal(again.code, 0, again.out)
    assert.doesNotMatch(again.out, /时好时坏/)
    assert.match(listed(repo, env), /时好时坏的测试：没有/)
  })

  test('同一次运行里同名的测试有过有没过：分不清是哪个，不记没过、不算时好时坏', () => {
    const { repo, env } = flipRepo('')
    writeFileSync(
      join(repo, 'tests', 'twins.test.mjs'),
      "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('同名', () => {})\ntest('同名', () => assert.equal(1, 2))\n",
    )
    assert.equal(testpace(repo, ['files', 'tests/twins.test.mjs'], env).code, 1)
    assert.deepEqual(runs(repo).at(-1)!.failed, [])
    const again = testpace(repo, ['files', 'tests/twins.test.mjs'], env)
    assert.equal(again.code, 1)
    assert.doesNotMatch(again.out, /时好时坏/)
    assert.match(listed(repo, env), /时好时坏的测试：没有/)
  })

  test('连跑：前面过了、后面没过也算；代码没改连跑 10 次都过才从名单上去掉，不到 10 次不去掉', () => {
    const { repo, env } = flipRepo('2')
    const caught = testpace(repo, ['files', '--repeat', '5', 'tests/flip.test.mjs'], env)
    assert.equal(caught.code, 1, caught.out)
    assert.match(caught.out, /连跑第 3 次（共 5 次）失败/)
    assert.match(caught.out, new RegExp(`时好时坏：${FLIP_TEST.source} 这次没过，代码没改，连跑时前面却过了`))
    assert.equal(runs(repo).length, 3, '没过就停')

    const short = testpace(repo, ['files', '--repeat', '9', 'tests/flip.test.mjs'], env)
    assert.equal(short.code, 0, short.out)
    assert.match(short.out, /^1 个测试文件连跑 9 次都通过/)
    assert.match(testpace(repo, ['status'], env).out, /时好时坏的测试（1 个/)

    const proven = testpace(repo, ['files', '--repeat', '10', 'tests/flip.test.mjs'], env)
    assert.equal(proven.code, 0, proven.out)
    assert.match(proven.out, new RegExp(`${FLIP_TEST.source} 连跑 10 次都过了，从时好时坏名单上去掉`))
    assert.match(testpace(repo, ['status'], env).out, /时好时坏的测试：没有/)
    assert.deepEqual(runs(repo).slice(-2).map(run => run.repeat), [{ index: 9, of: 10 }, { index: 10, of: 10 }])
  })

  test('连跑的过程中工作区变了（测试写了没被忽略的文件）：不算证明修好了，说一句', () => {
    const { repo, env } = flipRepo('0')
    listFlip(repo, env)
    const r = testpace(repo, ['files', 'tests/flip.test.mjs', '--repeat', '10'], { ...env, TOUCH_EACH: join(repo, 'src', 'out.txt') })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /连跑 10 次都通过/)
    assert.match(r.out, /连跑的过程中代码或工作区变了.+不算证明时好时坏的测试修好了/)
    assert.match(listed(repo, env), /时好时坏的测试（1 个/)
  })

  test('--repeat 要跟正整数', () => {
    const { repo, env } = flipRepo('')
    for (const bad of [['--repeat', '0'], ['--repeat', 'x'], ['--repeat']]) {
      const r = testpace(repo, ['files', ...bad, 'tests/flip.test.mjs'], env)
      assert.equal(r.code, 2, r.out)
    }
    const after = testpace(repo, ['files', 'tests/flip.test.mjs', '--repeat', '2'], env)
    assert.match(after.out, /^1 个测试文件连跑 2 次都通过/, '写在路径后面也行')
  })

  test('名单上的测试删掉或改了名：整个文件跑过、全部通过后从名单上去掉；有没过的、只跑了几行的不算', () => {
    const { repo, env } = flipRepo('0')
    listFlip(repo, env)
    const renamed = readFileSync(join(repo, 'tests', 'flip.test.mjs'), 'utf8').replace('时过时不过', '换了名字')
    writeFileSync(join(repo, 'tests', 'flip.test.mjs'), `${renamed}test('没过', () => assert.equal(1, 2))\n`)
    const failing = testpace(repo, ['files', 'tests/flip.test.mjs'], env)
    assert.equal(failing.code, 1, failing.out)
    assert.doesNotMatch(failing.out, /不在了/, '框架可能没跑完')
    assert.match(listed(repo, env), /时好时坏的测试（1 个/)
    writeFileSync(join(repo, 'tests', 'flip.test.mjs'), renamed)
    const line = testpace(repo, ['files', 'tests/flip.test.mjs:5'], env)
    assert.equal(line.code, 0, line.out)
    assert.doesNotMatch(line.out, /不在了/, '只跑了一行，没跑到的测试不报')
    const r = testpace(repo, ['files', 'tests/flip.test.mjs'], env)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, new RegExp(`${FLIP_TEST.source} 不在了（删掉或改了名），从时好时坏名单上去掉`))
    assert.match(testpace(repo, ['status'], env).out, /时好时坏的测试：没有/)
  })

  test('名单上的测试所在的组整个被跳过：还在，不去掉', () => {
    const { repo, env } = flipRepo('0')
    const grouped = FLIP.replace("import { test } from 'node:test'", "import { describe, test } from 'node:test'").replace("test('时过时不过', () => {", "describe('组', () => test('时过时不过', () => {").replace(/\}\)\n$/, '}))\n')
    writeFileSync(join(repo, 'tests', 'flip.test.mjs'), grouped)
    listFlip(repo, env)
    writeFileSync(join(repo, 'tests', 'flip.test.mjs'), grouped.replace("describe('组'", "describe.skip('组'"))
    const r = testpace(repo, ['files', 'tests/flip.test.mjs'], env)
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /不在了/)
    assert.match(listed(repo, env), /组 > 时过时不过/)
  })

  test('别的工作区的代码里没有名单上的测试：不去掉；认出它的工作区删掉以后才按"不在了"去掉', () => {
    const { repo, env } = flipRepo('0')
    // 在另一个工作区认出来（配置和测试提交了，那边才有）
    commit(repo, 'flip')
    const other = join(tempDir('testpace-flip-wt-'), 'b')
    execFileSync('git', ['worktree', 'add', '-q', other], { cwd: repo, env })
    listFlip(other, env)
    // 这个工作区里没有这个测试
    writeFileSync(join(repo, 'tests', 'flip.test.mjs'), FLIP.replace('时过时不过', '别的测试'))
    const here = testpace(repo, ['files', 'tests/flip.test.mjs'], env)
    assert.equal(here.code, 0, here.out)
    assert.doesNotMatch(here.out, /不在了/)
    assert.match(listed(repo, env), /时好时坏的测试（1 个/)

    execFileSync('git', ['worktree', 'remove', '--force', other], { cwd: repo, env })
    const gone = testpace(repo, ['files', 'tests/flip.test.mjs'], env)
    assert.match(gone.out, /不在了（删掉或改了名）/)
    assert.match(listed(repo, env), /时好时坏的测试：没有/)
  })

  test('这个会话认出的时好时坏测试：收尾时拦一次；别的会话不拦', () => {
    const { repo, env } = flipRepo('0')
    const session = { ...env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'flaky-finder' }
    testpace(repo, ['files', 'tests/flip.test.mjs'], session)
    testpace(repo, ['files', 'tests/flip.test.mjs'], session)
    const stop = (id: string) => handle({ hook_event_name: 'Stop', session_id: id, cwd: repo }, Date.now(), 'claude') as { decision?: string; reason?: string } | undefined
    const first = stop('flaky-finder')
    assert.equal(first?.decision, 'block')
    assert.match(first!.reason!, new RegExp(`认出了时好时坏的测试，还在名单上：${FLIP_TEST.source}`))
    assert.equal(stop('flaky-finder')?.decision, undefined, '只拦一次')
    assert.equal(stop('someone-else')?.decision, undefined)
  })
})

describe('几轮没过', () => {
  const FAILING = (round: number) => `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n// 第 ${round} 轮的改法\ntest('总是不对', () => assert.equal(1 + 1, 3))\n`
  const PASSING = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n// 修好了\ntest('总是不对', () => assert.equal(1 + 1, 2))\n"

  test('改了代码再跑还没过算一轮，到第三轮让 agent 停下来找用户；代码没改重跑不算一轮；过了清零', () => {
    const repo = sampleRepo()
    setConfig(repo, { files: 'testpace run node-test' })
    const file = join(repo, 'tests', 'stuck.test.mjs')
    const round = (text: string) => {
      writeFileSync(file, text)
      return testpace(repo, ['files', 'tests/stuck.test.mjs'])
    }
    assert.doesNotMatch(round(FAILING(1)).out, /停下来/)
    assert.doesNotMatch(testpace(repo, ['files', 'tests/stuck.test.mjs']).out, /停下来/, '代码没改的重跑不算一轮')
    assert.doesNotMatch(round(FAILING(2)).out, /停下来/)
    const third = round(FAILING(3))
    assert.equal(third.code, 1)
    assert.match(third.out, /tests\/stuck\.test\.mjs:4 「总是不对」 已经连着 3 轮改了代码还没过（最近 3 轮的日志：.+\.log、.+\.log、.+\.log）/)
    assert.match(third.out, /停下来：把失败原因和这几轮各改了什么告诉用户，等用户决定。不要接着改，也不要改测试凑通过/)

    assert.equal(round(PASSING).code, 0)
    assert.doesNotMatch(round(FAILING(4)).out, /停下来/, '过了之后重新数')
  })
})
