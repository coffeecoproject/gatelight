// testpace focused 和 testpace files：用一个假的 layermap 命令决定选出哪些测试。

import assert from 'node:assert/strict'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fullReasons, type LayermapCheck, parseCheck, parseUntested, select, type Untested } from '../src/focused.ts'
import { matcher } from '../src/glob.ts'
import { commit, ENV, runs, sampleRepo, sh, tempDir, testpace } from './helpers.ts'

const check = (partial: Partial<LayermapCheck>): LayermapCheck => ({ files: [], tests: [], unmapped: [], truncated: false, ...partial })

describe('选测', () => {
  const exists = (path: string): boolean => !path.includes('deleted')

  test('选 rank 4 以下（含 3.5）而且还在的测试文件', () => {
    const selection = select(
      check({
        files: [{ path: 'src/a.ts', status: 'MODIFIED' }],
        tests: [
          { path: 't/a.test.ts', rank: 0, why: 'calls a' },
          { path: 't/b.test.ts', rank: 3, why: 'same directory' },
          { path: 't/s.test.ts', rank: 3.5, why: 'may use it through t/support.ts' },
          { path: 't/deleted.test.ts', rank: 1, why: 'changed' },
          { path: 't/c.test.ts', rank: 4, why: 'imports' },
        ],
      }),
      () => false,
      exists,
    )
    assert.deepEqual(selection, {
      kind: 'selected',
      changed: ['src/a.ts'],
      onlyIgnored: false,
      tests: ['t/a.test.ts', 't/b.test.ts', 't/s.test.ts'],
      indirect: 1,
      unmapped: [],
      truncated: false,
      untested: null,
    })
    assert.deepEqual(fullReasons(selection), [])
  })

  test('选出的测试跑不到的改动，或者确认时追踪被截断，都建议跑整组', () => {
    const selection = select(
      check({ files: [{ path: 'src/a.ts', status: 'MODIFIED' }], tests: [{ path: 't/b.test.ts', rank: 3, why: 'same directory' }] }),
      () => false,
      () => true,
    )
    assert.ok(selection.kind === 'selected')
    selection.untested = { changed: [], truncated: false }
    assert.deepEqual(fullReasons(selection), [])
    selection.untested = { changed: ['src/a.ts: a f1-3', 'src/a.ts: b f5-9', 'src/a.ts: c f11-12', 'src/a.ts: d f14-20'], truncated: true }
    assert.deepEqual(fullReasons(selection), [
      '选出的测试跑不到 src/a.ts: a f1-3、src/a.ts: b f5-9、src/a.ts: c f11-12 等 4 处',
      '确认选出的测试跑不跑得到改动时，layermap 追踪到上限就停了',
    ])
    // 选测时已经截断，确认时的截断不再重复
    selection.truncated = true
    assert.deepEqual(fullReasons(selection), [
      '改动影响的范围太大，layermap 追踪到上限就停了',
      '选出的测试跑不到 src/a.ts: a f1-3、src/a.ts: b f5-9、src/a.ts: c f11-12 等 4 处',
    ])
  })

  test('改了地图跟不到的文件、追踪被截断、没找到测试，都建议跑整组', () => {
    const selection = select(
      check({ files: [{ path: 'config.yaml', status: 'MODIFIED' }], unmapped: [{ path: 'config.yaml', kind: 'configuration' }], truncated: true }),
      () => false,
      exists,
    )
    assert.deepEqual(fullReasons(selection), [
      '改了 config.yaml（configuration），地图跟不到它们影响哪些测试',
      '改动影响的范围太大，layermap 追踪到上限就停了',
      'layermap 没找到和这次改动相关的测试',
    ])
  })

  test('只改了 ignore 路径时不用跑测试，也不建议整组', () => {
    const selection = select(check({ files: [{ path: 'docs/a.md', status: 'MODIFIED' }] }), matcher(['docs/**']), exists)
    assert.equal(selection.kind === 'selected' && selection.onlyIgnored, true)
    assert.deepEqual(fullReasons(selection), [])
  })

  test('layermap 的输出缺字段时说明可能是版本太旧', () => {
    assert.throws(() => parseCheck('{"files":[],"tests":[]}'), /版本太旧/)
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
    assert.match(noLayermap.out, /^fast 通过 · 用时 \d+秒\n建议跑整组（testpace full，放后台）：找不到 layermap 命令，没法按改动选测试。\n$/)

    const failing = fakeLayermap(FORMAT_CHANGE)
    const r = testpace(repo, ['focused'], { ...failing.env, FAKE_LAYERMAP_FAIL: '1' })
    assert.equal(r.code, 4)
    assert.match(r.out, /layermap 出错了：layermap: map build failed/)
  })

  test('多余的参数报用法错误', () => {
    const repo = sampleRepo()
    assert.equal(testpace(repo, ['focused', 'extra']).code, 2)
    assert.equal(testpace(repo, ['focused', '--base']).code, 2)
    assert.equal(testpace(repo, ['focused', '--base', 'HEAD', 'x']).code, 2)
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
