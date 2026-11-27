// gatelight 自带的默认清单条目（skills/setup-testcraft/checklist/）：已接入的项目还没有的新条目，提醒补上。
// 项目在 .testcraft/defaults 里记一行版本号：补到了 gatelight 哪一版的默认条目（setup-testcraft 接入、补条目时写）。
// 只提醒比它新、项目清单里又没有同名文件的条目：项目不要的条目，不复制、照样把版本号改到这一版，就不再提醒。
// 没有这个文件的（这个机制之前接入的）当作一条都没补过：没有的默认条目都提醒。
//
// 来由（2026-11-27）：same-number 是从 CrocWork 一次漏改（9b21af3e）总结出来的，可 CrocWork 接入时只有 dev-login，
// 后来加的条目从没补进去；它的 MCN 分支改的全是钱怎么算，testcraft checklist 却报"一条也没命中"。新条目只有用户想起来要才会补。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, VERSION } from '../base/version.ts'
import { CHECKLIST_DIR, TESTCRAFT_DIR } from './config.ts'

/** 默认条目放在哪（插件里）。 */
export const DEFAULTS_DIR = fileURLToPath(new URL('../../skills/setup-testcraft/checklist', import.meta.url))

/** 项目补到了哪一版的默认条目。 */
export const SYNCED_FILE = `${TESTCRAFT_DIR}/defaults`

/** 每条默认条目是 gatelight 哪一版加的。加新的默认条目时在这里写上（测试核对和目录里的文件一一对应）。 */
export const DEFAULT_SINCE: Readonly<Record<string, string>> = {
  'dev-login.md': '0.16.1',
  'same-number.md': '0.22.2',
}

export interface MissingDefault {
  file: string
  title: string
  since: string
}

/** 项目记的版本号；没有文件、写的不是版本号的当作 0.0.0（一条都没补过）。 */
function syncedVersion(root: string): string {
  try {
    const text = readFileSync(join(root, SYNCED_FILE), 'utf8').trim()
    return /^\d+\.\d+\.\d+$/.test(text) ? text : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 比项目记的版本新、项目清单（工作区里的）又没有同名文件的默认条目。 */
export function missingDefaults(root: string): MissingDefault[] {
  const synced = syncedVersion(root)
  const have = new Set(existsSync(join(root, CHECKLIST_DIR)) ? readdirSync(join(root, CHECKLIST_DIR)) : [])
  return Object.entries(DEFAULT_SINCE)
    .filter(([file, since]) => compareVersions(since, synced) > 0 && !have.has(file))
    .map(([file, since]) => ({ file, since, title: /^#\s+(.+?)\s*$/m.exec(readFileSync(join(DEFAULTS_DIR, file), 'utf8'))?.[1] ?? file }))
}

/** 说给 agent 的一段：哪几条没补、怎么补、不要的怎么记。没有要补的返回 undefined。 */
export function missingText(root: string): string | undefined {
  const missing = missingDefaults(root)
  if (missing.length === 0) return undefined
  const named = missing.map(entry => `${entry.file.replace(/\.md$/, '')}（${entry.title}）`).join('、')
  return (
    `gatelight 有 ${missing.length} 条默认清单条目这个仓库还没有：${named}。` +
    `下次在这个仓库的分支上做事时顺手补上，照 gatelight:setup-testcraft 技能"已接入的项目补默认条目"一节，和那个分支一起合；` +
    `补完（或用户说哪条不要）把 ${SYNCED_FILE} 写成 ${VERSION}，就不再提醒。`
  )
}
