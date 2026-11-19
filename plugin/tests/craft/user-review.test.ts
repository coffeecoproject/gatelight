import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { sampleRepo, TEST_HEAD, testcraft, write } from './helpers.ts'

/** 写改动记录：放水理由；要给用户过目的再写"## 给用户过目"。 */
const record = (repo: string, reason: string, plain?: string): void =>
  write(repo, '.testcraft/changes/feature.md', `# feature\n\n## 放水理由\n\n${reason}\n${plain ? `\n## 给用户过目\n\n${plain}\n` : ''}`)

describe('放水检查里给用户看的说法', () => {
  test('删掉的测试和同一个文件里新加的测试不像：说成删了，不说改了名', () => {
    const repo = sampleRepo()
    const file = join(repo, 'tests/price.test.mjs')
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(/test\('合计是单价乘数量再相加'[\s\S]*?\n\}\)\n/, "test('满 200 减 50', () => {\n  assert.equal(applyCoupon(200, { threshold: 200, off: 50 }), 150)\n})\n"),
    )
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删了测试用例[^：\n]*：tests\/price\.test\.mjs（删了："合计是单价乘数量再相加"）/)
    assert.doesNotMatch(r.out, /改了名也改了内容/)
  })

  test('删掉的测试和新加的测试只共用准备代码、断言全换了：说成删了，不说改了名', () => {
    const flow = (body: string): string => `${TEST_HEAD}import { applyCoupon, total } from '../src/price.mjs'\n\n${body}\ntest('合计', () => {\n  assert.equal(total([{ price: 1, quantity: 1 }]), 1)\n})\n`
    const setup = "  const cart = [{ price: 50, quantity: 2 }]\n  const sum = total(cart)\n"
    const repo = sampleRepo(dir =>
      write(dir, 'tests/flow.test.mjs', flow(`test('会员价不叠加优惠券', () => {\n${setup}  assert.equal(sum, 100)\n  assert.equal(applyCoupon(sum, { threshold: 100, off: 20 }), 80)\n})\n`)),
    )
    write(repo, 'tests/flow.test.mjs', flow(`test('新用户首单立减十元', () => {\n${setup}  assert.equal(sum - 10, 90)\n})\n`))
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删了测试用例[^：\n]*：tests\/flow\.test\.mjs（删了："会员价不叠加优惠券"）/)
    assert.doesNotMatch(r.out, /改了名也改了内容/)
  })

  test('要给用户过目的放水只写了理由、没写"给用户过目"：不通过，说明要用白话写原来守什么、现在守什么、为什么', () => {
    const repo = sampleRepo(dir => write(dir, 'tests/format.test.mjs', `${TEST_HEAD}test('一', () => assert.equal(1, 1))\n`))
    rmSync(join(repo, 'tests/format.test.mjs'))
    record(repo, '- `tests/format.test.mjs`：格式化功能整块去掉了')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删了测试文件：tests\/format\.test\.mjs\n.*理由.*格式化功能整块去掉了\n.*还没写"## 给用户过目"/)
    assert.match(r.out, /"## 给用户过目"一段[\s\S]*原来这些测试守的是什么，现在守的是什么，为什么改/)
    // 理由都写了，不再提示写理由
    assert.doesNotMatch(r.out, /"## 放水理由"一段/)

    record(repo, '- `tests/format.test.mjs`：格式化功能整块去掉了', '- `tests/format.test.mjs`：原来守着金额的显示格式，这个功能去掉了，不再守')
    const ok = testcraft(repo, ['weaken'])
    assert.equal(ok.code, 0, ok.out)
    assert.match(ok.out, /✓ 删了测试文件.*\n.*理由.*\n.*给用户过目.*这个功能去掉了/)
  })
})
