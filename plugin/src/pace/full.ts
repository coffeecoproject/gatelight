// 整组里"跑测试"的部分（base/module.ts 的 fullPart）：测试以外的检查（full），再把 tests 规则找到的全部测试文件交给 files。
// 测试由这里按规则找出来，不靠谁记得把新测试加进整组。跑完读回每个测试的结果：记下没过的，认时好时坏和几轮没过的。

import type { FullPart } from '../base/module.ts'
import type { Repo } from '../base/repo.ts'
import { loadConfig } from './config.ts'
import { unconfirmedChanges } from './consent.ts'
import type { PaceRun } from './record.ts'
import { FULL_STEP, TESTS_STEP } from './report.ts'
import { failedTests, noteResults, readResults, RESULTS_ENV, resultsFile, type TestResult } from './results.ts'
import { findTests } from './tests.ts'

export function fullPart(repo: Repo): FullPart | { problem: string } {
  const { config, problems } = loadConfig(repo.root)
  if (!config?.full || !config.files || problems.length > 0) return { problem: problems.join('；') }
  const tests = findTests(repo.root, config.tests)
  if (tests.length === 0) return { problem: `按 tests 规则（${config.tests.join('、')}）在工作区里没找到测试文件。` }
  // 这次改动改了命令、缩小了找测试的范围：用户同意过才跑（不然通过记录是按放松过的办法得来的）
  const unconfirmed = unconfirmedChanges(repo)
  if (unconfirmed) return { problem: unconfirmed }
  const resultsAt = resultsFile()
  const files = config.files
  return {
    steps: [
      { kind: 'full', name: FULL_STEP, title: FULL_STEP, header: `${FULL_STEP}：${config.full}`, command: config.full, args: [] },
      { kind: 'tests', name: TESTS_STEP, title: `${TESTS_STEP}（${tests.length} 个文件）`, header: `${TESTS_STEP}（${tests.length} 个文件）：${files}`, command: files, args: tests },
    ],
    summary: `${tests.length} 个测试文件`,
    env: { [RESULTS_ENV]: resultsAt.path },
    finish() {
      const results = readResults(resultsAt.path, repo.root)
      return {
        fields: { tests: tests.length, ...(results.length > 0 ? { failed: failedTests(results) } : {}) },
        problems: silentFiles(tests, results, files),
        notes: (record, before) => noteResults(repo, { record: record as PaceRun, results, before: before as PaceRun[], whole: tests }),
      }
    },
    dispose: () => resultsAt.dispose(),
  }
}

/** 一次最多点名几个没交回结果的文件。 */
const NAMED = 10

/**
 * 交给 files 的每个测试文件都要交回至少一条结果（过、没过、跳过都算）。不读脚本：脚本漏跑了哪一类测试，结果里就少了那些文件。
 * 一条结果都没交回的，是 files 整个没经 testpace run 跑、也没自己写结果。
 */
export function silentFiles(tests: readonly string[], results: readonly TestResult[], files: string): string[] {
  const reported = new Set(results.map(test => test.file))
  const silent = tests.filter(file => !reported.has(file))
  if (silent.length === 0) return []
  const how = `node:test、Vitest、Playwright 的测试经 testpace run 跑（它会交回结果）；别的跑法自己往环境变量 ${RESULTS_ENV} 给的文件里，每个测试追加一行 JSON：{"file":"文件的绝对路径","name":"测试名","status":"passed、failed 或 skipped"}`
  if (results.length === 0) return [`files 命令（${files}）跑完，一个测试结果都没交回，整组核对不了跑到了哪些测试。${how}。`]
  const named = silent.slice(0, NAMED).join('、') + (silent.length > NAMED ? ` 等 ${silent.length} 个` : '')
  return [
    `交给 files 命令（${files}）的测试文件里，这些一条结果都没交回：${named}。可能是 files 的脚本没把它们交给测试框架、被框架的配置排除了，或跑它们的那一路没交结果。${how}。`,
  ]
}
