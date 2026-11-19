// 改坏证明用的小破坏：在给定的代码行上换一个比较符、逻辑符、加减乘除、真假值、数字（含 10_000 这样带下划线的）、去掉一个取反、清空一个字符串。
// 按文本改，不分语言；改出来编不过、加载失败的，跑测试时会被认成"别的失败"，不算被抓到，换下一处。

export interface Mutant {
  path: string
  line: number
  before: string
  after: string
  /** 改坏后整份文件的内容。 */
  text: string
}

const OPERATORS: Array<[RegExp, string | ((match: string) => string)]> = [
  [/===/, '!=='],
  [/!==/, '==='],
  [/(?<![=!<>])==(?!=)/, '!='],
  [/!=(?!=)/, '=='],
  [/&&/, '||'],
  [/\|\|/, '&&'],
  // 大小比较只认两边有空格的：类型里的尖括号（Kysely<Database>、Promise<T>）贴着字，改了只会编不过
  [/ >= /, ' > '],
  [/ <= /, ' < '],
  [/ > /, ' >= '],
  [/ < /, ' <= '],
  [/\btrue\b/, 'false'],
  [/\bfalse\b/, 'true'],
  [/\bTrue\b/, 'False'],
  [/\bFalse\b/, 'True'],
  [/\(\s*!(?!=)/, '('],
  [/(?<![\w.$])\d[\d_]*(?:\.\d[\d_]*)?(?![\w.])/, match => String(Number(match.replace(/_/g, '')) + 1)],
  [/ \+ /, ' - '],
  [/ - /, ' + '],
  // 乘除也只认两边有空格的：`/*` 注释、`**` 乘方、`import * as` 不会被改
  [/ \* /, ' / '],
  [/ \/ /, ' * '],
  // 排序方向：倒序、正序对调（`orderBy("x", "desc")`、SQL 里的 `DESC`），排在清空字符串前面
  [/(['"])(?:asc|desc|ASC|DESC)\1/, match => `${match[0]}${swapDirection(match.slice(1, -1))}${match[0]}`],
  // 两边都贴着引号的上一条已经换过；只贴一边的（'created_at DESC'）照换
  [/(?<!['"])\b(?:ASC|DESC)\b|\b(?:ASC|DESC)\b(?!['"])/, swapDirection],
  [/(['"])(?!\1)([^'"\\\n]+)\1/, match => `${match[0]}${match[0]}`],
]

const SKIP_LINE =
  /^\s*(?:$|\/\/|\/\*|\*|#(?!\[)|--|import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|from\s+\S+\s+import\b|package\b|use\s|type\s+\w+\s*=|interface\b|@\w+|console\.\w+\(|print\(|logger\.|log\.)|\brequire\s*\(/

const PER_LINE = 3

/** 这些行上能做的小破坏，每行最多几种。 */
export function mutantsFor(path: string, text: string, lines: number[]): Mutant[][] {
  const all = text.split('\n')
  const result: Mutant[][] = []
  for (const number of [...new Set(lines)].sort((a, b) => a - b)) {
    const line = all[number - 1]
    if (line === undefined || SKIP_LINE.test(line)) continue
    const options: Mutant[] = []
    for (const [pattern, replacement] of OPERATORS) {
      if (options.length >= PER_LINE) break
      const match = pattern.exec(line)
      if (!match) continue
      const swapped = typeof replacement === 'string' ? replacement : replacement(match[0])
      const changed = line.slice(0, match.index) + swapped + line.slice(match.index + match[0].length)
      if (changed === line) continue
      const copy = [...all]
      copy[number - 1] = changed
      options.push({ path, line: number, before: match[0], after: swapped, text: copy.join('\n') })
    }
    if (options.length) result.push(options)
  }
  return result
}

function swapDirection(word: string): string {
  const swapped = /^asc$/i.test(word) ? 'desc' : 'asc'
  return word === word.toUpperCase() ? swapped.toUpperCase() : swapped
}

/** 一段文字里的词：按非字母数字、驼峰拆开，转小写，去掉太短的和到处都有的。 */
export function wordsOf(text: string): Set<string> {
  const words = new Set<string>()
  for (const part of text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length > 2 && !COMMON.has(part)) words.add(part)
  }
  return words
}

const COMMON = new Set(
  'const let var function async await return export import from new this true false null undefined expect assert equal test describe tobe toequal the and for not'.split(
    ' ',
  ),
)

/**
 * 同一段代码里的各行，和测试用到的词对得上的排前面，其余照原来的顺序。
 * 一个词在这段里出现的行越少，分量越重：几乎每行都有的名字（organization_id 这类）说明不了什么。
 */
export function byRelevance(lines: Mutant[][], text: string, testWords: Set<string>): Mutant[][] {
  const all = text.split('\n')
  const wordsAt = new Map(lines.map(group => [group, wordsOf(all[(group[0] as Mutant).line - 1] ?? '')]))
  const spread = new Map<string, number>()
  for (const words of wordsAt.values()) for (const word of words) spread.set(word, (spread.get(word) ?? 0) + 1)
  const score = (group: Mutant[]): number =>
    [...(wordsAt.get(group) as Set<string>)].reduce((sum, word) => sum + (testWords.has(word) ? 1 / (spread.get(word) as number) : 0), 0)
  return lines
    .map((group, index) => ({ group, index, score: score(group) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ group }) => group)
}

/** 轮流从各行里取：先每行一种，再每行第二种，凑够 limit 个。 */
export function pick(groups: Mutant[][], limit: number): Mutant[] {
  const picked: Mutant[] = []
  for (let round = 0; picked.length < limit; round++) {
    let any = false
    for (const group of groups) {
      const mutant = group[round]
      if (!mutant) continue
      any = true
      picked.push(mutant)
      if (picked.length >= limit) break
    }
    if (!any) break
  }
  return picked
}

/** 函数、方法或 const 声明所在的那几行：从声明那行起，到缩进退回去为止。找不到时为 undefined。 */
export function blockOf(text: string, name: string): number[] | undefined {
  const lines = text.split('\n')
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declaration = new RegExp(
    `\\b(?:function\\s*\\*?\\s*${escaped}\\b|${escaped}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\(|\\w+\\s*=>)|(?:const|let|var|val)\\s+${escaped}\\s*(?::[^=]*)?=|def\\s+${escaped}\\b|func\\s+(?:\\([^)]*\\)\\s*)?${escaped}\\b|fn\\s+${escaped}\\b|(?:class|struct|impl|enum)\\s+${escaped}\\b|^\\s*(?:(?:public|private|protected|static|async|override|get|set)\\s+)*${escaped}\\s*\\([^)]*\\)\\s*(?::[^{]*)?\\{)`,
  )
  const start = lines.findIndex(line => declaration.test(line))
  if (start < 0) return undefined
  const indent = (line: string): number => (/^\s*/.exec(line) as RegExpExecArray)[0].length
  const base = indent(lines[start] as string)
  const block = [start + 1]
  for (let i = start + 1; i < lines.length && block.length < 300; i++) {
    const line = lines[i] as string
    if (line.trim() === '' || indent(line) > base) {
      block.push(i + 1)
      continue
    }
    if (!/^\s*[}\])>]/.test(line)) break
    block.push(i + 1)
    // 多行参数、多行泛型参数收尾，接着开参数、函数体的那行（`}): Promise<T> {`、`>(args: {`、`>(`、`) -> int:`）：函数还没完
    if (!/(?:[{(\[<:]|=>)\s*$/.test(line)) break
  }
  return block
}
