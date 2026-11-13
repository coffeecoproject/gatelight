import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { commandWord, parseConfig } from '../src/config.ts'
import { findCoverage } from '../src/coverage.ts'
import { cleanLines, failureExcerpt } from '../src/excerpt.ts'
import { duration } from '../src/format.ts'
import { matcher } from '../src/glob.ts'
import { failedThenPassed, fileRole, landingCost, renderReport, repeatedFiles, rerunsAfterFailure, weekly } from '../src/report.ts'
import { KEEP_LOGS, type RunRecord, Store } from '../src/store.ts'
import { firstTest } from '../src/verify.ts'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let seq = 0
function run(partial: Partial<RunRecord>): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    kind: 'full',
    worktree: '/repo',
    tree: 't1',
    treeAtEnd: partial.tree ?? 't1',
    startedAt: seq * 1000,
    durationMs: 60_000,
    exitCode: 0,
    result: 'pass',
    log: `/logs/r${seq}.log`,
    ...partial,
  }
}

describe('ignore 路径规则', () => {
  test('** 跨目录，* 不跨目录，结尾 / 表示整个目录', () => {
    const ignored = matcher(['docs/**', '*.png', 'notes/'])
    assert.ok(ignored('docs/a.md'))
    assert.ok(ignored('docs/deep/b.md'))
    assert.ok(ignored('logo.png'))
    assert.ok(!ignored('assets/logo.png'))
    assert.ok(ignored('notes/today.md'))
    assert.ok(!ignored('src/docs.ts'))
  })

  test('**/ 开头匹配任意层，包括根目录', () => {
    const ignored = matcher(['**/CHANGELOG.md'])
    assert.ok(ignored('CHANGELOG.md'))
    assert.ok(ignored('packages/a/CHANGELOG.md'))
    assert.ok(!ignored('packages/a/CHANGELOG.mdx'))
  })

  test('点号等字符按字面匹配', () => {
    assert.ok(!matcher(['a.md'])('abmd'))
  })
})

describe('配置', () => {
  test('三条命令齐全时没有问题，ignore 默认为空', () => {
    const { config, problems } = parseConfig({ fast: 'a', files: 'b', full: 'c' })
    assert.deepEqual(problems, [])
    assert.deepEqual(config, { fast: 'a', files: 'b', full: 'c', ignore: [] })
  })

  test('缺字段、拼错字段、类型不对都报出来', () => {
    const { problems } = parseConfig({ fast: '', full: 'c', ignroe: [], ignore: 'docs' })
    assert.deepEqual(problems, ['未知字段 "ignroe"', '"fast" 应该是非空字符串', '缺少 "files" 命令', '"ignore" 应该是路径规则的字符串数组'])
  })

  test('命令的第一个词跳过环境变量赋值', () => {
    assert.equal(commandWord('NODE_ENV=test FOO=1 pnpm -s test'), 'pnpm')
    assert.equal(commandWord('  ./scripts/full.sh'), './scripts/full.sh')
  })
})

describe('通过记录', () => {
  const noDiff = (): string[] => {
    throw new Error('不该调用')
  }

  test('内容完全一致的通过记录直接算数', () => {
    const pass = run({ tree: 'A' })
    assert.deepEqual(findCoverage('A', [pass], () => false, noDiff), { kind: 'exact', run: pass })
  })

  test('失败、跑的过程中改过代码的都不算', () => {
    const runs = [run({ tree: 'A', result: 'fail', exitCode: 1 }), run({ tree: 'A', treeAtEnd: 'B' })]
    assert.deepEqual(findCoverage('A', runs, () => false, () => []), { kind: 'none' })
  })

  test('相对通过的代码只改了忽略路径时记录继续有效', () => {
    const pass = run({ tree: 'A' })
    const coverage = findCoverage('B', [pass], matcher(['docs/**']), () => ['docs/a.md'])
    assert.deepEqual(coverage, { kind: 'ignored', run: pass, changed: ['docs/a.md'] })
  })

  test('改了忽略路径以外的文件就没有记录', () => {
    const coverage = findCoverage('B', [run({ tree: 'A' })], matcher(['docs/**']), () => ['docs/a.md', 'src/a.ts'])
    assert.deepEqual(coverage, { kind: 'none' })
  })

  test('树对象找不到时跳过那条记录', () => {
    const coverage = findCoverage('B', [run({ tree: 'A' })], () => true, () => {
      throw new Error('bad object')
    })
    assert.deepEqual(coverage, { kind: 'none' })
  })
})

describe('精简输出', () => {
  test('去掉颜色码，进度条只留最后一次', () => {
    assert.deepEqual(cleanLines('\x1b[31mFAIL\x1b[0m a\n10%\r50%\r100%'), ['FAIL a', '100%'])
  })

  test('取失败相关的行和结尾，跳过的部分用省略号', () => {
    const log = ['start', ...Array.from({ length: 50 }, (_, i) => `ok ${i}`), 'FAIL tests/a.test.ts', ...Array.from({ length: 50 }, (_, i) => `line ${i}`), 'Tests 1 failed']
    const out = failureExcerpt(log.join('\n'), { matches: 5, tail: 3 })
    assert.deepEqual(out, ['…', 'FAIL tests/a.test.ts', '…', 'line 48', 'line 49', 'Tests 1 failed'])
  })

  test('短输出原样保留', () => {
    assert.deepEqual(failureExcerpt('a\nb\n\n', { matches: 5, tail: 10 }), ['a', 'b'])
  })
})

describe('报告的统计', () => {
  test('失败后连续重跑几轮才通过，按工作区分开算', () => {
    const runs = [
      run({ result: 'fail', tree: 'A' }),
      run({ result: 'fail', tree: 'B', worktree: '/other' }),
      run({ result: 'fail', tree: 'C' }),
      run({ result: 'pass', tree: 'D' }),
      run({ result: 'pass', tree: 'E', worktree: '/other' }),
    ]
    assert.deepEqual(rerunsAfterFailure(runs), [2, 1])
  })

  test('同一份代码先失败后通过的找出来；先通过后失败、代码改过的不算', () => {
    const runs = [
      run({ result: 'fail', tree: 'A' }),
      run({ result: 'pass', tree: 'A' }),
      run({ result: 'pass', tree: 'B' }),
      run({ result: 'fail', tree: 'B' }),
      run({ result: 'fail', tree: 'C' }),
      run({ result: 'pass', tree: 'C', treeAtEnd: 'X' }),
    ]
    assert.deepEqual(failedThenPassed(runs).map(f => f.tree), ['A'])
  })

  test('反复跑的测试文件按次数排', () => {
    const runs = [
      run({ kind: 'files', files: ['a.test.ts', 'b.test.ts'] }),
      run({ kind: 'files', files: ['a.test.ts'] }),
      run({ kind: 'files', files: ['b.test.ts'] }),
      run({ kind: 'files', files: ['b.test.ts'] }),
    ]
    assert.deepEqual(repeatedFiles(runs), [['b.test.ts', 3], ['a.test.ts', 2]])
  })

  test('平均每次落地的测试耗时和整组次数，落地从第一次运行算起', () => {
    const t = 1_000_000_000_000
    const runs = [
      run({ kind: 'fast', startedAt: t, durationMs: 60_000 }),
      run({ kind: 'full', startedAt: t + 1, durationMs: 600_000 }),
      run({ kind: 'full', startedAt: t + 2, durationMs: 540_000 }),
    ]
    const landing = (time: number) => ({ commit: 'c', time, files: [] })
    // 第一次运行之前的落地不摊
    assert.equal(
      landingCost(runs, [landing(t - 1), landing(t + 10), landing(t + 20)], 'main'),
      '落地到 main 2 次，平均每次落地跑测试 10分00秒、整组 1.0 次（从这段时间第一次运行算起，含分支上还没落地的）',
    )
    assert.equal(landingCost(runs, [landing(t - 1)], 'main'), undefined)
    assert.equal(landingCost([], [landing(t)], 'main'), undefined)
  })

  test('文件:行号 算那个文件，一次里给了同一文件的几行算一次', () => {
    const runs = [run({ kind: 'files', files: ['a.test.ts:12', 'a.test.ts:30:5'] }), run({ kind: 'files', files: ['a.test.ts'] })]
    assert.deepEqual(repeatedFiles(runs), [['a.test.ts', 2]])
  })

  test('区分测试代码、主代码和非代码文件', () => {
    assert.equal(fileRole('src/a.test.ts'), 'test')
    assert.equal(fileRole('e2e/login.ts'), 'test')
    assert.equal(fileRole('pkg/store_test.go'), 'test')
    assert.equal(fileRole('app/test_api.py'), 'test')
    assert.equal(fileRole('Sources/AppTests.swift'), 'test')
    assert.equal(fileRole('src/latest.ts'), 'code')
    assert.equal(fileRole('README.md'), 'other')
    assert.equal(fileRole('pnpm-lock.yaml'), 'other')
  })

  test('按周汇总落地行数和整组耗时中位数', () => {
    const week = 7 * 24 * 3600 * 1000
    const runs = [run({ startedAt: 10, durationMs: 1000 }), run({ startedAt: 20, durationMs: 3000 }), run({ startedAt: week + 5, durationMs: 9000 })]
    const landingList = [{ commit: 'c1', time: 30, files: [{ path: 'src/a.ts', added: 10 }, { path: 'src/a.test.ts', added: 25 }, { path: 'README.md', added: 99 }] }]
    const rows = weekly(runs, landingList, 0, week + 10)
    assert.deepEqual(rows, [
      { start: 0, landings: 1, testLines: 25, codeLines: 10, fullPasses: 2, fullMedianMs: 2000 },
      { start: week, landings: 0, testLines: 0, codeLines: 0, fullPasses: 1, fullMedianMs: 9000 },
    ])
  })

  test('报告写出次数、失败重跑、先失败后通过和 fast 过慢', () => {
    const now = 100 * 24 * 3600 * 1000
    const at = (minutes: number): number => now - minutes * 60_000
    const runs = [
      run({ kind: 'fast', startedAt: at(50), durationMs: 30_000 }),
      run({ kind: 'full', startedAt: at(40), result: 'fail', exitCode: 1, tree: 'A', durationMs: 8_000, log: '/logs/a-fail.log' }),
      run({ kind: 'full', startedAt: at(30), result: 'pass', tree: 'A' }),
      run({ kind: 'full', startedAt: at(500 * 24 * 60), tree: 'old' }),
    ]
    const text = renderReport({ repo: '/repo', days: 7, now, runs, landings: [] })
    assert.match(text, /fast\s+1\s+1\s+0\s+30秒\s+30秒/)
    assert.match(text, /full\s+2\s+1\s+1\s+34秒\s+1分08秒/)
    assert.match(text, /整组失败 1 次；失败后平均重跑 1\.0 轮才通过（1 次）/)
    assert.match(text, /先失败后通过：1 份代码整组先失败、后通过。可能是测试不稳定，也可能是环境问题（比如数据库没起来），看失败的日志分辨：\n  代码 A（.+）：失败用时 8秒，之后通过用时 1分00秒，失败日志 \/logs\/a-fail\.log/)
    assert.match(text, /fast 平均 30秒，超过 20 秒/)
  })

  test('没有记录时说明一句', () => {
    assert.match(renderReport({ repo: '/repo', days: 7, now: 1e9, runs: [], landings: [] }), /没有 testpace 跑过的命令/)
  })
})

test('时长显示', () => {
  assert.equal(duration(4_400), '4秒')
  assert.equal(duration(192_000), '3分12秒')
  assert.equal(duration(3_720_000), '1小时02分')
})

test('日志只留最近的，最早的先删', () => {
  const dir = mkdtempSync(join(tmpdir(), 'testpace-store-'))
  try {
    const store = new Store(dir)
    mkdirSync(join(store.dir, 'logs'), { recursive: true })
    for (let i = 0; i < KEEP_LOGS + 5; i++) writeFileSync(join(store.dir, 'logs', `2026${String(i).padStart(4, '0')}.log`), '')
    const path = store.logPath('2027new')
    writeFileSync(path, '')
    const left = readdirSync(join(store.dir, 'logs')).sort()
    assert.equal(left.length, KEEP_LOGS)
    assert.equal(left[0], `2026${String(6).padStart(4, '0')}.log`)
    assert.equal(left.at(-1), '2027new.log')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('verify', () => {
  test('找文件里第一个测试声明的行和列', () => {
    assert.deepEqual(firstTest("import { test } from 'node:test'\n\ntest('a', () => {})\n"), { line: 3, column: 1 })
    assert.deepEqual(firstTest("describe('x', () => {\n  it.only('y', () => {})\n})\n"), { line: 1, column: 1 })
    assert.deepEqual(firstTest('import x\n  it.skip("y", () => {})\n'), { line: 2, column: 3 })
    assert.deepEqual(firstTest('import os\n\ndef test_price():\n    pass\n'), { line: 3, column: 1 })
    assert.deepEqual(firstTest('package p\n\nfunc TestPrice(t *testing.T) {}\n'), { line: 3, column: 1 })
    assert.equal(firstTest('const testing = 1\nexport function it() {}\n'), undefined)
    // 钩子和配置那一行没有测试，按行跑会落空：跳过它们
    assert.deepEqual(firstTest("test.use({ locale: 'zh' })\ntest.beforeEach(() => {})\ntest.describe.configure({ mode: 'serial' })\ntest.skip('a', () => {})\n"), { line: 4, column: 1 })
  })
})
