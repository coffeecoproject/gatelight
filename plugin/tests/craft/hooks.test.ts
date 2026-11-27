import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runs } from '../helpers.ts'
import { ENV, hook, MEMBER_PRICE, sampleRepo, sh, TEST_HEAD, TESTPACE, write } from './helpers.ts'

/**
 * 停止门：testcraft 拦没拦、出没出声。停止门里"跑测试"那一项（testpace 的：改了代码、当前内容没跑过 testpace focused）
 * 不归 testcraft 管，认出来当作没出声；testcraft 排在它前面，testcraft 自己拦的照样看得到。
 */
function stopped(repo: string, session: string): Record<string, any> | undefined {
  const out = hook(repo, 'Stop', { session_id: session })
  const focusedOnly = out?.decision === 'block' && /当前内容还没跑过 testpace focused/.test(out.reason) && out.systemMessage === undefined
  return focusedOnly ? undefined : out
}

const edit = (repo: string, path: string, from: string, to: string): void => {
  const file = join(repo, path)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes(from), `${path} 里没有 ${from}`)
  writeFileSync(file, text.replace(from, to))
}

const realTest = `${TEST_HEAD}import { memberPrice } from '../src/price.mjs'\ntest('金卡九折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n  assert.equal(memberPrice(100, { level: 'silver' }), 100)\n})\n`

/** 两条清单：改满减要查结算页提示；改合计要查发票。 */
const COUPON = '# 改了满减，结算页提示要跟着改\n\n## 触发\n\n- `src/price.mjs` 改到 `coupon`\n\n## 怎么查\n\n结算页提示和 applyCoupon 对一遍。\n\n## 来由\n\nfix/coupon-hint：提示金额是旧的。\n'
const TOTAL = '# 改了合计，发票金额要跟着改\n\n## 触发\n\n- `src/price.mjs` 改到 `quantity`\n\n## 怎么查\n\n发票金额和 total 对一遍。\n\n## 来由\n\nfix/invoice-total：发票还按旧的合计开。\n'
const withItems = (): string =>
  sampleRepo(dir => {
    write(dir, '.testcraft/checklist/coupon-hint.md', COUPON)
    write(dir, '.testcraft/checklist/invoice-total.md', TOTAL)
  })
const hitCoupon = (repo: string): void => edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
const hitTotal = (repo: string): void => edit(repo, 'src/price.mjs', 'sum += item.price * item.quantity', 'sum = sum + item.price * item.quantity')

describe('hooks', () => {
  test('会话开始：接入的仓库说明约定（改已定的业务规则先问用户，别的不问），不提证明、放水检查、复查；没接入的不出声', () => {
    const repo = sampleRepo()
    const told = hook(repo, 'SessionStart')?.hookSpecificOutput.additionalContext
    assert.match(told, /用 testcraft 管测试的写法/)
    assert.match(told, /要改已定的业务规则（包括为此删测试、让测试不跑、改期望值），先用白话问用户/)
    assert.match(told, /测试上别的调整.*自己定，不问用户/)
    assert.match(told, /必跑层：钱、权限、状态与数据/)
    assert.match(told, /细节层：界面细节、样式、提示文字这类人容易漏看的，也值得写/)
    assert.doesNotMatch(told, /超过 5 分钟|先删/)
    assert.doesNotMatch(told, /testcraft prove|testcraft weaken|testcraft review|检查员|放水|证明/)
    // 没接入"测试写法"的仓库：只说 testpace 的测试节奏，不说写测试的约定
    const outside = sampleRepo(dir => rmSync(join(dir, '.testcraft'), { recursive: true }))
    const quiet = hook(outside, 'SessionStart')?.hookSpecificOutput.additionalContext
    assert.match(quiet, /testpace focused/)
    assert.doesNotMatch(quiet, /testcraft/)
  })

  test('会话开始：不留记录类的 .md，规则在测试里，原因写进提交说明，测试守不住的陷阱处留一句注释；方案合并时写进提交说明、删掉文件，不说会被拦；看不出为什么的代码先看提交说明', () => {
    const told = hook(sampleRepo(), 'SessionStart')?.hookSpecificOutput.additionalContext
    const item = /^3\. .*$/m.exec(told)?.[0] ?? ''
    assert.match(item, /以测试名为准/)
    assert.match(item, /不留记录（方案、设计、说明）：规则在测试里/)
    assert.match(item, /为什么这样定、否掉的做法、用户拍板的、还没定的写进做这件事的提交说明/)
    assert.match(item, /AI 很可能好心改掉、测试又守不住的地方，在那段代码旁边留一句为什么/)
    assert.match(item, /方案只在分支上讨论时写，合并时写进提交说明、删掉文件。/)
    assert.doesNotMatch(item, /会被拦/)
    assert.match(item, /先看那几行的提交说明（git log -L、git blame）/)
    assert.doesNotMatch(item, /设计文档只写/)
  })

  test('停止门：这个会话加了测试、跳过了测试、删了测试、改到了清单条目，都不拦，不要求证明或写下什么', () => {
    const repo = withItems()
    hook(repo, 'SessionStart', { session_id: 's' })
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', realTest)
    assert.equal(stopped(repo, 's'), undefined)
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    assert.equal(stopped(repo, 's'), undefined)
    hitCoupon(repo)
    hitTotal(repo)
    assert.equal(stopped(repo, 's'), undefined)
    rmSync(join(repo, 'tests/price.test.mjs'))
    assert.equal(stopped(repo, 's'), undefined)
  })

  test('停止门：合并分支上仓库里留着方案这类 .md，testcraft 不拦', () => {
    const repo = sampleRepo()
    write(repo, '方案.md', '# 方案\n')
    write(repo, 'docs/design.md', '# 设计\n')
    sh(repo, "git add -A && git commit -qm '写方案' && git checkout -qb merge/20261127-feature")
    hook(repo, 'SessionStart', { session_id: 's' })
    assert.equal(stopped(repo, 's'), undefined)
  })
})

describe('整组里"测试写法"的一段', () => {
  const testpace = (repo: string, args: string[]) => {
    const r = spawnSync(TESTPACE, args, { cwd: repo, env: ENV, encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  const kinds = (repo: string): string[] => ((runs(repo).at(-1)?.steps ?? []) as Array<{ kind: string }>).map(step => step.kind)

  test('接入了的仓库：testpace full 在测试之前把命中的清单条目说一遍，不跑别的检查；加了测试、跳过了测试照样过', () => {
    const repo = withItems()
    // 改到满减那一段，但算出来的数不变：示例项目自己的测试照样过
    edit(repo, 'src/price.mjs', 'export function applyCoupon', '// coupon：满额才减\nexport function applyCoupon')
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', realTest)
    edit(repo, 'tests/price.test.mjs', "test('合计是单价乘数量再相加'", "test.skip('合计是单价乘数量再相加'")
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^整组通过 · 2 个测试文件/)
    assert.deepEqual(kinds(repo), ['craft', 'full', 'tests'])
    const log = readFileSync(runs(repo).at(-1)!.log as string, 'utf8')
    assert.match(log, /===== testpace 清单：testcraft checklist\n[\s\S]*这次改动命中 1 条[\s\S]*· coupon-hint/)
    assert.doesNotMatch(log, /证明|放水/)
  })

  test('这次加的清单条目写坏了：这一段没过，后面的不跑', () => {
    const repo = sampleRepo()
    write(repo, '.testcraft/checklist/broken.md', '# 有个坑\n\n## 触发\n\n- `src/**`\n')
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^整组失败：清单（testcraft checklist）没通过，后面的没有跑/)
    assert.deepEqual(kinds(repo), ['craft'])
  })

  test('没接入的仓库（没有 .testcraft/）没有这一段', () => {
    const repo = sampleRepo(dir => rmSync(join(dir, '.testcraft'), { recursive: true }))
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(kinds(repo), ['full', 'tests'])
  })
})
