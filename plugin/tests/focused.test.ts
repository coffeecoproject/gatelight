// testpace focused 和 testpace files：用一个假的 layermap 命令决定选出哪些测试。

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fullReasons, type LayermapCheck, parseCheck, parseUntested, select, type Untested } from '../src/focused.ts'
import { matcher } from '../src/glob.ts'
import { commit, ENV, runs, sampleRepo, sh, tempDir, testpace } from './helpers.ts'

const check = (partial: Partial<LayermapCheck>): LayermapCheck => ({ files: [], tests: [], unmapped: [], incomplete: [], ...partial })

describe('选测', () => {
  // 整组的测试：tests 规则在工作区里找到的，已删除的不在里面
  const suite = new Set(['t/a.test.ts', 't/b.test.ts', 't/s.test.ts', 't/c.test.ts', 'tests/a.test.ts'])
  const inRules = (path: string): boolean => /^(t|tests)\/.*\.test\.ts$/.test(path)

  test('选 rank 4 以下（含 3.5）而且在整组里的测试文件', () => {
    const selection = select(
      check({
        files: [
          { path: 'src/a.ts', status: 'MODIFIED' },
          { path: 't/deleted.test.ts', status: 'DELETED' },
        ],
        tests: [
          { path: 't/a.test.ts', rank: 0, why: 'calls a' },
          { path: 't/b.test.ts', rank: 3, why: 'same directory' },
          { path: 't/s.test.ts', rank: 3.5, why: 'may use it through t/support.ts' },
          { path: 't/c.test.ts', rank: 4, why: 'imports' },
        ],
      }),
      () => false,
      suite,
      inRules,
    )
    assert.deepEqual(selection, {
      kind: 'selected',
      changed: ['src/a.ts', 't/deleted.test.ts'],
      nothingToTest: false,
      tests: ['t/a.test.ts', 't/b.test.ts', 't/s.test.ts'],
      indirect: 1,
      outside: [],
      unmapped: [],
      incomplete: [],
      untested: null,
    })
    assert.deepEqual(fullReasons(selection), [])
  })

  test('选出的测试跑不到的改动，或者确认时追踪被截断，都建议跑整组', () => {
    const selection = select(
      check({ files: [{ path: 'src/a.ts', status: 'MODIFIED' }], tests: [{ path: 't/b.test.ts', rank: 3, why: 'same directory' }] }),
      () => false,
      suite,
      inRules,
    )
    assert.ok(selection.kind === 'selected')
    selection.untested = { changed: [], truncated: false }
    assert.deepEqual(fullReasons(selection), [])
    selection.untested = { changed: ['src/a.ts: a f1-3', 'src/a.ts: b f5-9', 'src/a.ts: c f11-12', 'src/a.ts: d f14-20'], truncated: true }
    assert.deepEqual(fullReasons(selection), [
      '选出的测试跑不到 src/a.ts: a f1-3、src/a.ts: b f5-9、src/a.ts: c f11-12 等 4 处',
      '确认选出的测试跑不跑得到改动时，layermap 追踪到上限就停了',
    ])
    // 选测时已经没做完，确认时的截断不再重复
    selection.incomplete = ['the trace stopped at 8 levels or 2000 declarations; continue with project_explore_map from the last ones']
    assert.deepEqual(fullReasons(selection), [
      'layermap 这次检查没做完，可能漏选测试：the trace stopped at 8 levels or 2000 declarations; continue with project_explore_map from the last ones',
      '选出的测试跑不到 src/a.ts: a f1-3、src/a.ts: b f5-9、src/a.ts: c f11-12 等 4 处',
    ])
  })

  test('改了地图跟不到的文件、layermap 检查没做完、没找到测试，都建议跑整组', () => {
    const selection = select(
      check({ files: [{ path: 'config.yaml', status: 'MODIFIED' }], unmapped: [{ path: 'config.yaml', kind: 'configuration' }], incomplete: ['the trace stopped at 8 levels or 2000 declarations; continue with project_explore_map from the last ones'] }),
      () => false,
      suite,
      inRules,
    )
    assert.deepEqual(fullReasons(selection), [
      '改了 config.yaml（configuration），地图跟不到它们影响哪些测试',
      'layermap 这次检查没做完，可能漏选测试：the trace stopped at 8 levels or 2000 declarations; continue with project_explore_map from the last ones',
      'layermap 没找到和这次改动相关的测试',
    ])
  })

  test('只改了 ignore 路径时不用跑测试，也不建议整组', () => {
    const selection = select(check({ files: [{ path: 'docs/a.md', status: 'MODIFIED' }] }), matcher(['docs/**']), suite, inRules)
    assert.equal(selection.kind === 'selected' && selection.nothingToTest, true)
    assert.deepEqual(fullReasons(selection), [])
  })

  test('地图跟不到的文件在 ignore 里时不算，其余照样建议跑整组', () => {
    const selection = select(
      check({
        files: [
          { path: 'src/a.ts', status: 'MODIFIED' },
          { path: 'docs/shot.png', status: 'ADDED' },
          { path: 'scripts/deploy.sh', status: 'MODIFIED' },
        ],
        tests: [{ path: 'tests/a.test.ts', rank: 2, why: 'imports src/a.ts' }],
        unmapped: [
          { path: 'docs/shot.png', kind: 'binary file' },
          { path: 'scripts/deploy.sh', kind: 'shell script' },
        ],
      }),
      matcher(['docs/**']),
      suite,
      inRules,
    )
    assert.deepEqual(selection.kind === 'selected' && selection.unmapped, [{ path: 'scripts/deploy.sh', kind: 'shell script' }])
    assert.deepEqual(fullReasons(selection), ['改了 scripts/deploy.sh（shell script），地图跟不到它们影响哪些测试'])
  })

  test('规则排除的测试和规则外的练习脚本不选；改到的规则内测试 layermap 认不出也选', () => {
    const selection = select(
      check({
        files: [
          { path: 'src/shared.ts', status: 'MODIFIED' },
          { path: 'checks/db.check.ts', status: 'MODIFIED' },
        ],
        tests: [
          { path: 'messages/send.test.ts', rank: 0, why: 'calls fmt' },
          { path: 'e2e/import/load.spec.ts', rank: 0, why: 'calls fmt' },
          { path: 'src/order.test.ts', rank: 0.1, why: 'calls order' },
          { path: 'messages/far.test.ts', rank: 4, why: 'imports indirectly' },
        ],
      }),
      () => false,
      new Set(['src/order.test.ts', 'checks/db.check.ts']),
      path => ['src/order.test.ts', 'checks/db.check.ts'].includes(path),
    )
    assert.ok(selection.kind === 'selected')
    assert.deepEqual(selection.tests, ['src/order.test.ts', 'checks/db.check.ts'])
    assert.deepEqual(selection.outside, ['messages/send.test.ts', 'e2e/import/load.spec.ts'])
    assert.equal(selection.indirect, 0, '整组外的间接导入不算')
    assert.equal(selection.nothingToTest, false)
  })

  test('只改了规则外的测试（和 ignore 路径）时不用跑测试，也不建议整组', () => {
    const selection = select(
      check({
        files: [
          { path: 'messages/send.test.ts', status: 'MODIFIED' },
          { path: 'docs/a.md', status: 'MODIFIED' },
        ],
        tests: [{ path: 'messages/send.test.ts', rank: 1, why: 'changed in this diff' }],
      }),
      matcher(['docs/**']),
      suite,
      inRules,
    )
    assert.equal(selection.kind === 'selected' && selection.nothingToTest, true)
    assert.deepEqual(fullReasons(selection), [])
  })

  test('只删了整组的测试时不用跑测试；删了规则外的代码文件不算', () => {
    // layermap 不列删掉的文件，靠 tests 规则认出删的是整组的测试
    const removed = select(check({ files: [{ path: 't/old.test.ts', status: 'DELETED' }] }), () => false, suite, inRules)
    assert.equal(removed.kind === 'selected' && removed.nothingToTest, true)
    assert.deepEqual(fullReasons(removed), [])
    const code = select(check({ files: [{ path: 'src/old.ts', status: 'DELETED' }] }), () => false, suite, inRules)
    assert.equal(code.kind === 'selected' && code.nothingToTest, false)
    assert.deepEqual(fullReasons(code), ['layermap 没找到和这次改动相关的测试'])
  })

  test('规则外的测试被整组测试用到时，照样跑整组里相关的那些', () => {
    const selection = select(
      check({
        files: [{ path: 'e2e/helpers/login.spec.ts', status: 'MODIFIED' }],
        tests: [
          { path: 'e2e/helpers/login.spec.ts', rank: 1, why: 'changed in this diff' },
          { path: 'tests/a.test.ts', rank: 2, why: 'imports e2e/helpers/login.spec.ts' },
        ],
      }),
      () => false,
      suite,
      inRules,
    )
    assert.ok(selection.kind === 'selected')
    assert.equal(selection.nothingToTest, false)
    assert.deepEqual(selection.tests, ['tests/a.test.ts'])
  })

  test('相关测试都不在规则里、又改了别的代码时，说明找到的都在规则外，建议跑整组', () => {
    const selection = select(
      check({ files: [{ path: 'src/shared.ts', status: 'MODIFIED' }], tests: [{ path: 'messages/send.test.ts', rank: 0, why: 'calls fmt' }] }),
      () => false,
      suite,
      inRules,
    )
    assert.equal(selection.kind === 'selected' && selection.nothingToTest, false)
    assert.deepEqual(fullReasons(selection), ['layermap 没找到和这次改动相关的测试（它找到的 1 个都不在 tests 规则里）'])
  })

  test('layermap 的输出缺字段时说明可能是版本太旧', () => {
    assert.throws(() => parseCheck('{"files":[],"tests":[]}'), /版本太旧/)
    // 0.1.40 的输出还没有 incomplete
    assert.throws(() => parseCheck('{"files":[],"tests":[],"unmapped":[],"truncated":false}'), /要 0\.1\.41 以上/)
    assert.throws(() => parseUntested('{"files":[],"tests":[],"unmapped":[],"truncated":false}'), /没有输出 untested/)
    assert.deepEqual(parseUntested('{"untested":{"changed":["src/a.ts: a f1-3"],"routes":[],"truncated":false}}'), {
      changed: ['src/a.ts: a f1-3'],
      truncated: false,
    })
  })
})

/**
 * 假的 layermap：每次调用的参数按行记下；输出给定的 JSON，参数里给了测试文件时再带上 untested；
 * FAKE_LAYERMAP_FAIL 时报错退出。
 */
function fakeLayermap(output: LayermapCheck, untested: Untested = { changed: [], truncated: false }): { env: NodeJS.ProcessEnv; calls: () => string[][] } {
  const dir = tempDir('testpace-fake-')
  const json = join(dir, 'check.json')
  const withTests = join(dir, 'check-tests.json')
  const callsFile = join(dir, 'calls.jsonl')
  writeFileSync(json, JSON.stringify(output))
  writeFileSync(withTests, JSON.stringify({ ...output, untested: { ...untested, entries: [], throughRoutes: [], routes: [], missing: [] } }))
  const bin = join(dir, 'layermap')
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n')
if (process.env.FAKE_LAYERMAP_FAIL) { console.error('layermap: map build failed'); process.exit(1) }
// check --json --base REF 之后还有参数，就是给了测试文件
process.stdout.write(fs.readFileSync(args.length > 4 ? ${JSON.stringify(withTests)} : ${JSON.stringify(json)}, 'utf8'))
`,
  )
  chmodSync(bin, 0o755)
  return {
    env: { ...ENV, PATH: `${dir}:${ENV.PATH}` },
    calls: () => readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  }
}

const FORMAT_CHANGE = check({
  files: [{ path: 'src/format.mjs', status: 'MODIFIED' }],
  tests: [
    { path: 'tests/format.test.mjs', rank: 0, why: 'calls yuan' },
    { path: 'tests/price.test.mjs', rank: 4, why: 'imports indirectly' },
  ],
})

describe('testpace focused', () => {
  test('跑 fast，再只跑选出的测试文件，两次都记下来', () => {
    const repo = sampleRepo()
    writeFileSync(join(repo, 'src', 'format.mjs'), 'export function yuan(amount) {\n  return `¥${amount.toFixed(2)}`\n}\n// 改过\n')
    const layermap = fakeLayermap(FORMAT_CHANGE)
    const r = testpace(repo, ['focused'], layermap.env)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /^fast 通过 · 用时 \d+秒\n相关测试 1 个（对比 [0-9a-f]{10}；另有 1 个只是间接导入改动，没选）：\n {2}tests\/format\.test\.mjs\n相关测试通过 · 用时 \d+秒\n$/)
    const [fast, files] = runs(repo)
    assert.equal(fast!.kind, 'fast')
    assert.equal(files!.kind, 'files')
    assert.deepEqual(files!.files, ['tests/format.test.mjs'])
    assert.match(readFileSync(files!.log as string, 'utf8'), /^# tests 1$/m, '只跑了选出的那个文件')
    // 在默认分支上，对比的就是 HEAD；选出测试后再问 layermap 它们跑不跑得到改动
    const head = sh(repo, 'git rev-parse HEAD').trim()
    assert.deepEqual(layermap.calls(), [
      ['check', '--json', '--base', head],
      ['check', '--json', '--base', head, 'tests/format.test.mjs'],
    ])
  })

  test('在工作分支上对比和默认分支的分叉点，分支上已提交的改动也算', () => {
    const repo = sampleRepo()
    const fork = sh(repo, 'git rev-parse HEAD').trim()
    sh(repo, 'git checkout -qb feature')
    writeFileSync(join(repo, 'src', 'extra.mjs'), 'export const x = 1\n')
    commit(repo, 'extra')
    const layermap = fakeLayermap(FORMAT_CHANGE)
    assert.equal(testpace(repo, ['focused'], layermap.env).code, 0)
    assert.deepEqual(layermap.calls()[0], ['check', '--json', '--base', fork])
    testpace(repo, ['focused', '--base', 'HEAD~1'], layermap.env)
    assert.deepEqual(layermap.calls()[2], ['check', '--json', '--base', 'HEAD~1'])
  })

  test('相关测试失败时给出节选，退出码 1', () => {
    const repo = sampleRepo()
    writeFileSync(join(repo, 'src', 'format.mjs'), 'export function yuan(amount) {\n  return `¥${amount}`\n}\n')
    const r = testpace(repo, ['focused'], fakeLayermap(FORMAT_CHANGE).env)
    assert.equal(r.code, 1)
    assert.match(r.out, /相关测试失败（退出码 1）· 用时 \d+秒\n--- 输出节选 ---\n/)
    assert.match(r.out, /not ok 1 - yuan shows two decimals/)
  })

  test('fast 失败时不再跑测试', () => {
    const repo = sampleRepo()
    writeFileSync(join(repo, 'src', 'format.mjs'), 'export function yuan( {\n')
    const r = testpace(repo, ['focused'], fakeLayermap(FORMAT_CHANGE).env)
    assert.equal(r.code, 1)
    assert.match(r.out, /^fast 失败（退出码 1）/)
    assert.deepEqual(runs(repo).map(run => run.kind), ['fast'])
  })

  test('改了地图跟不到的文件：跑完选出的测试，再建议跑整组，退出码 4', () => {
    const repo = sampleRepo()
    const layermap = fakeLayermap({ ...FORMAT_CHANGE, unmapped: [{ path: 'package.json', kind: 'build or dependency file' }] })
    const r = testpace(repo, ['focused'], layermap.env)
    assert.equal(r.code, 4, r.out)
    assert.match(r.out, /相关测试通过 · 用时 \d+秒\n建议跑整组（testpace full，放后台）：改了 package\.json（build or dependency file），地图跟不到它们影响哪些测试。\n$/)
  })

  test('选出的测试跑不到某处改动：跑完选出的测试，再建议跑整组，退出码 4', () => {
    const repo = sampleRepo()
    const layermap = fakeLayermap(FORMAT_CHANGE, { changed: ['src/format.mjs: yuan f1-3'], truncated: false })
    const r = testpace(repo, ['focused'], layermap.env)
    assert.equal(r.code, 4, r.out)
    assert.match(r.out, /相关测试通过 · 用时 \d+秒\n建议跑整组（testpace full，放后台）：选出的测试跑不到 src\/format\.mjs: yuan f1-3。\n$/)
  })

  test('没有 layermap 或它出错时不跑测试，建议跑整组', () => {
    const repo = sampleRepo()
    // 只留 node 和系统命令的 PATH：没有 layermap
    const node = sh(repo, 'dirname "$(command -v node)"').trim()
    const noLayermap = testpace(repo, ['focused'], { ...ENV, PATH: `${node}:/usr/bin:/bin` })
    assert.equal(noLayermap.code, 4, noLayermap.out)
    assert.match(noLayermap.out, /^fast 通过 · 用时 \d+秒\n建议跑整组（testpace full，放后台）：找不到 layermap 命令，没法按改动选测试。\n装上 layermap 插件并开新会话（或把 layermap 命令加进 PATH），focused 就会只跑和改动相关的测试。\n$/)

    const failing = fakeLayermap(FORMAT_CHANGE)
    const r = testpace(repo, ['focused'], { ...failing.env, FAKE_LAYERMAP_FAIL: '1' })
    assert.equal(r.code, 4)
    assert.match(r.out, /layermap 出错了：layermap: map build failed/)
    // 装了但出错：不提示去装
    assert.doesNotMatch(r.out, /装上 layermap 插件/)
  })

  test('在分支上选测靠不住时不建议现在跑整组，退出码 0；合并时的整组会覆盖', () => {
    const repo = sampleRepo()
    sh(repo, 'git checkout -qb feature')
    const layermap = fakeLayermap({ ...FORMAT_CHANGE, unmapped: [{ path: 'package.json', kind: 'build or dependency file' }] })
    const r = testpace(repo, ['focused'], layermap.env)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /相关测试通过 · 用时 \d+秒\n这次选测不完全可靠：改了 package\.json（build or dependency file），地图跟不到它们影响哪些测试。在分支上不用现在跑整组，合回 main 时的整组会覆盖。\n$/)
    assert.doesNotMatch(r.out, /建议跑整组/)

    // 分离的 HEAD 也不在默认分支上
    sh(repo, 'git checkout -q --detach')
    const node = sh(repo, 'dirname "$(command -v node)"').trim()
    const noLayermap = testpace(repo, ['focused'], { ...ENV, PATH: `${node}:/usr/bin:/bin` })
    assert.equal(noLayermap.code, 0, noLayermap.out)
    assert.match(noLayermap.out, /这次选测不完全可靠：找不到 layermap 命令，没法按改动选测试。在分支上不用现在跑整组，合回 main 时的整组会覆盖。\n装上 layermap 插件/)
  })

  test('status 说明有没有 layermap', () => {
    const repo = sampleRepo()
    const node = sh(repo, 'dirname "$(command -v node)"').trim()
    const missing = testpace(repo, ['status'], { ...ENV, PATH: `${node}:/usr/bin:/bin` })
    assert.match(missing.out, /\nlayermap：找不到，focused 没法按改动选测试，每次都会建议跑整组。装上 layermap 插件并开新会话（或把 layermap 命令加进 PATH），focused 就会只跑和改动相关的测试。\n$/)
    const found = testpace(repo, ['status'], fakeLayermap(FORMAT_CHANGE).env)
    assert.match(found.out, /\nlayermap：找到\n$/)
  })

  test('多余的参数报用法错误', () => {
    const repo = sampleRepo()
    assert.equal(testpace(repo, ['focused', 'extra']).code, 2)
    assert.equal(testpace(repo, ['focused', '--base']).code, 2)
    assert.equal(testpace(repo, ['focused', '--base', 'HEAD', 'x']).code, 2)
  })

  test('只交给 files 规则里的测试；规则外的说一句没选', () => {
    const repo = sampleRepo()
    mkdirSync(join(repo, 'scratch'))
    writeFileSync(join(repo, 'scratch', 'try.test.mjs'), "throw new Error('不该跑')\n")
    const layermap = fakeLayermap(check({
      files: [{ path: 'src/format.mjs', status: 'MODIFIED' }],
      tests: [
        { path: 'scratch/try.test.mjs', rank: 0, why: 'calls yuan' },
        { path: 'tests/format.test.mjs', rank: 0, why: 'calls yuan' },
      ],
    }))
    const r = testpace(repo, ['focused'], layermap.env)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /相关测试 1 个（对比 [0-9a-f]{10}；另有 1 个不在 tests 规则里，整组不跑，没选）：\n {2}tests\/format\.test\.mjs\n/)
    assert.deepEqual(runs(repo).at(-1)!.files, ['tests/format.test.mjs'])
    assert.deepEqual(layermap.calls()[1]!.slice(4), ['tests/format.test.mjs'], '交回 layermap 核对的也只有规则里的')
  })

  test('只改了规则外的测试时说明不用跑测试', () => {
    const repo = sampleRepo()
    const r = testpace(repo, ['focused'], fakeLayermap(check({
      files: [{ path: 'scratch/try.test.mjs', status: 'ADDED' }],
      tests: [{ path: 'scratch/try.test.mjs', rank: 1, why: 'changed in this diff' }],
    })).env)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /改动里没有整组要跑的东西（只有 ignore 里的路径、tests 规则外或删掉的测试），不用跑测试。\n$/)
    assert.deepEqual(runs(repo).map(run => run.kind), ['fast'])
  })

  test('tests 规则写坏了时不跑，说明原因', () => {
    const repo = sampleRepo()
    const config = JSON.parse(readFileSync(join(repo, 'testpace.json'), 'utf8'))
    delete config.tests
    writeFileSync(join(repo, 'testpace.json'), JSON.stringify(config))
    const r = testpace(repo, ['focused'], fakeLayermap(FORMAT_CHANGE).env)
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /没法跑 focused：缺少 "tests"/)
  })

  test('只改了 ignore 路径时说明不用跑测试', () => {
    const repo = sampleRepo()
    const r = testpace(repo, ['focused'], fakeLayermap(check({ files: [{ path: 'docs/README.md', status: 'MODIFIED' }] })).env)
    assert.equal(r.code, 0)
    assert.match(r.out, /改动只涉及 ignore 里的路径，不用跑测试。\n$/)
  })
})

describe('testpace files', () => {
  test('跑给定的测试文件并记录，失败时给节选', () => {
    const repo = sampleRepo()
    const ok = testpace(repo, ['files', 'tests/price.test.mjs'])
    assert.equal(ok.code, 0, ok.out)
    assert.match(ok.out, /^1 个测试文件通过 · 用时 \d+秒\n$/)
    const missing = testpace(repo, ['files', 'tests/nope.test.mjs'])
    assert.equal(missing.code, 1)
    assert.match(missing.out, /^1 个测试文件失败（退出码 2）/)
    assert.match(missing.out, /测试文件不存在：tests\/nope\.test\.mjs/)
    assert.deepEqual(runs(repo).map(run => [run.kind, run.result, run.files]), [
      ['files', 'pass', ['tests/price.test.mjs']],
      ['files', 'fail', ['tests/nope.test.mjs']],
    ])
    assert.equal(testpace(repo, ['files']).code, 2)
  })
})
