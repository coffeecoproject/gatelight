import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { blobIdsAt } from '../../src/base/git.ts'
import { MEMBER_PRICE, sampleRepo, sh, TEST_HEAD, testcraft, write } from './helpers.ts'

const memberTest = `${TEST_HEAD}import { memberPrice } from '../src/price.mjs'\ntest('金卡九折', () => {\n  assert.equal(memberPrice(100, { level: 'gold' }), 90)\n  assert.equal(memberPrice(100, { level: 'silver' }), 100)\n})\n`

const edit = (repo: string, path: string, from: string, to: string): void => {
  const file = join(repo, path)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes(from), `${path} 里没有 ${from}`)
  writeFileSync(file, text.replace(from, to))
}

/** 跑了几次测试（看日志）。 */
const runs = (repo: string): number =>
  sh(repo, 'cat .git/testpace/logs/* 2>/dev/null || true')
    .split('\n')
    .filter(line => line.startsWith('===== ') && !line.startsWith('===== 退出码')).length

/** 默认分支上多一个提交（script 在 main 上改文件），再合进 feature。feature 上的改动要先提交。 */
function mainMoves(repo: string, script: string): void {
  sh(repo, `git checkout -q main && ${script} && git add -A && git commit -qm main && git checkout -q feature && git merge -q main`)
}

/** 满减改成减一半，测试的期望值跟着改：旧版测试在新代码上跑不过，要理由、要给用户过目。 */
function halfOff(repo: string): void {
  edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
  edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 90)')
}

const HALF_OFF_RECORD =
  '# feature\n\n## 放水理由\n\n- `tests/price.test.mjs`：规则变了，用户确认"减一半"\n\n## 给用户过目\n\n- `tests/price.test.mjs`：原来满 100 减 20，现在减一半\n'

describe('跑过的结果接着用', () => {
  test('证明过以后只加了清单条目：不用重证', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', memberTest)
    assert.equal(testcraft(repo, ['prove']).code, 0)

    write(repo, '.testcraft/checklist/member-hint.md', '# 改了会员价，会员页的说明要跟着改\n\n## 触发\n\n- `src/member-page.mjs`\n\n## 怎么查\n\n会员页的折扣说明和 memberPrice 对一遍。\n\n## 来由\n\nfeature：加会员价时想到的。\n')
    const again = testcraft(repo, ['prove'])
    assert.equal(again.code, 0, again.out)
    assert.match(again.out, /以前证明过/)
  })

  test('证明过以后改了 testpace.json 里跑测试的 files 命令：要重证', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    write(repo, 'tests/member.test.mjs', memberTest)
    assert.equal(testcraft(repo, ['prove']).code, 0)
    assert.match(testcraft(repo, ['prove']).out, /以前证明过/)

    edit(repo, 'testpace.json', '"files": "node --test"', '"files": "node --test --test-concurrency=1"')
    const again = testcraft(repo, ['prove'])
    assert.equal(again.code, 0, again.out)
    assert.doesNotMatch(again.out, /以前证明过/)
  })

  test('证明过以后默认分支往前走了、合了进来：证明用到的文件原来的样子没变，不用重证；变了要重证', () => {
    const repo = sampleRepo()
    // 这次在价格文件里改了两处：开头加一行说明，末尾加会员价
    const price = join(repo, 'src/price.mjs')
    writeFileSync(price, `// 价格\n${readFileSync(price, 'utf8')}${MEMBER_PRICE}`)
    write(repo, 'tests/member.test.mjs', memberTest)
    sh(repo, 'git add -A && git commit -qm member')
    assert.equal(testcraft(repo, ['prove']).code, 0)

    mainMoves(repo, "printf 'export const unrelated = 1\\n' > src/other.mjs")
    assert.match(testcraft(repo, ['prove']).out, /以前证明过/)

    // 默认分支上也加了开头那一行：合进来以后价格文件现在的内容没变，可它在分叉点上的样子变了（证明时换回的旧版不一样了），之前的证明不算
    mainMoves(repo, "printf '// 价格\\n' | cat - src/price.mjs > price.tmp && mv price.tmp src/price.mjs")
    assert.equal(readFileSync(price, 'utf8').split('// 价格').length, 2)
    const again = testcraft(repo, ['prove'])
    assert.equal(again.code, 0, again.out)
    assert.doesNotMatch(again.out, /以前证明过/)
  })

  test('放水检查缺理由没过，补上理由再查：旧版测试不重跑；又改了代码要重跑', () => {
    const repo = sampleRepo()
    halfOff(repo)
    assert.equal(testcraft(repo, ['weaken']).code, 1)
    const first = runs(repo)
    assert.ok(first > 0)

    write(repo, '.testcraft/changes/feature.md', HALF_OFF_RECORD)
    const explained = testcraft(repo, ['weaken'])
    assert.equal(explained.code, 0, explained.out)
    assert.match(explained.out, /✓ .*tests\/price\.test\.mjs/)
    assert.equal(runs(repo), first)

    // 加清单条目也一样：文字，不重跑
    write(repo, '.testcraft/checklist/half-hint.md', '# 改了满减，活动页的说明要跟着改\n\n## 触发\n\n- `src/sale-page.mjs`\n\n## 怎么查\n\n活动页的满减说明和 price 对一遍。\n\n## 来由\n\nfeature：改满减时想到的。\n')
    assert.equal(testcraft(repo, ['weaken']).code, 0)
    assert.equal(runs(repo), first)

    appendFileSync(join(repo, 'src/price.mjs'), MEMBER_PRICE)
    assert.equal(testcraft(repo, ['weaken']).code, 0)
    assert.ok(runs(repo) > first)
  })

  test('放水检查跑到一半判断不了（新版测试在副本里也跑不过）：没做完的结果不记，再查还是没做完', () => {
    const repo = sampleRepo()
    edit(repo, 'src/price.mjs', 'return amount - coupon.off', 'return amount - coupon.off / 2')
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 81)')
    assert.equal(testcraft(repo, ['weaken']).code, 2)
    const again = testcraft(repo, ['weaken'])
    assert.equal(again.code, 2, again.out)
    assert.match(again.out, /放水检查没做完/)
    assert.doesNotMatch(again.out, /没有发现|通过/)
  })

  test('放水检查过了以后默认分支往前走了、合了进来，相关的文件没变：不用重查', () => {
    const repo = sampleRepo()
    halfOff(repo)
    write(repo, '.testcraft/changes/feature.md', HALF_OFF_RECORD)
    sh(repo, 'git add -A && git commit -qm half')
    assert.equal(testcraft(repo, ['weaken']).code, 0)

    mainMoves(repo, "printf 'export const unrelated = 1\\n' > src/other.mjs")
    assert.match(testcraft(repo, ['weaken']).out, /已经检查过/)
  })

  test('取文件在某个提交上的内容标识：名字里有方括号、星号、空格、中文的按原名取；那里没有的文件不在结果里', () => {
    const names = ['src/[id].mjs', 'src/a*b.mjs', 'src/会员 价.mjs']
    const repo = sampleRepo(dir => names.forEach((name, index) => write(dir, name, `export const n = ${index}\n`)))
    const ids = blobIdsAt(repo, 'main', [...names, 'src/none.mjs'])
    assert.deepEqual([...ids.keys()].sort(), [...names].sort())
    for (const name of names) assert.equal(ids.get(name), sh(repo, `git rev-parse "main:${name}"`).trim())
  })

  test('取内容标识时 git 跑不成（没有这个提交）：报错，不当成那里没有这些文件', () => {
    const repo = sampleRepo()
    assert.throws(() => blobIdsAt(repo, 'no-such-branch', ['src/price.mjs']))
  })

  test('只改了已有测试的断言、加了一条清单，代码没改：放水检查一个测试都不用跑', () => {
    const repo = sampleRepo()
    edit(repo, 'tests/price.test.mjs', '{ threshold: 100, off: 20 }), 80)', '{ threshold: 100, off: 20 }), 100 - 20)')
    write(repo, '.testcraft/checklist/half-hint.md', '# 改了满减，活动页的说明要跟着改\n\n## 触发\n\n- `src/sale-page.mjs`\n\n## 怎么查\n\n活动页的满减说明和 price 对一遍。\n\n## 来由\n\nfeature：改断言写法时想到的。\n')
    const r = testcraft(repo, ['weaken'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ 删改了已有测试的断言.*tests\/price\.test\.mjs/)
    assert.equal(runs(repo), 0)
  })
})
