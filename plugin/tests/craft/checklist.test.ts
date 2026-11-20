import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { sampleRepo, testcraft, write } from './helpers.ts'

const edit = (repo: string, path: string, from: string, to: string): void => {
  const file = join(repo, path)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes(from), `${path} 里没有 ${from}`)
  writeFileSync(file, text.replace(from, to))
}

const COUPON_ITEM = `# 改了满减的算法，结算页的提示要跟着改

## 触发

- \`src/price.mjs\` 改到 \`coupon\`

## 怎么查

结算页提示的减免金额和 applyCoupon 算出来的一样。

## 来由

fix/coupon-hint：满减改了，结算页提示还是旧的金额。
`

const ITEM_PATH = '.testcraft/checklist/coupon-hint.md'
const withItem = (): string => sampleRepo(dir => write(dir, ITEM_PATH, COUPON_ITEM))

describe('testcraft checklist', () => {
  test('改到了条目触发条件写的文件和文字：列出这条和怎么查，只是提醒，不算没通过，也不用写下怎么查的', () => {
    const repo = withItem()
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /这次改动命中 1 条/)
    assert.match(r.out, /· coupon-hint：改了满减的算法/)
    assert.match(r.out, /改到了：src\/price\.mjs/)
    assert.match(r.out, /怎么查：结算页提示的减免金额/)
    assert.match(r.out, /来由：fix\/coupon-hint/)
    assert.match(testcraft(repo, ['status']).out, /清单（\.testcraft\/checklist\/）：1 条，这次命中 1 条：coupon-hint/)
  })

  test('改到了触发条件写的文件、增删的行里却没有那段文字：不命中', () => {
    const repo = withItem()
    edit(repo, 'src/price.mjs', 'sum += item.price * item.quantity', 'sum = sum + item.price * item.quantity')
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /一条也没命中/)
  })

  test('按分叉点那一版的清单提醒：分支里新加的条目这次不生效，分支里删了的照旧提醒', () => {
    const repo = withItem()
    write(repo, '.testcraft/checklist/total.md', COUPON_ITEM.replace('`src/price.mjs` 改到 `coupon`', '`src/**`'))
    rmSync(join(repo, ITEM_PATH))
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /· coupon-hint/)
    assert.doesNotMatch(r.out, /total/)
  })

  test('触发写的文字只出现在删掉的行、或只出现在新加的行：也命中', () => {
    const removedOnly = withItem()
    edit(removedOnly, 'src/price.mjs', 'if (amount >= coupon.threshold) {', 'if (amount >= 100) {')
    assert.match(testcraft(removedOnly, ['checklist']).out, /· coupon-hint/)

    const addedOnly = withItem()
    edit(addedOnly, 'src/price.mjs', 'export function applyCoupon', "export const NOTE = 'coupon'\n\nexport function applyCoupon")
    assert.match(testcraft(addedOnly, ['checklist']).out, /· coupon-hint/)
  })

  test('这次加的条目没写怎么查、来由，或触发条件写坏了：不算通过', () => {
    const repo = sampleRepo()
    write(repo, '.testcraft/checklist/broken.md', '# 有个坑\n\n## 触发\n\n- `src/**` 改到 `(`\n- 价格文件\n')
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /`\(` 不是合法的正则/)
    assert.match(r.out, /"价格文件"没写路径/)
    assert.match(r.out, /没写怎么查/)
    assert.match(r.out, /没写来由/)
  })

  test('分叉点上原有的条目写坏了：这次改动不拦，只提醒', () => {
    const repo = sampleRepo(dir => {
      write(dir, ITEM_PATH, COUPON_ITEM)
      write(dir, '.testcraft/checklist/broken.md', '# 有个坑\n\n## 触发\n\n- `src/**`\n')
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /分叉点上这几条写得不对[\s\S]*broken\.md 没写怎么查/)
    assert.match(r.out, /· coupon-hint/)
  })

  test('条目的文件名是中文：照样按它提醒', () => {
    const repo = sampleRepo(dir => write(dir, '.testcraft/checklist/满减提示.md', COUPON_ITEM))
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    assert.match(testcraft(repo, ['checklist']).out, /· 满减提示：改了满减的算法/)
  })

  test('在 .gitattributes 里把文件标成二进制：照样按增删的行判断命中', () => {
    const repo = withItem()
    write(repo, '.gitattributes', '*.mjs -diff\n')
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    assert.match(testcraft(repo, ['checklist']).out, /· coupon-hint/)
  })

  test('没有证明、放水检查、复查这些命令：testcraft 只有 checklist 和 status', () => {
    const repo = withItem()
    for (const gone of ['prove', 'weaken', 'review', 'check']) {
      const r = testcraft(repo, [gone])
      assert.equal(r.code, 2, gone)
      assert.match(r.out, new RegExp(`不认识的命令：${gone}`))
    }
  })
})
