import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { inOrder, testStatements } from '../../src/craft/files.ts'
import { provedText } from '../../src/craft/prove.ts'
import { hash } from '../../src/craft/store.ts'
import { BIN, ENV, MEMBER_PRICE, sampleRepo, sh, TEST_HEAD, tempDir, testcraft, TESTPACE, TMP, write } from './helpers.ts'
import { fullWithSteps } from '../helpers.ts'

/** 这个工作区的副本位置（和 copy.ts 的 copyDirOf 一样算，临时目录用测试给的）。 */
const copyOf = (repo: string): string => {
  const root = realpathSync(repo)
  return join(TMP, 'testcraft', `${basename(root)}-${hash(root).slice(0, 12)}`)
}

const memberTest = (body: string): string => `${TEST_HEAD}import { memberPrice } from '../src/price.mjs'\n\n${body}\n`

describe('testcraft prove', () => {
  test('新功能的空洞测试：回旧代码只是加载失败，改坏也发现不了，被拦下', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', memberTest(`test('会员价有返回值', () => {\n  assert.ok(memberPrice(100, { level: 'gold' }) !== undefined)\n})`))
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /换回改动前的代码后它没跑起来（加载或编译失败）/)
    assert.match(r.out, /没有一处是它新抓到的/)
  })

  test('新功能的有效测试：改坏后它发现了，通过并记下', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(
      repo,
      'tests/member.test.mjs',
      memberTest(`test('金卡打九折，其他不打折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n  assert.equal(memberPrice(100, { level: 'silver' }), 100)\n})`),
    )
    const first = testcraft(repo, ['prove'])
    assert.equal(first.code, 0, first.out)
    assert.match(first.out, /证明二：src\/price\.mjs:\d+ 把/)
    const again = testcraft(repo, ['prove'])
    assert.equal(again.code, 0, again.out)
    assert.match(again.out, /以前证明过/)
  })

  test('修 bug：新测试在旧代码上因断言失败，证明一成立', () => {
    const repo = sampleRepo(dir => {
      const file = join(dir, 'src/price.mjs')
      writeFileSync(file, readFileSync(file, 'utf8').replace('amount >= coupon.threshold', 'amount > coupon.threshold'))
      const tests = join(dir, 'tests/price.test.mjs')
      writeFileSync(tests, readFileSync(tests, 'utf8').replace("  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), 80)\n", ''))
    })
    const file = join(repo, 'src/price.mjs')
    writeFileSync(file, readFileSync(file, 'utf8').replace('amount > coupon.threshold', 'amount >= coupon.threshold'))
    appendFileSync(
      join(repo, 'tests/price.test.mjs'),
      `\ntest('刚好满额也减', () => {\n  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), 80)\n})\n`,
    )
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /新的测试：刚好满额也减/)
    assert.match(r.out, /证明一：换回改动前的代码后，它因为断言不成立而失败/)
  })

  test('给已有代码补测试：没写守的代码时说明要写，写了就按它改坏', () => {
    const repo = sampleRepo()
    write(repo, 'tests/total.test.mjs', `${TEST_HEAD}import { total } from '../src/price.mjs'\n\ntest('空订单合计为零', () => {\n  assert.equal(total([]), 0)\n  assert.equal(total([{ price: 2, quantity: 3 }]), 6)\n})\n`)
    const missing = testcraft(repo, ['prove'])
    assert.equal(missing.code, 1, missing.out)
    assert.match(missing.out, /守的代码/)

    write(repo, '.testcraft/changes/feature.md', '# feature\n\n## 守的代码\n\n- `tests/total.test.mjs` → `src/price.mjs#total`\n')
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /证明二：src\/price\.mjs:[4-9] 把/)
  })

  test('守的代码里一处也改不坏：说清楚是没找到能改坏的地方，不说没写守的代码', () => {
    const repo = sampleRepo(dir => appendFileSync(join(dir, 'src/price.mjs'), '\nexport function label(item) {\n  return item.name\n}\n'))
    write(repo, 'tests/label.test.mjs', `${TEST_HEAD}import { label } from '../src/price.mjs'\n\ntest('名字原样显示', () => {\n  assert.equal(label({ name: 'x' }), 'x')\n})\n`)
    write(repo, '.testcraft/changes/feature.md', '# feature\n\n## 守的代码\n\n- `tests/label.test.mjs` → `src/price.mjs#label`\n')
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /改坏证明做不了：在守的代码里没找到能改坏的地方/)
    assert.doesNotMatch(r.out, /没写这个测试守的是哪段代码/)
  })

  test('新代码上就没通过的测试，直接说明', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', memberTest(`test('金卡打八折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 80)\n})`))
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /新代码上就没通过/)
  })

  test('没有要证明的测试、没接入的仓库，都直接通过', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    assert.match(testcraft(repo, ['prove']).out, /不用证明/)

    const outside = sampleRepo(dir => rmSync(join(dir, '.testcraft'), { recursive: true }))
    write(outside, 'tests/member.test.mjs', memberTest(`test('x', () => {\n  assert.ok(memberPrice)\n})`))
    const r = testcraft(outside, ['prove'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /没有接入 testcraft/)
  })

  test('往已有测试文件里加空洞测试：改坏的地方旧版也抓得到，不算新测试的，被拦下', () => {
    const repo = sampleRepo()
    const code = join(repo, 'src/price.mjs')
    // 碰一下老测试守着的那行（意思不变），再加新功能
    writeFileSync(code, readFileSync(code, 'utf8').replace('if (amount >= coupon.threshold) {', 'if (coupon.threshold <= amount) {') + MEMBER_PRICE)
    const tests = join(repo, 'tests/price.test.mjs')
    writeFileSync(
      tests,
      readFileSync(tests, 'utf8').replace("import { applyCoupon, total } from '../src/price.mjs'", "import { applyCoupon, memberPrice, total } from '../src/price.mjs'") +
        `\ntest('会员价有返回值', () => {\n  assert.ok(memberPrice(100, { level: 'gold' }) !== undefined)\n})\n`,
    )
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /新的测试：会员价有返回值/)
    assert.match(r.out, /原有的测试也发现了/)
  })

  test('改了行为、跟着改老断言、再加一个空洞测试：老断言抓到的不算新测试的，被拦下', () => {
    const repo = sampleRepo()
    const code = join(repo, 'src/price.mjs')
    writeFileSync(code, readFileSync(code, 'utf8').replace('return amount - coupon.off', 'return amount - coupon.off - 1'))
    const tests = join(repo, 'tests/price.test.mjs')
    writeFileSync(
      tests,
      readFileSync(tests, 'utf8').replace('{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 79)') +
        `\ntest('满减有返回值', () => {\n  assert.ok(applyCoupon(100, { threshold: 100, off: 20 }) !== undefined)\n})\n`,
    )
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ tests\/price\.test\.mjs（新的测试：满减有返回值）/)
    assert.match(r.out, /文件里原有的测试也因断言失败/)
    assert.match(r.out, /原有的测试也发现了/)
    // 指定这个文件证明，照样按这次新加的部分算
    const named = testcraft(repo, ['prove', 'tests/price.test.mjs'])
    assert.equal(named.code, 1, named.out)
    assert.match(named.out, /新的测试：满减有返回值/)
  })

  test('只改了已有测试的断言、没加新测试：不在这里证明（归放水检查）', () => {
    const repo = sampleRepo()
    const tests = join(repo, 'tests/price.test.mjs')
    writeFileSync(tests, readFileSync(tests, 'utf8').replace('{ threshold: 100, off: 20 }), 80)', "{ threshold: 100, off: 20 }), 80, '满 100 减 20')"))
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /不用证明/)
  })

  test('写在一行里的测试只改了名字、断言只改了缩进：不用证明', () => {
    const repo = sampleRepo(dir => write(dir, 'tests/total.test.mjs', `${TEST_HEAD}import { total } from '../src/price.mjs'\ntest('空的', () => assert.equal(total([]), 0))\n`))
    const file = join(repo, 'tests/total.test.mjs')
    writeFileSync(file, readFileSync(file, 'utf8').replace("test('空的'", "test('空订单合计为零'"))
    const price = join(repo, 'tests/price.test.mjs')
    writeFileSync(price, readFileSync(price, 'utf8').replace('  assert.equal(applyCoupon(99,', '    assert.equal(applyCoupon(99,'))
    assert.match(testcraft(repo, ['prove']).out, /不用证明/)
  })

  test('改动多、测试守的函数排在后面：先改坏测试用到的函数，有效测试照样证明', () => {
    const repo = sampleRepo()
    const rules = Array.from({ length: 14 }, (_, i) => `  if (weight > ${i + 1}) cost += 1`).join('\n')
    appendFileSync(join(repo, 'src/price.mjs'), `\nexport function shipping(weight) {\n  let cost = 0\n${rules}\n  return cost\n}\n${MEMBER_PRICE}`)
    write(repo, 'tests/member.test.mjs', memberTest(`test('金卡打九折，其他不打折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n  assert.equal(memberPrice(100, { level: 'silver' }), 100)\n})`))
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /证明二：src\/price\.mjs:\d+ 把/)
  })

  test('只改了测试名：不用证明', () => {
    const renamed = sampleRepo()
    const tests = join(renamed, 'tests/price.test.mjs')
    writeFileSync(tests, readFileSync(tests, 'utf8').replace("test('满额才减'", "test('满额才减，不满不减'"))
    assert.match(testcraft(renamed, ['prove']).out, /不用证明/)
  })

  test('改了名、只删了整条语句（断言挪到下层测试）：不用证明，归放水检查的删了测试用例，要理由、合并前给用户过目', () => {
    const repo = sampleRepo()
    const tests = join(repo, 'tests/price.test.mjs')
    writeFileSync(
      tests,
      readFileSync(tests, 'utf8')
        .replace("test('满额才减'", "test('满 100 减 20'")
        .replace('  assert.equal(applyCoupon(99, { threshold: 100, off: 20 }), 99)\n', ''),
    )
    assert.match(testcraft(repo, ['prove']).out, /不用证明/)
    const weakened = testcraft(repo, ['weaken'])
    assert.equal(weakened.code, 1, weakened.out)
    assert.match(weakened.out, /✗ 删了测试用例[^：\n]*：tests\/price\.test\.mjs（改了名也改了内容：原"满额才减" → 现"满 100 减 20"）/)
    write(
      repo,
      '.testcraft/changes/feature.md',
      '# feature\n\n## 放水理由\n\n- `tests/price.test.mjs`：不满额不减挪到下层的单元测试\n\n## 给用户过目\n\n- `tests/price.test.mjs`：原来这里还查不满 100 不减，现在这条由下层的测试守\n',
    )
    const r = testcraft(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /还没经用户确认[\s\S]*- 1 个测试改了名也改了内容：原"满额才减" → 现"满 100 减 20"\n.*说明：原来这里还查不满 100 不减/)
    assert.match(r.out, /不用证明/)
  })

  test('改了名又加了内容、改了原有断言、删了多行断言里的一行、挪进别的测试的内容：照旧当新测试，要证明能抓错', () => {
    const coupon = "{ threshold: 100, off: 20 }"
    const cases: Array<[string, (text: string) => string]> = [
      ['加了内容', text => text.replace("test('满额才减', () => {\n", "test('满额减', () => {\n  assert.ok(applyCoupon(0, " + coupon + ") !== undefined)\n").replace(`  assert.equal(applyCoupon(99, ${coupon}), 99)\n`, '')],
      ['改了原有断言', text => text.replace("test('满额才减'", "test('满额减'").replace(`  assert.equal(applyCoupon(99, ${coupon}), 99)\n`, `  assert.ok(applyCoupon(99, ${coupon}) > 0)\n`)],
      [
        '挪进别的测试的内容',
        text =>
          text
            .replace(/test\('合计是单价乘数量再相加'[\s\S]*?\n\}\)\n\n/, '')
            .replace("test('满额才减', () => {\n", "test('满额减', () => {\n  assert.equal(total([{ price: 3, quantity: 2 }, { price: 5, quantity: 1 }]), 11)\n")
            .replace(`  assert.equal(applyCoupon(99, ${coupon}), 99)\n`, ''),
      ],
    ]
    for (const [what, change] of cases) {
      const repo = sampleRepo()
      const tests = join(repo, 'tests/price.test.mjs')
      writeFileSync(tests, change(readFileSync(tests, 'utf8')))
      const r = testcraft(repo, ['prove'])
      assert.equal(r.code, 1, `${what}：${r.out}`)
      assert.match(r.out, /新的测试：满额减/, what)
    }

    // 多行断言里删一行：整条断言变了，不是删了整条语句
    const multiline = `test('满额才减', () => {\n  assert.deepEqual([\n    applyCoupon(100, ${coupon}),\n    applyCoupon(99, ${coupon}),\n  ], [\n    80,\n    99,\n  ])\n})\n`
    const repo = sampleRepo(dir => {
      const file = join(dir, 'tests/price.test.mjs')
      writeFileSync(file, readFileSync(file, 'utf8').replace(/test\('满额才减'[\s\S]*$/, multiline))
    })
    const tests = join(repo, 'tests/price.test.mjs')
    writeFileSync(
      tests,
      readFileSync(tests, 'utf8').replace("test('满额才减'", "test('满额减'").replace(`    applyCoupon(99, ${coupon}),\n`, '').replace('    99,\n', ''),
    )
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /新的测试：满额减/)

    // 只改了字符串里的空白：期望值变了，也是改了原有断言
    const trimmed = sampleRepo(dir => {
      appendFileSync(join(dir, 'src/price.mjs'), '\nexport function label(item) {\n  return item.name.trim()\n}\n')
      write(dir, 'tests/label.test.mjs', `${TEST_HEAD}import { label } from '../src/price.mjs'\n\ntest('名字去掉首尾空格', () => {\n  assert.equal(label({ name: ' x ' }), 'x')\n})\n`)
    })
    write(trimmed, 'tests/label.test.mjs', `${TEST_HEAD}import { label } from '../src/price.mjs'\n\ntest('名字原样显示', () => {\n  assert.equal(label({ name: 'x' }), 'x')\n})\n`)
    const spaces = testcraft(trimmed, ['prove'])
    assert.equal(spaces.code, 1, spaces.out)
    assert.match(spaces.out, /新的测试：名字原样显示/)
  })

  test('证明记录：改文档、改别的测试文件不失效，改这个测试就失效', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', memberTest(`test('金卡打九折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n  assert.equal(memberPrice(100, { level: 'silver' }), 100)\n})`))
    assert.equal(testcraft(repo, ['prove']).code, 0)
    write(repo, 'docs/note.md', '# 说明\n')
    // 别的测试文件改了也不影响这个测试的证明
    appendFileSync(join(repo, 'tests/price.test.mjs'), `test('不满额不减', () => {\n  assert.equal(applyCoupon(50, { threshold: 100, off: 20 }), 50)\n})\n`)
    assert.match(testcraft(repo, ['status']).out, /✓ tests\/member\.test\.mjs/)
    appendFileSync(join(repo, 'tests/member.test.mjs'), `test('银卡不打折', () => {\n  assert.equal(memberPrice(50, { level: 'silver' }), 50)\n})\n`)
    assert.match(testcraft(repo, ['status']).out, /· tests\/member\.test\.mjs.*还没证明/)
  })

  test('证明二成立前没发现的几处破坏列出来；status 列出这次改到的测试文件里的测试名', () => {
    const repo = sampleRepo()
    // 金额高过门槛：满额那行把 >= 改成 > 它发现不了，后面改减法那行才抓到
    write(repo, 'tests/coupon.test.mjs', `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\n\ntest('满额减', () => {\n  assert.equal(applyCoupon(150, { threshold: 100, off: 20 }), 130)\n})\n`)
    write(repo, '.testcraft/changes/feature.md', '# feature\n\n## 守的代码\n\n- `tests/coupon.test.mjs` → `src/price.mjs`\n')
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /在这之前改坏的 \d+ 处它没发现[^]*\n\s+- src\/price\.mjs:12 把  >=  改成  > \n/)
    const status = testcraft(repo, ['status']).out
    assert.match(status, /已定的规则（以测试名为准）：仓库里 2 个测试文件、3 个测试/)
    assert.match(status, /tests\/coupon\.test\.mjs（新增）：\n\s+- 满额减/)
  })

  test('合并前的检查：放水检查之外，新测试也要证明能抓错', () => {
    const hollow = sampleRepo()
    appendFileSync(join(hollow, 'src/price.mjs'), MEMBER_PRICE)
    write(hollow, 'tests/member.test.mjs', memberTest(`test('会员价有返回值', () => {\n  assert.ok(memberPrice(100, { level: 'gold' }) !== undefined)\n})`))
    let r = testcraft(hollow, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /放水检查：没有发现/)
    assert.match(r.out, /✗ tests\/member\.test\.mjs/)

    write(hollow, 'tests/member.test.mjs', memberTest(`test('金卡打九折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n  assert.equal(memberPrice(100, { level: 'silver' }), 100)\n})`))
    r = testcraft(hollow, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /测试都证明了能抓错/)
  })

  test('副本和工作区停在同一处：测试读得到提交号、分支名、标签（打包写版本号那样），找仓库根目录停在副本里；建副本不让分支钩子看到更新，原仓库不动', () => {
    const repo = sampleRepo(dir => {
      const file = join(dir, 'src/price.mjs')
      writeFileSync(file, readFileSync(file, 'utf8').replace('amount >= coupon.threshold', 'amount > coupon.threshold'))
    })
    sh(repo, 'git tag -a v1 -m v1 main')
    const head = sh(repo, 'git rev-parse --short HEAD').trim()
    const root = realpathSync(repo)
    const file = join(repo, 'src/price.mjs')
    writeFileSync(file, readFileSync(file, 'utf8').replace('amount > coupon.threshold', 'amount >= coupon.threshold'))
    write(
      repo,
      'tests/version.test.mjs',
      `${TEST_HEAD}import { execSync } from 'node:child_process'\nimport { applyCoupon } from '../src/price.mjs'\n\nconst git = args => execSync(\`git \${args}\`).toString().trim()\nconst version = [git('rev-parse --short HEAD'), git('rev-parse --abbrev-ref HEAD'), git('describe --tags'), git('rev-parse --show-toplevel') === '${root}']\n\ntest('刚好满额也减', () => {\n  assert.deepEqual(version, ['${head}', 'feature', 'v1', false])\n  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), 80)\n})\n`,
    )
    // 用户全局配置里管分支更新的引用钩子（testpace 的合并门就是这样配的）：建副本不该让它看到分支、标签的更新
    const marker = join(TMP, 'ref-hook-ran')
    sh(repo, `git config --global hook.probe.event reference-transaction && git config --global hook.probe.command 'probe() { if grep -q " refs/"; then touch ${marker}; fi; }; probe'`)
    try {
      const before = sh(repo, 'git for-each-ref && git count-objects -v && git status --porcelain')
      const r = testcraft(repo, ['prove'])
      assert.equal(r.code, 0, r.out)
      assert.match(r.out, /证明一：换回改动前的代码后，它因为断言不成立而失败/)
      assert.equal(sh(repo, 'git for-each-ref && git count-objects -v && git status --porcelain'), before, '原仓库不该被写')
      assert.ok(!existsSync(marker), '建副本让分支钩子看到了更新')
    } finally {
      sh(repo, 'git config --global --remove-section hook.probe')
    }
  })

  test('守的代码很长、测试守的那行在后面：先改和测试有关的行，不按从头的顺序轮不到', () => {
    // 前面十几行各有能改坏的地方，都和退款无关；规则在最后：按次数倒序取最新一笔
    const filler = Array.from({ length: 14 }, (_, i) => `  const region${i} = shop.region === 'north${i}'`).join('\n')
    const latest = `\nexport function latestStatus(refunds, shop) {\n${filler}\n  return orderBy(refunds, 'attempt', 'desc')[0].status\n}\n\nfunction orderBy(list, key, direction) {\n  const sign = direction === 'desc' ? -1 : 1\n  return [...list].sort((a, b) => sign * (a[key] - b[key]))\n}\n`
    const repo = sampleRepo(dir => appendFileSync(join(dir, 'src/price.mjs'), latest))
    write(
      repo,
      'tests/refund.test.mjs',
      `${TEST_HEAD}import { latestStatus } from '../src/price.mjs'\n\ntest('看最新一笔退款', () => {\n  const refunds = [{ attempt: 1, status: 'CLOSED' }, { attempt: 2, status: 'PROCESSING' }]\n  assert.equal(latestStatus(refunds, { region: 'south' }), 'PROCESSING')\n})\n`,
    )
    write(repo, '.testcraft/changes/feature.md', '# feature\n\n## 守的代码\n\n- `tests/refund.test.mjs` → `src/price.mjs#latestStatus`\n')
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 0, r.out)
    const rule = readFileSync(join(repo, 'src/price.mjs'), 'utf8').split('\n').findIndex(line => line.includes("'attempt', 'desc'")) + 1
    assert.match(r.out, new RegExp(`证明二：src/price\\.mjs:${rule} 把 .+，它发现了`))
  })

  test('指定测试文件：没改过的测试也能证明（按守的代码改坏）', () => {
    const repo = sampleRepo()
    write(repo, '.testcraft/changes/feature.md', '# feature\n\n## 守的代码\n\n- `tests/price.test.mjs` → `src/price.mjs#applyCoupon`\n')
    const r = testcraft(repo, ['prove', 'tests/price.test.mjs'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /tests\/price\.test\.mjs（指定的测试）\n\s+证明二/)
    assert.equal(testcraft(repo, ['prove', 'tests/nope.test.mjs']).code, 2)
  })

  test('跑测试超时就停掉；副本放在系统临时目录、每个工作区固定一处，以前残留的和用完的都删掉', () => {
    const repo = sampleRepo(dir => write(dir, '.testcraft/config.json', '{ "timeoutSeconds": 3 }\n'))
    const copy = copyOf(repo)
    mkdirSync(join(copy, 'leftover'), { recursive: true })
    writeFileSync(`${copy}.owner`, '99999999')
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', memberTest(`test('慢', async () => {\n  await new Promise(resolve => setTimeout(resolve, 60000))\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n})`))
    const before = sh(repo, 'git status --porcelain && git diff')
    const started = Date.now()
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /新代码上就没通过/)
    // 超时 3 秒就先发停止信号，不等 10 秒后的强制结束
    assert.ok(Date.now() - started < 12_000, `用了 ${Date.now() - started} 毫秒`)
    assert.ok(!existsSync(copy))
    assert.ok(!existsSync(`${copy}.owner`))
    assert.ok(!existsSync(join(repo, '.git/testpace/craft/copies')), '副本不放在 .git 里')
    assert.equal(sh(repo, 'git status --porcelain && git diff'), before, '工作区不该被动过')
  })

  test('同一个工作区的副本正被另一个 testcraft 用着：报错，不动它的副本', () => {
    const repo = sampleRepo()
    const copy = copyOf(repo)
    mkdirSync(join(copy, 'busy'), { recursive: true })
    writeFileSync(`${copy}.owner`, String(process.pid))
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', memberTest(`test('金卡打九折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n})`))
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, new RegExp(`另一个 testcraft（进程 ${process.pid}）正在用这个工作区的副本`))
    assert.ok(existsSync(join(copy, 'busy')))
  })
})

describe('建副本前查工作区里的符号链接', () => {
  /** 主目录（装好了依赖）里嵌一个 worktree，像 .claude/worktrees/x 那样；worktree 里加新功能和测试。测试加载时往 node_modules 里写一个文件，像装依赖那样。 */
  const mainWithWorktree = (): { main: string; wt: string } => {
    const main = sampleRepo()
    appendFileSync(join(main, '.git/info/exclude'), 'node_modules\nlinks/\n.venv/\n.claude/\n')
    write(main, 'node_modules/pkg/index.js', 'export default 1\n')
    write(main, 'shared/readme.txt', 'shared\n')
    sh(main, 'git worktree add -q -b wt .claude/worktrees/wt main')
    const wt = join(main, '.claude/worktrees/wt')
    appendFileSync(join(wt, 'src/price.mjs'), MEMBER_PRICE)
    write(
      wt,
      'tests/member.test.mjs',
      memberTest(
        `import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('../node_modules/written-by-copy', import.meta.url), '')\n\ntest('金卡打九折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n  assert.equal(memberPrice(100, { level: 'silver' }), 100)\n})`,
      ),
    )
    return { main, wt }
  }
  const link = (repo: string, path: string, target: string): void => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    symlinkSync(target, join(repo, path))
  }
  const HEADER = '工作区里有符号链接指向本仓库的其他工作目录（主目录或别的 worktree）或仓库的 git 目录，没建副本：'
  const noCopyLeft = (root: string): void => {
    assert.ok(!existsSync(copyOf(root)), '留下了副本')
    assert.ok(!existsSync(`${copyOf(root)}.owner`), '留下了 owner 文件')
  }

  test('worktree 里的链接指向主目录（绝对路径、相对路径都算）：不建副本，报错列出链接，主目录不被写', () => {
    const { main, wt } = mainWithWorktree()
    link(wt, 'node_modules', join(main, 'node_modules'))
    link(wt, 'links/shared', '../../../../shared')
    const r = testcraft(wt, ['prove'])
    assert.equal(r.code, 2, r.out)
    const real = realpathSync(main)
    assert.ok(r.out.includes(`${HEADER}\n  links/shared → ${real}/shared\n  node_modules → ${real}/node_modules\n`), r.out)
    assert.match(r.out, /先在自己的工作区里装好依赖，或者去掉这些链接，再跑。/)
    assert.deepEqual(readdirSync(join(main, 'node_modules')), ['pkg'], '主目录的依赖被写了')
    noCopyLeft(wt)
  })

  test('主目录里嵌着别的 worktree，主目录的链接指向它或指向仓库的 git 目录：同样不建副本、报错；那个 worktree 自己里面的链接不算', () => {
    const { main, wt } = mainWithWorktree()
    write(wt, 'lib/shared.mjs', 'export default 1\n')
    write(wt, 'node_modules/.pnpm/p/index.js', 'export default 1\n')
    link(wt, 'node_modules/p', '.pnpm/p')
    link(main, 'links/wt-lib', '../.claude/worktrees/wt/lib')
    link(main, 'links/hooks', '../.git/hooks')
    const file = join(main, 'tests/price.test.mjs')
    writeFileSync(file, readFileSync(file, 'utf8').replace('{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)'))
    const r = testcraft(main, ['weaken'])
    assert.equal(r.code, 2, r.out)
    const listed = `${HEADER}\n  links/hooks → ${realpathSync(main)}/.git/hooks（仓库的 git 目录）\n  links/wt-lib → ${realpathSync(wt)}/lib\n副本里`
    assert.ok(r.out.includes(listed), r.out)
    noCopyLeft(main)
  })

  test('链接先跳到主目录、主目录那里再指向仓库外：也报错，副本里改的是主目录在用的那份', () => {
    const { main, wt } = mainWithWorktree()
    const store = join(tempDir('testcraft-outside-'), 'store')
    write(store, 'pkg/index.js', 'export default 1\n')
    rmSync(join(main, 'node_modules'), { recursive: true })
    link(main, 'node_modules', store)
    link(wt, 'node_modules', join(main, 'node_modules'))
    const r = testcraft(wt, ['prove'])
    assert.equal(r.code, 2, r.out)
    assert.ok(r.out.includes(`${HEADER}\n  node_modules → ${realpathSync(main)}/node_modules\n副本里`), r.out)
    assert.deepEqual(readdirSync(store), ['pkg'], '主目录在用的依赖被写了')
    noCopyLeft(wt)
  })

  test('查链接时有目录读不了：不建副本，说清楚哪个路径读不了、为什么', () => {
    const { wt } = mainWithWorktree()
    write(wt, 'links/locked/x.txt', 'x\n')
    chmodSync(join(wt, 'links/locked'), 0o000)
    try {
      const r = testcraft(wt, ['prove'])
      assert.equal(r.code, 2, r.out)
      assert.match(r.out, /建副本前查工作区里的符号链接时读不了 links\/locked（EACCES: permission denied/)
      noCopyLeft(wt)
    } finally {
      chmodSync(join(wt, 'links/locked'), 0o755)
    }
  })

  test('大小写不敏感的盘上，链接里的大小写和盘上不一样也认得出指向主目录', t => {
    const { main, wt } = mainWithWorktree()
    writeFileSync(join(main, 'case-probe'), '')
    if (!existsSync(join(main, 'CASE-PROBE'))) {
      t.skip('这块盘区分大小写')
      return
    }
    link(wt, 'node_modules', join(dirname(main), basename(main).toUpperCase(), 'node_modules'))
    const r = testcraft(wt, ['prove'])
    assert.equal(r.code, 2, r.out)
    assert.ok(r.out.includes(`${HEADER}\n  node_modules → ${realpathSync(main)}/node_modules\n副本里`), r.out)
    assert.deepEqual(readdirSync(join(main, 'node_modules')), ['pkg'], '主目录的依赖被写了')
    noCopyLeft(wt)
  })

  test('链接指向仓库外面（存在的、悬空的都算）或工作区自己里面：照常建副本跑通', () => {
    const { wt } = mainWithWorktree()
    const outside = tempDir('testcraft-outside-')
    write(outside, 'python3.12', '')
    mkdirSync(join(wt, 'node_modules'))
    link(wt, 'node_modules/price', '../src')
    link(wt, '.venv/bin/python3.12', join(outside, 'python3.12'))
    link(wt, 'links/result', join(outside, 'nix-result'))
    const r = testcraft(wt, ['prove'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /证明二：src\/price\.mjs:\d+ 把/)
    noCopyLeft(wt)
  })

  test('悬空链接按链接文字算目标：指向别的工作目录里不存在的路径也报错，指向仓库外不存在的路径不算', () => {
    const { main, wt } = mainWithWorktree()
    link(wt, 'node_modules', join(main, 'node_modules/missing'))
    link(wt, 'links/result', join(tempDir('testcraft-outside-'), 'nix-result'))
    const r = testcraft(wt, ['prove'])
    assert.equal(r.code, 2, r.out)
    assert.ok(r.out.includes(`：\n  node_modules → ${realpathSync(main)}/node_modules/missing\n副本里`), r.out)
    noCopyLeft(wt)
  })
})

describe('建副本的那几秒借用工作区：有测试在跑不建，复制时别的测试不跑', () => {
  const memberFeature = (repo: string): void => {
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(
      repo,
      'tests/member.test.mjs',
      memberTest(`test('金卡打九折，其他不打折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n  assert.equal(memberPrice(100, { level: 'silver' }), 100)\n})`),
    )
  }
  const noCopyLeft = (repo: string): void => {
    assert.ok(!existsSync(copyOf(repo)), '留下了副本')
    assert.ok(!existsSync(`${copyOf(repo)}.owner`), '留下了 owner 文件')
  }
  /**
   * PATH 里放停住的 cp 和 node：建副本复制到第一份时记下"在复制"，等 go 文件出现再接着复制；
   * 在副本里跑测试（项目的 files 命令是 node --test）时记下"在跑测试"，等 goTests 文件出现再跑。
   */
  const pausedCp = (): { path: string; copying: string; testing: string; go: () => void; goTests: () => void } => {
    const dir = tempDir('testcraft-cp-')
    const [copying, go, testing, goTests] = ['copying', 'go', 'testing', 'go-tests'].map(name => join(dir, name)) as [string, string, string, string]
    write(dir, 'cp', `#!/bin/sh\n: > "${copying}"\nwhile [ ! -f "${go}" ]; do sleep 0.1; done\nexec /bin/cp "$@"\n`)
    write(dir, 'node', `#!/bin/sh\nif [ "$1" = --test ]; then : > "${testing}"; while [ ! -f "${goTests}" ]; do sleep 0.1; done; fi\nexec "${process.execPath}" "$@"\n`)
    chmodSync(join(dir, 'cp'), 0o755)
    chmodSync(join(dir, 'node'), 0o755)
    return { path: `${dir}:${process.env.PATH}`, copying, testing, go: () => writeFileSync(go, ''), goTests: () => writeFileSync(goTests, '') }
  }
  /** 等文件出现。 */
  const until = async (path: string, what: () => string): Promise<void> => {
    const deadline = Date.now() + 30_000
    while (!existsSync(path)) {
      assert.ok(Date.now() < deadline, what())
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  /** 后台起 testcraft prove，等它开始复制。 */
  const proveUntilCopying = async (repo: string, cp: ReturnType<typeof pausedCp>) => {
    const child = spawn(BIN, ['prove'], { cwd: repo, env: { ...ENV, PATH: cp.path } })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (out += chunk))
    const exited = new Promise<number | null>(resolve => child.on('close', resolve))
    await until(cp.copying, () => `没开始复制：${out}`)
    return { child, exited, out: () => out }
  }
  const files = (repo: string) => spawnSync(TESTPACE, ['files', 'tests/member.test.mjs'], { cwd: repo, env: ENV, encoding: 'utf8' })

  test('复制时占着工作区：新起的 testpace files 被挡，说是 testcraft 在建副本；复制完马上放开，副本里跑证明时工作区的测试照常能跑', async () => {
    const repo = sampleRepo()
    memberFeature(repo)
    const cp = pausedCp()
    const prove = await proveUntilCopying(repo, cp)
    try {
      const blocked = files(repo)
      assert.equal(blocked.status, 3, blocked.stdout + blocked.stderr)
      assert.match(blocked.stdout, new RegExp(`^这个工作区正被 testcraft 建副本 占着（开始于 [^，]+，进程 ${prove.child.pid}），占着时不跑测试，等它放开再跑。`))
      cp.go()
      await until(cp.testing, () => `没在副本里跑测试：${prove.out()}`)
      const during = files(repo)
      assert.equal(during.status, 0, during.stdout + during.stderr)
    } finally {
      cp.go()
      cp.goTests()
    }
    assert.equal(await prove.exited, 0, prove.out())
    assert.match(prove.out(), /证明二：src\/price\.mjs:\d+ 把/)
  })

  test('testcraft 在复制中途被杀：占用跟着作废，下一次 testpace 命令照常跑', async () => {
    const repo = sampleRepo()
    memberFeature(repo)
    const cp = pausedCp()
    const prove = await proveUntilCopying(repo, cp)
    try {
      assert.equal(files(repo).status, 3, '复制时占着')
      prove.child.kill('SIGKILL')
      await prove.exited
      const after = files(repo)
      assert.equal(after.status, 0, after.stdout + after.stderr)
    } finally {
      cp.go()
      cp.goTests()
    }
  })

  test('工作区有 testpace 的命令在跑：不建副本，说在跑什么、等它结束；整组里测试之前的段（testcraft check 就是）来证明照常建，整组照常跑完', async () => {
    const repo = sampleRepo()
    memberFeature(repo)
    // 整组最前面加一段要借用工作区的检查：记下 testpace 给它的运行 id，停着等 hold 删掉，像整组跑到一半
    const dir = tempDir('testcraft-hold-')
    const hold = join(dir, 'hold')
    write(dir, 'check.sh', `echo "$TESTPACE_RUN" > "${hold}.tmp" && mv "${hold}.tmp" "${hold}.id"\nwhile [ -f "${hold}" ]; do sleep 0.1; done\n`)
    writeFileSync(hold, '')
    const { program, args } = fullWithSteps([{ command: `sh ${join(dir, 'check.sh')}`, borrows: true }])
    const full = spawn(program, args, { cwd: repo, env: ENV, stdio: 'ignore' })
    const exited = new Promise(resolve => full.on('exit', resolve))
    try {
      const deadline = Date.now() + 30_000
      while (!existsSync(`${hold}.id`)) {
        assert.ok(Date.now() < deadline, '整组最前面的那一段没跑起来')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const busy = testcraft(repo, ['prove'])
      assert.equal(busy.code, 2, busy.out)
      assert.match(busy.out, /^这个工作区正在跑整组.*\n没建副本：.+等它结束再跑。$/m)
      noCopyLeft(repo)
      const check = testcraft(repo, ['prove'], { TESTPACE_RUN: readFileSync(`${hold}.id`, 'utf8').trim() })
      assert.equal(check.code, 0, check.out)
      assert.match(check.out, /证明二：src\/price\.mjs:\d+ 把/)
    } finally {
      rmSync(hold, { force: true })
    }
    assert.equal(await exited, 0, '整组里建过副本，整组照常跑完、通过')
  })
})

describe('改了名的测试按语句和原来的比', () => {
  test('多行的链式调用、接着写的表达式算一条语句：删掉其中一行（比如 .not）整条就变了；删整条、注释照样认得出', () => {
    const before = [
      "test('旧名', () => {",
      '  expect(price)',
      '    .not',
      '    .toBe(0)',
      '  const sum = a +',
      '    b',
      '  // 合计',
      '  expect(sum).toBe(3)',
      '})',
    ]
    const old = testStatements(before.join('\n')).get('旧名') as string[]
    const renamed = (lines: string[]): string[] => testStatements(lines.join('\n').replace('旧名', '新名')).get('新名') as string[]
    assert.ok(inOrder(renamed(before.filter((_, i) => i !== 1 && i !== 2 && i !== 3)), old), '删整条语句')
    assert.ok(!inOrder(renamed(before.filter((_, i) => i !== 2)), old), '删了 .not 那一行')
    assert.ok(!inOrder(renamed(before.filter((_, i) => i !== 5)), old), '删了接着写的表达式里的一行')
    assert.ok(inOrder(renamed(before.filter((_, i) => i !== 6)), old), '删了注释')
  })
})

describe('改坏时先挑和测试有关的行，看的是测试的哪部分', () => {
  test('改了的已有测试文件只看新加的测试和改了的断言，找不到位置的不算；新的测试文件看整个', () => {
    const text = ["test('新的', () => {", '  expect(latest).toBe(2)', '})', "test('旧的', () => {", '  expect(old).toBe(1)', '  expect(changed).toBe(3)', '})'].join('\n')
    const parts = {
      fresh: [
        { name: '新的', start: 0, end: 2 },
        { name: '找不到', start: -1, end: -1 },
      ],
      assertions: [{ start: 5, end: 5 }],
    }
    assert.equal(provedText(text, parts), ["test('新的', () => {", '  expect(latest).toBe(2)', '})', '  expect(changed).toBe(3)'].join('\n'))
    assert.equal(provedText(text, undefined), text)
  })
})
