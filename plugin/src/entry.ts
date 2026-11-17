// 固定命令入口 ~/.local/bin/testpace：Codex 不把插件的 bin/ 放进命令的 PATH，合并门的 git 钩子也靠 PATH 找 testpace。
// 入口本身不带版本（entry/testpace），运行时找这台机器上装着的最高版本，插件升级不用重放。
// 这是全局安装：只在 testpace install 时放，不在会话开始时自动放。

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const SOURCE = new URL('../entry/testpace', import.meta.url)
/** 入口文件里认得出是 testpace 放的那一行。 */
const MARK = '# testpace 固定入口'

export function entryPath(): string {
  return join(homedir(), '.local', 'bin', 'testpace')
}

export type EntryState = 'installed' | 'missing' | 'outdated' | 'foreign'

/** 固定入口的状态：没放、放的是这一版、旧的、还是同名的别的文件（不动它）。 */
export function entryState(): EntryState {
  const path = entryPath()
  if (!existsSync(path)) return 'missing'
  const text = readFileSync(path, 'utf8')
  if (text === readFileSync(SOURCE, 'utf8')) return 'installed'
  return text.includes(MARK) ? 'outdated' : 'foreign'
}

/** 放上或更新固定入口；同名的别的文件不覆盖，返回原因。 */
export function installEntry(): { ok: boolean; problem?: string } {
  const path = entryPath()
  const state = entryState()
  if (state === 'foreign') return { ok: false, problem: `${path} 已经有别的文件，没有覆盖。确认不要它后删掉，再跑 testpace install。` }
  if (state !== 'installed') {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, readFileSync(SOURCE, 'utf8'))
    chmodSync(path, 0o755)
  }
  return { ok: true }
}
