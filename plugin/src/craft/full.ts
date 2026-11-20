// 整组里"测试写法"的部分（base/module.ts 的 fullPart）：接入了的仓库在测试之前跑一次 testcraft checklist，
// 落地前把这次命中的清单条目再说一遍；这次加、改的条目写坏了的不让过。不跑测试，只读文件。
// 它随插件一起装，不用在本机另外登记；没接入的仓库没有这一段。

import { fileURLToPath } from 'node:url'
import { quoted } from '../base/execute.ts'
import { forkPoint } from '../base/git.ts'
import type { FullPart } from '../base/module.ts'
import type { Repo } from '../base/repo.ts'
import { joined } from './config.ts'

/** 这个插件里的 testcraft 命令：用完整路径，不靠 PATH 上碰巧有哪一版。 */
const BIN = fileURLToPath(new URL('../../bin/testcraft', import.meta.url))

export function fullPart(repo: Repo): FullPart {
  // 按分叉点也算接入：这次删掉 .testcraft/ 的，照旧按原来的清单提醒
  if (!joined(repo.root, forkPoint(repo.root).commit)) return { steps: [] }
  return {
    steps: [
      {
        kind: 'craft',
        name: '清单（testcraft checklist）',
        title: '清单（testcraft checklist）',
        header: '清单：testcraft checklist',
        command: `${quoted(BIN)} checklist`,
        args: [],
      },
    ],
  }
}
