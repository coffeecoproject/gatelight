// 落地前怎么测（testpace.json 的三条命令和 tests 规则）改了要用户同意：整组之前把关。

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { confirm } from '../src/base/confirm.ts'
import { loosenedItems } from '../src/pace/consent.ts'
import { commit, runs, sampleRepo, setConfig, sh, testpace } from './helpers.ts'

const contract = (change: Record<string, unknown> = {}): string =>
  JSON.stringify({ fast: 'npm run check', files: 'node scripts/test-files.mjs', full: 'npm run check:all', tests: ['tests/**/*.test.mjs', '!tests/slow/**'], ignore: ['docs/**'], ...change })

/** testpace full 交给确认工具的编号和文字。 */
function pendingOf(out: string): { id: string; text: string } {
  const id = /^id：(\S+)$/m.exec(out)?.[1]
  const text = /^-----\n([\s\S]*?)\n-----$/m.exec(out)?.[1]
  assert.ok(id && text, out)
  return { id, text }
}

describe('哪些改动算放松了落地前怎么测', () => {
  const texts = (now: string, before = contract()): string[] => loosenedItems({ before, now }).map(item => item.text)

  test('三条命令改了就要问，说明原来是什么、现在是什么', () => {
    assert.deepEqual(texts(contract()), [])
    assert.deepEqual(texts(contract({ full: 'true' })), ['testpace.json 的 full 命令（落地前跑的全部检查）改了\n原来：npm run check:all\n现在：true'])
    assert.deepEqual(texts(contract({ fast: 'true', files: 'node --test' })), [
      'testpace.json 的 fast 命令（改完代码先跑的快检查）改了\n原来：npm run check\n现在：true',
      'testpace.json 的 files 命令（跑测试文件用的命令）改了\n原来：node scripts/test-files.mjs\n现在：node --test',
    ])
    // 同一条命令改成不同的东西，是不同的两项（同意过一个不等于同意另一个）
    const [toTrue] = loosenedItems({ before: contract(), now: contract({ full: 'true' }) })
    const [toEcho] = loosenedItems({ before: contract(), now: contract({ full: 'echo ok' }) })
    assert.notDeepEqual({ before: toTrue?.before, after: toTrue?.after }, { before: toEcho?.before, after: toEcho?.after })
  })

  test('tests 规则：少了找测试的规则、多了排除要问；多加一条规则、去掉一条排除是加严，不问', () => {
    assert.deepEqual(texts(contract({ tests: ['tests/unit/**/*.test.mjs', '!tests/slow/**'] })), [
      [
        'testpace.json 里找测试文件的规则（tests）缩小了，落地前跑的测试可能变少',
        '去掉了：tests/**/*.test.mjs',
        '原来：tests/**/*.test.mjs、!tests/slow/**',
        '现在：tests/unit/**/*.test.mjs、!tests/slow/**',
      ].join('\n'),
    ])
    assert.deepEqual(texts(contract({ tests: ['tests/**/*.test.mjs', '!tests/slow/**', '!tests/price.test.mjs'] })), [
      [
        'testpace.json 里找测试文件的规则（tests）缩小了，落地前跑的测试可能变少',
        '新加了排除：tests/price.test.mjs',
        '原来：tests/**/*.test.mjs、!tests/slow/**',
        '现在：tests/**/*.test.mjs、!tests/slow/**、!tests/price.test.mjs',
      ].join('\n'),
    ])
    assert.deepEqual(texts(contract({ tests: ['tests/**/*.test.mjs', '!tests/slow/**', 'e2e/**/*.spec.mjs'] })), [])
    assert.deepEqual(texts(contract({ tests: ['tests/**/*.test.mjs'] })), [])
  })

  test('ignore 不在这里问（它合并后才生效）；首次接入、分叉点那一版读不出来时没有可比的', () => {
    assert.deepEqual(texts(contract({ ignore: ['**'] })), [])
    assert.deepEqual(loosenedItems({ before: undefined, now: contract({ full: 'true' }) }), [])
    assert.deepEqual(loosenedItems({ before: '{', now: contract({ full: 'true' }) }), [])
  })
})

describe('testpace full：改了命令、缩小了 tests 规则，用户同意过才跑', () => {
  test('分支上改了 full 命令：整组不跑，说明怎么让用户确认；确认后照常跑，记录里的同意换一份改法就不算', () => {
    const repo = sampleRepo()
    sh(repo, 'git checkout -qb feature')
    setConfig(repo, { full: 'node scripts/full.mjs && true' })
    const fork = sh(repo, 'git rev-parse main').trim()
    let r = testpace(repo, ['full'])
    assert.equal(r.code, 2, r.out)
    assert.match(
      r.out,
      new RegExp(`^没法跑整组：testpace\\.json 里落地前怎么测的改动要用户同意后才生效（和分叉点 ${fork.slice(0, 10)} 上的比）。\\n这 1 项还没经用户确认。`),
    )
    assert.deepEqual(runs(repo), [], '没同意就没跑，也没有记录')
    const asked = pendingOf(r.out)
    assert.equal(
      asked.text,
      [
        '这次改动改了落地前怎么测，要你确认的有 1 项：',
        '',
        '1. testpace.json 的 full 命令（落地前跑的全部检查）改了',
        '   原来：node scripts/full.mjs',
        '   现在：node scripts/full.mjs && true',
        '',
        '同意：按这样改。不同意：告诉 agent 改回去或换个做法。',
      ].join('\n'),
    )
    // 提交了也一样：比的是分叉点，不是上一次提交
    commit(repo, '改 full')
    assert.equal(testpace(repo, ['full']).code, 2)

    assert.equal(confirm(repo, asked.id, asked.text).ok, true)
    r = testpace(repo, ['full'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^整组通过/)

    // 又改成别的：那次同意的是上一种改法
    setConfig(repo, { full: 'true' })
    r = testpace(repo, ['full'])
    assert.equal(r.code, 2, r.out)
    assert.match(pendingOf(r.out).text, /现在：true\n/)
    // 改回原样就没有要问的了
    setConfig(repo, { full: 'node scripts/full.mjs' })
    assert.equal(testpace(repo, ['full']).code, 0)
  })

  test('在默认分支上没提交的改动也算；把一个测试排除出去要问，多认一类测试不问', () => {
    const repo = sampleRepo()
    setConfig(repo, { tests: ['tests/**/*.test.mjs', '!tests/price.test.mjs'] })
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 2, r.out)
    assert.match(pendingOf(r.out).text, /找测试文件的规则（tests）缩小了，落地前跑的测试可能变少\n {3}新加了排除：tests\/price\.test\.mjs\n/)
    setConfig(repo, { tests: ['tests/**/*.test.mjs', 'checks/**/*.check.mjs'] })
    const wider = testpace(repo, ['full'])
    assert.equal(wider.code, 0, wider.out)
  })

  test('focused、files 照常跑：把关的是留下通过记录的整组', () => {
    const repo = sampleRepo()
    setConfig(repo, { full: 'true' })
    assert.equal(testpace(repo, ['files', 'tests/price.test.mjs']).code, 0)
    assert.equal(testpace(repo, ['full']).code, 2)
  })
})
