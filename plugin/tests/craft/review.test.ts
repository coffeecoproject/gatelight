import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { commitOnMain, ENV, HOOK, MEMBER_PRICE, sampleRepo, sh, TEST_HEAD, testcraft, write } from './helpers.ts'

/** 停止门说的话：不拦时没有。 */
function stop(cwd: string): string | undefined {
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', HOOK, 'claude'], {
    input: JSON.stringify({ hook_event_name: 'Stop', cwd }),
    env: ENV,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  if (!r.stdout.trim()) return undefined
  const said = JSON.parse(r.stdout)
  assert.equal(said.decision, 'block')
  return said.reason
}

const memberTest = `${TEST_HEAD}import { memberPrice } from '../src/price.mjs'\ntest('金卡九折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n  assert.equal(memberPrice(100, { level: 'silver' }), 100)\n})\n`
const silverTest = "test('银卡不打折', () => assert.equal(memberPrice(50, { level: 'silver' }), 50))\n"

/** 加了会员价和它的测试、还没证明的仓库。 */
function withNewTest(setup?: (repo: string) => void): string {
  const repo = sampleRepo(setup)
  appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
  write(repo, 'tests/member.test.mjs', memberTest)
  return repo
}

describe('复查', () => {
  test('复查开始前这份改动要先证明过：没证明的不让开始，证明了才让', () => {
    const repo = withNewTest()
    const refused = testcraft(repo, ['review', 'start'])
    assert.equal(refused.code, 1)
    assert.match(refused.out, /testcraft prove.*tests\/member\.test\.mjs/)
    // 没开成：停止门照常催证明
    assert.match(stop(repo) ?? '', /还缺：testcraft prove/)

    assert.equal(testcraft(repo, ['prove']).code, 0)
    assert.equal(testcraft(repo, ['review', 'start']).code, 0)
  })

  test('复查中改了测试，停止门不催证明，只提醒一次复查还开着；复查结束后照常催', () => {
    const repo = withNewTest()
    assert.equal(testcraft(repo, ['prove']).code, 0)
    assert.equal(testcraft(repo, ['review', 'start']).code, 0)
    // 检查员在看的还是证明过的那份：不出声
    assert.equal(stop(repo), undefined)

    appendFileSync(join(repo, 'tests/member.test.mjs'), silverTest)
    const reminded = stop(repo)
    assert.match(reminded ?? '', /testcraft review done/)
    assert.doesNotMatch(reminded ?? '', /还缺/)
    assert.equal(stop(repo), undefined)

    const done = testcraft(repo, ['review', 'done'])
    assert.equal(done.code, 0)
    assert.match(done.out, /testcraft prove.*tests\/member\.test\.mjs/)
    assert.match(stop(repo) ?? '', /还缺：testcraft prove.*tests\/member\.test\.mjs/)
  })

  test('复查中没改测试，结束时不要求重跑', () => {
    const repo = withNewTest()
    assert.equal(testcraft(repo, ['prove']).code, 0)
    assert.equal(testcraft(repo, ['review', 'start']).code, 0)
    const done = testcraft(repo, ['review', 'done'])
    assert.equal(done.code, 0)
    assert.match(done.out, /不用重跑/)
    assert.equal(stop(repo), undefined)
  })

  test('没结束的复查只管当时那次改动：合并后在同一个目录里做下一件事，停止门照常催', () => {
    const repo = withNewTest()
    assert.equal(testcraft(repo, ['prove']).code, 0)
    assert.equal(testcraft(repo, ['review', 'start']).code, 0)
    commitOnMain(repo, '会员价')

    write(repo, 'tests/silver.test.mjs', `${TEST_HEAD}import { memberPrice } from '../src/price.mjs'\n${silverTest}`)
    assert.match(stop(repo) ?? '', /还缺：testcraft prove.*tests\/silver\.test\.mjs/)
  })

  test('复查只管开它的那个工作目录：同一个仓库的另一个工作目录改了测试，停止门照常催', () => {
    const repo = withNewTest()
    assert.equal(testcraft(repo, ['prove']).code, 0)
    assert.equal(testcraft(repo, ['review', 'start']).code, 0)

    // 另一个工作目录从同一个提交分出来，记录和这边存在同一处
    const other = join(dirname(repo), 'other')
    sh(repo, `git worktree add -q -b other "${other}" main`)
    appendFileSync(join(other, 'src/price.mjs'), MEMBER_PRICE)
    write(other, 'tests/silver.test.mjs', `${TEST_HEAD}import { memberPrice } from '../src/price.mjs'\n${silverTest}`)
    assert.match(stop(other) ?? '', /还缺：testcraft prove.*tests\/silver\.test\.mjs/)
  })

  test('复查中清单照常拦：改到了清单条目的触发条件、没写怎么查的，和复查的提醒一起说', () => {
    const item = '# 改了满减，结算页提示要跟着改\n\n## 触发\n\n- `src/price.mjs` 改到 `coupon`\n\n## 怎么查\n\n结算页提示和 applyCoupon 对一遍。\n\n## 来由\n\nfix/coupon-hint：提示金额是旧的。\n'
    const repo = withNewTest(dir => write(dir, '.testcraft/checklist/coupon-hint.md', item))
    assert.equal(testcraft(repo, ['prove']).code, 0)
    assert.equal(testcraft(repo, ['review', 'start']).code, 0)

    appendFileSync(join(repo, 'tests/member.test.mjs'), silverTest)
    const price = join(repo, 'src/price.mjs')
    writeFileSync(price, readFileSync(price, 'utf8').replace('return amount - coupon.off', 'return amount - coupon.off * 2'))
    const said = stop(repo) ?? ''
    assert.match(said, /清单.*coupon-hint/)
    assert.match(said, /testcraft review done/)
    assert.doesNotMatch(said, /还缺/)
  })

  test('review 后面只认 start 和 done', () => {
    const repo = sampleRepo()
    assert.equal(testcraft(repo, ['review']).code, 2)
    assert.equal(testcraft(repo, ['review', 'pause']).code, 2)
  })
})
