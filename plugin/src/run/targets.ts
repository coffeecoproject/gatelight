// testpace run 各框架共用：解析交给 files 的测试文件，跑完逐个文件核对有没有跑到测试。

import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { testFile } from '../store.ts'

export interface Target {
  /** 照给的写法，去掉了行号、列号。 */
  file: string
  /** 真实的绝对路径（解开符号链接），和框架报上来的路径对得上。 */
  path: string
  /** 带行号给的写法，原样。 */
  lines: string[]
}

/**
 * 解析 文件[:行号[:列号]]：路径按 base（仓库根目录）算，同一个文件只留一份；
 * 不存在、不是文件的放进 missing（框架拿到找不到的路径时常常悄悄跳过，要先查）。
 */
export function parseTargets(args: string[], base: string): { targets: Target[]; missing: string[] } {
  const byPath = new Map<string, Target>()
  const missing: string[] = []
  for (const arg of args) {
    const file = testFile(arg)
    const absolute = resolve(base, file)
    if (!isFile(absolute)) {
      if (!missing.includes(file)) missing.push(file)
      continue
    }
    const path = realpathSync(absolute)
    let target = byPath.get(path)
    if (!target) {
      target = { file, path, lines: [] }
      byPath.set(path, target)
    }
    if (file !== arg) target.lines.push(arg)
  }
  return { targets: [...byPath.values()], missing }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 一个测试跑完的记录：哪个文件，是不是被跳过。 */
export interface Ran {
  file: string
  skipped: boolean
}

/** 逐个文件核对：一个测试都没跑到的（没加载起来、里面没有测试）算失败；测试全被跳过的不算失败，但要说。 */
export function tally(targets: Target[], ran: Ran[]): { empty: Target[]; allSkipped: Target[] } {
  const counts = new Map(targets.map(target => [target.path, { ran: 0, skipped: 0 }]))
  for (const test of ran) {
    const count = counts.get(test.file)
    if (count) count[test.skipped ? 'skipped' : 'ran'] += 1
  }
  const count = (target: Target) => counts.get(target.path)!
  return {
    empty: targets.filter(target => count(target).ran + count(target).skipped === 0),
    allSkipped: targets.filter(target => count(target).ran === 0 && count(target).skipped > 0),
  }
}
