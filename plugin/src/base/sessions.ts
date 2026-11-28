// 会话碰过哪些接入了 testpace 的仓库。记在插件数据目录（agent 给 hook 的 CLAUDE_PLUGIN_DATA，Claude Code 和 Codex 都给；
// Codex 实测是 ~/.codex/plugins/data/<插件>-<市场>。Antigravity 给的是 PLUGIN_DATA，文档说装好的插件才有）里，不在哪个仓库里：会话从仓库外（比如上一级目录）开始时，
// 压缩后补说节奏、停止门都靠它找到仓库。没有插件数据目录（不在 hook 里）时不记，只认会话所在目录的仓库。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_KEEP_MS, writeWhole } from './store.ts'

interface SessionRepos {
  updatedAt: number
  repos: string[]
  /** 会话所在的目录：第一次见到这个会话时 hook 给的目录。 */
  home?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

function sessionsDir(): string | undefined {
  const data = process.env.CLAUDE_PLUGIN_DATA || process.env.PLUGIN_DATA
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

/** 清掉过期的会话。 */
function prune(dir: string, now: number): void {
  for (const name of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const file = join(dir, name)
    const state = read(file)
    if (!state || now - state.updatedAt > SESSION_KEEP_MS) rmSync(file, { force: true })
  }
}

/**
 * 改这个会话的记录：change 拿到现在记着的（没有时是空的），返回要记的；返回 undefined 不用改。
 * 第一次记这个会话时顺手清掉过期的会话。
 */
function update(id: string, now: number, change: (known: SessionRepos | undefined) => Omit<SessionRepos, 'updatedAt'> | undefined): void {
  const dir = sessionsDir()
  if (!dir) return
  const path = fileOf(dir, id)
  const known = existsSync(path) ? read(path) : undefined
  const next = change(known)
  if (!next) return
  mkdirSync(dir, { recursive: true })
  if (!known) prune(dir, now)
  writeWhole(path, JSON.stringify({ ...next, updatedAt: now } satisfies SessionRepos))
}

/** 记下这个会话碰到的仓库。 */
export function noteSessionRepos(id: string, roots: string[], now: number): void {
  if (roots.length === 0) return
  update(id, now, known => (known && roots.every(root => known.repos.includes(root)) ? undefined : { ...known, repos: [...new Set([...(known?.repos ?? []), ...roots])] }))
}

/**
 * 会话所在的目录：记下第一次见到这个会话时的目录，以后都按它认，不跟着 hook 给的目录变。
 * Claude Code 主会话里 cd 会留到下一条命令，之后 hook 给的就是 cd 进去的目录：按它认，只进去看过的别人的工作区会被当成会话干活的地方。
 * 隔一天刷新一次记录的时间：会话还在用，不能当过期清掉、再按那时 cd 进去的目录重记。
 * 没有插件数据目录（不在 hook 里）时记不下，用这次给的目录。
 */
export function sessionHome(id: string, cwd: string, now: number): string {
  let home = cwd
  update(id, now, known => {
    home = known?.home ?? cwd
    if (known?.home && now - known.updatedAt < DAY_MS) return undefined
    return { repos: known?.repos ?? [], home }
  })
  return home
}
