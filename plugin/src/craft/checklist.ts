// 按改动触发的清单：.testcraft/checklist/<编号>.md，一条一个文件，每条记一个写不成测试、又能从改动看出来的坑。
//   # 标题：要守的事
//   ## 触发：每行一条，行首反引号写路径规则（几个用、隔开）；后面可以加 改到 `文字`（正则）：这些文件增删的行里有这段文字才算。
//   ## 怎么查：命中时要做的检查。
//   ## 来由：哪次出的事（分支、提交、事故），说明为什么有这条。
// 从分叉点那一版读清单：分支里新加的条目合并后才生效，删了、改了的这次照旧按原来的提醒。
// 按这次改了的文件挑出命中的条目，提醒 agent 按"怎么查"查一遍。只是提醒：不要求写下怎么查的，也没有人核对查没查。

import { basename } from 'node:path'
import type { Snapshot } from './change.ts'
import { CHECKLIST_DIR, TESTCRAFT_DIR } from './config.ts'
import { matchesAny } from '../base/glob.ts'
import { type Change, diffLines, fileAt, fileNow, filesAt } from '../base/git.ts'

/** 行首的文件：一个或几个反引号括起来的路径，用、或逗号隔开。 */
const LEADING_FILES = /^`[^`]+`(?:\s*[、，,]\s*`[^`]+`)*/

/** 清单的条目：清单目录下一层的 .md 文件，一个文件一条。改名成别的扩展名、挪进子目录，就不再是条目。 */
export function isChecklistItem(path: string): boolean {
  return path.startsWith(`${CHECKLIST_DIR}/`) && /^[^/]+\.md$/.test(path.slice(CHECKLIST_DIR.length + 1))
}

export interface Trigger {
  paths: string[]
  /** 这些文件增删的行里要有的文字（正则）；不写就是改到这些文件就算。 */
  text?: string
}

export interface Item {
  id: string
  file: string
  title: string
  triggers: Trigger[]
  check: string
  origin: string
}

export interface Parsed {
  items: Item[]
  problems: string[]
}

const TEXT_AFTER = /^\s*改到\s*`([^`]+)`\s*$/

export function parseItem(file: string, text: string): { item: Item } | { problems: string[] } {
  const problems: string[] = []
  const title = /^#\s+(.+?)\s*$/m.exec(text)?.[1] ?? ''
  if (!title) problems.push(`${file} 没有标题（# 后面写要守的事）`)
  const sections = new Map<string, string[]>()
  let section = ''
  for (const line of text.split('\n')) {
    const heading = /^#{2,}\s*(.+?)\s*$/.exec(line)
    if (heading) {
      section = heading[1] as string
      continue
    }
    const name = ['触发', '怎么查', '来由'].find(key => section.includes(key))
    if (name) sections.set(name, [...(sections.get(name) ?? []), line])
  }
  const triggers: Trigger[] = []
  for (const line of sections.get('触发') ?? []) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (!bullet) continue
    const body = bullet[1] as string
    const leading = LEADING_FILES.exec(body)
    if (!leading) {
      problems.push(`${file} 的触发条件"${body}"没写路径（行首用反引号括起来）`)
      continue
    }
    const paths = [...leading[0].matchAll(/`([^`]+)`/g)].map(match => match[1] as string)
    const rest = body.slice(leading[0].length)
    if (rest.trim() === '') {
      triggers.push({ paths })
      continue
    }
    const after = TEXT_AFTER.exec(rest)
    if (!after) {
      problems.push(`${file} 的触发条件"${body}"看不懂：路径后面只能写 改到 \`文字\``)
      continue
    }
    try {
      new RegExp(after[1] as string)
      triggers.push({ paths, text: after[1] as string })
    } catch (error) {
      problems.push(`${file} 的触发条件里 \`${after[1]}\` 不是合法的正则：${(error as Error).message}`)
    }
  }
  if (triggers.length === 0 && !problems.some(problem => problem.includes('触发条件'))) problems.push(`${file} 没写触发条件（"## 触发"下每行一条）`)
  const prose = (name: string): string =>
    (sections.get(name) ?? [])
      .map(line => line.trim())
      .filter(Boolean)
      .join('\n')
  const check = prose('怎么查')
  const origin = prose('来由')
  if (check.length < 4) problems.push(`${file} 没写怎么查（"## 怎么查"）`)
  if (origin.length < 4) problems.push(`${file} 没写来由（"## 来由"：哪次出的事）`)
  if (problems.length) return { problems }
  return { item: { id: basename(file, '.md'), file, title, triggers, check, origin } }
}

function parseAll(files: Array<{ file: string; text: string | undefined }>): Parsed {
  const parsed: Parsed = { items: [], problems: [] }
  for (const { file, text } of files) {
    if (text === undefined) continue
    const result = parseItem(file, text)
    if ('item' in result) parsed.items.push(result.item)
    else parsed.problems.push(...result.problems)
  }
  return parsed
}

/** 分叉点上的清单：这次改动按它提醒（分支上加的、删改的条目合并后才生效）。 */
export function baseChecklist(s: Snapshot): Parsed {
  const files = filesAt(s.root, s.base, CHECKLIST_DIR).filter(isChecklistItem)
  return parseAll(files.map(file => ({ file, text: fileAt(s.root, s.base, file) })))
}

/** 这次改动加的、改的条目：要写得对，合并后才用得上。分叉点上原有、这次没动的不在这里查。 */
export function changedChecklist(s: Snapshot): Parsed {
  const files = s.changes.filter(change => change.status !== 'D' && isChecklistItem(change.path)).map(change => change.path)
  return parseAll(files.map(file => ({ file, text: fileNow(s.root, file) })))
}

export interface Hit {
  item: Item
  /** 这次改了的、触发了它的文件。 */
  paths: string[]
}

/** 这次改了的文件里，命中各条目触发条件的。testcraft 自己的文件（记录、清单、配置）不算；从别处改名挪进 .testcraft/ 的照旧按原来的路径算。 */
export function hitsOf(s: Snapshot, items: Item[]): Hit[] {
  const ours = (path: string | undefined): boolean => path === undefined || path.startsWith(`${TESTCRAFT_DIR}/`)
  const changes = s.changes.filter(change => !(ours(change.path) && ours(change.oldPath)))
  const lines = new Map<string, string[]>()
  const changedLines = (change: Change): string[] => {
    let cached = lines.get(change.path)
    if (!cached) {
      const diff = diffLines(s.root, s.base, change)
      cached = [...diff.added.map(line => line.text), ...diff.removed]
      lines.set(change.path, cached)
    }
    return cached
  }
  const fires = (trigger: Trigger, change: Change): boolean => {
    if (!matchesAny(change.path, trigger.paths) && !(change.oldPath !== undefined && matchesAny(change.oldPath, trigger.paths))) return false
    if (trigger.text === undefined) return true
    const pattern = new RegExp(trigger.text)
    return changedLines(change).some(line => pattern.test(line))
  }
  const hits: Hit[] = []
  for (const item of items) {
    const paths = changes.filter(change => item.triggers.some(trigger => fires(trigger, change))).map(change => change.path)
    if (paths.length) hits.push({ item, paths })
  }
  return hits
}
