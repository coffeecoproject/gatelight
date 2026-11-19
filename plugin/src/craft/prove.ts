// 新测试必须能抓错：这次新增的测试文件、往已有测试文件里加的新测试（或指定的测试文件），逐个证明。都在一次性副本里做。
//   只改了已有测试的断言、没加新测试的，不在这里证明：归放水检查（weaken.ts 的"改了已有测试的断言"）。
//   改了名、内容的每一条语句都按顺序在原来那个测试里的（只删了整条语句），也不在这里证明：归放水检查的"删了测试用例"，要理由、合并前给用户过目。
//     加了内容、改了原有的语句、删了多行语句里的一行，照旧算新的测试。
//   先在新代码上跑，必须通过。
//   证明一（回旧代码跑）：把这次改了的代码换回分叉点的样子，测试保留新版，它要因为断言不成立而失败。
//     加载失败、编译失败、找不到页面元素这类"功能还不存在"的失败不算，转证明二。
//   证明二（改坏证明）：在它守的代码上做小破坏，在新代码上跑，至少有一处被它抓到（断言不成立）。
//     守的代码：改动记录"守的代码"一段写明的位置，加上这次改了的代码行；测试里用到的函数排前面。
//   改过的已有测试文件，证明的是这次新加的测试：
//     两种证明里，去掉新加部分的版本也因断言失败的不算（是文件里原有的测试抓到的）；证明二里改动前的版本也抓得到的同样不算。
// 证明成立的按内容记下（这个测试文件、测试辅助和数据、证明一里换回旧版的那些文件、守的代码），同样的内容不再证明。
// 记录按开始证明之前的内容记：写之前再算一次，证明的过程中这些内容改过，这次的证明不记（底座的 saveChecked）。

import { type Changed, contentKey, ignoredChange, onTestSide, open, type Snapshot } from './change.ts'
import type { Copy } from './copy.ts'
import { ASSERTING, declarationLine, inOrder, statementEnd, testStatements } from './files.ts'
import { blobAt, diffLines, fileAt, fileNow } from '../base/git.ts'
import { blockOf, byRelevance, type Mutant, mutantsFor, pick, wordsOf } from './mutate.ts'
import { type Guard, readRecords, type Records } from './records.ts'
import { runFiles } from './run.ts'
import type { ProofRecord, Store } from './store.ts'

const MUTANT_LIMIT = 12

export interface Target {
  change: Changed
  why: string
  /** 改了的已有测试文件里，这次新加的测试（指定的测试文件、新文件没有）：证明的是它们能抓错，不是文件里原有的测试。 */
  parts?: Parts
}

/** 改了的测试文件里新加的部分：新的测试；新测试以外改了的断言。行号从 0 起，含首尾。 */
export interface Parts {
  fresh: Array<{ name: string; start: number; end: number }>
  assertions: Array<{ start: number; end: number }>
}

/** 要证明的测试：新增的测试文件；改了的测试文件里有新的测试（改了名、只删了整条语句的不算）。 */
export function proveTargets(s: Snapshot): Target[] {
  const targets: Target[] = []
  for (const change of s.changes) {
    if (change.kind !== 'test' || change.status === 'D') continue
    if (change.status === 'A') {
      targets.push({ change, why: '新增的测试文件' })
      continue
    }
    const parts = changedParts(s, change)
    if (!parts?.fresh.length) continue
    const names = parts.fresh.map(item => item.name)
    const why = `新的测试：${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 个` : ''}`
    targets.push({ change, why, parts })
  }
  return targets
}

/** 改了的测试文件里新加的部分；都没有时为 undefined。 */
export function changedParts(s: Snapshot, change: Changed): Parts | undefined {
  const before = fileAt(s.root, s.base, change.oldPath ?? change.path) ?? ''
  const after = fileNow(s.root, change.path) ?? ''
  const lines = after.split('\n')
  const diff = diffLines(s.root, s.base, change)
  const removed = new Set(diff.removed.map(line => line.trim()))
  // 挪了位置、改了缩进的行不算改
  const added = new Set(diff.added.filter(({ text }) => text.trim() !== '' && !removed.has(text.trim())).map(({ line }) => line - 1))
  const old = testStatements(before)
  const now = testStatements(after)
  // 这次不见了的旧测试（按名字）：改了名的测试只和它们比
  const gone = [...old].filter(([name]) => !now.has(name)).map(([, statements]) => statements)
  const fresh: Parts['fresh'] = []
  for (const [name, statements] of now) {
    if (old.has(name)) continue
    const start = declarationLine(lines, name)
    if (start < 0) {
      // 找不到声明在哪一行：算新的测试，但没法去掉它来比对
      fresh.push({ name, start, end: start })
      continue
    }
    const end = statementEnd(lines, start)
    // 改了名、内容的每一条语句都按顺序在某个不见了的旧测试里（只改了名、或者只删了整条语句）：不算新的测试，
    // 删了的部分归放水检查（删了测试用例）。加了内容、改了原有的语句、删了多行语句里的一行，都照旧算新的测试。
    if (statements.length && gone.some(was => was[0] === statements[0] && inOrder(statements, was))) {
      for (let line = start; line <= end; line++) added.delete(line)
    } else fresh.push({ name, start, end })
  }
  // 新的测试以外改了的断言（含多行断言里的一行）
  const inFresh = (line: number): boolean => fresh.some(item => line >= item.start && line <= item.end)
  const assertions: Parts['assertions'] = []
  for (let i = 0; i < lines.length; i++) {
    if (inFresh(i) || !ASSERTING.test(lines[i] as string)) continue
    const end = statementEnd(lines, i)
    if ([...added].some(line => line >= i && line <= end)) assertions.push({ start: i, end })
    i = Math.max(i, end)
  }
  return fresh.length || assertions.length ? { fresh, assertions } : undefined
}

/**
 * 去掉一部分的测试文件，行数不变：去掉新的测试；assertions 时再去掉新测试以外改了的断言（Python 留一个 pass，块不会空）。
 * 证明里拿来比对"是不是文件里原有的测试抓到的"，放水检查里拿来看"是不是改了的断言抓到的"。
 * 找不到新测试在哪一行时为 undefined。
 */
export function withoutParts(text: string, parts: Parts, path: string, assertions = false): string | undefined {
  if (parts.fresh.some(item => item.start < 0)) return undefined
  const lines = text.split('\n')
  const blank = (start: number, end: number, keep?: string): void => {
    for (let i = start; i <= end; i++) lines[i] = i === start && keep !== undefined ? `${(/^\s*/.exec(lines[i] as string) as RegExpExecArray)[0]}${keep}` : ''
  }
  for (const item of parts.fresh) blank(item.start, item.end)
  if (assertions) for (const item of parts.assertions) blank(item.start, item.end, path.endsWith('.py') ? 'pass' : undefined)
  return lines.join('\n')
}

/** 指定的测试文件（比如删多余测试前，确认剩下的照样能抓错）。 */
export function namedTargets(s: Snapshot, paths: string[]): Target[] | { problem: string } {
  const targets: Target[] = []
  for (const path of paths) {
    const change = s.changes.find(item => item.path === path)
    if (change?.status === 'D' || fileNow(s.root, path) === undefined) return { problem: `${path} 不存在` }
    const ownChange: Changed = change ?? { status: 'M', path, kind: 'test' }
    targets.push({ change: ownChange, why: '指定的测试' })
  }
  return targets
}

/** 证明一要换回旧版的文件：这次改了的、不属于测试这一侧，也不是依赖、测试配置和测试约定的。 */
export function revertSet(s: Snapshot): Changed[] {
  return s.changes.filter(
    change =>
      !onTestSide(change) &&
      !ignoredChange(s, change) &&
      !['deps', 'lock', 'testConfig', 'contract', 'record'].includes(change.kind) &&
      !s.contractFiles.has(change.path),
  )
}

/**
 * 证明记录的 key：这个测试文件、改了的测试辅助文件和测试数据、证明一里换回旧版的那些文件（revertSet，和实际换的是同一批）、守的代码。
 * 别的测试文件不算，改了不用重证。文档这类不影响测试的文件，项目写进 testpace.json 的 ignore 就不换回、也不算。
 */
export function proofKey(s: Snapshot, target: Target, guards: Guard[]): string {
  const paths = new Set<string>([target.change.path])
  const reverted = revertSet(s)
  for (const change of s.changes) {
    const support = [change.kind, change.oldKind].some(kind => kind === 'helper' || kind === 'data')
    if (support || reverted.includes(change)) paths.add(change.path)
  }
  for (const guard of guards) paths.add(guard.path)
  return contentKey(s.root, s.base, paths, 'prove-5', JSON.stringify(guards.map(g => [g.test, g.path, g.name])))
}

/** 这个测试现在的证明记录的 key：重新看一遍改动和改动记录。写记录之前核对用；看不了时为空（对不上任何 key）。 */
export function currentProofKey(root: string, target: Target): string {
  const opened = open(root)
  if ('problem' in opened) return ''
  const s = opened.snapshot
  const change = s.changes.find(item => item.path === target.change.path) ?? target.change
  return proofKey(s, { ...target, change }, guardsFor(readRecords(s.root, s.changes), target))
}

export function guardsFor(records: Records, target: Target): Guard[] {
  return records.guards.filter(guard => guard.test === undefined || guard.test === target.change.path)
}

export type Verdict =
  | { kind: 'proven'; record: ProofRecord; cached: boolean }
  | { kind: 'failsAfter'; log: string }
  /** 证明成立，但证明的过程中这个测试、它守的代码或改动记录改过：这次的证明不是现在这份内容的，没记。 */
  | { kind: 'moved' }
  | { kind: 'unproven'; revert?: string; tried: string[]; shared: string[]; invalid: number; noCode?: string }

/** 各个测试的证明记录的 key，按现在的内容算。要在建副本之前算：证明是在副本上做的，记录按那时的内容记。 */
export function proofKeys(s: Snapshot, records: Records, targets: Target[]): Map<Target, string> {
  return new Map(targets.map(target => [target, proofKey(s, target, guardsFor(records, target))]))
}

/** 已有证明记录的，直接给结论；剩下的要在副本里证明。 */
export function cachedVerdicts(store: Store, keys: Map<Target, string>): Map<Target, Verdict> {
  const verdicts = new Map<Target, Verdict>()
  for (const [target, key] of keys) {
    const cached = store.proofs.get(key)
    if (cached) verdicts.set(target, { kind: 'proven', record: cached, cached: true })
  }
  return verdicts
}

/** 证明这些测试（不含已有记录的）。副本由调用方建好，结束时副本里是新代码。keys 是建副本之前算的（proofKeys）。 */
export async function prove(
  s: Snapshot,
  store: Store,
  copy: Copy,
  records: Records,
  targets: Target[],
  log: string,
  keys: Map<Target, string>,
): Promise<Map<Target, Verdict>> {
  const verdicts = new Map<Target, Verdict>()
  const timeout = s.config.timeoutSeconds * 1000
  const command = s.filesCommand as string
  const run = (target: Target, label: string) => runFiles(command, [target.change.path], copy.dir, log, timeout, label)
  /** 把测试文件换成另一个版本跑一次，再换回来。 */
  const runAs = async (target: Target, text: string, label: string) => {
    copy.put(target.change.path, text)
    const result = await run(target, label)
    copy.restore(target.change.path)
    return result.outcome
  }

  // 新代码上必须通过
  const open: Target[] = []
  for (const target of targets) {
    if ((await run(target, `新代码上跑 ${target.change.path}`)).outcome === 'pass') open.push(target)
    else verdicts.set(target, { kind: 'failsAfter', log })
  }

  // 改了的已有测试文件：拿来比对的版本（去掉这次新加的部分；改动前的版本），在新代码上能过的才用
  const baselines = new Map<Target, { without?: string; old?: string }>()
  for (const target of open) {
    if (!target.parts) continue
    const path = target.change.path
    const now = fileNow(s.root, path)
    const without = withoutParts(now ?? '', target.parts, path)
    const old = fileAt(s.root, s.base, target.change.oldPath ?? path)
    const usable: { without?: string; old?: string } = {}
    if (without !== undefined && without !== now && (await runAs(target, without, `去掉新加部分的 ${path} 跑新代码（比对用）`)) === 'pass') usable.without = without
    if (old !== undefined && old !== now && old !== without && (await runAs(target, old, `旧版 ${path} 跑新代码（比对用）`)) === 'pass') usable.old = old
    baselines.set(target, usable)
  }

  const done = (target: Target, method: ProofRecord['method'], detail: string, missed: string[] = []): void => {
    const record: ProofRecord = { test: target.change.path, method, detail, ...(missed.length ? { missed } : {}), at: Date.now() }
    // 按建副本之前的内容记；这期间内容改过的不记
    const saved = store.proofs.saveChecked(keys.get(target) as string, () => currentProofKey(s.root, target), record)
    verdicts.set(target, saved ? { kind: 'proven', record, cached: false } : { kind: 'moved' })
  }

  // 证明一：回旧代码跑。文件里原有的测试（去掉新加部分的版本）也因断言失败的，不算新加的部分抓到的
  const reverted = revertSet(s)
  const revertNotes = new Map<Target, string>()
  if (open.length && reverted.length) {
    for (const change of reverted) putOld(s, copy, change)
    for (const target of open) {
      const result = await run(target, `旧代码上跑 ${target.change.path}`)
      const without = baselines.get(target)?.without
      if (result.outcome === 'assertion') {
        if (without !== undefined && (await runAs(target, without, `旧代码上跑去掉新加部分的 ${target.change.path}`)) === 'assertion') {
          revertNotes.set(target, '换回改动前的代码后，文件里原有的测试也因断言失败（不是这次新加的部分抓到的）')
        } else done(target, 'revert', '换回改动前的代码后，它因为断言不成立而失败')
      } else revertNotes.set(target, result.outcome === 'pass'
            ? '换回改动前的代码后它照样通过'
            : result.outcome === 'notStarted'
              ? '换回改动前的代码后它没跑起来（加载或编译失败）'
              : '换回改动前的代码后它没跑到断言就失败了（功能还不存在）')
    }
    for (const change of reverted) {
      copy.restore(change.path)
      if (change.oldPath) copy.restore(change.oldPath)
    }
  }

  // 证明二：改坏证明。改过的已有测试文件：同一处破坏，比对用的版本也抓得到的不算，换下一处
  for (const target of open) {
    if (verdicts.has(target)) continue
    const revert = revertNotes.get(target)
    const mutants = candidates(s, target, guardsFor(records, target), reverted)
    if ('noCode' in mutants) {
      verdicts.set(target, { kind: 'unproven', ...(revert ? { revert } : {}), tried: [], shared: [], invalid: 0, noCode: mutants.noCode })
      continue
    }
    const path = target.change.path
    const compare = Object.entries(baselines.get(target) ?? {}) as Array<[string, string]>
    const tried: string[] = []
    const shared: string[] = []
    let invalid = 0
    let proven = false
    for (const mutant of mutants.list) {
      const where = `${mutant.path}:${mutant.line} 把 ${mutant.before} 改成 ${mutant.after}`
      copy.put(mutant.path, mutant.text)
      const result = await run(target, `改坏 ${where}，跑 ${path}`)
      let byOthers = false
      if (result.outcome === 'assertion') {
        for (const [which, text] of compare) {
          const label = which === 'old' ? `改坏 ${where}，跑旧版 ${path}` : `改坏 ${where}，跑去掉新加部分的 ${path}`
          if ((await runAs(target, text, label)) === 'assertion') {
            byOthers = true
            break
          }
        }
      }
      copy.restore(mutant.path)
      if (result.outcome === 'assertion' && !byOthers) {
        done(target, 'mutant', `${where}，它发现了`, tried)
        proven = true
        break
      }
      if (byOthers) shared.push(where)
      else if (result.outcome === 'pass') tried.push(where)
      else invalid++
    }
    if (!proven) verdicts.set(target, { kind: 'unproven', ...(revert ? { revert } : {}), tried, shared, invalid })
  }
  return verdicts
}

/** 副本里把这个文件换回分叉点的样子。 */
export function putOld(s: Snapshot, copy: Copy, change: Changed): void {
  if (change.status === 'A') copy.put(change.path, undefined)
  else if (change.status === 'R') {
    copy.put(change.path, undefined)
    copy.put(change.oldPath as string, blobAt(s.root, s.base, change.oldPath as string))
  } else copy.put(change.path, blobAt(s.root, s.base, change.path))
}

/**
 * 改坏的候选，按先后：改动记录写明的守的代码；这次改了的代码行里、测试用到的函数里的；其余改了的代码行。
 * 同一档里和测试名字像的文件排前面；同一段代码里，和测试用到的词对得上的行排前面。
 */
function candidates(s: Snapshot, target: Target, guards: Guard[], reverted: Changed[]): { list: Mutant[] } | { noCode: string } {
  const groups: Array<{ path: string; lines: number[] }> = []
  const problems: string[] = []
  for (const guard of guards) {
    const text = fileNow(s.root, guard.path)
    if (text === undefined) {
      problems.push(`改动记录里写的 ${guard.path} 不存在`)
      continue
    }
    if (!guard.name) {
      groups.push({ path: guard.path, lines: text.split('\n').map((_, index) => index + 1) })
      continue
    }
    const block = blockOf(text, guard.name)
    if (block) groups.push({ path: guard.path, lines: block })
    else problems.push(`在 ${guard.path} 里没找到 ${guard.name}`)
  }
  const code = sortBySimilarity(
    reverted.filter(change => change.kind === 'code' && change.status !== 'D'),
    target.change.path,
  )
  const used = identifiers(fileNow(s.root, target.change.path) ?? '')
  const rest: typeof groups = []
  for (const change of code) {
    const text = fileNow(s.root, change.path) ?? ''
    const changed = diffLines(s.root, s.base, change).added.map(({ line }) => line)
    const inUsed = new Set<number>()
    for (const name of used) {
      if (!text.includes(name)) continue
      for (const line of blockOf(text, name) ?? []) inUsed.add(line)
    }
    groups.push({ path: change.path, lines: changed.filter(line => inUsed.has(line)) })
    rest.push({ path: change.path, lines: changed.filter(line => !inUsed.has(line)) })
  }
  groups.push(...rest)
  const words = wordsOf(provedText(fileNow(s.root, target.change.path) ?? '', target.parts))
  const mutantGroups = groups.flatMap(group => {
    const text = fileNow(s.root, group.path) ?? ''
    return byRelevance(mutantsFor(group.path, text, group.lines), text, words)
  })
  const list = pick(mutantGroups, MUTANT_LIMIT)
  if (list.length) return { list }
  const why = problems.length
    ? problems.join('；')
    : guards.length
      ? `在守的代码${code.length ? '和这次改了的代码行' : ''}里没找到能改坏的地方`
      : code.length
        ? '这次改了的代码行里没有能改坏的地方'
        : '这次没有代码改动，改动记录的"守的代码"一段也没写这个测试守的是哪段代码'
  return { noCode: why }
}

/** 要证明的那部分测试：改了的已有测试文件只取新加的测试和改了的断言，别的取整个文件。用来在守的代码里先挑和它有关的行。 */
export function provedText(text: string, parts: Parts | undefined): string {
  if (!parts) return text
  const lines = text.split('\n')
  const ranges = [...parts.fresh, ...parts.assertions].filter(({ start }) => start >= 0)
  return ranges.map(({ start, end }) => lines.slice(start, end + 1).join('\n')).join('\n')
}

/** 测试里出现的名字（函数、方法），用来找它守的代码。 */
function identifiers(text: string): Set<string> {
  const names = new Set<string>()
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]{2,})\s*\(/g)) names.add(match[1] as string)
  for (const word of ['test', 'describe', 'expect', 'assert', 'equal', 'function', 'require', 'import', 'async', 'await', 'return']) names.delete(word)
  return names
}

function sortBySimilarity(changes: Changed[], test: string): Changed[] {
  const words = (path: string): Set<string> =>
    new Set(
      path
        .toLowerCase()
        .replace(/\.(test|spec)\./, '.')
        .split(/[^a-z0-9]+/)
        .filter(word => word.length > 2 && !['src', 'lib', 'test', 'tests', 'spec', 'index', 'mjs', 'cjs', 'tsx', 'jsx'].includes(word)),
    )
  const mine = words(test)
  const score = (change: Changed): number => [...words(change.path)].filter(word => mine.has(word)).length
  return [...changes].sort((a, b) => score(b) - score(a))
}
