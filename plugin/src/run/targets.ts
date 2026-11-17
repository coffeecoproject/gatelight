// testpace run 各框架共用：解析交给 files 的测试文件，跑完逐个文件核对有没有跑到测试。

import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOCATED, testFile } from '../store.ts'

export interface Target {
  /** 照给的写法，去掉了行号、列号。 */
  file: string
  /** 真实的绝对路径（解开符号链接），和框架报上来的路径对得上。 */
  path: string
  /** 带行号给的写法，原样。 */
  located: string[]
  /** 给的行号（去掉了列号），和 located 一一对应。 */
  lines: number[]
  /** 有一次没带行号：整个文件跑。 */
  whole: boolean
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
      target = { file, path, located: [], lines: [], whole: false }
      byPath.set(path, target)
    }
    const location = LOCATED.exec(arg)?.[0]
    if (location === undefined) {
      target.whole = true
    } else {
      target.located.push(arg)
      target.lines.push(Number(location.split(':')[1]))
    }
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

/** 一个测试跑完的记录：哪个文件（绝对路径），是不是被跳过。 */
export interface Ran {
  file: string
  skipped: boolean
}

/**
 * 逐个文件核对：一个测试都没跑到的算失败；测试全被跳过的不算失败，但要说；
 * 框架顺带跑了没给的文件（比如按名字片段匹配）的，也要说。
 */
export function tally(targets: Target[], ran: Ran[]): { empty: Target[]; allSkipped: Target[]; others: string[] } {
  const counts = new Map(targets.map(target => [target.path, { ran: 0, skipped: 0 }]))
  const others = new Set<string>()
  for (const test of ran) {
    const count = counts.get(test.file)
    if (count) count[test.skipped ? 'skipped' : 'ran'] += 1
    else others.add(test.file)
  }
  const count = (target: Target) => counts.get(target.path)!
  return {
    empty: targets.filter(target => count(target).ran + count(target).skipped === 0),
    allSkipped: targets.filter(target => count(target).ran === 0 && count(target).skipped > 0),
    others: [...others],
  }
}
