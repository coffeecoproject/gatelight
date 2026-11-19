// "跑测试"说给 agent 的话，经底座的钩子送出去（base/module.ts 的 brief、alerts、beforeCommand、unfinished）：
// 测试节奏、名单上的时好时坏测试、直接跑 full 命令时的提示、停止门里这个会话认出的时好时坏测试。

import { basename } from 'node:path'
import { openRepo, type Repo } from '../base/repo.ts'
import { invocations, runsCommand } from '../base/shell.ts'
import { loadConfig } from './config.ts'
import { describeTest, flakyBrief } from './results.ts'
import { flakyTests, testKey } from './testlist.ts'

/** 测试节奏。repo 是话里指这个仓库的写法。落地的规矩由底座接在后面说。 */
export function rhythm(repo: string): string[] {
  return [
    `${repo}用 testpace 管测试节奏（testpace.json）：`,
    '1. 每个任务在自己的分支上做，最好是自己的 worktree，不和别的会话挤在同一个目录里。',
    '2. 改完跑 testpace focused：fast 检查加上和改动相关的测试。在分支上不跑整组。',
    '3. 有失败，用 testpace files <文件:行号> 只重跑失败的那几个测试（位置看失败输出）。',
    '4. 整组在合回默认分支时跑：做完的几个分支一起合，合并后的代码跑一次 testpace full，通过了再落地（testpace:merge 技能）。整组要跑几分钟，能把命令放到后台的就放后台、接着做别的，不要干等；跑完用 testpace status 看结果。',
  ]
}

/** 名单上有时好时坏的测试时提醒一句。 */
export function alerts(repo: Repo): string[] {
  const flaky = flakyBrief(flakyTests(repo.store))
  return flaky ? [flaky] : []
}

/** 直接跑配置里的 full 不会留下记录，合并门不认；它也只是整组的一部分。 */
export function fullCommandHint(command: string, cwd: string): string | undefined {
  const repo = openRepo(cwd)
  const full = repo && loadConfig(repo.root).config?.full
  const calls = invocations(command, cwd)
  if (!full || calls.some(call => basename(call.argv[0] ?? '') === 'testpace') || !runsCommand(command, full, cwd)) return undefined
  return '这是 testpace.json 里 full 的检查，只是整组的一部分（整组还要跑 tests 规则找到的全部测试）。直接跑不会留下通过记录，合并门不认；整组改用 testpace full，结果会按当前代码记录。'
}

/** 这个会话认出的时好时坏测试，还在名单上的：每个拦一次（记号 flaky:<testKey>），免得一句带过。 */
export function unfinished(repo: Repo, sessionId: string, seen: readonly string[], named: boolean): { keys: string[]; text: string } | undefined {
  const found = flakyTests(repo.store).filter(test => test.session === sessionId && !seen.includes(`flaky:${testKey(test)}`))
  if (found.length === 0) return undefined
  return {
    keys: found.map(test => `flaky:${testKey(test)}`),
    text: `这个会话${named ? `在 ${repo.root} ` : ''}认出了时好时坏的测试，还在名单上：${found.map(describeTest).join('、')}。不能靠重跑过关：按 testcraft 写测试技能里"测试时好时坏"一节找原因修；和手上的活无关的，告诉用户是哪个测试、在哪次没过、日志在哪（testpace status 列着）。说清楚了再收尾。`,
  }
}
