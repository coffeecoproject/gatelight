// 整组里"跑测试"的部分（base/module.ts 的 fullPart）：测试以外的检查（full），再把 tests 规则找到的全部测试文件交给 files。
// 测试由这里按规则找出来，不靠谁记得把新测试加进整组。跑完读回每个测试的结果：记下没过的，认时好时坏和几轮没过的。

import type { FullPart } from '../base/module.ts'
import type { Repo } from '../base/repo.ts'
import { loadConfig } from './config.ts'
import type { PaceRun } from './record.ts'
import { failedTests, noteResults, readResults, RESULTS_ENV, resultsFile } from './results.ts'
import { findTests } from './tests.ts'

export function fullPart(repo: Repo): FullPart | { problem: string } {
  const { config, problems } = loadConfig(repo.root)
  if (!config?.full || !config.files || problems.length > 0) return { problem: problems.join('；') }
  const tests = findTests(repo.root, config.tests)
  if (tests.length === 0) return { problem: `按 tests 规则（${config.tests.join('、')}）在工作区里没找到测试文件。` }
  const resultsAt = resultsFile()
  return {
    steps: [
      { kind: 'full', title: '整组的检查（full）', header: `整组的检查（full）：${config.full}`, command: config.full, args: [] },
      { kind: 'tests', title: `全部测试（${tests.length} 个文件）`, header: `全部测试（${tests.length} 个文件）：${config.files}`, command: config.files, args: tests },
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
