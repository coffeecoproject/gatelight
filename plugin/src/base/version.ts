// 插件自己的名字和版本：取 Claude Code 的插件清单（Codex、Antigravity 的清单和它一起改，测试核对几份一致）。

import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8')) as { name: string; version: string }

export const VERSION: string = manifest.version

/**
 * 插件的名字。说给 agent 的话里提到插件时用它；确认工具的全名里也有它（.mcp.json 里服务的名字，测试核对和它一样）。
 * 几条命令（testpace、testcraft、modwall、codekeep）不跟它走。
 */
export const PLUGIN_NAME: string = manifest.name

/** 比较两个 x.y.z 版本号：a 新返回正数，旧返回负数，一样返回 0。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
