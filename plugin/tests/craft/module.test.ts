// "测试写法"接在底座上的部分：要用户过目的交给底座的确认（按文件记）、记录按开始时的内容记、配置合并后才生效、
// 证明记录按实际换回的文件算、整组里有它的一段。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { confirm } from '../../src/base/confirm.ts'
import { effectiveConfig } from '../../src/craft/config.ts'
import { runs } from '../helpers.ts'
import { ENV, MEMBER_PRICE, sampleRepo, tempDir, TEST_HEAD, testcraft, TESTPACE, write } from './helpers.ts'

const edit = (repo: string, path: string, from: string, to: string): void => {
  const file = join(repo, path)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes(from), `${path} 里没有 ${from}`)
  writeFileSync(file, text.replace(from, to))
}

/** 写改动记录：每个文件一条放水理由、一条给用户过目的白话。 */
const record = (repo: string, entries: Array<[file: string, reason: string, plain: string]>): void =>
  write(
    repo,
    '.testcraft/changes/feature.md',
    `# feature\n\n## 放水理由\n\n${entries.map(([file, reason]) => `- \`${file}\`：${reason}`).join('\n')}\n\n## 给用户过目\n\n${entries.map(([file, , plain]) => `- \`${file}\`：${plain}`).join('\n')}\n`,
  )

/** testcraft check 交给确认工具的编号和文字。 */
function pendingOf(out: string): { id: string; text: string } {
  const id = /^id：(\S+)$/m.exec(out)?.[1]
  const text = /^-----\n([\s\S]*?)\n-----$/m.exec(out)?.[1]
  assert.ok(id && text, out)
  return { id, text }
}

const PRICE: [string, string, string] = ['tests/price.test.mjs', '满减用例改成 skip，等新规则', '原来守着满 100 才减 20，满减活动暂停，先不查']
const FORMAT: [string, string, string] = ['tests/format.test.mjs', '格式化功能整块去掉了', '原来守着金额的显示格式，这个功能去掉了，不再守']

const memberTest = `${TEST_HEAD}import { memberPrice } from '../src/price.mjs'\ntest('金卡九折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n  assert.equal(memberPrice(100, { level: 'silver' }), 100)\n})\n`

describe('放水给用户过目：交给底座的确认，一个文件一项', () => {
  test('弹窗里是白话说明，不给技术理由；照 check 给的编号和文字确认过才算过', () => {
    const repo = sampleRepo()
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    record(repo, [PRICE])
    let r = testcraft(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /放水检查通过/)
    assert.match(r.out, /这 1 项还没经用户确认。用户不会看命令输出，要调用 testpace 的 confirm_with_user 工具/)
    const { id, text } = pendingOf(r.out)
    assert.equal(
      text,
      [
        '这次改动里放松测试的地方，要你确认的有 1 项：',
        '',
        '1. tests/price.test.mjs',
        '   看到的改动：',
        '   - 新加了跳过，测试"满额才减"暂时不跑',
        '   说明：原来守着满 100 才减 20，满减活动暂停，先不查',
        '',
        '同意：按这样改。不同意：告诉 agent 改回去或换个做法。',
      ].join('\n'),
    )
    // 技术理由、代码原文都不进弹窗
    assert.doesNotMatch(text, /改成 skip|test\.skip|第 \d+ 行/)

    assert.equal(confirm(repo, id, text.replace('先不查', '以后再说')).ok, false)
    assert.match(testcraft(repo, ['check']).out, /还没经用户确认/)
    assert.equal(confirm(repo, id, text).ok, true)
    r = testcraft(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /用户过目过这 1 处放水/)

    // 给用户看的说明改了：是另一项，要重新确认
    record(repo, [[PRICE[0], PRICE[1], '原来守着满 100 才减 20，满减规则下个月才定，先不查']])
    r = testcraft(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.notEqual(pendingOf(r.out).id, id)
  })

  test('同意按文件记：别的文件又放松了只问新的那一处；同意过的文件又改了，要重新确认', () => {
    const repo = sampleRepo(dir => write(dir, 'tests/format.test.mjs', `${TEST_HEAD}test('一', () => assert.equal(1, 1))\n`))
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    record(repo, [PRICE])
    const first = pendingOf(testcraft(repo, ['check']).out)
    assert.equal(confirm(repo, first.id, first.text).ok, true)
    assert.equal(testcraft(repo, ['check']).code, 0)

    // 另一个文件也放松了（比如另一个分支合进来）：价格那一处同意过，不再问
    rmSync(join(repo, 'tests/format.test.mjs'))
    record(repo, [PRICE, FORMAT])
    let r = testcraft(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const second = pendingOf(r.out)
    assert.match(second.text, /^这次改动里放松测试的地方，要你确认的有 1 项：\n\n1\. tests\/format\.test\.mjs\n/)
    assert.doesNotMatch(second.text, /tests\/price\.test\.mjs/)
    assert.equal(confirm(repo, second.id, second.text).ok, true)
    r = testcraft(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /用户过目过这 2 处放水/)

    // 同意过的那个文件又跳过了一个测试：文件内容和看到的改动都变了，那次同意不算
    edit(repo, 'tests/price.test.mjs', "test('合计", "test.skip('合计")
    r = testcraft(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const third = pendingOf(r.out)
    assert.match(third.text, /要你确认的有 1 项：\n\n1\. tests\/price\.test\.mjs\n/)
    assert.doesNotMatch(third.text, /tests\/format\.test\.mjs/)
  })

  test('文字和文件名都一样、文件里改的地方不一样：是另一项，不沿用那次同意', () => {
    const repo = sampleRepo()
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    record(repo, [PRICE])
    const asked = pendingOf(testcraft(repo, ['check']).out)
    assert.equal(confirm(repo, asked.id, asked.text).ok, true)
    assert.equal(testcraft(repo, ['check']).code, 0)
    // 同一个测试照样跳过，另外把它的断言也改松了：弹窗里的字一样，文件内容不一样
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 99)', '{ threshold: 100, off: 20 }), 99 + 0)')
    const r = testcraft(repo, ['check'])
    assert.match(r.out, /这 1 项还没经用户确认/)
    assert.equal(pendingOf(r.out).text, asked.text)
  })
})

describe('记录按开始时的内容记', () => {
  test('放水检查的过程中改动变了：这次的结论不算，要重跑，不能因为取不到记录就当没有要过目的', () => {
    // 旧版测试在副本里跑的时候往工作区的改动记录里补一句，放水检查结束时改动已经不是开始时的样子
    const coupon = (want: number, extra = ''): string =>
      `${TEST_HEAD}import { applyCoupon } from '../src/price.mjs'\n${extra}test('满减', () => {\n  assert.equal(applyCoupon(100, { threshold: 100, off: 20 }), ${want})\n})\n`
    const repo = sampleRepo(dir => {
      const note = JSON.stringify(join(dir, '.testcraft/changes/feature.md'))
      write(dir, 'tests/coupon.test.mjs', coupon(80, `import { appendFileSync } from 'node:fs'\nappendFileSync(${note}, '\\n说明补一句。\\n')\n`))
    })
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
    write(repo, 'tests/coupon.test.mjs', coupon(90))
    record(repo, [['tests/price.test.mjs`、`tests/coupon.test.mjs', '满减改成减一半', '原来满 100 减 20，现在减一半']])
    const r = testcraft(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /检查过程中改动变了（放水检查是按开始时的样子做的），这次的结论不算：重跑。/)
    assert.doesNotMatch(r.out, /还没经用户确认/)
    assert.match(readFileSync(join(repo, '.testcraft/changes/feature.md'), 'utf8'), /说明补一句/)
    assert.match(testcraft(repo, ['status']).out, /放水检查：这份改动还没检查/)
  })

  test('证明的过程中它守的代码改了：这次的证明不记，改完再证', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    // 这个测试第一次跑（在副本里）时往工作区的代码里补一行
    const marker = join(tempDir('testcraft-moved-'), 'touched')
    const touch = `import { appendFileSync, existsSync, writeFileSync } from 'node:fs'\nif (!existsSync(${JSON.stringify(marker)})) {\n  writeFileSync(${JSON.stringify(marker)}, '')\n  appendFileSync(${JSON.stringify(join(repo, 'src/price.mjs'))}, '\\n// 证明的时候补的\\n')\n}\n`
    write(repo, 'tests/member.test.mjs', memberTest.replace("test('金卡九折'", `${touch}test('金卡九折'`))
    const r = testcraft(repo, ['prove'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ tests\/member\.test\.mjs（新增的测试文件）\n {4}证明的过程中这个测试、它守的代码或改动记录改过，这次的证明不算：改完了再跑 testcraft prove。/)
    assert.match(testcraft(repo, ['status']).out, /· tests\/member\.test\.mjs（新增的测试文件）：还没证明/)
    // 代码不再变了，再证一次就记下
    const again = testcraft(repo, ['prove'])
    assert.equal(again.code, 0, again.out)
    assert.match(testcraft(repo, ['status']).out, /✓ tests\/member\.test\.mjs（新增的测试文件）/)
  })

  test('证明记录按证明时换回旧版的文件算：数据、模板这类不是代码的文件改了也要重证；约定里 ignore 的文档不用', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', memberTest)
    assert.equal(testcraft(repo, ['prove']).code, 0)
    assert.match(testcraft(repo, ['status']).out, /✓ tests\/member\.test\.mjs/)
    // 示例项目的约定里 ignore 是 docs/**：证明时不换回它，改了不用重证
    write(repo, 'docs/note.md', '说明\n')
    assert.match(testcraft(repo, ['status']).out, /✓ tests\/member\.test\.mjs/)
    // 折扣表不是代码，但证明时会连它一起换回旧版：它变了，那次证明就不是现在这份内容的
    write(repo, 'src/rates.json', '{ "gold": 0.9 }\n')
    assert.match(testcraft(repo, ['status']).out, /· tests\/member\.test\.mjs（新增的测试文件）：还没证明/)
  })
})

describe('.testcraft/config.json 合并后才生效', () => {
  const lists = (config: object): string => JSON.stringify(config)

  test('分叉点上有的规则分支上删了仍然算，分支上新加的"不算测试"这次不算；加严的马上算', () => {
    const before = lists({ tests: ['checks/*.check.mjs'], helpers: ['support/**'], contract: ['infra/test.yaml'], notTests: ['e2e/manual/**'], timeoutSeconds: 60 })
    const now = lists({ tests: ['probes/*.probe.mjs'], notTests: ['tests/price.test.mjs'], timeoutSeconds: 300 })
    assert.deepEqual(effectiveConfig({ before, now }), {
      config: {
        tests: ['checks/*.check.mjs', 'probes/*.probe.mjs'],
        helpers: ['support/**'],
        contract: ['infra/test.yaml'],
        // 分叉点上的那条这次删了（加严，马上算）；新加的那条这次不算
        notTests: [],
        timeoutSeconds: 300,
      },
      problems: [],
      deferred: [
        '.testcraft/config.json 的 "tests" 删掉了 "checks/*.check.mjs"：合并后才生效，这次改动仍按有它判',
        '.testcraft/config.json 的 "helpers" 删掉了 "support/**"：合并后才生效，这次改动仍按有它判',
        '.testcraft/config.json 的 "contract" 删掉了 "infra/test.yaml"：合并后才生效，这次改动仍按有它判',
        '.testcraft/config.json 的 "notTests" 新加了 "tests/price.test.mjs"：合并后才生效，这次改动仍按没有它判',
      ],
    })
    // 两版都有的照常算；没改就没有"这次不算的"
    assert.deepEqual(effectiveConfig({ before, now: before }).config.notTests, ['e2e/manual/**'])
    assert.deepEqual(effectiveConfig({ before, now: before }).deferred, [])
    // 首次接入（分叉点上没有配置）：新写的"不算测试"也要合并后才生效
    assert.deepEqual(effectiveConfig({ before: undefined, now }).config.notTests, [])
    // 现在这一版写坏了要说出来；分叉点那一版照常算
    const broken = effectiveConfig({ before, now: '{' })
    assert.match(broken.problems[0] ?? '', /不是合法的 JSON/)
    assert.deepEqual(broken.config.tests, ['checks/*.check.mjs'])
  })

  test('在分支上把测试划成"不算测试"、把认测试的规则删掉，再删测试：照样认出删了测试；改配置本身不用写理由', () => {
    const repo = sampleRepo(dir => {
      write(dir, '.testcraft/config.json', lists({ tests: ['checks/*.check.mjs'] }))
      write(dir, 'checks/a.check.mjs', `${TEST_HEAD}test('查', () => assert.equal(1, 1))\n`)
    })
    write(repo, '.testcraft/config.json', lists({ notTests: ['tests/price.test.mjs'] }))
    rmSync(join(repo, 'tests/price.test.mjs'))
    rmSync(join(repo, 'checks/a.check.mjs'))
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删了测试文件：checks\/a\.check\.mjs/)
    assert.match(r.out, /✗ 删了测试文件：tests\/price\.test\.mjs/)
    assert.doesNotMatch(r.out, /config\.json/)
    assert.match(
      testcraft(repo, ['status']).out,
      /这次不算的配置改动：\n {2}· \.testcraft\/config\.json 的 "tests" 删掉了 "checks\/\*\.check\.mjs"：合并后才生效，这次改动仍按有它判\n {2}· \.testcraft\/config\.json 的 "notTests" 新加了 "tests\/price\.test\.mjs"：合并后才生效，这次改动仍按没有它判\n/,
    )
  })

  test('分支上新加一条认测试的规则马上生效：照它认出的新测试要证明', () => {
    const repo = sampleRepo()
    write(repo, '.testcraft/config.json', lists({ tests: ['probes/*.probe.mjs'] }))
    write(repo, 'probes/a.probe.mjs', `${TEST_HEAD}test('查', () => assert.equal(1, 1))\n`)
    const status = testcraft(repo, ['status']).out
    assert.match(status, /· probes\/a\.probe\.mjs（新增的测试文件）：还没证明/)
    assert.doesNotMatch(status, /这次不算的配置改动/)
  })
})

describe('整组里"测试写法"的一段', () => {
  const testpace = (repo: string, args: string[]) => {
    const r = spawnSync(TESTPACE, args, { cwd: repo, env: ENV, encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  const kinds = (repo: string): string[] => ((runs(repo).at(-1)?.steps ?? []) as Array<{ kind: string }>).map(step => step.kind)

  test('接入了的仓库：testpace full 在测试之前跑 testcraft check，不用另外登记；它没过整组就不过', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', memberTest)
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^整组通过 · 2 个测试文件/)
    assert.deepEqual(kinds(repo), ['craft', 'full', 'tests'])
    const log = readFileSync(runs(repo).at(-1)!.log as string, 'utf8')
    assert.match(log, /===== testpace 测试写法的检查：testcraft check\n[\s\S]*测试都证明了能抓错：\n {2}✓ tests\/member\.test\.mjs/)
    // 整组里证明过的记下了，之后不用再证
    assert.match(testcraft(repo, ['status']).out, /✓ tests\/member\.test\.mjs（新增的测试文件）/)
    assert.match(testcraft(repo, ['status']).out, /合并前：testcraft check 是整组（testpace full）里的一段，没通过就不留整组通过记录。/)

    // 跳过一个测试没写理由：这一段没过，后面的不跑
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    const failed = testpace(repo, ['full'])
    assert.equal(failed.code, 1, failed.out)
    assert.match(failed.out, /^整组失败：测试写法的检查（testcraft check）没通过，后面的没有跑/)
    assert.match(failed.out, /✗ 让测试暂时不跑（新加了跳过）：tests\/price\.test\.mjs/)
    assert.deepEqual(kinds(repo), ['craft'])
  })

  test('没接入的仓库（没有 .testcraft/）没有这一段', () => {
    const repo = sampleRepo(dir => rmSync(join(dir, '.testcraft'), { recursive: true }))
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(kinds(repo), ['full', 'tests'])
  })

  test('在分支上删掉 .testcraft/ 躲不过：分叉点上接入了就照查', () => {
    const repo = sampleRepo()
    rmSync(join(repo, '.testcraft'), { recursive: true })
    edit(repo, 'tests/price.test.mjs', "test('满额才减'", "test.skip('满额才减'")
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^整组失败：测试写法的检查（testcraft check）没通过/)
  })
})
