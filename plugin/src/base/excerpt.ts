// 精简输出：失败时只给失败相关的行和结尾，完整内容在日志文件里。

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const FAILURE = /\b(FAIL|FAILED|Failed|failed|ERROR|Error|error|panic|AssertionError|not ok)\b|[✗✘×❌]/

const MAX_LINE = 300

export interface ExcerptOptions {
  /** 最多取多少行失败相关的行（从前往后，最先出错的地方最有用）。 */
  matches: number
  /** 结尾取多少行（测试工具的汇总一般在最后）。 */
  tail: number
}

export const DEFAULT_EXCERPT: ExcerptOptions = { matches: 20, tail: 30 }

export function cleanLines(text: string): string[] {
  return text
    .replace(ANSI, '')
    .split('\n')
    .map(line => {
      // 进度条用 \r 覆盖同一行，只留最后一次的内容
      const last = line.slice(line.lastIndexOf('\r') + 1)
      return last.length > MAX_LINE ? `${last.slice(0, MAX_LINE)}…` : last
    })
}

/** 按原顺序取失败相关的行和结尾几行，中间跳过的部分用 "…" 表示。 */
export function failureExcerpt(text: string, options: ExcerptOptions = DEFAULT_EXCERPT): string[] {
  const lines = cleanLines(text)
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()
  const keep = new Set<number>()
  for (let i = 0; i < lines.length && keep.size < options.matches; i++) {
    if (FAILURE.test(lines[i]!)) keep.add(i)
  }
  for (let i = Math.max(0, lines.length - options.tail); i < lines.length; i++) keep.add(i)

  const out: string[] = []
  let previous = -1
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > previous + 1) out.push('…')
    out.push(lines[i]!)
    previous = i
  }
  return out
}
