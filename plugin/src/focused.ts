// testpace focused 的选测：问 layermap 这次改动的相关测试，判断选得靠不靠得住。
// 靠不住的时候不假装选准了，提示跑整组（方案 5.1）。

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { commandExists } from './config.ts'

/** rank 0–3：调用改动、改动里的测试、同模块或同目录的测试。4 是间接导入改动的文件，不选。 */
export const MAX_RANK = 3

/** layermap check --json 里 testpace 用到的部分。 */
export interface LayermapCheck {
  files: Array<{ path: string; status: string }>
  tests: Array<{ path: string; rank: number; why: string }>
  unmapped: Array<{ path: string; kind: string }>
  truncated: boolean
}

export type Selection =
  | { kind: 'unavailable'; reason: string }
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
    }

export function parseCheck(text: string): LayermapCheck {
  const data = JSON.parse(text) as Partial<LayermapCheck>
  if (!Array.isArray(data.files) || !Array.isArray(data.tests) || !Array.isArray(data.unmapped) || typeof data.truncated !== 'boolean') {
    throw new Error('layermap check --json 的输出缺少 files、tests、unmapped 或 truncated（layermap 版本太旧？）')
  }
  return data as LayermapCheck
}

/** 从 layermap 的结果里选要跑的测试文件。 */
export function select(check: LayermapCheck, isIgnored: (path: string) => boolean, exists: (path: string) => boolean): Selection {
  const changed = check.files.map(file => file.path)
  const tests = check.tests.filter(test => test.rank <= MAX_RANK && exists(test.path)).map(test => test.path)
  return {
    kind: 'selected',
    changed,
    onlyIgnored: changed.every(isIgnored),
    tests: [...new Set(tests)],
    indirect: check.tests.filter(test => test.rank > MAX_RANK).length,
    unmapped: check.unmapped,
    truncated: check.truncated,
  }
}

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
  return reasons
}

/** 调 layermap 拿这次改动（相对 base）的相关测试。 */
export function askLayermap(root: string, base: string, isIgnored: (path: string) => boolean): Selection {
  if (!commandExists(root, 'layermap')) return { kind: 'unavailable', reason: '找不到 layermap 命令，没法按改动选测试' }
  let output: string
  try {
    output = execFileSync('layermap', ['check', '--json', '--base', base], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n').at(-1)
    return { kind: 'unavailable', reason: `layermap 出错了${stderr ? `：${stderr}` : ''}` }
  }
  try {
    return select(parseCheck(output), isIgnored, path => existsSync(join(root, path)))
  } catch (error) {
    return { kind: 'unavailable', reason: (error as Error).message }
  }
}
