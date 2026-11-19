import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { sampleRepo, sh, testcraft, write } from './helpers.ts'

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
const record = (repo: string, text: string): void => write(repo, '.testcraft/changes/feature.md', `# feature\n\n${text}\n`)

describe('testcraft checklist', () => {
  test('改到了条目触发条件写的文件和文字：改动记录没写怎么查的不让合并，写了就过', () => {
    const repo = withItem()
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ coupon-hint：改了满减的算法/)
    assert.match(r.out, /怎么查：结算页提示的减免金额/)
    assert.equal(testcraft(repo, ['check']).code, 1)

    record(repo, '## 清单\n\n- `coupon-hint`：结算页提示改成按两倍减免显示，和 applyCoupon 对过')
    const ok = testcraft(repo, ['checklist'])
    assert.equal(ok.code, 0, ok.out)
    assert.match(ok.out, /✓ coupon-hint[\s\S]*和 applyCoupon 对过/)
    assert.equal(testcraft(repo, ['check']).code, 0)
  })

  test('只写了编号没写怎么查的，不算写了', () => {
    const repo = withItem()
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    record(repo, '## 清单\n\n- `coupon-hint`')
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ coupon-hint/)
  })

  test('改到了触发条件写的文件、增删的行里却没有那段文字：不命中', () => {
    const repo = withItem()
    edit(repo, 'src/price.mjs', 'sum += item.price * item.quantity', 'sum = sum + item.price * item.quantity')
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /一条也没命中/)
  })

  test('按分叉点那一版的清单查：分支里新加的条目这次不生效，分支里删了的照旧要查', () => {
    const repo = withItem()
    write(repo, '.testcraft/checklist/total.md', COUPON_ITEM.replace('`src/price.mjs` 改到 `coupon`', '`src/**`'))
    rmSync(join(repo, ITEM_PATH))
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ coupon-hint/)
    assert.doesNotMatch(r.out, /total/)
  })

  test('删了或放宽了清单条目：要理由，合并前给用户过目', () => {
    const repo = withItem()
    edit(repo, ITEM_PATH, '`src/price.mjs` 改到 `coupon`', '`src/coupon.mjs`')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删了或放宽了清单里的条目：\.testcraft\/checklist\/coupon-hint\.md（去掉或改了触发条件）/)

    record(
      repo,
      '## 放水理由\n\n- `.testcraft/checklist/coupon-hint.md`：触发条件从 price.mjs 改到 coupon.mjs\n\n## 给用户过目\n\n- `.testcraft/checklist/coupon-hint.md`：原来改价格文件就要查提示，现在满减搬到了 coupon.mjs，因为代码挪了地方',
    )
    assert.equal(testcraft(repo, ['weaken']).code, 0)
    const check = testcraft(repo, ['check'])
    assert.equal(check.code, 1, check.out)
    assert.match(check.out, /还没经用户确认[\s\S]*1\. \.testcraft\/checklist\/coupon-hint\.md\n.*\n.*- 删了或放宽了合并前要查的清单条目（去掉或改了触发条件）\n.*说明：原来改价格文件就要查提示/)

    const deleted = withItem()
    rmSync(join(deleted, ITEM_PATH))
    assert.match(testcraft(deleted, ['weaken']).out, /✗ 删了或放宽了清单里的条目：.*（删了这条）/)

    const looser = withItem()
    edit(looser, ITEM_PATH, '结算页提示的减免金额和 applyCoupon 算出来的一样。', '看一眼结算页。')
    assert.match(testcraft(looser, ['weaken']).out, /✗ 删了或放宽了清单里的条目：.*（改了怎么查）/)

    // 只改触发的文字、只改触发的路径，都算改了触发条件
    const otherText = withItem()
    edit(otherText, ITEM_PATH, '改到 `coupon`', '改到 `discount`')
    assert.match(testcraft(otherText, ['weaken']).out, /✗ 删了或放宽了清单里的条目：.*（去掉或改了触发条件）/)
    const otherPath = withItem()
    edit(otherPath, ITEM_PATH, '`src/price.mjs` 改到', '`src/coupon.mjs` 改到')
    assert.match(testcraft(otherPath, ['weaken']).out, /✗ 删了或放宽了清单里的条目：.*（去掉或改了触发条件）/)
  })

  test('触发写的文字只出现在删掉的行、或只出现在新加的行：也命中', () => {
    const removedOnly = withItem()
    edit(removedOnly, 'src/price.mjs', 'if (amount >= coupon.threshold) {', 'if (amount >= 100) {')
    assert.match(testcraft(removedOnly, ['checklist']).out, /✗ coupon-hint/)

    const addedOnly = withItem()
    edit(addedOnly, 'src/price.mjs', 'export function applyCoupon', "export const NOTE = 'coupon'\n\nexport function applyCoupon")
    assert.match(testcraft(addedOnly, ['checklist']).out, /✗ coupon-hint/)
  })

  test('新加条目、给条目多加触发条件、改来由：不算放宽，不用理由', () => {
    const repo = withItem()
    edit(repo, ITEM_PATH, '- `src/price.mjs` 改到 `coupon`', '- `src/price.mjs` 改到 `coupon`\n- `src/cart.mjs`')
    edit(repo, ITEM_PATH, '结算页提示还是旧的金额。', '结算页提示还是旧的金额，用户投诉。')
    write(repo, '.testcraft/checklist/total.md', COUPON_ITEM.replace('`src/price.mjs` 改到 `coupon`', '`src/**`'))
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /没有发现/)
  })

  test('这次加的条目没写怎么查、来由，或触发条件写坏了：不让合并', () => {
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
    record(repo, '## 清单\n\n- `coupon-hint`：结算页提示改成按两倍减免显示，和 applyCoupon 对过')
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /分叉点上这几条写得不对[\s\S]*broken\.md 没写怎么查/)
    assert.match(r.out, /✓ coupon-hint/)
  })

  test('条目的文件名是中文：照样按它查', () => {
    const repo = sampleRepo(dir => write(dir, '.testcraft/checklist/满减提示.md', COUPON_ITEM))
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 满减提示：改了满减的算法/)
  })

  test('条目改成别的扩展名、挪进子目录：等于删了这条，要理由', () => {
    for (const to of ['coupon-hint.md.bak', 'old/coupon-hint.md']) {
      const repo = withItem()
      // git mv：内容不变，git 认成改名
      sh(repo, `mkdir -p .testcraft/checklist/old && git mv ${ITEM_PATH} .testcraft/checklist/${to}`)
      const r = testcraft(repo, ['weaken'])
      assert.equal(r.code, 1, r.out)
      assert.match(r.out, /✗ 删了或放宽了清单里的条目：.*coupon-hint\.md.*（删了这条）/, to)
    }
  })

  test('在 .gitattributes 里把文件标成二进制：照样按增删的行判断命中', () => {
    const repo = withItem()
    write(repo, '.gitattributes', '*.mjs -diff\n')
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ coupon-hint/)
  })

  test('改动记录里别的段落标题带"清单"：不当成清单的答案，也不让放水检查失败', () => {
    const repo = withItem()
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    record(repo, '## 上线检查清单\n\n- 通知运营\n- `coupon-hint`：上线前通知运营看一眼')
    assert.equal(testcraft(repo, ['weaken']).code, 0)
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ coupon-hint/)
  })

  test('"## 清单"里写得不对的行：由 checklist 指出来，放水检查不管', () => {
    const repo = withItem()
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off * 2')
    record(repo, '## 清单\n\n- `coupon-hint`：结算页提示改成按两倍减免显示，和 applyCoupon 对过\n- 对过结算页了')
    assert.equal(testcraft(repo, ['weaken']).code, 0)
    const r = testcraft(repo, ['checklist'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /"## 清单"写得不对[\s\S]*没写是清单的哪一条/)
  })
})
