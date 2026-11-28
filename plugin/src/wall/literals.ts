// 从代码文件（JS/TS、Python、Go、Java）里取出字符串字面量，跳过注释，给 R6 认代码里写的 SQL。
// 不解析语法，只切词：插值（`${…}`、Python 的 {…}、%s 这类格式占位）换成一个占位的名字。
// JS 的正则字面量按前一个字符猜（前面是运算符、括号、逗号或行首时算正则），猜错只会让个别字面量切歪。

export interface Literal {
  text: string
  line: number
  /** 字面量后面紧跟着 +：拼接，后半截在别处。 */
  joined: boolean
}

/** 插值、格式占位换成的名字：在 SQL 里当成一个普通的名字。 */
export const PLACEHOLDER = '__x'

type Language = 'js' | 'py' | 'go' | 'java'

const languageOf = (path: string): Language | undefined => {
  if (/\.[cm]?[jt]sx?$/u.test(path)) return 'js'
  if (/\.pyi?$/u.test(path)) return 'py'
  if (path.endsWith('.go')) return 'go'
  if (path.endsWith('.java')) return 'java'
  return undefined
}

const ESCAPED: Record<string, string> = { n: ' ', t: ' ', r: ' ' }

export function stringLiterals(path: string, source: string): Literal[] {
  const language = languageOf(path)
  if (!language) return []
  const found: Literal[] = []
  let i = 0
  let line = 1
  // 上一个不是空白的代码字符：猜 / 是除号还是正则
  let previous = ''
  // JS 模板字符串停在 ${ 里时，先记下已读的部分，插值读完再接着读
  const suspended: { text: string; line: number; depth: number }[] = []
  let depth = 0

  const finish = (text: string, start: number): void => {
    let k = i
    while (k < source.length && /\s/u.test(source[k] as string)) k++
    const placeheld = language === 'js' ? text : text.replace(/\{[^{}]*\}/gu, ` ${PLACEHOLDER} `)
    found.push({ text: placeheld.replace(/%[sdvqIL]/gu, ` ${PLACEHOLDER} `), line: start, joined: source[k] === '+' })
    previous = 'x'
  }

  // 读到收尾的引号为止；escapes：反斜杠转义
  const quoted = (close: string, escapes: boolean): string => {
    let text = ''
    while (i < source.length && !source.startsWith(close, i)) {
      const char = source[i] as string
      if (escapes && char === '\\') {
        const next = source[i + 1] ?? ''
        if (next === '\n') line++
        text += ESCAPED[next] ?? next
        i += 2
        continue
      }
      if (char === '\n') line++
      text += char
      i++
    }
    i += close.length
    return text
  }

  // JS 模板字符串：读到 ` 收尾，或者停在 ${ 里
  const template = (text: string, start: number): void => {
    while (i < source.length) {
      const char = source[i] as string
      if (char === '\\') {
        text += ESCAPED[source[i + 1] ?? ''] ?? source[i + 1] ?? ''
        i += 2
      } else if (char === '`') {
        i++
        finish(text, start)
        return
      } else if (char === '$' && source[i + 1] === '{') {
        i += 2
        suspended.push({ text: `${text} ${PLACEHOLDER} `, line: start, depth })
        depth = 0
        previous = '('
        return
      } else {
        if (char === '\n') line++
        text += char
        i++
      }
    }
    finish(text, start)
  }

  while (i < source.length) {
    const char = source[i] as string
    const next = source[i + 1]
    if (char === '\n') {
      line++
      i++
    } else if (/\s/u.test(char)) {
      i++
    } else if (language === 'py' ? char === '#' : char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (language !== 'py' && char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      line += source.slice(i, stop).split('\n').length - 1
      i = stop
    } else if (language === 'js' && char === '`') {
      i++
      template('', line)
    } else if (language === 'go' && char === '`') {
      const start = line
      i++
      finish(quoted('`', false), start)
    } else if (char === '"' || char === "'") {
      const start = line
      if (language === 'py') {
        const prefix = /[A-Za-z]{1,2}$/u.exec(source.slice(Math.max(0, i - 2), i))?.[0] ?? ''
        const raw = /r/iu.test(prefix)
        const triple = source.startsWith(char.repeat(3), i)
        i += triple ? 3 : 1
        finish(quoted(triple ? char.repeat(3) : char, !raw), start)
      } else if (language === 'java' && source.startsWith('"""', i)) {
        i += 3
        finish(quoted('"""', true), start)
      } else if (char === "'" && language !== 'js') {
        // Go、Java 的单引号是字符
        i++
        quoted("'", true)
        previous = 'x'
      } else {
        i++
        finish(quoted(char, true), start)
      }
    } else if (language === 'js' && char === '/' && (previous === '' || /[(,=:[!&|?{};+\-*%<>~^]/u.test(previous))) {
      // 正则字面量：跳到收尾的 /（方括号里的 / 不算）
      let inClass = false
      i++
      while (i < source.length && source[i] !== '\n') {
        const c = source[i] as string
        if (c === '\\') i++
        else if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) break
        i++
      }
      i++
      previous = 'x'
    } else if (language === 'js' && char === '}' && depth === 0 && suspended.length > 0) {
      i++
      const outer = suspended.pop() as { text: string; line: number; depth: number }
      depth = outer.depth
      template(outer.text, outer.line)
    } else {
      if (char === '{') depth++
      if (char === '}') depth--
      previous = char
      i++
    }
  }
  return found
}
