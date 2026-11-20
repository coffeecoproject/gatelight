// testpace focused 的选测：问 layermap 这次改动的相关测试，只从整组的测试（tests 规则找到的）里选，
// 再问选出的测试跑不跑得到每处改动，判断选得靠不靠得住。靠不住的时候不假装选准了，提示跑整组。
// layermap 按命名惯例认测试，和项目的 tests 规则不一定一致：规则排除的、规则外的练习脚本它也会给，
// 规则里不按惯例命名的它认不出。哪些算测试以 tests 规则为准，和整组一致。

import { layermap, type LayermapFailure, tooOld } from '../base/layermap.ts'

/**
 * layermap 的 rank：0 到 1 以下调用改动，1 是改动里的测试，2 直接导入改动，3 同模块或同目录，
 * 3.5 可能通过测试支持文件或类型不明的对象用到，4 间接导入。
 * 在默认分支上 4 以下都跑（INDIRECT_RANK）。在分支上只跑直接相关的，3 以下（NEARBY_RANK）：同模块、同目录、
 * 可能经支持文件用到的那些常常是小半个整组，留给合回默认分支时的整组——开发要轻，合并兜底。
 * 在分支上还有个数上限（BRANCH_CAP）：这次改到的测试都跑，其余相关的按 rank 从近到远最多再跑这么多个文件。
 * 测试都经接口、页面去测的项目里，"请求了改动波及的接口"的测试很多只是拿那个接口造数据，一次能选中大半个整组。
 * 选得准不准不看 rank，看选出的测试跑不跑得到每处改动（untested）。
 */
export const INDIRECT_RANK = 4
export const NEARBY_RANK = 3
export const BRANCH_CAP = 8

/** layermap check --json 里 testpace 用到的部分。 */
export interface LayermapCheck {
  files: Array<{ path: string; status: string }>
  tests: Array<{ path: string; rank: number; why: string }>
  unmapped: Array<{ path: string; kind: string }>
  /** 检查自己没做完的地方（追踪到上限、搜索超时、路径读不了等），漏掉的测试可能就在那里。layermap 0.1.41 起。 */
  incomplete: string[]
}

/** layermap check --json 给了测试文件时：这些测试跑不到的改动。 */
export interface Untested {
  changed: string[]
  truncated: boolean
}

export type Selection =
  /** missing：PATH 里没有 layermap 命令（不是它出错）。 */
  | { kind: 'unavailable'; reason: string; missing?: true }
  | {
      kind: 'selected'
      changed: string[]
      /** 改动只涉及 ignore 路径和整组不跑的测试（规则外的、删掉的），也没有整组的测试和它们相关：不用跑测试。 */
      nothingToTest: boolean
      tests: string[]
      /** 整组里和改动有关、却没选上的测试文件数（间接导入的；在分支上还有同模块、同目录的，和超出个数上限的）。 */
      indirect: number
      /** layermap 认为相关、但不在 tests 规则里的测试文件，没选。 */
      outside: string[]
      unmapped: Array<{ path: string; kind: string }>
      incomplete: string[]
      /** 选出的测试跑不到的改动；没选出测试时为 null。 */
      untested: Untested | null
    }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 从 layermap check --json 的输出里读选测要的部分；缺字段（layermap 版本太旧）返回 undefined。 */
export function parseCheck(value: unknown): LayermapCheck | undefined {
  if (!isRecord(value)) return undefined
  if (!Array.isArray(value.files) || !Array.isArray(value.tests) || !Array.isArray(value.unmapped) || !Array.isArray(value.incomplete)) return undefined
  return value as unknown as LayermapCheck
}

/** 给了测试文件时输出里的 untested；没有（layermap 版本太旧）返回 undefined。 */
export function parseUntested(value: unknown): Untested | undefined {
  const untested = isRecord(value) ? value.untested : undefined
  if (!isRecord(untested) || !Array.isArray(untested.changed) || typeof untested.truncated !== 'boolean') return undefined
  return { changed: untested.changed as string[], truncated: untested.truncated }
}

/**
 * 从 layermap 的结果里选要跑的测试文件。suite 是整组的测试（tests 规则在工作区里找到的，和整组同一份），
 * inRules 判断路径在不在 tests 规则里（删掉的文件不在 suite 里，用它认出删掉的是不是整组的测试）。
 * 选 layermap 给的相关测试里在整组的，再加上这次改到、在整组里的测试文件（不按惯例命名的 layermap 认不出）。
 * limit 是选到哪一档为止（不含）：默认分支上是 INDIRECT_RANK，分支上是 NEARBY_RANK。
 * cap 是这次改到的测试以外最多再选几个文件（按 rank 从近到远）：默认分支上不限，分支上是 BRANCH_CAP。
 */
export function select(
  check: LayermapCheck,
  isIgnored: (path: string) => boolean,
  suite: ReadonlySet<string>,
  inRules: (path: string) => boolean,
  limit: number = INDIRECT_RANK,
  cap: number = Infinity,
): Selection {
  const changed = check.files.map(file => file.path)
  const related = check.tests.filter(test => test.rank < limit).map(test => test.path)
  // 这次改到的测试都跑；其余相关的按 rank 从近到远（同一档照 layermap 给的顺序），最多 cap 个
  const mine = new Set(changed.filter(path => suite.has(path)))
  const nearest = [...check.tests]
    .filter(test => test.rank < limit && suite.has(test.path) && !mine.has(test.path))
    .sort((a, b) => a.rank - b.rank)
    .map(test => test.path)
  const kept = new Set([...mine, ...[...new Set(nearest)].slice(0, cap)])
  const tests = [...new Set([...related, ...changed])].filter(path => kept.has(path))
  const outside = [...new Set(related.filter(path => !suite.has(path)))]
  // 整组不跑的测试的改动，和 ignore 路径一样不用测：layermap 当成测试、规则又不收的（规则排除的测试、练习脚本），
  // 和删掉的整组测试（layermap 不列删掉的文件）
  const notRun = new Set([
    ...check.tests.filter(test => !suite.has(test.path)).map(test => test.path),
    ...check.files.filter(file => file.status === 'DELETED' && inRules(file.path)).map(file => file.path),
  ])
  return {
    kind: 'selected',
    changed,
    nothingToTest: tests.length === 0 && changed.every(path => isIgnored(path) || notRun.has(path)),
    tests,
    indirect: new Set(check.tests.filter(test => suite.has(test.path) && !kept.has(test.path)).map(test => test.path)).size,
    outside,
    // ignore 里的文件约定不影响测试，地图跟不到它们也无妨
    unmapped: check.unmapped.filter(file => !isIgnored(file.path)),
    incomplete: check.incomplete,
    untested: null,
  }
}

/**
 * 找不到 layermap 时告诉 agent 怎么补上。只在命令输出里说：插件的 bin/ 只在 Bash 工具的 PATH 里，
 * hook 进程查不到，会话开始时没法准确判断装没装。
 */
export const LAYERMAP_HINT = '装上 layermap 插件并开新会话（或把 layermap 命令加进 PATH），focused 就会只跑和改动相关的测试。'

/** 列出前几个，多的说一共几个：a、b、c 等 5 个。 */
export function someOf(items: string[], unit: string, shown = 3): string {
  const more = items.length > shown ? ` 等 ${items.length} ${unit}` : ''
  return `${items.slice(0, shown).join('、')}${more}`
}

/** layermap 认为相关、但不在 tests 规则里的测试：点出是哪几个，让 agent 判断是不是规则漏了。没有时为 undefined。 */
export function outsideNote(selection: Selection): string | undefined {
  if (selection.kind !== 'selected' || selection.outside.length === 0) return undefined
  return `不在 tests 规则里、没选的：${someOf(selection.outside, '个')}。是测试的话整组永远跑不到它，该补进 tests 规则；练习脚本、有意排除的不用管。`
}

/** 选测靠不住、应当跑整组的原因；空数组表示选测可以信。 */
export function fullReasons(selection: Selection): string[] {
  if (selection.kind === 'unavailable') return [selection.reason]
  if (selection.nothingToTest) return []
  const reasons: string[] = []
  if (selection.unmapped.length > 0) {
    reasons.push(`改了 ${someOf(selection.unmapped.map(file => `${file.path}（${file.kind}）`), '个')}，地图跟不到它们影响哪些测试`)
  }
  if (selection.incomplete.length > 0) reasons.push(`layermap 这次检查没做完，可能漏选测试：${selection.incomplete.join('；')}`)
  if (selection.tests.length === 0) {
    const outside = selection.outside.length ? `（它找到的 ${selection.outside.length} 个都不在 tests 规则里，见上）` : ''
    reasons.push(`layermap 没找到和这次改动相关的测试${outside}`)
  }
  const untested = selection.untested
  if (untested && untested.changed.length > 0) {
    reasons.push(`选出的测试跑不到 ${someOf(untested.changed, '处')}`)
  }
  // 选测时已经没做完的，确认时多半也一样，不重复说
  if (untested?.truncated && selection.incomplete.length === 0) reasons.push('确认选出的测试跑不跑得到改动时，layermap 追踪到上限就停了')
  return reasons
}

/**
 * 问 layermap 这次改动（相对 base）的相关测试；选出了测试，再把它们交给 layermap，问哪些改动它们跑不到。
 * 调 layermap 走底座的那一处（base/layermap.ts）。拿不到事实（找不到命令、它出错、版本太旧）就是选不了，退回建议跑整组。
 */
export function askLayermap(
  root: string,
  base: string,
  isIgnored: (path: string) => boolean,
  suite: ReadonlySet<string>,
  inRules: (path: string) => boolean,
  limit: number = INDIRECT_RANK,
  cap: number = Infinity,
): Selection {
  const unavailable = (failure: LayermapFailure): Selection =>
    failure.kind === 'missing' ? { kind: 'unavailable', reason: '找不到 layermap 命令，没法按改动选测试', missing: true } : { kind: 'unavailable', reason: failure.problem }
  const args = ['check', '--json', '--base', base]
  const first = layermap(root, args)
  if (!first.ok) return unavailable(first)
  const check = parseCheck(first.value)
  if (!check) return unavailable(tooOld())
  const selection = select(check, isIgnored, suite, inRules, limit, cap)
  if (selection.kind === 'selected' && selection.tests.length > 0) {
    const second = layermap(root, [...args, ...selection.tests])
    if (!second.ok) return unavailable(second)
    const untested = parseUntested(second.value)
    if (!untested) return unavailable(tooOld())
    selection.untested = untested
  }
  return selection
}
