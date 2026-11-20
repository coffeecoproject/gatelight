import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { ENV, HOOK, MEMBER_PRICE, sampleRepo, sh, tempDir, TEST_HEAD, testcraft, write } from './helpers.ts'

function hook(cwd: string, event: string, extra: Record<string, unknown> = {}): Record<string, any> | undefined {
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', HOOK, 'claude'], {
    input: JSON.stringify({ hook_event_name: event, cwd, ...extra }),
    env: ENV,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim() ? JSON.parse(r.stdout) : undefined
}

const edit = (repo: string, path: string, from: string, to: string): void => {
  const file = join(repo, path)
  writeFileSync(file, readFileSync(file, 'utf8').replace(from, to))
}

const realTest = `${TEST_HEAD}import { memberPrice } from '../src/price.mjs'\ntest('金卡九折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n  assert.equal(memberPrice(100, { level: 'silver' }), 100)\n})\n`

describe('hooks', () => {
  test('会话开始：接入的仓库说明约定，没接入的不出声', () => {
    const repo = sampleRepo()
    assert.match(hook(repo, 'SessionStart')?.hookSpecificOutput.additionalContext, /testcraft prove/)
    // 没接入"测试写法"的仓库：只说 testpace 的测试节奏，不说写测试的约定
    const outside = sampleRepo(dir => rmSync(join(dir, '.testcraft'), { recursive: true }))
    const told = hook(outside, 'SessionStart')?.hookSpecificOutput.additionalContext
    assert.match(told, /testpace focused/)
    assert.doesNotMatch(told, /testcraft/)
  })

  test('停止门：没动测试不出声；动了测试没证明就拦一次；证明过就放行；只改文档不再拦', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    assert.equal(hook(repo, 'Stop'), undefined)

    write(repo, 'tests/member.test.mjs', realTest)
    const blocked = hook(repo, 'Stop')
    assert.equal(blocked?.decision, 'block')
    assert.match(blocked?.reason, /testcraft prove.*tests\/member\.test\.mjs/)
    // 没有要写理由的改动，不用跑放水检查
    assert.doesNotMatch(blocked?.reason, /testcraft weaken/)
    // 同一份改动只拦一次
    assert.equal(hook(repo, 'Stop'), undefined)

    assert.equal(testcraft(repo, ['prove']).code, 0)
    assert.equal(hook(repo, 'Stop'), undefined)
    write(repo, 'README.md', '# 说明\n')
    assert.equal(hook(repo, 'Stop'), undefined)

    // 再改一下测试，证明记录就对不上了
    appendFileSync(join(repo, 'tests/member.test.mjs'), "test('银卡不打折', () => assert.equal(memberPrice(50, { level: 'silver' }), 50))\n")
    assert.equal(hook(repo, 'Stop')?.decision, 'block')
  })

  test('停止门：有要写理由的改动时要求放水检查', () => {
    const repo = sampleRepo()
    hook(repo, 'SessionStart')
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    assert.match(hook(repo, 'Stop')?.reason, /testcraft weaken/)
  })

  test('停止门：只改了和测试无关的 npm 脚本，不拦；改了测试命令调到的脚本，要放水检查', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'package.json', JSON.stringify({ name: 's', private: true, type: 'module', scripts: { test: 'node --test', dev: 'node src/price.mjs' } }))
      edit(dir, 'testpace.json', '"files": "node --test"', '"files": "npm test"')
    })
    hook(repo, 'SessionStart', { session_id: 's1' })
    edit(repo, 'package.json', '"dev":"node src/price.mjs"', '"dev":"node --watch src/price.mjs"')
    assert.equal(hook(repo, 'Stop', { session_id: 's1' }), undefined)
    edit(repo, 'package.json', '"test":"node --test"', '"test":"node --test || true"')
    assert.match(hook(repo, 'Stop', { session_id: 's1' })?.reason, /测试的配置或约定.*testcraft weaken/)
  })

  test('停止门只管这个会话改的测试：会话开始前就改了、这个会话没动，不拦', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', realTest)
    hook(repo, 'SessionStart', { session_id: 'later' })
    assert.equal(hook(repo, 'Stop', { session_id: 'later' }), undefined)
    // 这个会话只改了代码：也不拦
    appendFileSync(join(repo, 'src/price.mjs'), '\n// 补一行注释\n')
    assert.equal(hook(repo, 'Stop', { session_id: 'later' }), undefined)
    // 压缩后再来一次 SessionStart，不覆盖会话开始时的样子
    appendFileSync(join(repo, 'tests/member.test.mjs'), '\n// 补一行\n')
    hook(repo, 'SessionStart', { session_id: 'later' })
    assert.equal(hook(repo, 'Stop', { session_id: 'later' })?.decision, 'block')
  })

  test('停止门：这个会话改到了清单条目的触发条件、没写怎么查的，拦一次；写了就放行；会话开始前就命中的，这个会话没动不拦、又改了要拦', () => {
    const item = '# 改了满减，结算页提示要跟着改\n\n## 触发\n\n- `src/price.mjs` 改到 `coupon`\n\n## 怎么查\n\n结算页提示和 applyCoupon 对一遍。\n\n## 来由\n\nfix/coupon-hint：提示金额是旧的。\n'
    const repo = sampleRepo(dir => write(dir, '.testcraft/checklist/coupon-hint.md', item))
    hook(repo, 'SessionStart', { session_id: 's1' })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    const blocked = hook(repo, 'Stop', { session_id: 's1' })
    assert.equal(blocked?.decision, 'block')
    assert.match(blocked?.reason, /清单.*coupon-hint/)
    assert.doesNotMatch(blocked?.reason, /testcraft prove|testcraft weaken/)

    hook(repo, 'SessionStart', { session_id: 's2' })
    assert.equal(hook(repo, 'Stop', { session_id: 's2' }), undefined)
    // 会话开始时就命中、这个会话又改了命中的文件：拦
    edit(repo, 'src/price.mjs', 'return amount - coupon.off * 2', 'return amount - coupon.off * 3')
    assert.equal(hook(repo, 'Stop', { session_id: 's2' })?.decision, 'block')

    write(repo, '.testcraft/changes/feature.md', '# feature\n\n## 清单\n\n- `coupon-hint`：提示改成按两倍显示，和 applyCoupon 对过\n')
    assert.equal(hook(repo, 'Stop', { session_id: 's1' }), undefined)
  })

  test('停止门：没有这个会话在这里的起点（比如这个模块是会话中途才装上的）：不说是这个会话改的，从这时算起；之后再改照常拦', () => {
    const repo = sampleRepo()
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    // 这个会话没有过会话开始，也没在这里跑过命令：没有起点可比
    assert.equal(hook(repo, 'Stop', { session_id: 'late' }), undefined)
    edit(repo, 'tests/price.test.mjs', "test('合计是单价乘数量再相加'", "test.skip('合计是单价乘数量再相加'")
    assert.match(hook(repo, 'Stop', { session_id: 'late' })?.reason, /testcraft weaken/)
  })

  test('停止门：没有起点时清单也一样：早就命中了清单条目、没写怎么查的，不说是这个会话改到的；之后再改命中的文件照常拦', () => {
    const item = '# 改了满减，结算页提示要跟着改\n\n## 触发\n\n- `src/price.mjs` 改到 `coupon`\n\n## 怎么查\n\n结算页提示和 applyCoupon 对一遍。\n\n## 来由\n\nfix/coupon-hint：提示金额是旧的。\n'
    const repo = sampleRepo(dir => write(dir, '.testcraft/checklist/coupon-hint.md', item))
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    assert.equal(hook(repo, 'Stop', { session_id: 'late' }), undefined)
    edit(repo, 'src/price.mjs', 'return amount - coupon.off * 2', 'return amount - coupon.off * 3')
    assert.match(hook(repo, 'Stop', { session_id: 'late' })?.reason, /清单.*coupon-hint/)
  })

  /** 同一个仓库的另一个工作区（从 main 新开一个分支）。 */
  const secondWorktree = (repo: string): string => {
    const other = join(tempDir('testcraft-wt-'), 'wt')
    sh(repo, `git worktree add -q -b second '${other}' main`)
    return other
  }
  const bash = (cwd: string, session: string, command: string): unknown =>
    hook(cwd, 'PreToolUse', { session_id: session, tool_name: 'Bash', tool_input: { command } })

  test('停止门按工作区认起点：会话后来进了同一个仓库的另一个工作区，那里早就改了的测试不算这个会话改的；在那里再改照常拦', () => {
    const repo = sampleRepo()
    hook(repo, 'SessionStart', { session_id: 's' })
    const other = secondWorktree(repo)
    // 别人早就在那个工作区加了测试，还没证明
    appendFileSync(join(other, 'src/price.mjs'), MEMBER_PRICE)
    write(other, 'tests/member.test.mjs', realTest)
    bash(other, 's', 'ls')
    assert.equal(hook(other, 'Stop', { session_id: 's' }), undefined)

    appendFileSync(join(other, 'tests/member.test.mjs'), "test('银卡不打折', () => assert.equal(memberPrice(50, { level: 'silver' }), 50))\n")
    assert.match(hook(other, 'Stop', { session_id: 's' })?.reason, /testcraft prove.*tests\/member\.test\.mjs/)
  })

  test('会话进了另一个工作区，在那里跑过命令以后才加的测试：起点在第一条命令之前就记了，照常拦', () => {
    const repo = sampleRepo()
    hook(repo, 'SessionStart', { session_id: 's' })
    const other = secondWorktree(repo)
    bash(other, 's', 'ls')
    write(other, 'tests/member.test.mjs', realTest)
    assert.match(hook(other, 'Stop', { session_id: 's' })?.reason, /testcraft prove.*tests\/member\.test\.mjs/)
  })

  test('会话进了另一个工作区，先用改文件的工具加了测试、后来才在那里跑命令：起点是改之前的样子，照常拦', () => {
    const repo = sampleRepo()
    hook(repo, 'SessionStart', { session_id: 's' })
    const other = secondWorktree(repo)
    hook(repo, 'PreToolUse', { session_id: 's', tool_name: 'Write', tool_input: { file_path: join(other, 'tests/member.test.mjs') } })
    write(other, 'tests/member.test.mjs', realTest)
    bash(other, 's', 'ls')
    assert.match(hook(other, 'Stop', { session_id: 's' })?.reason, /testcraft prove.*tests\/member\.test\.mjs/)
  })
})
