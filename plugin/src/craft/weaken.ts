// 放水检查：和分叉点比，找出这次改动里可能让测试变松的地方，每一处都要在这次的改动记录里有理由。
// 两类：
//   按文件和行认出、总要理由的：删了测试文件（含改名成不认作测试的名字）、删了测试用例（改名、挪到别的文件、改名时只加了内容的不算；
//     改名时也改了原来内容的照样算，只是说成"改了名也改了内容"）、新加跳过、
//     改了测试配置、改了快照或测试数据、改了依赖、改了测试的约定（testpace.json 的命令调到的脚本、配置里写明的约定文件；
//     testpace.json 和本模块的配置本身不在这里管，见 config.ts）、
//     改了找不到使用者的测试辅助文件（只改了注释和空行的不算）。
//   按行为判断的：每个删改了内容的测试文件、每个删改了内容又有测试用到的测试辅助文件算一个单位（只改了注释和空行的不算），旧版放到新代码上跑（在一次性副本里）。
//     跑得过就不用理由（格式化、改名、挪位置）；跑不过说明这次改了它守的行为，要理由、合并前给用户过目；
//     旧版加载、编译就失败（跑不起来）、测试文件除了导入语句没改别的，是测试跟着代码改了接法，要理由，不给用户过目。
//   删改了已有测试的断言（新加的测试以外）、旧版又跑得过的：测试里的断言少了，要理由；改了的，把测试保留新版、代码换回改动前的样子跑，
//     因为改了的断言不成立而失败，说明断言是跟着代码改的（比如修 bug 时收紧），不用理由；
//     没改代码、照样通过、或者看不出是改了的断言抓到的，就是只改了测试：可能是换了写法，也可能是改松了，机器分不出来，要理由。
//   删了或放宽了清单（.testcraft/checklist/）里的条目：去掉或改了触发条件、改了怎么查，要理由，合并前给用户过目。新加条目、只加触发条件不算。
// 合并前给用户过目的几种（FOR_USER）除了理由，还要在改动记录"## 给用户过目"写一行白话；弹窗里按文件合成一项，只给白话，理由留给检查员。

import { basename, dirname } from 'node:path'
import { type Changed, contentKey, ignoredChange, onTestSide, type Snapshot } from './change.ts'
import { loosened, parseItem } from './checklist.ts'
import type { Copy } from './copy.ts'
import { ASSERTING, assertionsPerTest, codeLines, inOrder, kindOf, SKIPPING, testBodies, testNames, testSide, withoutImports } from './files.ts'
import { blobAt, diffLines, fileAt, fileNow, trackedFiles } from '../base/git.ts'
import { matchesAny } from '../base/glob.ts'
import { changedParts, type Parts, putOld, revertSet, withoutParts } from './prove.ts'
import { forUserLine, type Reason, reasonFor, type Records } from './records.ts'
import type { UserReview } from './store.ts'
import type { ConfirmItem } from '../base/confirm.ts'
import { CONFIG_PATH, TESTPACE_FILE } from './config.ts'
import { failedFiles, type Outcome, runFiles } from './run.ts'

export type SignalKind = 'deleted' | 'removedTests' | 'skip' | 'testConfig' | 'data' | 'deps' | 'contract' | 'helper' | 'behavior' | 'notRun' | 'rewritten' | 'checklist'

export const LABEL: Record<SignalKind, string> = {
  deleted: '删了测试文件',
  removedTests: '删了测试用例（含改名时也改了原来内容的）',
  skip: '让测试暂时不跑（新加了跳过）',
  testConfig: '改了测试或检查的配置',
  data: '改了快照或测试数据',
  deps: '改了依赖',
  contract: '改了测试的约定（testpace.json 的命令调到的脚本，或配置里写明的约定文件）',
  helper: '删改了测试辅助文件，又找不到用它的测试（没法按行为判断）',
  behavior: '程序的做法变了，原来的测试跟着改了（旧版测试在新代码上跑不过）',
  notRun: '测试跟着代码改了接法，旧版在新代码上跑不起来（没法按行为判断）',
  rewritten: '删改了已有测试的断言，和代码改动对不上（换了写法还是改松了，要说明）',
  checklist: '删了或放宽了清单里的条目',
}

export interface Signal {
  kind: SignalKind
  path: string
  oldPath?: string
  detail?: string
  /** 删了测试用例：哪些是删了，哪些是改了名也改了内容（原名、现名）。 */
  tests?: Removed
  /** 新加了跳过：跳过的是哪个测试（认得出时）、在第几行。给用户看的说法不带代码。 */
  skipped?: { name?: string; line: number }
  /** 程序的做法变了：旧版有几个测试跑不过（认得出时）。 */
  failing?: number
}

export interface Removed {
  deleted: string[]
  renamed: Array<[string, string]>
}

/** 删了测试文件的两种说法：辅助文件、改名成不认作测试的文件。 */
const HELPER_FILE = '是测试辅助文件'
const RENAMED_AWAY = '改名成了不认作测试的文件'

/** 这几类只认写明的路径（或以 / 结尾的目录），不认通配：删测试、改约定要一处处看得见。 */
export const STRICT: ReadonlySet<SignalKind> = new Set(['deleted', 'removedTests', 'contract', 'checklist'])

/**
 * 合并前给用户过目的几种：删测试、让测试不跑、程序的做法变了、删了或放宽了清单里的条目。用户没有技术背景，只判断得了这些（业务上的事）。
 * 其余是技术调整（改断言写法、测试配置和数据、依赖、约定、辅助文件）：理由照样必须写，不给用户过目，由检查员复查时顺带看（只提醒）。
 */
export const FOR_USER: ReadonlySet<SignalKind> = new Set(['deleted', 'removedTests', 'skip', 'behavior', 'checklist'])

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions', 'pnpm', 'workspaces', 'packageManager']
const TEST_CONFIG_FIELDS = ['jest', 'vitest', 'mocha', 'ava', 'c8', 'nyc', 'eslintConfig', 'prettier']

/** 按文件和行认出的放水。 */
export function staticSignals(s: Snapshot): Signal[] {
  const signals: Signal[] = []
  const moved = movedTests(s)
  for (const change of s.changes) {
    if (change.kind === 'record') continue
    if (change.kind === 'checklist' || change.oldKind === 'checklist') {
      const detail = checklistLoosened(s, change)
      if (detail) signals.push({ kind: 'checklist', path: change.path, ...(change.oldPath ? { oldPath: change.oldPath } : {}), detail })
      continue
    }
    const at = { path: change.path, ...(change.oldPath ? { oldPath: change.oldPath } : {}) }
    const inContract = !testSide(change.kind) && (s.contractFiles.has(change.path) || (change.oldPath !== undefined && s.contractFiles.has(change.oldPath)))
    if (change.kind === 'contract' || inContract) {
      // testpace.json 和本模块的配置本身不用写理由：它们的放松要么合并后才生效，要么要用户同意（见 config.ts），理由管不到的地方已经管住了。
      // 它们调到的脚本、配置里写明的约定文件照旧要写理由。
      if (!inContract && (change.path === TESTPACE_FILE || change.path === CONFIG_PATH)) continue
      signals.push({ kind: 'contract', ...at })
      continue
    }
    if ((change.kind === 'test' || change.kind === 'helper') && change.status === 'D') {
      signals.push({ kind: 'deleted', ...at, ...(change.kind === 'helper' ? { detail: HELPER_FILE } : {}) })
      continue
    }
    if (renamedAway(change)) {
      signals.push({ kind: 'deleted', ...at, detail: RENAMED_AWAY })
      continue
    }
    if (change.kind === 'test' && change.status !== 'A') {
      const removed = removedTests(s, change, moved)
      if (removed.deleted.length || removed.renamed.length) signals.push({ kind: 'removedTests', ...at, detail: removedDetail(removed), tests: removed })
    }
    if (change.kind === 'helper' && behaviorChanged(s, change) && helperRuns(s, change).runs.length === 0) {
      signals.push({ kind: 'helper', ...at })
    }
    if (testSide(change.kind) && change.status !== 'D') {
      const skipped = newSkips(s, change)
      if (skipped) signals.push({ kind: 'skip', ...at, detail: `第 ${skipped.line} 行：${skipped.text.slice(0, 120)}`, skipped: { line: skipped.line, ...(skipped.name ? { name: skipped.name } : {}) } })
    }
    if (change.kind === 'data' && change.status !== 'A' && changedContent(s, change)) signals.push({ kind: 'data', ...at })
    if (change.kind === 'testConfig') signals.push({ kind: 'testConfig', ...at })
    if (change.kind === 'lock') signals.push({ kind: 'deps', ...at })
    if (change.kind === 'deps') {
      if (/(^|\/)package\.json$/.test(change.path)) signals.push(...packageSignals(s, change))
      else signals.push({ kind: 'deps', ...at })
    }
  }
  return signals
}

/** 清单里的条目和分叉点比放宽了什么；新加的、没放宽的为 undefined。改坏了认不出的，当放宽。 */
function checklistLoosened(s: Snapshot, change: Changed): string | undefined {
  if (change.status === 'A') return undefined
  if (change.status === 'D' || change.kind !== 'checklist') return '删了这条'
  const from = change.oldPath ?? change.path
  const before = parseItem(from, fileAt(s.root, s.base, from) ?? '')
  if (!('item' in before)) return undefined
  const after = parseItem(change.path, fileNow(s.root, change.path) ?? '')
  if (!('item' in after)) return '改得认不出了'
  const found = loosened(before.item, after.item)
  return found.length ? found.join('，') : undefined
}

/** 改名后不再算测试（或测试这一侧）：等于删了。 */
function renamedAway(change: Changed): boolean {
  if (change.status !== 'R' || change.oldKind === undefined) return false
  if (change.oldKind === 'test') return change.kind !== 'test'
  return change.oldKind === 'helper' && !testSide(change.kind)
}

/** 这次改动后各测试文件里的测试内容：删掉的测试在这里找得到原来的内容，是改名或挪了地方，不算删。 */
function movedTests(s: Snapshot): string[][] {
  const bodies: string[][] = []
  for (const change of s.changes) {
    if (change.kind !== 'test' || change.status === 'D') continue
    for (const body of testBodies(fileNow(s.root, change.path) ?? '').values()) if (body.length) bodies.push(body)
  }
  return bodies
}

/**
 * 原来的测试内容还在某个测试里：内容一样（换行方式不同也算），或者原来的每一行都按顺序还在、只是加了内容。
 * 改名时顺手加断言、加步骤，和不改名直接往里加一样，不算删；原来的行少了或改了，照旧算删，要理由。
 */
function keptIn(body: string[], moved: string[][]): boolean {
  if (body.length === 0) return false
  const joined = body.join('')
  return moved.some(other => other.join('') === joined || inOrder(body, other))
}

/**
 * 改了的测试文件里删掉的测试：分叉点上有、现在没有这个名字，原来的内容也没有留在别的测试里。
 * 其中能和同一个文件里新加的测试配上的（两边的内容一半以上相同、至少有一条断言一样），说成改了名也改了内容；照样算删、照样给用户过目，
 * 只是说法不同：配上了就放过的话，删一个测试再写个长得像的就绕过去了。
 */
function removedTests(s: Snapshot, change: Changed, moved: string[][]): Removed {
  const before = testBodies(fileAt(s.root, s.base, change.oldPath ?? change.path) ?? '')
  const now = testBodies(fileNow(s.root, change.path) ?? '')
  const gone = [...before].filter(([name]) => !now.has(name))
  const kept = gone.filter(([, body]) => keptIn(body, moved))
  const removed = gone.filter(entry => !kept.includes(entry))
  // 新加的测试里，装着某个只改了名的测试原来内容的，不再拿来配
  const added = [...now].filter(([name, body]) => !before.has(name) && !kept.some(([, old]) => keptIn(old, [body])))
  // 这个文件里过半的测试都有的行（共用的准备代码）不算像
  const counts = new Map<string, number>()
  for (const body of before.values()) for (const line of new Set(meaningful(body))) counts.set(line, (counts.get(line) ?? 0) + 1)
  const shared = new Set([...counts].filter(([, count]) => count >= 2 && count > before.size / 2).map(([line]) => line))
  const pairs: Array<{ from: string; to: string; score: number }> = []
  for (const [from, body] of removed) {
    for (const [to, other] of added) {
      const score = likeness(body, other, shared)
      if (score >= 0.5) pairs.push({ from, to, score })
    }
  }
  pairs.sort((a, b) => b.score - a.score)
  const renamed: Array<[string, string]> = []
  for (const { from, to } of pairs) {
    if (renamed.some(([a, b]) => a === from || b === to)) continue
    renamed.push([from, to])
  }
  const paired = new Set(renamed.map(([from]) => from))
  // 照原来的先后列
  const order = [...before.keys()]
  renamed.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
  return { deleted: removed.map(([name]) => name).filter(name => !paired.has(name)), renamed }
}

/** 比像不像用的行：不止一行时去掉声明那行（去掉测试名后各个测试都差不多），再去掉只有括号、标点的行。 */
const meaningful = (body: string[]): string[] => (body.length > 1 ? body.slice(1) : body).filter(line => /[\p{L}\p{N}]/u.test(line))

/**
 * 两个测试有多像：去掉共用的行后，按顺序相同的行（最长公共子序列）占两边行数的比例，两边一起算，免得一边很短就算像。
 * 一条断言都不一样的不算像：只共用准备代码、检查的东西全换了，就是删了一个、写了个新的。
 */
function likeness(before: string[], after: string[], shared: Set<string>): number {
  const a = meaningful(before).filter(line => !shared.has(line))
  const b = meaningful(after).filter(line => !shared.has(line))
  if (!a.some(line => ASSERTING.test(line) && b.includes(line))) return 0
  let row = new Array<number>(b.length + 1).fill(0)
  for (const line of a) {
    const next = new Array<number>(b.length + 1).fill(0)
    for (let j = 0; j < b.length; j++) next[j + 1] = line === b[j] ? (row[j] as number) + 1 : Math.max(row[j + 1] as number, next[j] as number)
    row = next
  }
  return (2 * (row[b.length] as number)) / (a.length + b.length)
}

/** 列几项，多了只列前 5 个。 */
const listed = (items: string[], by: string): string => items.slice(0, 5).join(by) + (items.length > 5 ? ` 等 ${items.length} 个` : '')

function removedDetail({ deleted, renamed }: Removed): string {
  const parts: string[] = []
  if (deleted.length) parts.push(`删了：${listed(deleted.map(name => `"${name}"`), '、')}`)
  if (renamed.length) parts.push(`改了名也改了内容：${listed(renamed.map(([from, to]) => `原"${from}" → 现"${to}"`), '；')}`)
  return parts.join('；')
}

function removedSome(s: Snapshot, change: Changed): boolean {
  return (change.status === 'M' || change.status === 'R') && diffLines(s.root, s.base, change).removed.some(line => line.trim() !== '')
}

/**
 * 删改了内容，又不只是改了注释和空行：只改注释的（CrocWork 一次只改了辅助文件里的一行注释，用到它的 62 个页面测试多跑了一遍，第 16 节）
 * 不会改测试的行为，不按行为判断；找不到使用者的辅助文件也不用为此写理由（没法按行为判断才要理由，这里不用判断）。
 * 两版不只是注释和空白的行一行不差才算；认不准的语言和写法（见 codeLines）不算。
 */
function behaviorChanged(s: Snapshot, change: Changed): boolean {
  if (!removedSome(s, change)) return false
  const before = codeLines(change.oldPath ?? change.path, fileAt(s.root, s.base, change.oldPath ?? change.path) ?? '')
  const after = codeLines(change.path, fileNow(s.root, change.path) ?? '')
  return before === undefined || after === undefined || before.join('\n') !== after.join('\n')
}

const users = new WeakMap<Snapshot, Map<string, string[]>>()

/** 用到这个测试辅助文件的测试文件：正文里提到它的名字（index 这类名字取所在目录名）。testpace.json 里 ignore 的测试不算。 */
function helperUsers(s: Snapshot, helper: string): string[] {
  let cache = users.get(s)
  if (!cache) users.set(s, (cache = new Map()))
  const known = cache.get(helper)
  if (known) return known
  const stem = basename(helper).replace(/\..*$/, '')
  const name = /^(index|mod|main|__init__)$/.test(stem) ? basename(dirname(helper)) : stem
  const found = trackedFiles(s.root).filter(path => kindOf(path, s.config) === 'test' && !matchesAny(path, s.ignored) && (fileNow(s.root, path)?.includes(name) ?? false))
  cache.set(helper, found)
  return found
}

function changedContent(s: Snapshot, change: Changed): boolean {
  const lines = diffLines(s.root, s.base, change)
  return lines.added.length > 0 || lines.removed.length > 0
}

/** 新加的跳过：加上的行里有、删掉的行里没有同样一行。跳过的测试名取这一行声明的，没有就取往上最近声明的那个。 */
function newSkips(s: Snapshot, change: Changed): { line: number; text: string; name?: string } | undefined {
  const lines = diffLines(s.root, s.base, change)
  const removed = new Map<string, number>()
  for (const line of lines.removed) if (SKIPPING.test(line)) removed.set(line.trim(), (removed.get(line.trim()) ?? 0) + 1)
  for (const { line, text } of lines.added) {
    if (!SKIPPING.test(text)) continue
    const left = removed.get(text.trim()) ?? 0
    if (left > 0) {
      removed.set(text.trim(), left - 1)
      continue
    }
    const now = (fileNow(s.root, change.path) ?? '').split('\n')
    let name: string | undefined
    for (let at = line - 1; at >= 0 && name === undefined; at--) name = [...testNames(now[at] ?? '')][0]
    return { line, text: text.trim(), ...(name ? { name } : {}) }
  }
  return undefined
}

function packageSignals(s: Snapshot, change: Changed): Signal[] {
  const parse = (text: string | undefined): Record<string, unknown> => {
    try {
      return text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>)
    } catch {
      return {}
    }
  }
  const before = parse(change.status === 'A' ? undefined : fileAt(s.root, s.base, change.oldPath ?? change.path))
  const after = parse(change.status === 'D' ? undefined : fileNow(s.root, change.path))
  const differs = (field: string): boolean => JSON.stringify(before[field]) !== JSON.stringify(after[field])
  const signals: Signal[] = []
  const deps = DEPENDENCY_FIELDS.filter(differs)
  if (deps.length) signals.push({ kind: 'deps', path: change.path, detail: deps.join('、') })
  // 只看测试命令调到的脚本：改 dev、deploy 这类脚本不算改测试的约定
  const scripts = (data: Record<string, unknown>): Record<string, unknown> =>
    data.scripts && typeof data.scripts === 'object' ? (data.scripts as Record<string, unknown>) : {}
  const [was, now] = [scripts(before), scripts(after)]
  const called = [...s.contractScripts].filter(name => JSON.stringify(was[name]) !== JSON.stringify(now[name]))
  if (called.length) signals.push({ kind: 'contract', path: change.path, detail: `scripts 里的 ${called.join('、')}` })
  const config = TEST_CONFIG_FIELDS.filter(differs)
  if (config.length) signals.push({ kind: 'testConfig', path: change.path, detail: config.join('、') })
  return signals
}

/**
 * 按行为判断的单位，每个改了的文件一个：删改了内容的测试文件；删改了内容、又有测试用到的测试辅助文件。只改了注释和空行的不算。
 * 一个辅助文件让用它的测试全都失败时，只在它身上出一处，不按用它的测试逐个拆。
 */
export interface Unit {
  kind: 'test' | 'helper'
  change: Changed
  /** 这个单位换回旧版时跑哪些测试文件（新名字）。测试文件跑它自己；辅助文件见 helperRuns。 */
  runs: string[]
  /** 辅助文件：用到它的测试这次都改了，跑的是改了的测试。 */
  changedUsers?: true
}

/**
 * 辅助文件换回旧版时跑的测试：用到它、这次没改的（只换辅助文件，新测试用了它新加的东西时不会因此跑不起来）；
 * 都改了的跑改动前就有的那些（这次新加的测试在副本里换回旧版时不存在）。
 */
function helperRuns(s: Snapshot, change: Changed): { runs: string[]; changedUsers: boolean } {
  const all = helperUsers(s, change.path)
  const status = new Map(s.changes.filter(other => other.kind === 'test').map(other => [other.path, other.status]))
  const unchanged = all.filter(path => !status.has(path))
  if (unchanged.length) return { runs: unchanged, changedUsers: false }
  return { runs: all.filter(path => status.get(path) !== 'A'), changedUsers: true }
}

export function behaviorUnits(s: Snapshot): Unit[] {
  const units: Unit[] = []
  for (const change of s.changes) {
    if (change.kind === 'test' && behaviorChanged(s, change)) units.push({ kind: 'test', change, runs: [change.path] })
  }
  for (const change of s.changes) {
    if (change.kind !== 'helper' || !behaviorChanged(s, change)) continue
    const { runs, changedUsers } = helperRuns(s, change)
    if (runs.length) units.push({ kind: 'helper', change, runs, ...(changedUsers ? { changedUsers: true as const } : {}) })
  }
  return units
}

/** 在副本里把测试这一侧的文件都换回分叉点的样子。拆开找时只换组里的单位，不算单位的一直是旧版。 */
function putOldTests(s: Snapshot, copy: Copy): void {
  for (const change of s.changes) if (onTestSide(change)) putOld(s, copy, change)
}

function putNew(copy: Copy, change: Changed): void {
  copy.restore(change.path)
  if (change.oldPath) copy.restore(change.oldPath)
}

function putNewTests(s: Snapshot, copy: Copy): void {
  for (const change of s.changes) if (onTestSide(change)) putNew(copy, change)
}

/** 旧版跑一组单位时跑的测试文件：新名字 → 副本里的名字。换回了旧版的改名的测试在旧名字上：组里的单位，和不算单位的测试这一侧的改动。 */
function runsOf(s: Snapshot, units: Unit[], group: Unit[]): Map<string, string> {
  const outside = new Set(units.filter(unit => !group.includes(unit)).map(unit => unit.change))
  const renamed = new Map(s.changes.filter(change => onTestSide(change) && change.oldPath && !outside.has(change)).map(change => [change.path, change.oldPath as string]))
  return new Map(group.flatMap(unit => unit.runs).map(path => [path, renamed.get(path) ?? path]))
}

export interface BehaviorResult {
  signals: Signal[]
  problem?: string
}

/**
 * 拆开找、跑不过的再跑一次、单独看改了的断言最多跑几次（和 prove 最多改坏 12 处一样）。到了上限，没分开的按跑不过、要理由算：只会多问，不会少问。
 * 加上旧版一起跑、核对环境、改了断言的一起跑各一次，一次按行为判断最多跑 15 次。
 */
export const SPLIT_RUNS = 12

interface Budget {
  left: number
}

/** 跑一次测试的结果：过没过，跑不过的文件（新名字）和跑不过的测试在第几行，认没认出是哪几个（认不出时是全部）。 */
interface Ran {
  outcome: Outcome
  failed: Map<string, number[]>
  known: boolean
}

const PASSED: Ran = { outcome: 'pass', failed: new Map(), known: true }

/** 跑这些文件（新名字 → 副本里的名字）。 */
type RunAs = (files: Map<string, string>, label: string) => Promise<Ran>

/** 只留上一次跑不过的文件。 */
const only = (files: Map<string, string>, ran: Ran): Map<string, string> => new Map([...files].filter(([path]) => ran.failed.has(path)))

/** 按行为判断：旧版放到新代码上跑；跑得过、又改了断言的，再看改了的断言是不是跟着代码改的。 */
export async function behaviorCheck(s: Snapshot, copy: Copy, log: string, units: Unit[]): Promise<BehaviorResult> {
  if (units.length === 0) return { signals: [] }
  if (!s.filesCommand) return { signals: [], problem: 'testpace.json 里没有 files 命令，没法跑测试' }
  const command = s.filesCommand
  const timeout = s.config.timeoutSeconds * 1000
  const run: RunAs = async (files, label) => {
    const paths = [...files.values()]
    const result = await runFiles(command, paths, copy.dir, log, timeout, label)
    if (result.outcome === 'pass') return PASSED
    const found = failedFiles(result, paths)
    const named = new Map([...files].map(([path, as]) => [as, path]))
    return { outcome: result.outcome, failed: new Map([...found.files].map(([as, lines]) => [named.get(as) as string, lines])), known: found.known }
  }
  const budget: Budget = { left: SPLIT_RUNS }
  // 测试这一侧之外都没改（改动记录和清单是给人看的文字，不算）：旧版测试跑新代码就是分叉点上的样子，不用跑
  const onlyTests = s.changes.every(change => onTestSide(change) || change.kind === 'record' || change.kind === 'checklist' || ignoredChange(s, change))
  const changed = onlyTests ? { signals: [] } : await oldOnNewCode(s, copy, log, units, run, budget)
  const flagged = new Set(changed.signals.map(signal => signal.path))
  const tests = units.filter(unit => unit.kind === 'test' && !flagged.has(unit.change.path))
  const rewritten = await rewrittenAssertions(s, copy, tests, run, budget)
  return { signals: [...changed.signals, ...rewritten], ...(changed.problem ? { problem: changed.problem } : {}) }
}

interface Failing<T> {
  item: T
  /** 找到它的那一次跑的结果。 */
  ran: Ran
  /** 拆分次数到了上限，没分开跑：不知道它单独跑过不过。 */
  unsplit?: true
}

const halves = <T>(items: T[]): T[][] => [items.slice(0, Math.ceil(items.length / 2)), items.slice(Math.ceil(items.length / 2))]

/**
 * 一起跑没过的一组，分开跑，找出单独跑也不过的和它单独跑的结果。合起来不过、分开都过的（测试之间互相影响、不稳定）不算。
 * 每次只跑上一次跑不过的文件里归这一组的；上一次跑不过的文件一个也不归它的（touches）不用再看。
 * 比逐个跑省：通过的一组整个跳过；前一组过了，后一组还有几个时不用再整组跑，直接往下分。
 */
async function failingOnes<T>(
  items: T[],
  ran: Ran,
  runGroup: (group: T[], within: Ran) => Promise<Ran>,
  touches: (item: T, within: Ran) => boolean,
  budget: Budget,
  split: (items: T[]) => T[][] = halves,
): Promise<Array<Failing<T>>> {
  if (items.length === 1) return [{ item: items[0] as T, ran }]
  const live = items.filter(item => touches(item, ran))
  const groups = live.length === 1 ? [live] : split(live).filter(group => group.length > 0)
  const found: Array<Failing<T>> = []
  let earlierPassed = false
  for (const [index, group] of groups.entries()) {
    if (earlierPassed && index === groups.length - 1 && group.length > 1) {
      found.push(...(await failingOnes(group, ran, runGroup, touches, budget, split)))
      continue
    }
    if (budget.left <= 0) {
      found.push(...group.map(item => ({ item, ran, unsplit: true as const })))
      continue
    }
    budget.left--
    const result = await runGroup(group, ran)
    if (result.outcome === 'pass') earlierPassed = true
    else found.push(...(await failingOnes(group, result, runGroup, touches, budget, split)))
  }
  return found
}

/** 单位先按辅助文件、测试文件分开（一个辅助文件常让一大片测试一起失败），再对半分。 */
const unitSplit = (units: Unit[]): Unit[][] => {
  const helpers = units.filter(unit => unit.kind === 'helper')
  return helpers.length > 0 && helpers.length < units.length ? [helpers, units.filter(unit => unit.kind === 'test')] : halves(units)
}

const groupLabel = (paths: string[]): string => (paths.length === 1 ? (paths[0] as string) : `其中 ${paths.length} 个`)

/**
 * 测试文件除了导入语句和新加的测试，跟改动前一样（每行去掉首尾空白比）：旧版跑不起来只是跟着代码改了接法。
 * 期望值不一定写在断言行里（比如先赋给变量），所以不只看断言。
 */
function onlyImportsChanged(s: Snapshot, change: Changed): boolean {
  const parts = changedParts(s, change)
  const now = fileNow(s.root, change.path) ?? ''
  const own = parts ? withoutParts(now, parts, change.path) : now
  return own !== undefined && withoutImports(own) === withoutImports(fileAt(s.root, s.base, change.oldPath ?? change.path) ?? '')
}

/** 这个单位跑的文件里跑不过的（新名字）和行号。 */
const failedOf = (unit: Unit, ran: Ran): Array<[string, number[]]> => [...ran.failed].filter(([path]) => unit.runs.includes(path))

/** 跑不过的几处：认出行号的写到行（`e2e/tests/x.spec.ts:79`），最多列 5 处。 */
function places(files: Array<[string, number[]]>, lines: boolean): string {
  const all = files.flatMap(([path, at]) => (lines && at.length ? at.map(line => `${path}:${line}`) : [path]))
  return all.slice(0, 5).join('、') + (all.length > 5 ? ` 等 ${all.length} 处` : '')
}

/** 找到的单位出的信号。files：它跑不过、新版又跑得过的文件。 */
function unitSignal(s: Snapshot, { item: unit, ran, unsplit }: Failing<Unit>, files: Array<[string, number[]]>): Signal {
  const at = { path: unit.change.path, ...(unit.change.oldPath ? { oldPath: unit.change.oldPath } : {}) }
  const users = `用到它的测试共 ${unit.runs.length} 个`
  if (unsplit) return { kind: 'behavior', ...at, detail: `拆开跑的次数到了上限，没来得及单独跑它${unit.kind === 'helper' ? `；跑不过的有 ${places(files, true)}（${users}）` : ''}` }
  if (ran.outcome === 'notStarted') {
    if (unit.kind === 'test') {
      return onlyImportsChanged(s, unit.change) ? { kind: 'notRun', ...at } : { kind: 'behavior', ...at, detail: '旧版在新代码上跑不起来，这次除了导入还改了别的' }
    }
    // 用到它的测试都改了：可能是新测试用了它新加的东西，分不清，按跑不过算
    if (unit.changedUsers) return { kind: 'behavior', ...at, detail: `换回旧版后这几个跑不起来：${places(files, false)}（${users}，这次都改了，分不清是不是用了它新加的东西）` }
    return { kind: 'notRun', ...at, detail: `换回旧版后这几个跑不起来：${places(files, false)}（${users}）` }
  }
  if (unit.kind === 'helper') {
    const failing = files.reduce((sum, [, at]) => sum + Math.max(1, at.length), 0)
    return { kind: 'behavior', ...at, detail: `换回旧版后这几处跑不过：${places(files, true)}（${users}）`, failing }
  }
  const lines = files[0]?.[1] ?? []
  return lines.length ? { kind: 'behavior', ...at, detail: `旧版第 ${lines.slice(0, 5).join('、')} 行的测试跑不过`, failing: lines.length } : { kind: 'behavior', ...at }
}

/**
 * 旧版放到新代码上跑：先全部换回旧版一起跑，跑不过的几个文件再跑一次（偶发失败的不算），还不过的按单位分开找，每次只跑还不过的文件；
 * 找到的单位跑不过的文件用新版核对一次副本里的环境。
 */
async function oldOnNewCode(s: Snapshot, copy: Copy, log: string, units: Unit[], run: RunAs, budget: Budget): Promise<BehaviorResult> {
  putOldTests(s, copy)
  const all = runsOf(s, units, units)
  let ran = await run(all, '旧版测试跑新代码')
  // 跑不过的几个文件再跑一次（还是全换回旧版）：这次过了的是偶发失败（几套环境一起跑、和时间有关），不算。认出了就再跑，哪怕是全部；
  // 认不出是哪几个文件时不再跑：再跑还是认不出，往下拆时每组照样会再跑
  if (ran.outcome !== 'pass' && ran.known && budget.left > 0) {
    budget.left--
    const again = only(all, ran)
    ran = await run(again, `旧版跑不过的 ${groupLabel([...again.values()])} 再跑一次`)
  }
  if (ran.outcome === 'pass') {
    putNewTests(s, copy)
    return { signals: [] }
  }
  // 只把组里的单位换回旧版，组外的用新版
  const asOld = (group: Unit[], within: Ran): Promise<Ran> => {
    for (const unit of units) {
      if (group.includes(unit)) putOld(s, copy, unit.change)
      else putNew(copy, unit.change)
    }
    const files = only(runsOf(s, units, group), within)
    return run(files, `旧版 ${groupLabel(group.map(unit => unit.change.oldPath ?? unit.change.path))} 跑新代码（跑 ${groupLabel([...files.values()])}）`)
  }
  const touches = (unit: Unit, within: Ran): boolean => unit.runs.some(path => within.failed.has(path))
  const failed = await failingOnes(units, ran, asOld, touches, budget, unitSplit)
  putNewTests(s, copy)
  if (failed.length === 0) return { signals: [] }
  // 核对环境：找到的单位跑不过的文件用新版跑，跑不过的再跑一次；还不过的说明副本里的环境有问题，或者测试本来就不过，这几处判断不了
  const suspects = new Map(failed.flatMap(found => failedOf(found.item, found.ran)).map(([path]) => [path, path]))
  let broken = await run(suspects, `新版 ${groupLabel([...suspects.keys()])} 跑新代码（核对环境）`)
  if (broken.outcome !== 'pass' && broken.known && budget.left > 0) {
    budget.left--
    const again = only(suspects, broken)
    broken = await run(again, `新版跑不过的 ${groupLabel([...again.keys()])} 再跑一次（核对环境）`)
  }
  const signals: Signal[] = []
  for (const found of failed) {
    const files = failedOf(found.item, found.ran).filter(([path]) => !broken.failed.has(path))
    if (files.length) signals.push(unitSignal(s, found, files))
  }
  if (broken.failed.size === 0) return { signals }
  return {
    signals,
    problem: `这些文件的新版在副本里也跑不过（或者没来得及再跑一次核对），判断不了改动有没有放水：${[...broken.failed.keys()].join('、')}。先用 testpace files 确认它们在工作区里能过；能过说明副本里的环境有问题，日志：${log}`,
  }
}

/**
 * 删改了已有测试的断言、旧版在新代码上又跑得过的（新加的测试不算）：
 *   测试里的断言比改动前少了（删了断言行、挪进别处），要理由；
 *   改了断言的，测试保留新版（去掉这次新加的测试）、代码换回改动前的样子跑：
 *   因为断言不成立而失败、去掉改了的断言就不失败，断言是跟着代码改的，不用理由；其余的都要理由。
 */
async function rewrittenAssertions(s: Snapshot, copy: Copy, units: Unit[], run: RunAs, budget: Budget): Promise<Signal[]> {
  const signal = (change: Changed, detail: string): Signal => ({
    kind: 'rewritten',
    path: change.path,
    ...(change.oldPath ? { oldPath: change.oldPath } : {}),
    detail,
  })
  const signals: Signal[] = []
  const found: Array<{ change: Changed; parts: Parts; own: string; without: string }> = []
  for (const { change } of units) {
    const parts = changedParts(s, change)
    const now = fileNow(s.root, change.path) ?? ''
    const own = parts ? withoutParts(now, parts, change.path) : now
    const without = parts && withoutParts(now, parts, change.path, true)
    if (own === undefined || (parts?.assertions.length && without === undefined)) {
      signals.push(signal(change, '找不到新加的测试在哪一行，没法单独看已有的测试'))
      continue
    }
    // 两边都有的测试（按测试名）里少了的断言；删掉、改名、挪走的整个测试另外认（删了测试用例）
    const before = assertionsPerTest(fileAt(s.root, s.base, change.oldPath ?? change.path) ?? '')
    const after = assertionsPerTest(own)
    let fewer = 0
    for (const [name, count] of before) if (after.has(name)) fewer += Math.max(0, count - (after.get(name) as number))
    if (fewer > 0) signals.push(signal(change, `少了 ${fewer} 处断言`))
    else if (parts?.assertions.length) found.push({ change, parts, own, without: without as string })
  }
  if (found.length === 0) return signals
  const reverted = revertSet(s)
  if (reverted.length === 0) return [...signals, ...found.map(({ change }) => signal(change, '这次没有改代码'))]
  for (const change of reverted) putOld(s, copy, change)
  const self = (paths: string[]): Map<string, string> => new Map(paths.map(path => [path, path]))
  // 先一起跑：都通过（常见于一批文件换了写法）就不用分开跑；跑过的文件不用再看，跑不过的对半分开找，每次只跑上一次跑不过的
  for (const { change, own } of found) copy.put(change.path, own)
  const together = await run(self(found.map(({ change }) => change.path)), '旧代码上跑改了断言的测试')
  const failed =
    together.outcome === 'pass'
      ? []
      : await failingOnes(
          found,
          together,
          (group, within) => {
            const paths = [...only(self(group.map(({ change }) => change.path)), within).keys()]
            return run(self(paths), `旧代码上跑改了断言的 ${groupLabel(paths)}`)
          },
          ({ change }, within) => within.failed.has(change.path),
          budget,
        )
  for (const { change, own, without } of found) {
    copy.put(change.path, own)
    const hit = failed.find(({ item }) => item.change === change)
    const outcome = hit?.ran.outcome ?? 'pass'
    let detail: string | undefined
    if (hit?.unsplit) detail = '拆开跑的次数到了上限，没来得及单独看它'
    else if (outcome === 'assertion' && budget.left <= 0) detail = '拆开跑的次数到了上限，没来得及单独看它'
    else if (outcome === 'assertion') {
      budget.left--
      copy.put(change.path, without)
      if ((await run(self([change.path]), `旧代码上跑去掉改了的断言的 ${change.path}`)).outcome !== 'pass') detail = '换回改动前的代码，去掉改了的断言也跑不过，看不出是改了的断言抓到的'
    } else detail = outcome === 'pass' ? '换回改动前的代码它照样通过' : '换回改动前的代码它没跑到断言就失败了'
    copy.restore(change.path)
    if (detail) signals.push(signal(change, detail))
  }
  for (const change of reverted) putNew(copy, change)
  return signals
}

export interface Explained {
  signal: Signal
  reason?: Reason
  /** 要给用户过目的几种：改动记录"## 给用户过目"里盖住它的那一行。 */
  plain?: Reason
}

export function explain(signals: Signal[], records: Records): Explained[] {
  return signals.map(signal => {
    const paths = [signal.path, signal.oldPath]
    const strict = STRICT.has(signal.kind)
    const reason = reasonFor(records, paths, strict)
    const plain = FOR_USER.has(signal.kind) ? forUserLine(records, paths, strict) : undefined
    return { signal, ...(reason ? { reason } : {}), ...(plain ? { plain } : {}) }
  })
}

/** 写够了：有理由；要给用户过目的几种还要有给用户看的那一行。 */
export const settled = (item: Explained): boolean => item.reason !== undefined && (!FOR_USER.has(item.signal.kind) || item.plain !== undefined)

/** 用户看得懂的说法：看到了什么改动，一种一句。 */
export function seenOf(signal: Signal): string[] {
  const detail = signal.detail ? `（${signal.detail}）` : ''
  switch (signal.kind) {
    case 'deleted':
      if (signal.detail === RENAMED_AWAY) return ['测试文件改了名，不再当测试跑，等于删了']
      return [signal.detail === HELPER_FILE ? '删了测试用到的辅助文件' : '删了整个测试文件，里面的测试都不跑了']
    case 'removedTests': {
      const { deleted, renamed } = signal.tests ?? { deleted: [], renamed: [] }
      const seen: string[] = []
      if (renamed.length) seen.push(`${renamed.length} 个测试改了名也改了内容：${renamed.map(([from, to]) => `原"${from}" → 现"${to}"`).join('；')}`)
      if (deleted.length) seen.push(`删了 ${deleted.length} 个测试：${deleted.map(name => `"${name}"`).join('、')}`)
      return seen
    }
    case 'skip':
      return [signal.skipped?.name ? `新加了跳过，测试"${signal.skipped.name}"暂时不跑` : `新加了跳过，第 ${signal.skipped?.line} 行的测试暂时不跑`]
    case 'behavior':
      return [`旧版测试在新代码上跑不过：程序的做法变了${signal.failing ? `（有 ${signal.failing} 个测试跑不过）` : ''}`]
    case 'checklist':
      return [`删了或放宽了合并前要查的清单条目${detail}`]
    default:
      return [describe(signal)]
  }
}

/** 要给用户过目的放水，一个文件合成一项（几种改动一起列）。只在都写够了时用。 */
export function userReview(explained: Explained[]): UserReview[] {
  const byFile = new Map<string, Omit<UserReview, 'plain'> & { plain: string[] }>()
  for (const { signal, plain } of explained) {
    if (!FOR_USER.has(signal.kind) || !plain) continue
    const item = byFile.get(signal.path) ?? {
      path: signal.path,
      ...(signal.oldPath ? { oldPath: signal.oldPath } : {}),
      file: signal.oldPath ? `${signal.oldPath} → ${signal.path}` : signal.path,
      seen: [],
      plain: [],
    }
    item.seen.push(...seenOf(signal))
    if (!item.plain.includes(plain.text)) item.plain.push(plain.text)
    byFile.set(signal.path, item)
  }
  return [...byFile.values()].map(item => ({ ...item, plain: item.plain.join('；') }))
}

/** 弹窗开头说这是什么的半句（底座的用户确认接着排各项）。 */
export const REVIEW_HEADING = '这次改动里放松测试的地方'

/**
 * 交给底座的用户确认的一项（base/confirm.ts）：一个文件一项。改之前、改成什么取这个文件在分叉点上和现在的内容，
 * 给用户看的文字是看到的改动和改动记录里的说明。文件内容、看到的改动、说明，有一样变了就是另一项，要重新过目；
 * 别的文件怎么改、别的分支合进来，这一项不用再问。
 */
export function reviewItem(s: Snapshot, item: UserReview): ConfirmItem {
  return {
    before: fileAt(s.root, s.base, item.oldPath ?? item.path) ?? MISSING,
    after: fileNow(s.root, item.path) ?? MISSING,
    text: [item.file, '看到的改动：', ...item.seen.map(seen => `- ${seen}`), `说明：${item.plain}`].join('\n'),
  }
}

/** 没有这个文件（删掉了，或分叉点上还没有）。 */
const MISSING = '\u0000missing'


export function describe(signal: Signal): string {
  const where = signal.oldPath ? `${signal.oldPath} → ${signal.path}` : signal.path
  return `${LABEL[signal.kind]}：${where}${signal.detail ? `（${signal.detail}）` : ''}`
}

/**
 * 和放水有关的文件：测试这一侧、配置、依赖、约定、改动记录；withCode 时再加上旧版测试跑新代码时不换回的那些文件
 * （revertSet：代码，和文档、样式、数据这类别的文件。和实际跑的是同一批，哪个改了结论都可能变）。
 * testpace.json 里 ignore 的不在 revertSet 里，不算：项目说了它们不影响测试。
 * ignore 里测试这一侧的照样算，删它、改它照样认作放水。
 */
function relevantPaths(s: Snapshot, withCode: boolean): Set<string> {
  const paths = new Set<string>()
  const kept = withCode ? new Set(revertSet(s)) : undefined
  for (const change of s.changes) {
    const contract = s.contractFiles.has(change.path)
    // 代码和别的文件：只有跑旧版测试时它们留在新版的才算
    const plain = (change.kind === 'other' && (change.oldKind ?? 'other') === 'other') || (change.kind === 'code' && !onTestSide(change))
    if (plain && !contract && !kept?.has(change)) continue
    paths.add(change.path)
    if (change.oldPath) paths.add(change.oldPath)
  }
  return paths
}

/** 这些文件在分叉点上和现在的内容，各是什么文件、怎么改的，用哪条命令跑。不带分叉点是哪个提交（见 contentKey）。 */
function keyOf(s: Snapshot, paths: Set<string>, tag: string): string {
  const changed = s.changes.filter(c => paths.has(c.path)).map(c => [c.status, c.path, c.oldPath, c.kind, c.oldKind])
  return contentKey(s.root, s.base, paths, tag, s.filesCommand ?? '', JSON.stringify(changed))
}

/** 放水检查的结果按这份改动里相关的内容记；有要按行为判断的测试时，代码也算（旧版测试跑的是新代码）。 */
export function weakenKey(s: Snapshot): string {
  const units = behaviorUnits(s)
  const paths = relevantPaths(s, units.length > 0)
  for (const unit of units) for (const path of unit.runs) paths.add(path)
  return keyOf(s, paths, 'weaken-12')
}

/**
 * 按行为判断（behaviorCheck）跑出来的结果按什么记：和放水检查一样的那些文件，去掉改动记录和清单。
 * 跑的是测试和代码，理由和清单是给人看的文字：补一行理由、改清单的写法，这部分不用重跑，只重新对理由。
 */
export function behaviorKey(s: Snapshot, units: Unit[]): string {
  const paths = relevantPaths(s, true)
  for (const change of s.changes) {
    if (change.kind !== 'record' && change.kind !== 'checklist') continue
    paths.delete(change.path)
    if (change.oldPath) paths.delete(change.oldPath)
  }
  for (const unit of units) for (const path of unit.runs) paths.add(path)
  return keyOf(s, paths, 'behavior-1')
}

/** testFingerprint 的算法的名字：算法变了要改它，会话起点里以前记的样子就不算了（见 base/baseline.ts）。 */
export const FINGERPRINT_FORMAT = 'fingerprint-2'

/** 测试这一侧现在的样子（不含代码）：停止门用它判断这个会话有没有改过测试。 */
export function testFingerprint(s: Snapshot): string {
  return keyOf(s, relevantPaths(s, false), FINGERPRINT_FORMAT)
}
