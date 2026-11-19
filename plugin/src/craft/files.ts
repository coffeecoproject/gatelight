// 认文件：测试、测试辅助、快照和测试数据、测试和检查的配置、依赖、锁文件、本插件的记录、清单、代码、其他。

import { CHANGES_DIR, CHECKLIST_DIR, CONFIG_PATH, type Config, RULES_DIR, TESTPACE_FILE } from './config.ts'
import { matchesAny } from '../base/glob.ts'

export type Kind = 'test' | 'helper' | 'data' | 'testConfig' | 'deps' | 'lock' | 'contract' | 'record' | 'checklist' | 'code' | 'other'

/** 能单独跑的测试文件（常见命名）。 */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs|swift)$/
/** 快照和测试数据。 */
const DATA_FILE = /(^|\/)(__snapshots__|fixtures?|testdata|__fixtures__)\/|\.snap$/
/** 只给测试用的代码：测试目录里的、名字带测试辅助字样的。 */
const HELPER_FILE =
  /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|testing|test-support|test-utils|test-helpers)\/|[-_.](test-?support|test-?helpers?|test-?utils?|fixtures?|mocks?)\.[cm]?[jt]sx?$|(^|\/)(conftest\.py|setup-?tests\.[cm]?[jt]s|test-setup\.[cm]?[jt]s)$/i
/** 测试运行器和代码检查的配置：改宽了，测试或检查就松了。 */
const TEST_CONFIG =
  /(^|\/)((vitest|jest|playwright|cypress|karma|ava|mocha|wdio|stryker)\.(config|workspace)\.[cm]?[jt]s(on)?|\.mocharc(\.[a-z]+)?|pytest\.ini|tox\.ini|\.coveragerc|biome\.jsonc?|eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?|tsconfig(\.[\w-]+)?\.json|\.golangci\.ya?ml|clippy\.toml|ruff\.toml)$/
const DEPS_FILE = /(^|\/)(go\.mod|Cargo\.toml|requirements[\w.-]*\.txt|pyproject\.toml|Gemfile|build\.gradle(\.kts)?|pom\.xml|Package\.swift)$/
const LOCK_FILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|go\.sum|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|Package\.resolved)$/
/** 文档、图片：放在测试目录里也不是测试辅助文件。 */
const NOT_HELPER = /\.(md|mdx|markdown|txt|rst|adoc|png|jpe?g|gif|svg|webp|ico|pdf)$/i
const CODE_FILE = /\.([cm]?[jt]sx?|vue|svelte|go|py|rs|java|kt|kts|swift|rb|php|cs|scala|c|cc|cpp|h|hpp|m|mm|sql|sh|bash)$/

/** 清单的条目：清单目录下一层的 .md 文件，一个文件一条。改名成别的扩展名、挪进子目录，就不再是条目。 */
export function isChecklistItem(path: string): boolean {
  return path.startsWith(`${CHECKLIST_DIR}/`) && /^[^/]+\.md$/.test(path.slice(CHECKLIST_DIR.length + 1))
}

export function kindOf(path: string, config: Config): Kind {
  if (path.startsWith(`${CHANGES_DIR}/`) || path.startsWith(`${RULES_DIR}/`)) return 'record'
  if (isChecklistItem(path)) return 'checklist'
  if (path === CONFIG_PATH || path === TESTPACE_FILE || matchesAny(path, config.contract)) return 'contract'
  // 不算测试这一侧的（手动跑的练习脚本、名字像测试的业务代码）照别的文件认
  const testable = !matchesAny(path, config.notTests)
  if (testable && (matchesAny(path, config.tests) || TEST_FILE.test(path))) return 'test'
  if (testable && DATA_FILE.test(path)) return 'data'
  if (TEST_CONFIG.test(path)) return 'testConfig'
  if (testable && (matchesAny(path, config.helpers) || (HELPER_FILE.test(path) && !NOT_HELPER.test(path)))) return 'helper'
  if (DEPS_FILE.test(path)) return 'deps'
  if (LOCK_FILE.test(path)) return 'lock'
  if (/(^|\/)package\.json$/.test(path)) return 'deps'
  if (CODE_FILE.test(path)) return 'code'
  return 'other'
}

/** 测试这一侧的文件：测试、测试辅助、快照和测试数据。 */
export function testSide(kind: Kind): boolean {
  return kind === 'test' || kind === 'helper' || kind === 'data'
}

/**
 * 跳过测试、关掉测试、标成预期失败的写法。`.only` 归 testpace 的默认检查，这里不管。
 * 测试体里的跳过（Playwright 的 testInfo、node:test 的 t、vitest 的 ctx）只认常用的参数名，改了名的认不出。
 * `skip:`、`todo:` 后面除了 false、null、undefined、数字和类型名都算，按条件跳过也要理由。
 */
export const SKIPPING =
  /\b(?:describe|it|test|context|suite|bench)\.(?:skip|todo|fixme|skipIf|runIf|fail|fails|failing)\b|\b(?:testInfo|info)\.(?:skip|fixme|fail)\s*\(|\b(?:t|ctx)\.(?:skip|todo)\s*\(|\bx(?:it|describe|test|context)\s*\(|@(?:Disabled|Ignore)\b|\bt\.Skip(?:Now|f)?\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail|importorskip)\s*\(|@unittest\.(?:skip\w*|expectedFailure)\b|#\[ignore\]|\bthis\.skip\s*\(|\b(?:skip|todo)\s*:\s*(?!(?:false|null|undefined|boolean|string)\b|\d)[\w'"`!(]/

/** 测试的声明：取出测试名。 */
const DECLARATION = [
  /\b(?:it|test|specify|scenario)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g,
  /\bfunc\s+(Test\w+)\s*\(/g,
  /\bdef\s+(test_\w+)\s*\(/g,
]

/** 一段测试代码里声明的测试名。 */
export function testNames(text: string): Set<string> {
  const names = new Set<string>()
  for (const pattern of DECLARATION) {
    for (const match of text.matchAll(pattern)) names.add((match[2] ?? match[1]) as string)
  }
  // Rust：#[test] 下面那个函数
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (!/#\[(tokio::)?test\]/.test(line)) return
    const next = lines.slice(index + 1, index + 4).join('\n')
    const fn = /\bfn\s+(\w+)/.exec(next)
    if (fn) names.add(fn[1] as string)
  })
  return names
}

/** 断言的写法。 */
export const ASSERTING =
  /\bexpect\s*\(|\bassert\w*\s*[(.!]|\bassert\s|\.should\b|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\b(?:require|assert)\.\w+\s*\(|\bself\.assert\w*\s*\(|\bXCTAssert\w*\s*\(/

/** 去掉一行里的字符串和行尾注释，数括号用。 */
function bare(line: string): string {
  return line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$|#.*$/, '')
}

/** 导入语句的开头：import、from … import、export … from、require、use、using、#include。 */
const IMPORTING = /^\s*(?:import(?:\s|\{|\*|['"])|from\s+\S+\s+import\b|export\s*(?:\*|\{|type\s*\{)|use\s+[\w:\\{]|using\s+[\w.]+\s*;|#include\b|require(?:_relative)?\s+['"])|\brequire\s*\(\s*['"]/

/** 去掉导入语句后剩下的各行（去掉首尾空白和空行）：看测试除了接法以外改没改。多行的导入按括号配对找结尾。 */
export function withoutImports(text: string): string {
  const kept: string[] = []
  let depth = 0
  for (const line of text.split('\n')) {
    if (depth > 0 || IMPORTING.test(line)) {
      const plain = bare(line)
      depth = Math.max(0, depth + (plain.match(/[{([]/g)?.length ?? 0) - (plain.match(/[})\]]/g)?.length ?? 0))
      continue
    }
    if (line.trim()) kept.push(line.trim())
  }
  return kept.join('\n')
}

/** 每个测试里有几条断言（多行的断言算一条）。找不到声明行的测试不算。 */
export function assertionsPerTest(text: string): Map<string, number> {
  const lines = text.split('\n')
  const counts = new Map<string, number>()
  for (const name of testNames(text)) {
    const start = declarationLine(lines, name)
    if (start < 0) continue
    const end = statementEnd(lines, start)
    let count = 0
    for (let i = start; i <= end; i++) {
      if (!ASSERTING.test(lines[i] as string)) continue
      count++
      i = Math.max(i, statementEnd(lines, i))
    }
    counts.set(name, count)
  }
  return counts
}

/**
 * 从 start 行（0 起）开始的一条语句（断言、测试声明）到哪一行结束：括号配平为止；以冒号结尾的（Python）到缩进退回去为止。
 * 按文本数，字符串跨行时会数错，够用来判断"改的这一行在不在这条语句里"。
 */
export function statementEnd(lines: string[], start: number): number {
  const first = lines[start] ?? ''
  if (/:\s*(#.*)?$/.test(first) && !/[([{]\s*$/.test(bare(first))) {
    const indent = (line: string): number => (/^\s*/.exec(line) as RegExpExecArray)[0].length
    let end = start
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i] as string
      if (line.trim() === '') continue
      if (indent(line) <= indent(first)) break
      end = i
    }
    return end
  }
  let depth = 0
  for (let i = start; i < lines.length && i < start + 400; i++) {
    for (const char of bare(lines[i] as string)) {
      if (char === '(' || char === '[' || char === '{') depth++
      else if (char === ')' || char === ']' || char === '}') depth--
    }
    if (depth <= 0) return i
  }
  return Math.min(lines.length - 1, start + 399)
}

/**
 * 一段测试代码里每个测试的内容，按行（去掉测试名、空白和空行）：认改名和挪到别的文件用。
 * 找不到声明行的测试内容为空（只认名字）。
 */
export function testBodies(text: string): Map<string, string[]> {
  const lines = text.split('\n')
  const bodies = new Map<string, string[]>()
  for (const name of testNames(text)) {
    const start = declarationLine(lines, name)
    if (start < 0) {
      bodies.set(name, [])
      continue
    }
    const block = lines.slice(start, statementEnd(lines, start) + 1)
    bodies.set(name, block.map(line => line.split(name).join('').replace(/\s+/g, '')).filter(Boolean))
  }
  return bodies
}

/** 上一行以运算符结尾、下一行以运算符或 `.` 开头（注释行不算）：还是同一条语句（`a +\n b`、`expect(x)\n .not\n .toBe(1)`）。 */
const CONTINUES_AFTER = /(?:[-+*/%=&|^<>?:,.]|=>)$/
const CONTINUES_BEFORE = /^(?:[-+*%=&|^<>?:.]|\/(?![/*])|=>)/

/**
 * 一段测试代码里每个测试的内容，按语句：声明那条去掉测试名；多行的语句、接着写的链式调用和表达式合成一条；每行去掉首尾空白。
 * 认"改了名、只删了整条语句"用：删多行断言里的一行、`.not` 这一行，整条语句就变了。找不到声明行的测试内容为空。
 */
export function testStatements(text: string): Map<string, string[]> {
  const lines = text.split('\n')
  const squash = (from: number, to: number): string => trimmed(lines.slice(from, to + 1).join('\n'))
  const result = new Map<string, string[]>()
  for (const name of testNames(text)) {
    const start = declarationLine(lines, name)
    if (start < 0) {
      result.set(name, [])
      continue
    }
    const end = statementEnd(lines, start)
    const header = (lines[start] as string).replace(name, '')
    if (start === end) {
      result.set(name, [trimmed(header)])
      continue
    }
    const statements = [trimmed(header)]
    for (let i = start + 1; i <= end; i++) {
      if ((lines[i] as string).trim() === '') continue
      let last = Math.min(statementEnd(lines, i), end)
      for (;;) {
        let next = last + 1
        while (next <= end && (lines[next] as string).trim() === '') next++
        if (next > end) break
        if (!CONTINUES_AFTER.test(bare(lines[last] as string).trim()) && !CONTINUES_BEFORE.test((lines[next] as string).trim())) break
        last = Math.min(statementEnd(lines, next), end)
      }
      statements.push(squash(i, last))
      i = last
    }
    result.set(name, statements)
  }
  return result
}

/** 每行去掉首尾空白、去掉空行，别的原样留着：只改了缩进不算改，改了字符串、正则里的空格，或者改了一行里的写法，都算改了。 */
function trimmed(text: string): string {
  return text.split('\n').map(line => line.trim()).filter(Boolean).join('\n')
}

/** lines 按顺序都在 within 里（中间可以少几条）。 */
export function inOrder(lines: string[], within: string[]): boolean {
  let at = 0
  for (const line of within) if (line === lines[at]) at++
  return at === lines.length
}

/** 声明这个测试名的那一行（0 起）。 */
export function declarationLine(lines: string[], name: string): number {
  return lines.findIndex(line => line.includes(name) && DECLARATION.some(pattern => new RegExp(pattern.source).test(line)))
}

/** 一种语言的注释和字符串写法：认"只改了注释"用。 */
interface Syntax {
  comment: '//' | '#'
  /** `#` 只在行首或空白后才开始注释（shell、YAML：`$#`、`a#b` 不是注释）。 */
  spaced?: true
  /** 有块注释（斜杠星号到星号斜杠）。 */
  block?: true
  /** 有跨行的 `'''`、`"""` 字符串。 */
  triple?: true
  /** JS 的模板字符串：跨行，里面 `${…}` 是代码。 */
  template?: true
  /** Go 的反引号字符串：跨行，不转义。 */
  raw?: true
  /** JS 的正则字面量。 */
  regex?: true
  /** 单引号里不转义（shell、YAML）。 */
  literalSingle?: true
  /** 反引号是单行的字符串（shell 的命令替换）。 */
  backtick?: true
  /** 文件里有这些写法就不判断：heredoc、Ruby 的 =begin 和 % 字面量、YAML 的多行块、Go 的 cgo（import "C" 上面的注释是 C 代码）、
   * Go 的示例测试（`// Output:` 和下面几行注释是 go test 核对的期望输出，就是断言）。 */
  unsure?: RegExp
}

/** 认得准的几种语言。jsx、tsx 不认（标签里的文字可以以 // 开头），没列的语言都不认。 */
const SYNTAX: Array<[RegExp, Syntax]> = [
  [/\.[cm]?[jt]s$/, { comment: '//', block: true, template: true, regex: true }],
  [/\.go$/, { comment: '//', block: true, raw: true, unsure: /^\s*import\s+"C"|^\s*\/\/\s*(?:unordered )?output:/im }],
  [/\.(py|toml)$/, { comment: '#', triple: true }],
  [/\.(sh|bash)$/, { comment: '#', spaced: true, literalSingle: true, backtick: true, unsure: /<</ }],
  [/\.rb$/, { comment: '#', unsure: /<<|^=begin|%[qQwWiIrsx]?[^\w\s=]/m }],
  [/\.ya?ml$/, { comment: '#', spaced: true, literalSingle: true, unsure: /(?:^|[:\s-])[|>][-+0-9]*[ \t]*(?:#.*)?$/m }],
]

/**
 * 起作用的注释：编译条件、shebang、测试环境、类型检查和代码检查的开关、编码声明。写在注释里也算代码，宁多勿少。
 */
const DIRECTIVE =
  /^\s*#!|\/\/\/\s*<|\/\/\s*(?:go:|\+build\b|nolint|lint:|export\s)|@(?:jest-|vitest-|ts-|flow\b|jsx|refresh\b|vite-ignore|license|preserve)|\b(?:eslint|jshint|tslint|istanbul|c8|v8|prettier-ignore|biome-ignore|deno-lint|deno-fmt|webpack\w*|globals?\s)|#\s*(?:frozen_string_literal|warn_indent|shareable_constant_value|-\*-|(?:vim?:.*)?(?:en)?coding[:=]|type:|noqa|pragma|pylint:|mypy:|pyright:|fmt:|isort:|nosec|rubocop:|shellcheck|yaml-language-server|ruff:|pyre-|cython:)/

/** 前面是这些（或什么都没有）时，`/` 开始的是正则，不是除号。 */
const BEFORE_REGEX = /^$|[(,=:[!&|?{};+\-*%<>~^}]$|^(?:return|typeof|case|do|else|in|of|new|delete|void|throw|instanceof|yield|await)$/

type Mode = { kind: 'code'; depth: number } | { kind: 'block' } | { kind: 'string'; close: string; escapes: boolean; multi: boolean; template: boolean }

/**
 * 一个文件里不只是注释和空白的行（原样）：比较两版的这些行，就知道是不是只改了注释和空行。
 * 跨行的字符串里的行（空行、以 // 或 # 开头的）是字符串的内容，算代码；代码后面带的注释连着代码一起比；起作用的注释（DIRECTIVE）算代码。
 * 不认的语言、有拿不准的写法（单行字符串、正则到行尾没收尾，块注释、跨行字符串到文件末尾没结束，SYNTAX 里 unsure 的写法）为 undefined。
 */
export function codeLines(path: string, text: string): string[] | undefined {
  const syntax = SYNTAX.find(([pattern]) => pattern.test(path))?.[1]
  if (!syntax || syntax.unsure?.test(text)) return undefined
  const stack: Mode[] = [{ kind: 'code', depth: 0 }]
  let before = ''
  const kept: string[] = []
  for (const line of text.split('\n')) {
    let code = stack.at(-1)?.kind === 'string'
    let i = 0
    while (i < line.length) {
      const mode = stack.at(-1) as Mode
      const char = line[i] as string
      if (mode.kind === 'block') {
        if (line.startsWith('*/', i)) {
          stack.pop()
          i += 2
        } else i++
        continue
      }
      if (mode.kind === 'string') {
        code = true
        if (char === '\\' && mode.escapes) i += 2
        else if (mode.template && line.startsWith('${', i)) {
          stack.push({ kind: 'code', depth: 0 })
          before = '{'
          i += 2
        } else if (line.startsWith(mode.close, i)) {
          stack.pop()
          before = 'a'
          i += mode.close.length
        } else i++
        continue
      }
      if (/\s/.test(char)) {
        i++
        continue
      }
      if (syntax.comment === '//' && line.startsWith('//', i)) break
      if (syntax.comment === '#' && char === '#' && (!syntax.spaced || i === 0 || /\s/.test(line[i - 1] as string))) break
      if (syntax.block && line.startsWith('/*', i)) {
        stack.push({ kind: 'block' })
        i += 2
        continue
      }
      code = true
      const string = (close: string, escapes: boolean, multi: boolean, template = false): void => {
        stack.push({ kind: 'string', close, escapes, multi, template })
        i += close.length
      }
      if (syntax.triple && (line.startsWith('"""', i) || line.startsWith("'''", i))) string(line.slice(i, i + 3), true, true)
      else if (char === '"') string('"', true, false)
      else if (char === "'") string("'", !syntax.literalSingle, false)
      else if (char === '`' && syntax.template) string('`', true, true, true)
      else if (char === '`' && syntax.raw) string('`', false, true)
      else if (char === '`' && syntax.backtick) string('`', true, false)
      else if (char === '/' && syntax.regex && BEFORE_REGEX.test(before)) {
        let inClass = false
        for (i++; ; i++) {
          if (i >= line.length) return undefined
          const at = line[i] as string
          if (at === '\\') i++
          else if (at === '[') inClass = true
          else if (at === ']') inClass = false
          else if (at === '/' && !inClass) break
        }
        i++
        while (i < line.length && /[a-z]/i.test(line[i] as string)) i++
        before = 'a'
      } else if (/[\w$]/.test(char)) {
        const word = (/^[\w$]+/.exec(line.slice(i)) as RegExpExecArray)[0]
        before = word
        i += word.length
      } else {
        // 模板字符串里 `${…}` 的代码：数花括号，配平的那个 } 回到字符串
        if (stack.length > 1 && char === '{') mode.depth++
        else if (stack.length > 1 && char === '}') {
          if (mode.depth === 0) stack.pop()
          else mode.depth--
        }
        before = char
        i++
      }
    }
    const mode = stack.at(-1) as Mode
    if (mode.kind === 'string' && !mode.multi) return undefined
    if (code || DIRECTIVE.test(line)) kept.push(line)
  }
  return stack.length === 1 ? kept : undefined
}
