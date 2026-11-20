// 整组里"跑测试"的部分（base/module.ts 的 fullPart）：测试以外的检查（full），再把 tests 规则找到的全部测试文件交给 files。
// 测试由这里按规则找出来，不靠谁记得把新测试加进整组。跑完读回每个测试的结果：记下没过的，认时好时坏和几轮没过的。

import type { FullPart } from '../base/module.ts'
import type { Repo } from '../base/repo.ts'
import { loadConfig } from './config.ts'
import { unconfirmedChanges } from './consent.ts'
import type { PaceRun } from './record.ts'
import { FULL_STEP, TESTS_STEP } from './report.ts'
import { failedTests, noteResults, readResults, RESULTS_ENV, resultsFile } from './results.ts'
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
  return {
    steps: [
      { kind: 'full', name: FULL_STEP, title: FULL_STEP, header: `${FULL_STEP}：${config.full}`, command: config.full, args: [] },
      { kind: 'tests', name: TESTS_STEP, title: `${TESTS_STEP}（${tests.length} 个文件）`, header: `${TESTS_STEP}（${tests.length} 个文件）：${config.files}`, command: config.files, args: tests },
    ],
    summary: `${tests.length} 个测试文件`,
    env: { [RESULTS_ENV]: resultsAt.path },
    finish() {
      const results = readResults(resultsAt.path, repo.root)
      return {
        fields: { tests: tests.length, ...(results.length > 0 ? { failed: failedTests(results) } : {}) },
        notes: (record, before) => noteResults(repo, { record: record as PaceRun, results, before: before as PaceRun[], whole: tests }),
      }
    },
    dispose: () => resultsAt.dispose(),
  }
}
