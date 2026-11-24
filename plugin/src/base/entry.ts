// 固定命令入口：~/.local/bin 下的 testpace、modwall、testcraft。Codex 不把插件的 bin/ 放进命令的 PATH，合并门的 git 钩子也靠 PATH 找 testpace。
// 入口文件只有一份（entry/command），每条命令放一份一样的；它不带版本，运行时按被叫的名字找这台机器上装着的最高版本的插件里同名的命令，插件升级不用重放。
// 这是全局安装：只在 testpace install 时放，不在会话开始时自动放（放过别的命令的机器上，新加的命令也一样）。
// 放过的入口是旧版本放的（入口文件本身变了，比如插件改了名、旧入口按旧名字找不到装着的那份）：会话开始时换成这一版的。

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 放固定入口的命令：插件 bin/ 里给 agent 直接叫的那几条。加命令只改这里。 */
export const ENTRY_COMMANDS = ['testpace', 'modwall', 'testcraft'] as const
export type EntryCommand = (typeof ENTRY_COMMANDS)[number]

const SOURCE = new URL('../../entry/command', import.meta.url)
/** 入口文件里认得出是 testpace install 放的那一行。 */
const MARK = '# testpace 固定入口'

export function entryDir(): string {
  return join(homedir(), '.local', 'bin')
}

export function entryPath(command: EntryCommand): string {
  return join(entryDir(), command)
}

export type EntryState = 'installed' | 'missing' | 'outdated' | 'foreign'

/** 一条命令的固定入口的状态：没放、放的是这一版、旧的、还是同名的别的文件（不动它）。 */
export function entryState(command: EntryCommand): EntryState {
  const path = entryPath(command)
  if (!existsSync(path)) return 'missing'
  const text = readFileSync(path, 'utf8')
  if (text === readFileSync(SOURCE, 'utf8')) return 'installed'
  return text.includes(MARK) ? 'outdated' : 'foreign'
}

/** 固定入口不是这一版放好的那几条命令（没放、旧的、同名的别的文件）：靠入口找命令的地方找不到它们。 */
export function entriesNotPlaced(): EntryCommand[] {
  return ENTRY_COMMANDS.filter(command => entryState(command) !== 'installed')
}

function place(command: EntryCommand): void {
  mkdirSync(entryDir(), { recursive: true })
  const path = entryPath(command)
  writeFileSync(path, readFileSync(SOURCE, 'utf8'))
  chmodSync(path, 0o755)
}

/**
 * 会话开始时：放过、但是旧版本放的入口，换成这一版的，不问（放的时候用户同意过；合并门的钩子也是这样更新的）。
 * 没放过的不放，同名的别的文件不动。写不进去（目录只读、在沙箱里）时不挡会话：入口还是旧的，会话说明和 testpace status 照旧会说。
 */
export function refreshEntries(): void {
  for (const command of ENTRY_COMMANDS) {
    if (entryState(command) !== 'outdated') continue
    try {
      place(command)
    } catch {
      // 见上：不挡会话
    }
  }
}

/** 放上或更新每条命令的固定入口；同名的别的文件不覆盖，返回是哪几条没放上。 */
export function installEntries(): { refused: EntryCommand[] } {
  const refused: EntryCommand[] = []
  for (const command of ENTRY_COMMANDS) {
    const state = entryState(command)
    if (state === 'foreign') refused.push(command)
    else if (state !== 'installed') place(command)
  }
  return { refused }
}
