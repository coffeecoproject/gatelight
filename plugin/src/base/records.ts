// 模块的记录：放在 .git/testpace/<模块>/<名字>.json，一个键一条，所有 worktree 共用。模块不自己写 .git 下的文件，都经这里。
// 按内容记的结论（"这份内容检查过，通过"）用 saveChecked：开始跑之前算出内容的标识当键，写之前再算一次，
// 变了就不写。跑的过程中内容改过的话，结论是按开始时的样子得出的，不是现在这份内容的。这条在这里统一做，模块不用各自核对。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Store, writeWhole } from './store.ts'

/** 几段内容合起来的摘要（32 位十六进制），当记录的键用。没有的那一段（undefined，比如文件不存在）和空内容不一样。 */
export function hash(...parts: Array<string | Buffer | undefined>): string {
  const h = createHash('sha256')
  for (const part of parts) {
    h.update(part === undefined ? '\u0000missing' : part)
    h.update('\u0000')
  }
  return h.digest('hex').slice(0, 32)
}

/** 记录留多久：太久以前的读不到，下次写回时清掉。 */
const KEEP_MS = 90 * 24 * 3600 * 1000

export class ModuleRecords<T extends { at: number }> {
  private readonly file: string

  /** module 是模块的名字，name 是这类记录的名字（比如 proofs）。 */
  constructor(store: Store, module: string, name: string) {
    this.file = join(store.dir, module, `${name}.json`)
  }

  private read(): Record<string, T> {
    if (!existsSync(this.file)) return {}
    let data: unknown
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {}
    const since = Date.now() - KEEP_MS
    return Object.fromEntries(Object.entries(data as Record<string, T>).filter(([, record]) => typeof record?.at === 'number' && record.at >= since))
  }

  /** 这个键的记录。键可能是外面传来的：只取文件里这个键自己的，不取对象原型上的东西。 */
  get(key: string): T | undefined {
    const all = this.read()
    return Object.hasOwn(all, key) ? all[key] : undefined
  }

  /** 记下一条（不是按内容得出的结论，比如会话开始时的样子）。 */
  put(key: string, record: T): void {
    const all = this.read()
    all[key] = record
    mkdirSync(join(this.file, '..'), { recursive: true })
    writeWhole(this.file, `${JSON.stringify(all, null, 1)}\n`)
  }

  /** 去掉一条：记的是一个状态（比如开着的复查），状态结束了。 */
  remove(key: string): void {
    const all = this.read()
    if (!Object.hasOwn(all, key)) return
    delete all[key]
    writeWhole(this.file, `${JSON.stringify(all, null, 1)}\n`)
  }

  /**
   * 记下按内容得出的结论。key 是开始跑之前算的内容标识，current 现在再算一次：和 key 不一样（跑的过程中内容改过）就不记，返回 false。
   */
  saveChecked(key: string, current: () => string, record: T): boolean {
    if (current() !== key) return false
    this.put(key, record)
    return true
  }
}
