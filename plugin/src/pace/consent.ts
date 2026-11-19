// 落地前怎么测（testpace.json 的三条命令和 tests 规则）是评判用的配置，走"用户同意后生效"（见 base/judging.ts）：
// 和分叉点那一版比，改了命令、缩小了找测试的范围，要用户在确认工具的弹窗里同意过，整组才跑。
// 加严的不用问：tests 规则多加一条找测试的规则、去掉一条排除。首次接入（分叉点上还没有 testpace.json）也不用问。
// 命令往哪个方向改程序判断不了（换个脚本名和换成 true 看起来一样），所以改了就问。

import { askUser, type ConfirmItem } from '../base/confirm.ts'
import { CONTRACT_FILE } from '../base/contract.ts'
import { forkPoint } from '../base/git.ts'
import { type Judging, judgingFile } from '../base/judging.ts'
import type { Repo } from '../base/repo.ts'
import { COMMAND_KEYS, type CommandKey } from './config.ts'

const COMMAND_USE: Record<CommandKey, string> = {
  fast: '改完代码先跑的快检查',
  files: '跑测试文件用的命令',
  full: '落地前跑的全部检查',
}

function fieldsOf(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  try {
    const raw = JSON.parse(text) as unknown
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const rules = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

/** 这次改动放松了落地前怎么测的地方，一个字段一项。分叉点上没有约定（首次接入）、或那一版读不出来时没有可比的，不算放松。 */
export function loosenedItems(contract: Judging): ConfirmItem[] {
  const before = fieldsOf(contract.before)
  const now = fieldsOf(contract.now)
  if (!before || !now) return []
  const items: ConfirmItem[] = []
  for (const key of COMMAND_KEYS) {
    const was = before[key]
    const is = now[key]
    if (typeof was !== 'string' || was === is) continue
    items.push({
      before: JSON.stringify([key, was]),
      after: JSON.stringify([key, is]),
      text: [`${CONTRACT_FILE} 的 ${key} 命令（${COMMAND_USE[key]}）改了`, `原来：${was}`, `现在：${typeof is === 'string' ? is : '（没有了）'}`].join('\n'),
    })
  }
  const was = rules(before.tests)
  const is = rules(now.tests)
  const excluded = (rule: string): boolean => rule.startsWith('!')
  // 少了一条找测试的规则，或多了一条排除：整组跑的测试可能变少
  const dropped = was.filter(rule => !excluded(rule) && !is.includes(rule))
  const added = is.filter(rule => excluded(rule) && !was.includes(rule))
  if (dropped.length || added.length) {
    items.push({
      before: JSON.stringify(['tests', was]),
      after: JSON.stringify(['tests', is]),
      text: [
        `${CONTRACT_FILE} 里找测试文件的规则（tests）缩小了，落地前跑的测试可能变少`,
        ...(dropped.length ? [`去掉了：${dropped.join('、')}`] : []),
        ...(added.length ? [`新加了排除：${added.map(rule => rule.slice(1)).join('、')}`] : []),
        `原来：${was.join('、')}`,
        `现在：${is.join('、')}`,
      ].join('\n'),
    })
  }
  return items
}

/**
 * 整组之前：这次改动放松了落地前怎么测的地方，用户都同意过没有。有没同意的，返回说给 agent 的话（怎么让用户确认）。
 * 算不出分叉点的仓库（认不出默认分支）不问：那里合并门本来就没在把关。
 */
export function unconfirmedChanges(repo: Repo): string | undefined {
  const fork = forkPoint(repo.root)
  if (!fork.commit) return undefined
  const items = loosenedItems(judgingFile(repo.root, fork.commit, CONTRACT_FILE))
  if (items.length === 0) return undefined
  const asked = askUser(repo, 'pace', '这次改动改了落地前怎么测', items)
  if (!asked.ask) return undefined
  return [`${CONTRACT_FILE} 里落地前怎么测的改动要用户同意后才生效（和分叉点 ${fork.commit.slice(0, 10)} 上的比）。`, ...asked.ask.lines].join('\n')
}
