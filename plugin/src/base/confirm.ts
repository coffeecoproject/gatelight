// 用户确认：检查里有要用户同意的改动（放松了测试、放宽了规则）时，模块把条目交到这里，不自己弹窗、不自己存同意记录。
// 同意只能来自确认工具（src/mcp.ts 的 confirm_with_user）：那个工具标了"每次都要用户在弹窗里同意"，agent 自己说"用户同意了"不算。
//
// 同意按项记：一项是"哪个模块的、改之前是什么、改成什么、用户当时看到的文字"，四样都一样才是同一项。
//   几个分支合到一起，没再动过的那一项不用重新确认；文字相同但改之前的内容不同，是另一项，要重新确认。
//
// 两步：检查（askUser）把还没同意的条目按编号存好，输出编号和弹窗文字让 agent 去调工具；
// 工具（confirm）只按编号取存下的内容，核对传来的文字一字不差，记下同意。工具进程跟着会话开着、插件更新后还是旧代码，
// 所以它不打开改动、不做任何判断。
//
// 记录在 .git/testpace/confirm/ 下（所有 worktree 共用）：pending.json 等用户过目的，confirmed.json 用户同意过的。

import { existsSync } from 'node:fs'
import { commonDir, repoRoot } from './git.ts'
import { hash, ModuleRecords } from './records.ts'
import { type Repo } from './repo.ts'
import { Store } from './store.ts'

/** 确认工具的名字（src/mcp.ts）。 */
export const CONFIRM_TOOL = 'confirm_with_user'

/** 要用户同意的一项改动。 */
export interface ConfirmItem {
  /** 这一项改之前是什么。写法由模块定（内容本身或它的摘要都行），同一项改动每次要写得一样。 */
  before: string
  /** 改成了什么。 */
  after: string
  /** 给用户看的文字：白话，用户不看代码也能判断。 */
  text: string
}

export interface Asked {
  /** 用户同意过的。 */
  confirmed: ConfirmItem[]
  /** 还没同意的。 */
  pending: ConfirmItem[]
  /** 有没同意的条目时：存好的编号和弹窗文字，以及说给 agent 的话（怎么调工具）。 */
  ask?: { id: string; text: string; lines: string[] }
}

interface PendingRecord {
  module: string
  /** 弹窗里给用户看的文字：工具只核对传来的和它一字不差。 */
  text: string
  /** 这次弹窗里的各项：同意后按 key 各记一条。 */
  items: Array<{ key: string; text: string }>
  at: number
}

interface ConfirmRecord {
  module: string
  /** 用户同意时看到的这一项的文字。 */
  text: string
  at: number
}

/** 文字比对用：每行去掉首尾空白，去掉空行，一样才算同一份。 */
function plain(text: string): string {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
}

/** 一项的记号：模块、改之前、改成什么、给用户看的文字。 */
function itemKey(module: string, item: ConfirmItem): string {
  return hash('item', module, item.before, item.after, plain(item.text))
}

/** 两份记录都用底座的模块记录存取（records.ts）：90 天前的不再算，文件坏了当成没有。 */
const pendingOf = (store: Store): ModuleRecords<PendingRecord> => new ModuleRecords(store, 'confirm', 'pending')
const confirmedOf = (store: Store): ModuleRecords<ConfirmRecord> => new ModuleRecords(store, 'confirm', 'confirmed')

/** 弹窗里给用户看的文字：一项一段，带编号。 */
function popupText(heading: string, items: ConfirmItem[]): string {
  const lines = [`${heading}，要你确认的有 ${items.length} 项：`]
  items.forEach((item, index) => {
    const [first = '', ...rest] = item.text.split('\n').map(line => line.trim()).filter(Boolean)
    lines.push('', `${index + 1}. ${first}`, ...rest.map(line => `   ${line}`))
  })
  lines.push('', '同意：按这样改。不同意：告诉 agent 改回去或换个做法。')
  return lines.join('\n')
}

/**
 * 检查时调：这些条目里用户同意过哪些。有没同意的，把它们按编号存好，返回编号、弹窗文字和说给 agent 的话。
 * module 是模块的名字，heading 是弹窗开头说这是什么的半句（比如"这次改动里放松测试的地方"）。
 * 有没同意的条目时，模块的检查不能算通过。
 */
export function askUser(repo: Repo, module: string, heading: string, items: ConfirmItem[]): Asked {
  const records = confirmedOf(repo.store)
  const seen = new Set<string>()
  const confirmed: ConfirmItem[] = []
  const pending: Array<{ key: string; item: ConfirmItem }> = []
  for (const item of items) {
    const key = itemKey(module, item)
    if (seen.has(key)) continue
    seen.add(key)
    if (records.get(key)) confirmed.push(item)
    else pending.push({ key, item })
  }
  if (pending.length === 0) return { confirmed, pending: [] }
  const text = popupText(heading, pending.map(({ item }) => item))
  // 编号按这一批没同意的条目算：条目变了就是另一个编号，旧编号的同意对它不算
  const id = hash('ask', module, text, ...pending.map(({ key }) => key))
  pendingOf(repo.store).put(id, { module, text, items: pending.map(({ key, item }) => ({ key, text: item.text })), at: Date.now() })
  return {
    confirmed,
    pending: pending.map(({ item }) => item),
    ask: {
      id,
      text,
      lines: [
        `这 ${pending.length} 项还没经用户确认。用户不会看命令输出，要调用 testpace 的 ${CONFIRM_TOOL} 工具，弹窗给用户看，用户同意了才算。`,
        '调用之前，先在对话里用白话告诉用户每一项原来是什么样、现在改成什么样、为什么；用户不同意的，改回去或者换个做法。',
        `repo：${repo.root}`,
        `id：${id}`,
        'text（下面两行分隔线之间的原样填，一字不改）：',
        '-----',
        text,
        '-----',
      ],
    },
  }
}

export interface Confirmed {
  ok: boolean
  text: string
}

/** 编号是 32 位十六进制。 */
const ID = /^[0-9a-f]{32}$/

/** 确认工具调：核对传来的文字就是检查给这个编号存下的弹窗内容，记下用户同意了里面的每一项。 */
export function confirm(repoPath: string, id: string, text: string): Confirmed {
  const root = existsSync(repoPath) ? repoRoot(repoPath) : undefined
  if (!root) return { ok: false, text: `${repoPath} 不在 git 仓库里` }
  const missing = { ok: false, text: '没有这个编号要确认的内容：重跑要求确认的那条检查，照它输出的编号和文字填。' }
  if (!ID.test(id)) return missing
  const store = new Store(commonDir(root))
  // 编号是外面传来的：模块记录只取文件里这个键自己的
  const pending = pendingOf(store).get(id)
  if (!pending) return missing
  const whole =
    typeof pending.text === 'string' &&
    typeof pending.module === 'string' &&
    Array.isArray(pending.items) &&
    pending.items.every(item => typeof item?.key === 'string' && typeof item.text === 'string')
  if (!whole) return { ok: false, text: '这个编号存下的内容坏了：重跑要求确认的那条检查，照它输出的编号和文字填。' }
  if (plain(text) !== plain(pending.text)) {
    return { ok: false, text: '传来的文字和检查给这个编号的不一致：照它输出的原样填，不要改写、增删。' }
  }
  const records = confirmedOf(store)
  const at = Date.now()
  for (const item of pending.items) records.put(item.key, { module: pending.module, text: item.text, at })
  return { ok: true, text: `已记下：用户确认并同意了这 ${pending.items.length} 项。再跑一次要求确认的那条检查。` }
}
