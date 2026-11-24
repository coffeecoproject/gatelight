// 读 LayerMap 输出里 modwall 要的事实：规则代码只用这里给出的事实。命令经底座跑（base/layermap.ts）：
// 找命令、版本下限、出了问题怎么说都在那一处；这里读不到要的字段，就按版本太旧说。
// LayerMap 用不了时检查算没做完，不算通过（check.ts）。

import { layermap, LAYERMAP_COMMAND, LAYERMAP_MINIMUM, tooOld } from '../base/layermap.ts'

const TOO_OLD = tooOld().problem
const MISSING = `没找到 layermap 命令：modwall 用 LayerMap 读代码里的 import，要装 LayerMap 插件（${LAYERMAP_MINIMUM} 以上），开新会话后在 Bash 里再跑；${LAYERMAP_COMMAND}`

/** 一条对上了项目文件的 import。 */
export interface ImportFact {
  from: string
  line: number
  to: string
  specifier: string
}

/** 一条没对上项目文件的 import。possiblyOwn：可能是项目自己的（路径或别名没对上、地图里没有、只做了语法解析），要列为"没检查到"。 */
export interface UnresolvedFact {
  from: string
  line: number
  specifier: string
  reason: string
  possiblyOwn: boolean
}

export interface ProjectImports {
  imports: ImportFact[]
  unresolved: UnresolvedFact[]
}

/** 这次改动（和分叉点比）增删的关系。 */
export interface ChangeFacts {
  /** 新增和删除的 import（含转导出、require）。 */
  imports: Array<{ from: string; to: string; line: number; change: 'ADDED' | 'REMOVED' }>
  /** 新增的调用：调用指向声明所在的文件。exported：那个声明是不是文件顶层的导出。 */
  calls: Array<{ from: string; line: number; to: string; declaration: string; exported: boolean }>
  /** 被改动的已有声明。exported：是不是文件顶层的导出。 */
  declarations: Array<{ path: string; declaration: string; line: number; exported: boolean }>
  /** 改动的声明太多，有的没列出来（R4 的提示可能不全）。 */
  edgesTruncated: boolean
  /** LayerMap 标明没看全的地方：检查的结果被截断、检查本身没做完的、它不跟的改动文件。 */
  truncated: boolean
  incomplete: string[]
  unmapped: Array<{ path: string; kind: string }>
}

export type Result<T> = { ok: true; value: T } | { ok: false; problem: string }

/** 外部包和语言自带的库：忽略。其余原因（含以后新加的）都当成可能是项目自己的。 */
const EXTERNAL = new Set(['OUTSIDE_SOURCE_CONTEXT', 'DECLARATION_NOT_AVAILABLE', 'COMPILER_LIBRARY'])

function run(root: string, args: string[]): Result<unknown> {
  const answer = layermap(root, args)
  if (answer.ok) return answer
  if (answer.kind === 'missing') return { ok: false, problem: MISSING }
  return { ok: false, problem: answer.kind === 'failed' ? `layermap ${args.join(' ')}：${answer.problem}` : answer.problem }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): value is string => typeof value === 'string'
const num = (value: unknown): value is number => typeof value === 'number'
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(str)

/** 数组里每一项都合格才算；有一项缺字段就当版本不对。 */
function list<T>(value: unknown, item: (row: Record<string, unknown>) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rows: T[] = []
  for (const row of value) {
    const parsed = isRecord(row) ? item(row) : undefined
    if (parsed === undefined) return undefined
    rows.push(parsed)
  }
  return rows
}

/** 项目现有的全部 import（含未提交的改动；来源是测试文件的不在其中）。 */
export function readImports(root: string): Result<ProjectImports> {
  const out = run(root, ['imports', '--json'])
  if (!out.ok) return out
  const value = out.value
  if (!isRecord(value)) return { ok: false, problem: TOO_OLD }
  const imports = list(value.imports, row =>
    str(row.from) && num(row.line) && str(row.to) && str(row.specifier) ? { from: row.from, line: row.line, to: row.to, specifier: row.specifier } : undefined,
  )
  const unresolved = list(value.unresolved, row =>
    str(row.from) && num(row.line) && str(row.specifier) && str(row.reason)
      ? { from: row.from, line: row.line, specifier: row.specifier, reason: row.reason, possiblyOwn: !EXTERNAL.has(row.reason) }
      : undefined,
  )
  if (!imports || !unresolved) return { ok: false, problem: TOO_OLD }
  return { ok: true, value: { imports, unresolved } }
}

/** 这次改动（和 base 比，含未提交的）增删的关系。 */
export function readChanges(root: string, base: string): Result<ChangeFacts> {
  const out = run(root, ['check', '--json', '--base', base])
  if (!out.ok) return out
  const value = out.value
  if (!isRecord(value) || !isRecord(value.edges)) return { ok: false, problem: TOO_OLD }
  const edges = value.edges
  const imports = list(edges.imports, row =>
    str(row.from) && str(row.to) && num(row.line) && (row.change === 'ADDED' || row.change === 'REMOVED')
      ? { from: row.from, to: row.to, line: row.line, change: row.change as 'ADDED' | 'REMOVED' }
      : undefined,
  )
  const calls = list(edges.calls, row =>
    str(row.from) && num(row.line) && str(row.to) && str(row.declaration) && typeof row.exported === 'boolean'
      ? { from: row.from, line: row.line, to: row.to, declaration: row.declaration, exported: row.exported }
      : undefined,
  )
  const declarations = list(edges.declarations, row =>
    str(row.path) && str(row.declaration) && num(row.line) && typeof row.exported === 'boolean'
      ? { path: row.path, declaration: row.declaration, line: row.line, exported: row.exported }
      : undefined,
  )
  const unmapped = list(value.unmapped ?? [], row => (str(row.path) && str(row.kind) ? { path: row.path, kind: row.kind } : undefined))
  const incomplete = value.incomplete ?? []
  if (!imports || !calls || !declarations || typeof edges.truncated !== 'boolean' || !unmapped || !strings(incomplete)) return { ok: false, problem: TOO_OLD }
  return {
    ok: true,
    value: { imports, calls, declarations, edgesTruncated: edges.truncated, truncated: value.truncated === true, incomplete, unmapped },
  }
}
