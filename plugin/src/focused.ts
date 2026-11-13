// testpace focused 的选测：问 layermap 这次改动的相关测试，再问选出的测试跑不跑得到每处改动，
// 判断选得靠不靠得住。靠不住的时候不假装选准了，提示跑整组。

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
  truncated: boolean
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
      /** 只改了 ignore 路径（或什么都没改）：不用跑测试。 */
      onlyIgnored: boolean
      tests: string[]
      /** 间接导入改动、没选上的测试文件数。 */
      indirect: number
      unmapped: Array<{ path: string; kind: string }>
      truncated: boolean
      /** 选出的测试跑不到的改动；没选出测试时为 null。 */
      untested: Untested | null
    }

export function parseCheck(text: string): LayermapCheck {
  const data = JSON.parse(text) as Partial<LayermapCheck>
  if (!Array.isArray(data.files) || !Array.isArray(data.tests) || !Array.isArray(data.unmapped) || typeof data.truncated !== 'boolean') {
    throw new Error('layermap check --json 的输出缺少 files、tests、unmapped 或 truncated（layermap 版本太旧？）')
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

/** 从 layermap 的结果里选要跑的测试文件。 */
export function select(check: LayermapCheck, isIgnored: (path: string) => boolean, exists: (path: string) => boolean): Selection {
  const changed = check.files.map(file => file.path)
  const tests = check.tests.filter(test => test.rank < INDIRECT_RANK && exists(test.path)).map(test => test.path)
  return {
    kind: 'selected',
    changed,
    onlyIgnored: changed.every(isIgnored),
    tests: [...new Set(tests)],
    indirect: check.tests.filter(test => test.rank >= INDIRECT_RANK).length,
    // ignore 里的文件约定不影响测试，地图跟不到它们也无妨
    unmapped: check.unmapped.filter(file => !isIgnored(file.path)),
    truncated: check.truncated,
    untested: null,
  }
}

/**
 * 找不到 layermap 时告诉 agent 怎么补上。只在命令输出里说：插件的 bin/ 只在 Bash 工具的 PATH 里，
 * hook 进程查不到，会话开始时没法准确判断装没装。
 */
export const LAYERMAP_HINT = '装上 layermap 插件并开新会话（或把 layermap 命令加进 PATH），focused 就会只跑和改动相关的测试。'

/** 选测靠不住、应当跑整组的原因；空数组表示选测可以信。 */
export function fullReasons(selection: Selection): string[] {
  if (selection.kind === 'unavailable') return [selection.reason]
  if (selection.onlyIgnored) return []
  const reasons: string[] = []
  if (selection.unmapped.length > 0) {
    const files = selection.unmapped.slice(0, 3).map(file => `${file.path}（${file.kind}）`).join('、')
    const more = selection.unmapped.length > 3 ? ` 等 ${selection.unmapped.length} 个` : ''
    reasons.push(`改了 ${files}${more}，地图跟不到它们影响哪些测试`)
  }
  if (selection.truncated) reasons.push('改动影响的范围太大，layermap 追踪到上限就停了')
  if (selection.tests.length === 0) reasons.push('layermap 没找到和这次改动相关的测试')
  const untested = selection.untested
  if (untested && untested.changed.length > 0) {
    const names = untested.changed.slice(0, 3).join('、')
    const more = untested.changed.length > 3 ? ` 等 ${untested.changed.length} 处` : ''
    reasons.push(`选出的测试跑不到 ${names}${more}`)
  }
  // 选测时已经截断的，确认时多半也截断，不重复说
  if (untested?.truncated && !selection.truncated) reasons.push('确认选出的测试跑不跑得到改动时，layermap 追踪到上限就停了')
  return reasons
}

/**
 * 调 layermap 拿这次改动（相对 base）的相关测试；选出了测试，再把它们交给 layermap，
 * 问哪些改动它们跑不到。
 */
export function askLayermap(root: string, base: string, isIgnored: (path: string) => boolean): Selection {
  if (!commandExists(root, 'layermap')) return { kind: 'unavailable', reason: '找不到 layermap 命令，没法按改动选测试', missing: true }
  try {
    const selection = select(parseCheck(layermapCheck(root, base, [])), isIgnored, path => existsSync(join(root, path)))
    if (selection.kind === 'selected' && !selection.onlyIgnored && selection.tests.length > 0) {
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
