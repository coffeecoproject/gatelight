// testpace 自己的版本：取 Claude Code 的插件清单（Codex 的清单版本和它一起升，测试核对两边一致）。

import { readFileSync } from 'node:fs'

export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8')) as { version: string }
).version

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
