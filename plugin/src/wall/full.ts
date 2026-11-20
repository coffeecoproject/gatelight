// 整组里"模块边界"的部分（base/module.ts 的 fullPart）：接入了的仓库在测试之前跑一次 modwall check。
// 它随插件一起装，不用在本机另外登记；没接入的仓库没有这一段。
// 库里的现状（modwall db check）不在这一段：要迁移跑完才能查，由项目写在自己的 full 命令里。

import { fileURLToPath } from 'node:url'
import { quoted } from '../base/execute.ts'
import { forkPoint } from '../base/git.ts'
import type { FullPart } from '../base/module.ts'
import type { Repo } from '../base/repo.ts'
import { joined } from './config.ts'

/** 这个插件里的 modwall 命令：用完整路径，不靠 PATH 上碰巧有哪一版。 */
const BIN = fileURLToPath(new URL('../../bin/modwall', import.meta.url))

export function fullPart(repo: Repo): FullPart {
  // 按分叉点也算接入：删掉 .modwall/ 躲不过检查
  if (!joined(repo.root, forkPoint(repo.root).commit)) return { steps: [] }
  return {
    steps: [
      {
        kind: 'wall',
        name: '模块边界的检查（modwall check）',
        title: '模块边界的检查（modwall check）',
        header: '模块边界的检查：modwall check',
        command: `${quoted(BIN)} check`,
        args: [],
      },
    ],
  }
}
