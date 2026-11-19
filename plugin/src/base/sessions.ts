// 会话碰过哪些接入了 testpace 的仓库。记在插件数据目录（agent 给 hook 的 CLAUDE_PLUGIN_DATA，Claude Code 和 Codex 都给；
// Codex 实测是 ~/.codex/plugins/data/<插件>-<市场>）里，不在哪个仓库里：会话从仓库外（比如上一级目录）开始时，
// 压缩后补说节奏、停止门都靠它找到仓库。没有插件数据目录（不在 hook 里）时不记，只认会话所在目录的仓库。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_KEEP_MS, writeWhole } from './store.ts'

interface SessionRepos {
  updatedAt: number
  repos: string[]
}

function sessionsDir(): string | undefined {
  const data = process.env.CLAUDE_PLUGIN_DATA
  return data ? join(data, 'sessions') : undefined
}

function fileOf(dir: string, id: string): string {
  return join(dir, `${id.replace(/[^\w.-]/g, '_')}.json`)
}

function read(path: string): SessionRepos | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SessionRepos
  } catch {
    return undefined
  }
}

/** 这个会话碰过的仓库根目录。 */
export function sessionRepos(id: string): string[] {
  const dir = sessionsDir()
  if (!dir) return []
  return read(fileOf(dir, id))?.repos ?? []
}

/** 记下这个会话碰到的仓库；第一次记这个会话时顺手清掉过期的会话。 */
export function noteSessionRepos(id: string, roots: string[], now: number): void {
  const dir = sessionsDir()
  if (!dir || roots.length === 0) return
  const path = fileOf(dir, id)
  const known = existsSync(path) ? read(path) : undefined
  if (known && roots.every(root => known.repos.includes(root))) return
  mkdirSync(dir, { recursive: true })
  if (!known) {
    for (const name of readdirSync(dir).filter(name => name.endsWith('.json'))) {
      const file = join(dir, name)
      const state = read(file)
      if (!state || now - state.updatedAt > SESSION_KEEP_MS) rmSync(file, { force: true })
    }
  }
  const repos = [...new Set([...(known?.repos ?? []), ...roots])]
  writeWhole(path, JSON.stringify({ updatedAt: now, repos } satisfies SessionRepos))
}
