// 固定命令入口 ~/.local/bin/testpace：Codex 不把插件的 bin/ 放进命令的 PATH，合并门的 git 钩子也靠 PATH 找 testpace。
// 入口本身不带版本（entry/testpace），运行时按插件的名字找这台机器上装着的最高版本，插件升级不用重放。
// 这是全局安装：只在 testpace install 时放，不在会话开始时自动放。
// 放过的入口是旧版本放的（入口文件本身变了，比如插件改了名、旧入口按旧名字找不到装着的那份）：会话开始时换成这一版的。

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const SOURCE = new URL('../../entry/testpace', import.meta.url)
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

/**
 * 会话开始时：放过、但是旧版本放的入口，换成这一版的，不问（放的时候用户同意过；合并门的钩子也是这样更新的）。
 * 没放过的不放，同名的别的文件不动。写不进去（目录只读、在沙箱里）时不挡会话：入口还是旧的，会话说明和 testpace status 照旧会说。
 */
export function refreshEntry(): void {
  if (entryState() !== 'outdated') return
  try {
    installEntry()
  } catch {
    // 见上：不挡会话
  }
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
