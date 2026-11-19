// testpace focused 的选测：问 layermap 这次改动的相关测试，只从整组的测试（tests 规则找到的）里选，
// 再问选出的测试跑不跑得到每处改动，判断选得靠不靠得住。靠不住的时候不假装选准了，提示跑整组。
// layermap 按命名惯例认测试，和项目的 tests 规则不一定一致：规则排除的、规则外的练习脚本它也会给，
// 规则里不按惯例命名的它认不出。哪些算测试以 tests 规则为准，和整组一致。

import { execFileSync } from 'node:child_process'
import { commandExists } from './config.ts'

/**
 * layermap 的 rank：0 到 1 以下调用改动，1 是改动里的测试，2 直接导入改动，3 同模块或同目录，
 * 3.5 可能通过测试支持文件或类型不明的对象用到，4 间接导入。4 以下都跑；4 不选。
 * 选得准不准不看 rank，看选出的测试跑不跑得到每处改动（untested）。
 */
export const INDIRECT_RANK = 4

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
      /** 整组里间接导入改动、没选上的测试文件数。 */
      indirect: number
      /** layermap 认为相关、但不在 tests 规则里的测试文件，没选。 */
      outside: string[]
      unmapped: Array<{ path: string; kind: string }>
      incomplete: string[]
      /** 选出的测试跑不到的改动；没选出测试时为 null。 */
      untested: Untested | null
    }

export function parseCheck(text: string): LayermapCheck {
  const data = JSON.parse(text) as Partial<LayermapCheck>
  if (!Array.isArray(data.files) || !Array.isArray(data.tests) || !Array.isArray(data.unmapped) || !Array.isArray(data.incomplete)) {
    throw new Error('layermap check --json 的输出缺少 files、tests、unmapped 或 incomplete（layermap 版本太旧，要 0.1.41 以上？）')
  }
  return data as LayermapCheck
}

export function parseUntested(text: string): Untested {
  const untested = (JSON.parse(text) as { untested?: Partial<Untested> }).untested
  if (!untested || !Array.isArray(untested.changed) || typeof untested.truncated !== 'boolean') {
    throw new Error('layermap check --json 给了测试文件却没有输出 untested（layermap 版本太旧？）')
  }
  return { changed: untested.changed, truncated: untested.truncated }
}

/**
 * 从 layermap 的结果里选要跑的测试文件。suite 是整组的测试（tests 规则在工作区里找到的，和整组同一份），
 * inRules 判断路径在不在 tests 规则里（删掉的文件不在 suite 里，用它认出删掉的是不是整组的测试）。
 * 选 layermap 给的相关测试里在整组的，再加上这次改到、在整组里的测试文件（不按惯例命名的 layermap 认不出）。
 */
export function select(
  check: LayermapCheck,
  isIgnored: (path: string) => boolean,
  suite: ReadonlySet<string>,
  inRules: (path: string) => boolean,
): Selection {
  const changed = check.files.map(file => file.path)
  const related = check.tests.filter(test => test.rank < INDIRECT_RANK).map(test => test.path)
  const tests = [...new Set([...related, ...changed])].filter(path => suite.has(path))
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
    indirect: new Set(check.tests.filter(test => test.rank >= INDIRECT_RANK && suite.has(test.path) && !tests.includes(test.path)).map(test => test.path)).size,
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
 * 调 layermap 拿这次改动（相对 base）的相关测试；选出了测试，再把它们交给 layermap，
 * 问哪些改动它们跑不到。
 */
export function askLayermap(
  root: string,
  base: string,
  isIgnored: (path: string) => boolean,
  suite: ReadonlySet<string>,
  inRules: (path: string) => boolean,
): Selection {
  if (!commandExists(root, 'layermap')) return { kind: 'unavailable', reason: '找不到 layermap 命令，没法按改动选测试', missing: true }
  try {
    const selection = select(parseCheck(layermapCheck(root, base, [])), isIgnored, suite, inRules)
    if (selection.kind === 'selected' && selection.tests.length > 0) {
      selection.untested = parseUntested(layermapCheck(root, base, selection.tests))
    }
    return selection
  } catch (error) {
    return { kind: 'unavailable', reason: (error as Error).message }
  }
}

function layermapCheck(root: string, base: string, tests: string[]): string {
  try {
    return execFileSync('layermap', ['check', '--json', '--base', base, ...tests], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n').at(-1)
    throw new Error(`layermap 出错了${stderr ? `：${stderr}` : ''}`)
  }
}
