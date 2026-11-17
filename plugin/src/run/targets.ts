// testpace run 各框架共用：解析交给 files 的测试文件，跑完逐个文件核对有没有跑到测试。

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOCATED, testFile } from '../store.ts'

export interface Target {
  /** 照给的写法，去掉了行号、列号。 */
  file: string
  /** 真实的绝对路径（解开符号链接），和框架报上来的路径对得上。 */
  path: string
  /** 带行号给的：原样的写法和行号（去掉了列号）。 */
  located: Array<{ text: string; line: number }>
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
      target = { file, path, located: [], whole: false }
      byPath.set(path, target)
    }
    const location = LOCATED.exec(arg)?.[0]
    if (location === undefined) {
      target.whole = true
    } else {
      target.located.push({ text: arg, line: Number(location.split(':')[1]) })
    }
  }
  return { targets: [...byPath.values()], missing }
}

/**
 * 交给能按行跑的框架的参数：整个文件给路径，按行给 路径:行号；同一个文件也给了整个文件时只给路径，整个跑
 * （框架见到行号就只跑那几行）。path 是这个框架认的路径写法。
 */
export function selectors(targets: Target[], path: (target: Target) => string = target => target.path): string[] {
  return targets.flatMap(target => (target.whole ? [path(target)] : target.located.map(({ line }) => `${path(target)}:${line}`)))
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

/** 读插件自己的计数报告器写的报告：每行一条 Ran。报告没写出来（框架起来就出错）时返回空。 */
export function readRanLines(report: string): Ran[] {
  if (!existsSync(report)) return []
  return readFileSync(report, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Ran)
}

/**
 * 逐个文件核对：一个测试都没跑到的算失败；测试全被跳过的不算失败，但要说；
 * 框架还跑了没给的文件（按名字片段匹配到的，或给的测试依赖的准备项目）的，也要说。
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
