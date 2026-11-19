import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { codeLines, SKIPPING } from '../../src/craft/files.ts'
import { commitOnMain, MEMBER_PRICE, sampleRepo, sh, TEST_HEAD, testcraft, write } from './helpers.ts'

const edit = (repo: string, path: string, from: string, to: string): void => {
  const file = join(repo, path)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes(from), `${path} 里没有 ${from}`)
  writeFileSync(file, text.replace(from, to))
}

/** 放水检查跑了几次测试（看日志）。 */
const runs = (repo: string): number =>
  sh(repo, 'cat .git/testpace/logs/* 2>/dev/null || true')
    .split('\n')
    .filter(line => line.startsWith('===== ') && !line.startsWith('===== 退出码')).length

/** 写改动记录：放水理由；要给用户过目的再写"## 给用户过目"。 */
const reason = (repo: string, lines: string, plain?: string): void =>
  write(repo, '.testcraft/changes/feature.md', `# feature\n\n## 放水理由\n\n${lines}\n${plain ? `\n## 给用户过目\n\n${plain}\n` : ''}`)

describe('testcraft weaken', () => {
  test('只加了代码和新测试：没有放水', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', `${TEST_HEAD}import { memberPrice } from '../src/price.mjs'\ntest('九折', () => assert.equal(memberPrice(100, { level: 'gold' }), 90))\n`)
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /没有发现/)
  })

  test('改了代码的行为、跟着改了期望值：旧版测试跑不过，要理由；写了理由就通过', () => {
    const repo = sampleRepo()
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 程序的做法变了.*旧版测试在新代码上跑不过.*：tests\/price\.test\.mjs（旧版第 9 行的测试跑不过）/)

    reason(repo, '- `tests/price.test.mjs`：规则变了，用户确认"满减券改成减一半"', '- `tests/price.test.mjs`：原来满 100 减 20，现在减一半；用户定的新活动规则')
    const ok = testcraft(repo, ['weaken'])
    assert.equal(ok.code, 0, ok.out)
    assert.match(ok.out, /✓ 程序的做法变了.*\n.*用户确认.*\n.*给用户过目.*原来满 100 减 20/)
  })

  test('只是改名、挪位置、格式化测试：旧版照样能过，不用理由', () => {
    const repo = sampleRepo()
    edit(repo, 'tests/price.test.mjs', "test('满额才减', () => {", "test('满额才减，不满不减', () => {")
    edit(repo, 'tests/price.test.mjs', '  assert.equal(applyCoupon(99,', '    assert.equal(applyCoupon(99,')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 0, r.out)
  })

  test('只改了已有测试的断言、没改代码（换了写法）：要理由，一条路径规则能盖住一批；改多行断言里的一行也算', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'tests/total.test.mjs', `${TEST_HEAD}import { total } from '../src/price.mjs'\ntest('空订单合计为零', () => {\n  assert.equal(total([]), 0)\n})\n`)
      edit(dir, 'tests/price.test.mjs', '  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), 80)', '  assert.equal(\n    applyCoupon(100, { threshold: 100, off: 20 }),\n    80,\n  )')
    })
    edit(repo, 'tests/price.test.mjs', '    80,', '    100 - 20,')
    edit(repo, 'tests/total.test.mjs', 'assert.equal(total([]), 0)', 'assert.strictEqual(total([]), 0)')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删改了已有测试的断言.*：tests\/price\.test\.mjs（这次没有改代码）/)
    assert.match(r.out, /✗ 删改了已有测试的断言.*：tests\/total\.test\.mjs（这次没有改代码）/)
    // 测试之外都没改：旧版测试跑新代码就是分叉点上的样子，一个测试都不用跑
    assert.doesNotMatch(sh(repo, 'cat .git/testpace/logs/* 2>/dev/null || true'), /=====/)

    reason(repo, '- `tests/*.test.mjs`：只换了断言的写法，检查的东西没变')
    const ok = testcraft(repo, ['weaken'])
    assert.equal(ok.code, 0, ok.out)
    assert.match(ok.out, /✓ 删改了已有测试的断言.*\n.*只换了断言的写法/)
  })

  test('testpace.json 里 ignore 的文件（文档）不算改了代码', () => {
    const repo = sampleRepo(dir => write(dir, 'docs/note.md', '# 说明\n'))
    write(repo, 'docs/note.md', '# 说明\n\n下拉框的找法换了。\n')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 100 - 20)')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删改了已有测试的断言.*：tests\/price\.test\.mjs（这次没有改代码）/)
    assert.doesNotMatch(sh(repo, 'cat .git/testpace/logs/* 2>/dev/null || true'), /=====/)
  })

  test('几个改过的测试里只有一个旧版跑不过：分开找，只标它', () => {
    const other = (name: string): string => `${TEST_HEAD}import { total } from '../src/price.mjs'\ntest('${name}', () => {\n  assert.equal(total([]), 0)\n})\n`
    const repo = sampleRepo(dir => {
      for (const name of ['a', 'b', 'c']) write(dir, `tests/${name}.test.mjs`, other(`空订单 ${name}`))
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    for (const name of ['a', 'b', 'c']) edit(repo, `tests/${name}.test.mjs`, `test('空订单 ${name}'`, `test('空订单合计为零 ${name}'`)
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 程序的做法变了.*旧版测试在新代码上跑不过.*tests\/price\.test\.mjs/)
    assert.doesNotMatch(r.out, /tests\/[abc]\.test\.mjs/)
  })

  test('修 bug 时收紧已有断言：换回改动前的代码它因改了的断言失败，不用理由；改了代码、断言却和它对不上，要理由', () => {
    const buggy = (dir: string): void => {
      edit(dir, 'src/price.mjs', 'amount >= coupon.threshold', 'amount >= coupon.threshold - 1')
      edit(dir, 'tests/price.test.mjs', 'assert.equal(applyCoupon(99, { threshold: 100, off: 20 }), 99)', 'assert.ok(applyCoupon(99, { threshold: 100, off: 20 }) <= 99)')
    }
    const fixed = sampleRepo(buggy)
    edit(fixed, 'src/price.mjs', 'amount >= coupon.threshold - 1', 'amount >= coupon.threshold')
    edit(fixed, 'tests/price.test.mjs', 'assert.ok(applyCoupon(99, { threshold: 100, off: 20 }) <= 99)', 'assert.equal(applyCoupon(99, { threshold: 100, off: 20 }), 99)')
    const r = testcraft(fixed, ['weaken'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /没有发现/)

    const unrelated = sampleRepo()
    edit(unrelated, 'src/price.mjs', 'sum += item.price * item.quantity', 'sum = sum + item.price * item.quantity')
    edit(unrelated, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 100 - 20)')
    const loose = testcraft(unrelated, ['weaken'])
    assert.equal(loose.code, 1, loose.out)
    assert.match(loose.out, /✗ 删改了已有测试的断言.*：tests\/price\.test\.mjs（换回改动前的代码它照样通过）/)
  })

  test('删了已有测试里的断言行：要理由；整个测试挪到别的文件不算', () => {
    const repo = sampleRepo()
    edit(repo, 'tests/price.test.mjs', '  assert.equal(applyCoupon(99, { threshold: 100, off: 20 }), 99)\n', '')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删改了已有测试的断言.*：tests\/price\.test\.mjs（少了 1 处断言）/)
    assert.doesNotMatch(r.out, /删了测试用例/)
  })

  test('删测试文件、加跳过、改依赖：都要理由；改 testpace.json 本身不用写理由（它的放松另有管法）', () => {
    const repo = sampleRepo(dir => write(dir, 'tests/format.test.mjs', `${TEST_HEAD}test('一', () => assert.equal(1, 1))\n`))
    rmSync(join(repo, 'tests/format.test.mjs'))
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    edit(repo, 'testpace.json', '"tests": ["tests/**/*.test.mjs"]', '"tests": ["tests/**/*.test.mjs", "!tests/format.test.mjs"]')
    edit(repo, 'package.json', '"private": true', '"private": true, "devDependencies": { "left-pad": "1.3.0" }')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删了测试文件：tests\/format\.test\.mjs/)
    assert.match(r.out, /✗ 让测试暂时不跑（新加了跳过）：tests\/price\.test\.mjs（第 \d+ 行/)
    // 缩小找测试的范围要用户同意，由 testpace full 把关；ignore 合并后才生效。这里不再要理由
    assert.doesNotMatch(r.out, /testpace\.json/)
    assert.match(r.out, /✗ 改了依赖：package\.json（devDependencies）/)

    reason(
      repo,
      ['- `tests/format.test.mjs`：格式化功能整块去掉了', '- `tests/price.test.mjs`：满减暂停，等用户确认新规则', '- `package.json`：加一个补齐用的依赖'].join('\n'),
      ['- `tests/format.test.mjs`：原来守着金额的显示格式，这个功能去掉了，不再守', '- `tests/price.test.mjs`：原来守着满额才减，满减活动暂停，先不查'].join('\n'),
    )
    assert.equal(testcraft(repo, ['weaken']).code, 0)
  })

  test('以前改动写的理由不算数，只认这次新加的记录文件', () => {
    const repo = sampleRepo()
    reason(repo, '- `tests/price.test.mjs`：上一次的理由')
    commitOnMain(repo, '上一次的改动')
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 让测试暂时不跑（新加了跳过）/)
  })

  test('理由行只写了文件没写原因：不算', () => {
    const repo = sampleRepo()
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    reason(repo, '- `tests/price.test.mjs`')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /只写了文件，没写理由/)
  })

  test('删掉 .testcraft/ 也躲不过：分叉点上接入了就照样检查', () => {
    const repo = sampleRepo()
    rmSync(join(repo, '.testcraft'), { recursive: true })
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 让测试暂时不跑（新加了跳过）/)
  })

  test('检查过的同一份改动不再重跑；在 testpace full 那样的已提交状态下也能查', () => {
    const repo = sampleRepo()
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    reason(repo, '- `tests/price.test.mjs`：规则变了，用户确认"减一半"', '- `tests/price.test.mjs`：原来满 100 减 20，现在减一半')
    sh(repo, 'git add -A && git commit -qm change')
    assert.equal(testcraft(repo, ['weaken']).code, 0)
    assert.match(testcraft(repo, ['weaken']).out, /已经检查过/)
  })

  test('检查过以后只改了 testpace.json 里 ignore 的脚本：不用重查；改了别的代码要重查', () => {
    const repo = sampleRepo(dir => {
      const config = JSON.parse(readFileSync(join(dir, 'testpace.json'), 'utf8')) as { ignore: string[] }
      write(dir, 'testpace.json', JSON.stringify({ ...config, ignore: [...config.ignore, 'infra/deploy/**'] }))
      write(dir, 'infra/deploy/deploy.sh', 'echo deploy\n')
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    reason(repo, '- `tests/price.test.mjs`：规则变了，用户确认"减一半"', '- `tests/price.test.mjs`：原来满 100 减 20，现在减一半')
    assert.equal(testcraft(repo, ['weaken']).code, 0)

    write(repo, 'infra/deploy/deploy.sh', 'echo deploy --prod\n')
    assert.match(testcraft(repo, ['weaken']).out, /已经检查过/)

    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /已经检查过/)
  })

  test('删了测试用例要理由，只认写明的文件；改名、挪到别的文件不算删', () => {
    const repo = sampleRepo()
    const file = join(repo, 'tests/price.test.mjs')
    const text = readFileSync(file, 'utf8')
    const coupon = text.slice(text.indexOf("test('满额才减'"))
    // 合计那个改了名，满减那个挪到新文件
    writeFileSync(file, text.replace("test('合计是单价乘数量再相加'", "test('合计按单价乘数量相加'").replace(coupon, ''))
    write(repo, 'tests/coupon.test.mjs', `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\n\n${coupon}`)
    let r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 0, r.out)

    edit(repo, 'tests/coupon.test.mjs', "  assert.equal(applyCoupon(99, { threshold: 100, off: 20 }), 99)\n", '')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/test\('合计按单价乘数量相加'[\s\S]*?\n\}\)\n/, ''))
    r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删了测试用例[^：\n]*：tests\/price\.test\.mjs（删了："合计是单价乘数量再相加"、"满额才减"）/)
    const exact = '- `tests/price.test.mjs`：合计改由下单流程的测试守，满减挪到 coupon 测试'
    const plain = '- `tests/price.test.mjs`：原来这里守着合计和满减，现在合计由下单流程守，满减挪到 coupon 测试'
    const wide = (line: string): string => line.replace('tests/price.test.mjs', 'tests/*.mjs')
    // 理由写通配、给用户过目写准：不通过
    reason(repo, wide(exact), plain)
    r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删了测试用例/)
    // 理由写准、给用户过目写通配：也不通过
    reason(repo, exact, wide(plain))
    r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删了测试用例.*\n.*理由.*\n.*还没写"## 给用户过目"/)
    reason(repo, exact, plain)
    assert.equal(testcraft(repo, ['weaken']).code, 0)
  })

  test('测试改名时只加了内容不算删；改名时删了原来的断言，算删', () => {
    const repo = sampleRepo()
    edit(
      repo,
      'tests/price.test.mjs',
      "test('满额才减', () => {\n",
      "test('满额才减，差一分不减', () => {\n  assert.equal(applyCoupon(0, { threshold: 100, off: 20 }), 0)\n",
    )
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 99)\n', '{ threshold: 100, off: 20 }), 99)\n  assert.equal(applyCoupon(120, { threshold: 100, off: 20 }), 100)\n')
    let r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 0, r.out)

    edit(repo, 'tests/price.test.mjs', '  assert.equal(applyCoupon(99, { threshold: 100, off: 20 }), 99)\n', '')
    r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    // 原来两条断言只剩一条，又加了两条：一半都不到，说成删了
    assert.match(r.out, /✗ 删了测试用例[^：\n]*：tests\/price\.test\.mjs（删了："满额才减"）/)
  })

  test('测试文件改名成不像测试的名字：等于删了，要理由', () => {
    const repo = sampleRepo()
    sh(repo, 'git mv tests/price.test.mjs tests/price.mjs.off')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删了测试文件：tests\/price\.test\.mjs → tests\/price\.mjs\.off（改名成了不认作测试的文件）/)
  })

  test('理由要对得上文件：写别的文件不算，太宽的通配不算，删测试只认写明的路径', () => {
    const repo = sampleRepo(dir => write(dir, 'tests/format.test.mjs', `${TEST_HEAD}test('一', () => assert.equal(1, 1))\n`))
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    rmSync(join(repo, 'tests/format.test.mjs'))
    reason(repo, '- `tests/other.test.mjs`：别的文件的理由')
    let r = testcraft(repo, ['weaken'])
    assert.match(r.out, /✗ 让测试暂时不跑（新加了跳过）/)
    assert.match(r.out, /✗ 删了测试文件/)

    reason(repo, '- `**`：统一调整一下')
    r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /`\*\*` 太宽/)

    const plain = ['- `tests/*.test.mjs`：原来守着满额才减，满减活动暂停', '- `tests/format.test.mjs`：原来守着金额格式，这个功能去掉了'].join('\n')
    reason(repo, '- `tests/*.test.mjs`：满减暂停，格式化功能去掉', plain)
    r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✓ 让测试暂时不跑（新加了跳过）/)
    assert.match(r.out, /✗ 删了测试文件：tests\/format\.test\.mjs/)

    reason(repo, ['- `tests/*.test.mjs`：满减暂停', '- `tests/format.test.mjs`：格式化功能整块去掉了'].join('\n'), plain)
    assert.equal(testcraft(repo, ['weaken']).code, 0)
  })

  test('改了以前的记录文件、在里面补理由：不算，只认这次新加的', () => {
    const repo = sampleRepo()
    reason(repo, '- `tests/format.test.mjs`：上一次的理由')
    commitOnMain(repo, '上一次的改动')
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    appendFileSync(join(repo, '.testcraft/changes/feature.md'), '- `tests/price.test.mjs`：这次补在旧记录里的理由\n')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 让测试暂时不跑（新加了跳过）/)
  })

  test('测试的约定：命令和 npm 脚本调到的脚本、shell 脚本再调的脚本算，脚本里提到的业务代码不算；命令里写了目录也不出错', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'src/money/rate.mjs', 'export const rate = 1\n')
      write(dir, 'testpace.json', JSON.stringify({ fast: 'test -d src/money', files: 'node --test', full: 'npm test' }))
      write(dir, 'package.json', JSON.stringify({ name: 's', private: true, type: 'module', scripts: { test: 'sh scripts/check.sh' } }))
      write(dir, 'scripts/check.sh', 'node --check src/price.mjs\nsh scripts/inner.sh\n')
      write(dir, 'scripts/inner.sh', 'node --test\n')
      write(dir, '.testcraft/config.json', JSON.stringify({ contract: ['infra/*.yaml'] }))
      write(dir, 'infra/test.yaml', 'db: postgres\n')
    })
    edit(repo, 'scripts/inner.sh', 'node --test', 'exit 0')
    edit(repo, 'infra/test.yaml', 'postgres', 'sqlite')
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off - 0')
    let r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 改了测试的约定.*scripts\/inner\.sh/)
    assert.match(r.out, /✗ 改了测试的约定.*infra\/test\.yaml/)
    assert.doesNotMatch(r.out, /约定.*src\/price\.mjs/)
    // 改约定的理由只认写明的路径
    reason(repo, '- `scripts/*.sh`：测试换个跑法\n- `infra/*.yaml`：测试改用 sqlite 库')
    r = testcraft(repo, ['weaken'])
    assert.match(r.out, /✗ 改了测试的约定.*scripts\/inner\.sh/)
    reason(repo, '- `scripts/inner.sh`：测试换个跑法\n- `infra/test.yaml`：测试改用 sqlite 库')
    assert.equal(testcraft(repo, ['weaken']).code, 0)
    // 命令不再调它、把它删掉：分叉点上调到的照样算约定
    edit(repo, 'scripts/check.sh', 'sh scripts/inner.sh\n', '')
    rmSync(join(repo, 'scripts/inner.sh'))
    reason(repo, '- `scripts/check.sh`：不再跑这一步\n- `infra/test.yaml`：测试改用 sqlite 库')
    r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 改了测试的约定.*scripts\/inner\.sh/)
  })

  test('测试的约定：用变量拼的脚本路径、交给 node 跑的文件、测试命令调到的 npm 脚本算；注释里提到的、和测试无关的 npm 脚本不算', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'testpace.json', JSON.stringify({ fast: 'node -e 0', files: 'node --test', full: 'npm test' }))
      write(dir, 'package.json', JSON.stringify({ name: 's', private: true, type: 'module', scripts: { test: 'sh scripts/testpace.sh', dev: 'node src/price.mjs' } }))
      write(dir, 'scripts/testpace.sh', '# 部署见 infra/deploy.sh\ndir="$(cd "$(dirname "$0")" && pwd)"\nsh "${dir}/inner.sh"\nnode scripts/ran.mjs # 核对每个文件都跑到了\n')
      write(dir, 'scripts/inner.sh', 'node --test\n')
      write(dir, 'scripts/ran.mjs', 'process.exit(0)\n')
      write(dir, 'infra/deploy.sh', 'echo deploy\n')
    })
    edit(repo, 'scripts/inner.sh', 'node --test', 'exit 0')
    edit(repo, 'scripts/ran.mjs', 'process.exit(0)', 'process.exit(0) // 不核对了')
    edit(repo, 'infra/deploy.sh', 'echo deploy', 'echo deploy now')
    edit(repo, 'package.json', '"dev":"node src/price.mjs"', '"dev":"node --watch src/price.mjs"')
    let r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 改了测试的约定.*scripts\/inner\.sh/)
    assert.match(r.out, /✗ 改了测试的约定.*scripts\/ran\.mjs/)
    assert.doesNotMatch(r.out, /infra\/deploy\.sh|package\.json/)
    edit(repo, 'package.json', '"test":"sh scripts/testpace.sh"', '"pretest":"true","test":"sh scripts/testpace.sh"')
    r = testcraft(repo, ['weaken'])
    assert.match(r.out, /✗ 改了测试的约定.*package\.json（scripts 里的 pretest）/)
  })

  test('改测试配置、快照和测试数据、锁文件，删辅助文件、改找不到使用者的辅助文件、辅助文件改名成别的：都要理由', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'vitest.config.mjs', 'export default { test: { bail: 0 } }\n')
      write(dir, 'tests/fixtures/order.json', '{ "amount": 100 }\n')
      write(dir, 'package-lock.json', '{ "lockfileVersion": 3 }\n')
      write(dir, 'tests/support/old.mjs', 'export const a = 1\n')
      write(dir, 'tests/support/lonely.mjs', 'export const b = 1\nexport const c = 2\n')
      write(dir, 'tests/support/moved.mjs', 'export const d = 1\n')
    })
    edit(repo, 'vitest.config.mjs', 'bail: 0', 'bail: 1')
    edit(repo, 'tests/fixtures/order.json', '100', '90')
    edit(repo, 'package-lock.json', '3', '2')
    rmSync(join(repo, 'tests/support/old.mjs'))
    edit(repo, 'tests/support/lonely.mjs', 'export const c = 2\n', '')
    sh(repo, 'mkdir -p lib && git mv tests/support/moved.mjs lib/moved.mjs')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 改了测试或检查的配置：vitest\.config\.mjs/)
    assert.match(r.out, /✗ 改了快照或测试数据：tests\/fixtures\/order\.json/)
    assert.match(r.out, /✗ 改了依赖：package-lock\.json/)
    assert.match(r.out, /✗ 删了测试文件：tests\/support\/old\.mjs/)
    assert.match(r.out, /✗ 删改了测试辅助文件，又找不到用它的测试.*tests\/support\/lonely\.mjs/)
    assert.match(r.out, /✗ 删了测试文件：tests\/support\/moved\.mjs → lib\/moved\.mjs/)
  })

  test('测试目录里的说明文档不算测试辅助文件；config 写了不算测试的路径，照别的文件认', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'tests/README.md', '# 测试说明\n- 一\n')
      write(dir, 'e2e/import/feishu.spec.mjs', "console.log('手动跑的导入练习')\n")
      write(dir, '.testcraft/config.json', JSON.stringify({ notTests: ['e2e/import/'] }))
    })
    edit(repo, 'tests/README.md', '- 一\n', '')
    rmSync(join(repo, 'e2e/import/feishu.spec.mjs'))
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /没有发现/)
  })

  test('新版测试在副本里也跑不过：判断不了，说明没做完，不说"没有发现"', () => {
    const repo = sampleRepo()
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 81)')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /放水检查没做完：这些文件的新版在副本里也跑不过.*tests\/price\.test\.mjs/)
    assert.doesNotMatch(r.out, /没有发现|通过/)
  })

  test('.testcraft/config.json 补充的测试文件规则照样认', () => {
    const repo = sampleRepo(dir => {
      write(dir, '.testcraft/config.json', JSON.stringify({ tests: ['checks/*.check.mjs'] }))
      write(dir, 'checks/price.check.mjs', `${TEST_HEAD}test('一', () => assert.equal(1, 1))\n`)
    })
    edit(repo, 'checks/price.check.mjs', "test('一'", "test.skip('一'")
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 让测试暂时不跑（新加了跳过）：checks\/price\.check\.mjs/)
  })

  test('期望值放在测试辅助文件里：改了代码的行为、跟着改辅助文件，用它的测试旧版跑不过，要理由', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'tests/support/coupon-cases.mjs', 'export const cases = [[100, 80], [99, 99]]\n')
      write(
        dir,
        'tests/coupon.test.mjs',
        `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\nimport { cases } from './support/coupon-cases.mjs'\ntest('满减', () => {\n  for (const [amount, want] of cases) assert.equal(applyCoupon(amount, { threshold: 100, off: 20 }), want)\n})\n`,
      )
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    edit(repo, 'tests/support/coupon-cases.mjs', '[100, 80]', '[100, 90]')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    // 只在辅助文件身上出一处，不按用它的测试逐个出
    assert.match(r.out, /✗ 程序的做法变了.*旧版测试在新代码上跑不过.*：tests\/support\/coupon-cases\.mjs（换回旧版后这几处跑不过：tests\/coupon\.test\.mjs:\d+（用到它的测试共 1 个））/)
    assert.doesNotMatch(r.out, /✗ [^：\n]*：tests\/coupon\.test\.mjs/)
    reason(
      repo,
      ['- `tests/price.test.mjs`：满减改成减一半，用户确认过', '- `tests/support/coupon-cases.mjs`：期望值跟着改成减一半'].join('\n'),
      '- `tests/price.test.mjs`、`tests/support/coupon-cases.mjs`：原来满 100 减 20，现在减一半，用户定的',
    )
    const passed = testcraft(repo, ['weaken'])
    assert.equal(passed.code, 0, passed.out)
  })

  test('没接入、又找不到默认分支的仓库：不检查，直接通过', () => {
    const repo = sampleRepo(dir => rmSync(join(dir, '.testcraft'), { recursive: true }))
    sh(repo, 'git branch -m main trunk')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /没有接入/)
  })

  test('检查过之后只改了文档：不用重查', () => {
    const repo = sampleRepo()
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    reason(repo, '- `tests/price.test.mjs`：满减暂停，等用户确认新规则', '- `tests/price.test.mjs`：原来守着满额才减，满减活动暂停，先不查')
    assert.equal(testcraft(repo, ['weaken']).code, 0)
    write(repo, 'docs/note.md', '# 说明\n')
    assert.match(testcraft(repo, ['weaken']).out, /已经检查过/)
  })

  test('测试、辅助文件只改了注释和空行：不按行为判断，一次也不跑；找不到使用者的辅助文件也不用理由', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'tests/support/cases.mjs', '// 满减的例子\nexport const cases = [[100, 80], [99, 99]]\n')
      write(dir, 'tests/support/lonely.mjs', '/* 没人用 */\nexport const b = 1\n')
      write(dir, 'tests/coupon.test.mjs', `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\nimport { cases } from './support/cases.mjs'\n// 例子在辅助文件里\ntest('满减', () => {\n  for (const [amount, want] of cases) assert.equal(applyCoupon(amount, { threshold: 100, off: 20 }), want)\n})\n`)
    })
    edit(repo, 'src/price.mjs', 'sum += item.price * item.quantity', 'sum = sum + item.price * item.quantity')
    edit(repo, 'tests/support/cases.mjs', '// 满减的例子\n', '/**\n * 满减的例子：满 100 减 20\n */\n\n')
    edit(repo, 'tests/support/lonely.mjs', '/* 没人用 */', '// 留着备用')
    edit(repo, 'tests/coupon.test.mjs', '// 例子在辅助文件里\n', '')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /没有发现/)
    assert.equal(runs(repo), 0)
  })

  const coupon = `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\nimport { cases } from './support/cases.mjs'\ntest('满减', () => {\n  for (const [amount, want] of cases) assert.equal(applyCoupon(amount, { threshold: 100, off: 20 }), want)\n})\n`
  // 在副本里第一次跑不过，再跑能过
  const flaky = `${TEST_HEAD}import { existsSync, writeFileSync } from 'node:fs'\nimport { cases } from './support/cases.mjs'\ntest('偶发', () => {\n  if (!existsSync('flaky.mark')) {\n    writeFileSync('flaky.mark', '')\n    assert.fail('偶发失败')\n  }\n  assert.ok(cases.length)\n})\n`
  const withFlaky = (): string =>
    sampleRepo(dir => {
      write(dir, 'tests/support/cases.mjs', 'export const cases = [[100, 80], [99, 99]]\n')
      write(dir, 'tests/coupon.test.mjs', coupon)
      write(dir, 'tests/flaky.test.mjs', flaky)
      write(dir, 'tests/count.test.mjs', `${TEST_HEAD}import { cases } from './support/cases.mjs'\ntest('有例子', () => assert.equal(cases.length, 2))\n`)
    })

  test('旧版一起跑时偶发失败、再跑一次能过：不算放水，只再跑跑不过的那个文件', () => {
    const repo = withFlaky()
    edit(repo, 'src/price.mjs', 'sum += item.price * item.quantity', 'sum = sum + item.price * item.quantity')
    edit(repo, 'tests/support/cases.mjs', '[[100, 80], [99, 99]]', '[\n  [100, 80],\n  [99, 99],\n]')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /没有发现/)
    assert.match(sh(repo, 'cat .git/testpace/logs/*'), /===== 旧版跑不过的 tests\/flaky\.test\.mjs 再跑一次/)
    assert.equal(runs(repo), 2)
  })

  test('用到辅助文件的只有一个测试、它偶发失败：认出了是它，照样再跑一次，不算放水', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'tests/support/cases.mjs', 'export const cases = [[100, 80], [99, 99]]\n')
      write(dir, 'tests/flaky.test.mjs', flaky)
    })
    edit(repo, 'src/price.mjs', 'sum += item.price * item.quantity', 'sum = sum + item.price * item.quantity')
    edit(repo, 'tests/support/cases.mjs', '[[100, 80], [99, 99]]', '[\n  [100, 80],\n  [99, 99],\n]')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /没有发现/)
    assert.match(sh(repo, 'cat .git/testpace/logs/*'), /===== 旧版跑不过的 tests\/flaky\.test\.mjs 再跑一次/)
  })

  test('真跑不过的和偶发失败的混在一起：只算真跑不过的，写明跑不过的位置；核对环境只跑那个文件', () => {
    const repo = withFlaky()
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/support/cases.mjs', '[100, 80]', '[100, 90]')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 程序的做法变了[^\n]*：tests\/support\/cases\.mjs（换回旧版后这几处跑不过：tests\/coupon\.test\.mjs:5（用到它的测试共 3 个））/)
    assert.doesNotMatch(r.out, /flaky/)
    const log = sh(repo, 'cat .git/testpace/logs/*')
    assert.match(log, /===== 旧版跑不过的 其中 2 个 再跑一次/)
    assert.match(log, /===== 新版 tests\/coupon\.test\.mjs 跑新代码（核对环境）/)
    // 一起跑、跑不过的两个再跑一次、核对环境各 1 次
    assert.equal(runs(repo), 3)
  })

  test('代码挪了位置，辅助文件和测试只跟着改了引用：各出一处"跑不起来"，不按用辅助文件的测试逐个拆；写了理由就过，不用用户过目', () => {
    const user = (name: string): string => `${TEST_HEAD}import { total } from './support/order.mjs'\ntest('空订单合计为零 ${name}', () => {\n  assert.equal(total([]), 0)\n})\n`
    const repo = sampleRepo(dir => {
      write(dir, 'tests/support/order.mjs', "export { total } from '../../src/price.mjs'\n")
      for (const name of ['a', 'b', 'c']) write(dir, `tests/${name}.test.mjs`, user(name))
    })
    sh(repo, 'git mv src/price.mjs src/money.mjs')
    edit(repo, 'tests/support/order.mjs', '../../src/price.mjs', '../../src/money.mjs')
    edit(repo, 'tests/price.test.mjs', '../src/price.mjs', '../src/money.mjs')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 测试跟着代码改了接法.*：tests\/support\/order\.mjs（换回旧版后这几个跑不起来：tests\/a\.test\.mjs、tests\/b\.test\.mjs、tests\/c\.test\.mjs（用到它的测试共 3 个））/)
    assert.match(r.out, /✗ 测试跟着代码改了接法.*：tests\/price\.test\.mjs\n/)
    assert.doesNotMatch(r.out, /程序的做法变了|✗ [^：\n]*：tests\/[abc]\.test\.mjs/)
    // 一起跑 1 次，跑不过的再跑 1 次（认出了是哪几个，哪怕是全部），辅助文件、测试文件分开各 1 次，核对环境 1 次
    assert.ok(runs(repo) <= 5, `跑了 ${runs(repo)} 次`)

    reason(repo, ['- `tests/support/order.mjs`：代码挪到 src/money.mjs，只改了引用', '- `tests/price.test.mjs`：同上，只改了引用'].join('\n'))
    const ok = testcraft(repo, ['check'])
    assert.equal(ok.code, 0, ok.out)
    assert.doesNotMatch(ok.out, /过目/)
  })

  test('测试文件旧版跑不起来，除了导入还改了别的（期望值写在断言行外）：照样算程序的做法变了', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'tests/coupon.test.mjs', `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\nconst want = 80\ntest('满减', () => {\n  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), want)\n})\n`)
    })
    sh(repo, 'git mv src/price.mjs src/money.mjs')
    edit(repo, 'src/money.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '../src/price.mjs', '../src/money.mjs')
    edit(repo, 'tests/price.test.mjs', '  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), 80)\n', '')
    edit(repo, 'tests/coupon.test.mjs', '../src/price.mjs', '../src/money.mjs')
    edit(repo, 'tests/coupon.test.mjs', 'const want = 80', 'const want = 90')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    for (const name of ['coupon', 'price']) assert.match(r.out, new RegExp(`✗ 程序的做法变了.*：tests/${name}\\.test\\.mjs（旧版在新代码上跑不起来，这次除了导入还改了别的）`))
    assert.doesNotMatch(r.out, /跟着代码改了接法/)
  })

  test('辅助文件唯一的使用者只改了名：旧版在旧名字上跑，只改了格式的辅助文件不出信号', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'tests/support/cases.mjs', 'export const cases = [[100, 80], [99, 99]]\n')
      write(dir, 'tests/coupon.test.mjs', `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\nimport { cases } from './support/cases.mjs'\ntest('满减', () => {\n  for (const [amount, want] of cases) assert.equal(applyCoupon(amount, { threshold: 100, off: 20 }), want)\n})\n`)
    })
    edit(repo, 'src/price.mjs', 'sum += item.price * item.quantity', 'sum = sum + item.price * item.quantity')
    sh(repo, 'git mv tests/coupon.test.mjs tests/coupon-rules.test.mjs')
    edit(repo, 'tests/support/cases.mjs', '[[100, 80], [99, 99]]', '[\n  [100, 80],\n  [99, 99],\n]')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /没有发现/)
  })

  test('用到辅助文件的测试这次都改了、换回旧版跑不起来：分不清是不是用了它新加的东西，按程序的做法变了算', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'tests/support/cases.mjs', 'export const cases = [[100, 80], [99, 99]]\n')
      write(dir, 'tests/coupon.test.mjs', `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\nimport { cases } from './support/cases.mjs'\ntest('满减', () => {\n  for (const [amount, want] of cases) assert.equal(applyCoupon(amount, { threshold: 100, off: 20 }), want)\n})\n`)
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    edit(repo, 'tests/support/cases.mjs', '[100, 80]', '[100, 90]')
    appendFileSync(join(repo, 'tests/support/cases.mjs'), 'export const coupon = { threshold: 100, off: 20 }\n')
    edit(repo, 'tests/coupon.test.mjs', "import { cases } from './support/cases.mjs'", "import { cases, coupon } from './support/cases.mjs'")
    edit(repo, 'tests/coupon.test.mjs', 'applyCoupon(amount, { threshold: 100, off: 20 })', 'applyCoupon(amount, coupon)')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 程序的做法变了.*：tests\/support\/cases\.mjs（换回旧版后这几个跑不起来：tests\/coupon\.test\.mjs（用到它的测试共 1 个，这次都改了/)
    assert.doesNotMatch(r.out, /跟着代码改了接法/)
  })

  test('拆开找时组外的单位用新版：辅助文件只改了格式、唯一的使用者改了期望值，只标使用者', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'tests/support/cases.mjs', 'export const cases = [[99, 99], [50, 50]]\n')
      write(dir, 'tests/coupon.test.mjs', `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\nimport { cases } from './support/cases.mjs'\ntest('满减', () => {\n  for (const [amount, want] of cases) assert.equal(applyCoupon(amount, { threshold: 100, off: 20 }), want)\n  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), 80)\n})\n`)
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    edit(repo, 'tests/coupon.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    edit(repo, 'tests/support/cases.mjs', '[[99, 99], [50, 50]]', '[\n  [99, 99],\n  [50, 50],\n]')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 程序的做法变了.*：tests\/coupon\.test\.mjs/)
    assert.doesNotMatch(r.out, /：tests\/support\/cases\.mjs/)
  })

  test('辅助文件只跑用到它、这次没改的测试：改了的测试用了它新加的东西，不会因此算跑不起来', () => {
    const user = (call: string, imports: string): string =>
      `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\nimport { ${imports} } from './support/cases.mjs'\ntest('不满额不减', () => {\n  for (const [amount, want] of cases) assert.equal(${call}, want)\n})\n`
    const repo = sampleRepo(dir => {
      write(dir, 'tests/support/cases.mjs', 'export const cases = [[99, 99], [50, 50]]\n')
      write(dir, 'tests/a.test.mjs', user('applyCoupon(amount, { threshold: 100, off: 20 })', 'cases'))
      write(dir, 'tests/b.test.mjs', user('applyCoupon(amount, { threshold: 100, off: 20 })', 'cases'))
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    write(repo, 'tests/support/cases.mjs', 'export const cases = [\n  [99, 99],\n  [50, 50],\n]\nexport const coupon = { threshold: 100, off: 20 }\n')
    write(repo, 'tests/b.test.mjs', user('applyCoupon(amount, coupon)', 'cases, coupon'))
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 程序的做法变了.*：tests\/price\.test\.mjs/)
    assert.doesNotMatch(r.out, /(程序的做法变了|跟着代码改了接法)[^：\n]*：tests\/(support\/cases\.mjs|b\.test\.mjs)/)
  })

  test('辅助文件改了期望值，另有几个测试只改了格式：只标辅助文件，先分开辅助文件和测试文件，跑的次数少', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const plain = (name: string): string => `${TEST_HEAD}import { total } from '../src/price.mjs'\ntest('空订单 ${name}', () => {\n  assert.equal(total([]), 0)\n})\n`
    const repo = sampleRepo(dir => {
      write(dir, 'tests/support/coupon-cases.mjs', 'export const cases = [[100, 80], [99, 99]]\n')
      write(dir, 'tests/coupon.test.mjs', `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\nimport { cases } from './support/coupon-cases.mjs'\ntest('满减', () => {\n  for (const [amount, want] of cases) assert.equal(applyCoupon(amount, { threshold: 100, off: 20 }), want)\n})\n`)
      for (const name of names) write(dir, `tests/${name}.test.mjs`, plain(name))
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/support/coupon-cases.mjs', '[100, 80]', '[100, 90]')
    for (const name of names) edit(repo, `tests/${name}.test.mjs`, '  assert.equal(total([]), 0)', '    assert.equal(total([]), 0)')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 程序的做法变了.*：tests\/support\/coupon-cases\.mjs/)
    assert.doesNotMatch(r.out, /✗ [^：\n]*：tests\/([a-h]|coupon)\.test\.mjs/)
    // 一起跑 1 次；辅助文件 1 次；8 个测试文件一起 1 次（都过）；核对环境 1 次。只对半分要 6 次
    assert.ok(runs(repo) <= 4, `跑了 ${runs(repo)} 次`)
  })

  test('核对环境时新版合起来跑不过、分开都过（测试之间互相影响）：照常出结论，不算没做完', () => {
    const racer = (want: number): string =>
      `${TEST_HEAD}import { unlinkSync, writeFileSync } from 'node:fs'\nimport { applyCoupon } from '../src/price.mjs'\ntest('占锁', async () => {\n  writeFileSync('shared.lock', '', { flag: 'wx' })\n  await new Promise(resolve => setTimeout(resolve, 800))\n  unlinkSync('shared.lock')\n  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), ${want})\n})\n`
    const repo = sampleRepo(dir => {
      write(dir, 'tests/a.test.mjs', racer(80))
      write(dir, 'tests/b.test.mjs', racer(80))
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    write(repo, 'tests/a.test.mjs', racer(90))
    write(repo, 'tests/b.test.mjs', racer(90))
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.doesNotMatch(r.out, /没做完/)
    for (const name of ['a', 'b', 'price']) assert.match(r.out, new RegExp(`✗ 程序的做法变了.*：tests/${name}\\.test\\.mjs`))
  })

  test('跑不过的太多：拆开跑到上限就停，没分开的按程序的做法变了算', () => {
    const coupon = (want: number): string => `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\ntest('满减', () => {\n  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), ${want})\n})\n`
    const names = Array.from({ length: 13 }, (_, index) => `c${index}`)
    const repo = sampleRepo(dir => {
      for (const name of names) write(dir, `tests/${name}.test.mjs`, coupon(80))
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    for (const name of names) write(repo, `tests/${name}.test.mjs`, coupon(90))
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /拆开跑的次数到了上限/)
    assert.equal((r.out.match(/✗ 程序的做法变了/g) ?? []).length, 14, r.out)
    // 一起跑 1 次，再跑一次和拆开最多 12 次，核对环境 1 次
    assert.ok(runs(repo) <= 14, `跑了 ${runs(repo)} 次`)
  })

  test('辅助文件跑不过的太多：到了上限没分开的，说明写跑不过的位置和使用者共几个', () => {
    const names = Array.from({ length: 14 }, (_, index) => `k${index}x`)
    const repo = sampleRepo(dir => {
      for (const name of names) {
        write(dir, `tests/support/${name}.mjs`, 'export const want = 80\n')
        write(dir, `tests/${name}.test.mjs`, `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\nimport { want } from './support/${name}.mjs'\ntest('满减', () => {\n  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), want)\n})\n`)
      }
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    for (const name of names) edit(repo, `tests/support/${name}.mjs`, '80', '90')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /：tests\/support\/(k\d+x)\.mjs（拆开跑的次数到了上限，没来得及单独跑它；跑不过的有 tests\/\1\.test\.mjs:5（用到它的测试共 1 个））/)
  })

  test('核对环境时新版偶发失败、再跑一次能过：照常出结论，不算没做完', () => {
    const coupon = (body: string): string => `${TEST_HEAD}import { existsSync, writeFileSync } from 'node:fs'\nimport { applyCoupon } from '../src/price.mjs'\ntest('满减', () => {\n${body}})\n`
    const repo = sampleRepo(dir => write(dir, 'tests/coupon.test.mjs', coupon('  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), 80)\n')))
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    // 新版在副本里第一次跑不过，再跑能过
    write(repo, 'tests/coupon.test.mjs', coupon("  if (!existsSync('env.mark')) {\n    writeFileSync('env.mark', '')\n    assert.fail('偶发失败')\n  }\n  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), 90)\n"))
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 程序的做法变了[^\n]*：tests\/coupon\.test\.mjs/)
    assert.doesNotMatch(r.out, /没做完/)
    assert.match(sh(repo, 'cat .git/testpace/logs/*'), /===== 新版跑不过的 tests\/coupon\.test\.mjs 再跑一次（核对环境）/)
  })

  test('跟着代码收紧断言的测试很多：单独看改了的断言也算进上限，一次最多跑 15 次', () => {
    const tightened = (check: string): string => `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\ntest('满减', () => {\n  ${check}\n})\n`
    const names = Array.from({ length: 10 }, (_, index) => `r${index}`)
    const repo = sampleRepo(dir => {
      for (const name of names) write(dir, `tests/${name}.test.mjs`, tightened('assert.ok(applyCoupon(100, { threshold: 100, off: 20 }) < 100)'))
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    for (const name of names) write(repo, `tests/${name}.test.mjs`, tightened('assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), 90)'))
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /拆开跑的次数到了上限，没来得及单独看它/)
    // 旧版一起跑、核对环境、改了断言的一起跑各 1 次，其余最多 12 次
    assert.ok(runs(repo) <= 15, `跑了 ${runs(repo)} 次`)
  })

  test('testpace.json 里 ignore 的测试不算用到辅助文件', () => {
    const repo = sampleRepo(dir => {
      const config = JSON.parse(readFileSync(join(dir, 'testpace.json'), 'utf8')) as { ignore: string[] }
      write(dir, 'testpace.json', JSON.stringify({ ...config, ignore: [...config.ignore, 'tests/legacy/**'] }))
      write(dir, 'tests/support/cases.mjs', 'export const cases = [[100, 80]]\n')
      write(dir, 'tests/legacy/old.test.mjs', `${TEST_HEAD}import { cases } from '../support/cases.mjs'\ntest('旧', () => assert.ok(cases))\n`)
    })
    edit(repo, 'tests/support/cases.mjs', '[100, 80]', '[100, 90]')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删改了测试辅助文件，又找不到用它的测试.*：tests\/support\/cases\.mjs/)
    assert.equal(runs(repo), 0)
  })

  test('在 .gitattributes 里把测试标成二进制：新加的跳过照样认出来', () => {
    const repo = sampleRepo()
    write(repo, '.gitattributes', 'tests/** -diff\n')
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 让测试暂时不跑（新加了跳过）：tests\/price\.test\.mjs/)
  })
})

describe('认跳过的写法', () => {
  test('测试体里的跳过、预期失败、按条件跳过：都认', () => {
    for (const line of [
      "testInfo.skip(browserName === 'webkit', '不支持')",
      'testInfo.fixme()',
      'testInfo.fail()',
      'info.skip()',
      "t.skip('先不跑')",
      't.todo()',
      'ctx.skip()',
      "test.fail('满额才减', async () => {})",
      "it.fails('满额才减', () => {})",
      "test.failing('满额才减', () => {})",
      "test('满额才减', { skip: process.env.CI }, () => {})",
      "test('满额才减', { todo: !ready }, () => {})",
    ]) assert.ok(SKIPPING.test(line), line)
  })

  test('分页、断言、关掉的开关、类型声明：不认', () => {
    for (const line of [
      'await query.skip(10).limit(5)',
      'findMany({ skip: 10, take: 5 })',
      "test('满额才减', { skip: false }, () => {})",
      'type Case = { name: string; skip: boolean }',
      "t.fail('tap 里这是断言失败，不是预期失败')",
      "testInfo.annotations.push({ type: 'issue' })",
    ]) assert.ok(!SKIPPING.test(line), line)
  })
})

describe('认只改了注释', () => {
  const same = (path: string, before: string, after: string): boolean => {
    const [was, now] = [codeLines(path, before), codeLines(path, after)]
    return was !== undefined && now !== undefined && was.join('\n') === now.join('\n')
  }

  test('只改了行注释、块注释和空行：认', () => {
    assert.ok(same('tests/a.ts', 'const a = 1\n// 旧说明\nconst b = 2\n', 'const a = 1\n\n// 新说明\n/**\n * 再加一段\n */\nconst b = 2\n'))
    assert.ok(same('tests/a_test.go', 'x := 1\n// 旧\n', 'x := 1\n/* 新 */\n'))
    assert.ok(same('tests/test_a.py', 'x = 1\n# 旧\n', 'x = 1\n    # 新\n'))
    assert.ok(same('tests/run.sh', 'echo $# a#b\n# 旧\n', 'echo $# a#b\n# 新\n'))
  })

  test('像注释的代码、字符串里的内容、行尾注释：不认', () => {
    // 乘号开头的续行是代码
    assert.ok(!same('tests/a.ts', 'const total = price\n  * quantity\n', 'const total = price\n  * count\n'))
    // 模板字符串里以 // 开头的行、空行是字符串的内容；${} 之后还在字符串里
    assert.ok(!same('tests/a.ts', 'const doc = `\n// 第一行\n`\n', 'const doc = `\n// 第二行\n`\n'))
    assert.ok(!same('tests/a.ts', 'const doc = `a\n`\n', 'const doc = `a\n\n`\n'))
    assert.ok(!same('tests/a.ts', 'const doc = `${a ? `x` : `y`}\n// 一\n`\n', 'const doc = `${a ? `x` : `y`}\n// 二\n`\n'))
    // 字符串、正则里的 /* 不开始注释
    assert.ok(!same('tests/a.ts', "const s = '/*'\nconst a = 1\nconst t = '*/'\n", "const s = '/*'\nconst a = 2\nconst t = '*/'\n"))
    assert.ok(!same('tests/a.ts', 'const r = /a\\/*b/\nconst a = 1\n// */\n', 'const r = /a\\/*b/\nconst a = 2\n// */\n'))
    // Python 三引号里以 # 开头的行是字符串的内容；TS 的 #私有字段是代码
    assert.ok(!same('tests/test_a.py', 'doc = """\n# 一\n"""\n', 'doc = """\n# 二\n"""\n'))
    assert.ok(!same('tests/a.ts', 'class A {\n  #count = 1\n}\n', 'class A {\n  #count = 2\n}\n'))
    assert.ok(!same('tests/a.ts', 'const a = 1 // 旧\n', 'const a = 1 // 新\n'))
  })

  test('起作用的注释（编译条件、shebang、测试环境、检查开关、编码声明）：算代码', () => {
    const changed: Array<[string, string, string]> = [
      ['tests/a_test.go', '//go:build linux', '//go:build darwin'],
      ['tests/a_test.go', '// +build linux', '// +build darwin'],
      ['tests/a_test.go', '//go:generate stringer', '//go:generate mockgen'],
      ['tests/a_test.go', '', '//nolint:errcheck'],
      ['tests/a.ts', '', '// @ts-nocheck'],
      ['tests/a.ts', '// @ts-expect-error', ''],
      ['tests/a.ts', '/** @jest-environment node */', '/** @jest-environment jsdom */'],
      ['tests/a.ts', '// @vitest-environment node', '// @vitest-environment happy-dom'],
      ['tests/a.ts', '', '// eslint-disable-next-line'],
      ['tests/a.ts', '/// <reference types="vitest" />', ''],
      ['tests/test_a.py', '#!/usr/bin/env python3', '#!/usr/bin/env python2'],
      ['tests/test_a.py', '# -*- coding: utf-8 -*-', '# -*- coding: latin-1 -*-'],
      ['tests/test_a.py', '', '# type: ignore'],
      ['tests/test_a.py', '# noqa: E501', ''],
      ['tests/test_a.py', '# pragma: no cover', ''],
      ['tests/a_spec.rb', '# frozen_string_literal: true', ''],
      ['tests/run.sh', '#!/bin/sh', '#!/bin/bash'],
    ]
    for (const [path, before, after] of changed) assert.ok(!same(path, `${before}\nx = 1\n`, `${after}\nx = 1\n`), `${path}：${before} → ${after}`)
    // cgo：import "C" 上面的注释是 C 代码
    assert.equal(codeLines('tests/a_test.go', '// #include <stdio.h>\nimport "C"\n'), undefined)
  })

  test('Go 的示例测试：// Output: 和下面几行是 go test 核对的期望输出，改值、整段删掉都不算只改了注释', () => {
    const example = (output: string): string => `package price\n\nfunc ExampleTotal() {\n\tfmt.Println(Total())\n${output}}\n`
    const before = example('\t// Output: 90\n')
    assert.ok(!same('price/example_test.go', before, example('\t// Output: 80\n')))
    assert.ok(!same('price/example_test.go', before, example('')))
    assert.ok(!same('price/example_test.go', example('\t// Unordered output:\n\t// a\n'), example('\t// Unordered output:\n\t// b\n')))
  })

  test('不认的语言、拿不准的写法：不判断', () => {
    for (const [path, text] of [
      ['tests/a.tsx', 'const a = 1\n'],
      ['tests/A.java', 'int a = 1;\n'],
      ['tests/a.ts', "const s = 'no end\n"],
      ['tests/a.ts', '/* 没收尾\n'],
      ['tests/run.sh', 'cat <<EOF\n# 内容\nEOF\n'],
      ['tests/data.yaml', 'script: |\n  # 内容\n'],
    ] as const) assert.equal(codeLines(path, text), undefined, `${path}：${text}`)
  })
})
