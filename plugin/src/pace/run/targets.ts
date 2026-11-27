// testpace run 各框架共用：解析交给 files 的测试文件，跑完逐个文件核对有没有跑到测试。

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOCATED, testFile } from '../testlist.ts'

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

/**
 * 一个测试的记录，三个框架的计数报告器都写成这样：哪个文件（真实的绝对路径）、声明在哪一行、外层各级分组（describe）声明在哪几行、名字、结果。
 * 记跑过或被跳过的；Playwright 还把选中了却没跑到的（serial 模式里前面的没过、框架提前停下）记成 notrun，
 * 核对文件和行时不算跑到（runner 先去掉），只点名。别的框架没跑到的不记。
 * 没有行号的（Vitest 没打开 includeTaskLocation 时）只能按整个文件核对。
 */
export interface Ran {
  file: string
  line?: number
  ancestors: number[]
  /** 测试名，带上外层各级分组的名字，用 > 连起来（Vitest、Playwright 的 project 有名字时前面还有 [project 名]）。认同一个测试靠它和文件。 */
  name: string
  status: 'passed' | 'failed' | 'skipped' | 'notrun'
  /** 框架重试之后才过。 */
  retried?: boolean
}

/** 读计数报告器写的报告：每行一条 Ran。没写报告（框架在选测试之前就停了）时返回 undefined。 */
export function readRanLines(report: string): Ran[] | undefined {
  if (!existsSync(report)) return undefined
  return readFileSync(report, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Ran)
}

export interface Tally {
  /** 一个测试都没跑到的：整个文件给的写文件，按行给的写原样的 文件:行号。 */
  notRun: string[]
  /** 选中的测试全被跳过的，写法同上。 */
  allSkipped: string[]
  /** 框架还跑了的没给的文件（按名字片段匹配到的，或给的测试依赖的准备项目）。 */
  others: string[]
  /** 有测试没过：没跑到的可能是框架提前停下了。 */
  failed: boolean
}

/**
 * 逐个核对给的文件和 文件:行号：整个文件给的看这个文件的测试，按行给的看这一行选中的测试
 * （测试自己声明在这一行，或它外层哪一级分组声明在这一行；三个框架按行跑都是这么选的）。
 * 一个测试都没跑到的算失败；全被跳过的不算失败，但要说。同一个文件也给了整个文件时，按行给的不另核对。
 */
export function tally(targets: Target[], ran: Ran[]): Tally {
  const byFile = new Map<string, Ran[]>(targets.map(target => [target.path, []]))
  const others = new Set<string>()
  for (const test of ran) {
    const tests = byFile.get(test.file)
    if (tests) tests.push(test)
    else others.add(test.file)
  }
  const notRun: string[] = []
  const allSkipped: string[] = []
  const check = (name: string, tests: Ran[]): void => {
    if (tests.length === 0) notRun.push(name)
    else if (tests.every(test => test.status === 'skipped')) allSkipped.push(name)
  }
  for (const target of targets) {
    const tests = byFile.get(target.path)!
    if (target.whole) {
      check(target.file, tests)
      continue
    }
    const seen = new Set<number>()
    for (const { text, line } of target.located) {
      if (seen.has(line)) continue // 同一行带列号、不带列号各给了一次
      seen.add(line)
      check(text, tests.filter(test => test.line === line || test.ancestors.includes(line)))
    }
  }
  return { notRun, allSkipped, others: [...others], failed: ran.some(test => test.status === 'failed') }
}
