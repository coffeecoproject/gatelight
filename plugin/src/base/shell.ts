// 大致读懂 agent 要跑的 Bash 命令：拆成一条条命令，跟着 cd 算出每条在哪个目录跑。
// 只用于提示（节奏说明、直接跑整组命令时的提醒、前台跑完整组算看过结果），不用来把关：
// 引号、转义、&& || ; | & 换行、cd、环境变量前缀、sh -c。

import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'

export interface Invocation {
  cwd: string
  argv: string[]
}

const OPERATORS = ['&&', '||', ';;', ';', '|&', '|', '&', '\n', '(', ')']

/** 重定向：`>`、`2>&1`、`&>file`、`<<EOF` 这类。不带目标时目标是下一个词。 */
const REDIRECT = /^(?:\d+|&)?(?:>>|>&|>\||>|<<<|<<-?|<&|<>|<)(.*)$/s
const HEREDOC = /^\d*<<(?!<)(-?)(.*)$/s

/**
 * 拆成词和操作符，不做展开：变量、反引号原样留在词里；$(...) 的括号按操作符拆开，里面的命令也当成命令。
 * here-document 的正文跳过：它是给命令的输入，不是命令。
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = []
  let word = ''
  let inWord = false
  // 等下一个换行之后跳过正文的 here-document，以及 `<< EOF` 写法里还没读到的结束符
  const heredocs: Array<{ delimiter: string; strip: boolean }> = []
  let pendingStrip: boolean | undefined
  const push = (): void => {
    if (inWord) {
      if (pendingStrip !== undefined) {
        heredocs.push({ delimiter: word, strip: pendingStrip })
        pendingStrip = undefined
      } else {
        const heredoc = HEREDOC.exec(word)
        if (heredoc) {
          if (heredoc[2]) heredocs.push({ delimiter: heredoc[2], strip: heredoc[1] === '-' })
          else pendingStrip = heredoc[1] === '-'
        }
      }
      tokens.push(word)
    }
    word = ''
    inWord = false
  }
  const skipHeredocs = (from: number): number => {
    let at = from
    for (const { delimiter, strip } of heredocs.splice(0)) {
      while (at < command.length) {
        const end = command.indexOf('\n', at)
        const line = command.slice(at, end === -1 ? command.length : end)
        at = end === -1 ? command.length : end + 1
        if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break
      }
    }
    return at
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      inWord = true
      i = stop
    } else if (c === '"') {
      inWord = true
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === '\\' && i + 1 < command.length && '"\\$`\n'.includes(command[i + 1]!)) i++
        word += command[i]
      }
    } else if (c === '\\') {
      if (command[i + 1] === '\n') i++
      else if (i + 1 < command.length) {
        word += command[++i]
        inWord = true
      }
    } else if (c === '#' && !inWord) {
      const end = command.indexOf('\n', i)
      i = (end === -1 ? command.length : end) - 1
    } else if (c === ' ' || c === '\t') {
      push()
    } else if (c === '&' && ((inWord && /[<>]$/.test(word)) || command[i + 1] === '>')) {
      // 2>&1、>&2、&>file 是重定向，不是后台运行
      word += c
      inWord = true
    } else if (c === '\n') {
      push()
      tokens.push('\n')
      if (heredocs.length > 0) i = skipHeredocs(i + 1) - 1
    } else {
      const op = OPERATORS.find(o => command.startsWith(o, i))
      if (op) {
        push()
        tokens.push(op)
        i += op.length - 1
      } else {
        word += c
        inWord = true
      }
    }
  }
  push()
  return tokens
}

/** 去掉重定向和它的目标。 */
function withoutRedirects(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const redirect = REDIRECT.exec(argv[i]!)
    if (!redirect) out.push(argv[i]!)
    else if (redirect[1] === '') i++
  }
  return out
}

const WRAPPERS = new Set(['command', 'exec', 'nohup', 'time', 'builtin'])

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? homedir() + path.slice(1) : path
}

/** 命令里的每条程序调用和它的工作目录。 */
export function invocations(command: string, cwd: string): Invocation[] {
  const result: Invocation[] = []
  let here = cwd
  let segment: string[] = []
  const flush = (): void => {
    let argv = withoutRedirects(segment)
    segment = []
    // 跳过环境变量前缀和 env、command 这类包装
    for (;;) {
      if (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) argv = argv.slice(1)
      else if (argv[0] === 'env') {
        argv = argv.slice(1)
        while (argv.length > 0 && (argv[0]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!))) argv = argv.slice(1)
      } else if (argv.length > 0 && WRAPPERS.has(argv[0]!)) argv = argv.slice(1)
      else break
    }
    if (argv.length === 0) return
    const program = basename(argv[0]!)
    if (program === 'cd') {
      // 目录要展开才知道（cd "$DIR"、cd $(git rev-parse --show-toplevel)）的，算不出来，当作没动
      const target = argv[1] ?? '~'
      if (!/[$`]/.test(target)) here = resolve(here, expandHome(target))
      return
    }
    if (['sh', 'bash', 'zsh', 'dash'].includes(program)) {
      const c = argv.indexOf('-c')
      if (c !== -1 && argv[c + 1] !== undefined) {
        result.push(...invocations(argv[c + 1]!, here))
        return
      }
    }
    result.push({ cwd: here, argv })
  }
  for (const token of tokenize(command)) {
    if (OPERATORS.includes(token)) flush()
    else segment.push(token)
  }
  flush()
  return result
}

/** command 里有没有按顺序、连着跑 target 的每条命令（参数完全一样）。 */
export function runsCommand(command: string, target: string, cwd: string): boolean {
  const want = invocations(target, cwd).map(call => call.argv.join('\0'))
  const have = invocations(command, cwd).map(call => call.argv.join('\0'))
  if (want.length === 0) return false
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((argv, j) => have[i + j] === argv)) return true
  }
  return false
}
