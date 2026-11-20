// 读 SQL 文本（迁移文件、库里函数的正文），只给出 R6 要用的事实，不判断：
//   refs       带 schema 的全名（a.b 的 a 可能是 schema，也可能是别名、表名、变量，由规则按名字认）
//   targets    这句建、改、删的对象（CREATE/ALTER/DROP 表、视图、函数、schema 等，挂触发器、规则、策略、索引的表，COMMENT、GRANT 的对象），
//              tables 是其中建表和把表挪进别的 schema 的
//   writes     这句写的表、视图（INSERT INTO、UPDATE、DELETE FROM、MERGE INTO、TRUNCATE）
//   view       这句建的是视图
//   function   建函数、过程：名字、SET search_path 写的值、是不是 SECURITY DEFINER；invoker 是 ALTER … SECURITY INVOKER 改回去的函数
//   inFunction 这句写在函数、过程的正文里（DO 块的正文不算）
//   aliases    表、列的别名，CTE 的名字（候选：规则只看和模块 schema 同名的）
//   relations  FROM/JOIN/UPDATE/INTO 后面没起别名的表名（不写别名时，表名就是限定列的前缀）
//   setsSearchPath 这句改了 search_path（SET、RESET search_path，set_config('search_path', …)）
//   switchesRole   这句切了身份（SET ROLE、RESET ROLE、SET SESSION AUTHORIZATION、set_config('role', …)，也包括角色、库上设的 role；建函数、改函数时设的不算）
//   schemas    这句建的 schema（CREATE SCHEMA）
// 不解析完整语法：切词（注释、字符串、带引号的名字、$$ 正文）后按分号分句，在句子里认几种固定的写法。
// 函数、DO 块的正文当成 SQL 再读一遍，得到的句子单独列出（别名只在自己的句子里起作用）。
// 拼出来再执行的 SQL（EXECUTE '...'）是字符串，读不到。

export type Token =
  /** 名字和关键字：不带引号的转成小写，带双引号的照原样（quoted）。 */
  | { kind: 'word'; text: string; line: number; quoted: boolean }
  /** 字符串：单引号的（转义已还原）、$tag$ 的（dollar）。 */
  | { kind: 'string'; text: string; line: number; dollar: boolean }
  | { kind: 'punct'; text: string; line: number }

export interface Ref {
  schema: string
  name: string
  line: number
  /** 写在 REFERENCES 后面（外键指向的表）。 */
  references: boolean
}

/** 一个对象的名字：schema 没写全名的为 undefined。 */
export interface Name {
  schema?: string
  name: string
  line: number
}

export interface Statement {
  /** 句子开头的行。 */
  line: number
  refs: Ref[]
  /** 这句建、改、删的对象；建、改、删 schema 本身时 schema 和 name 都是那个 schema。 */
  targets: Name[]
  writes: Name[]
  /** 建的表（CREATE TABLE）和挪了 schema 的表（ALTER TABLE … SET SCHEMA）：schema 是表最后所在的 schema。 */
  tables: Name[]
  view: boolean
  /** 建函数、过程：searchPath 是 SET search_path 写的值，没写时为 undefined。 */
  function?: Name & { searchPath?: string[]; securityDefiner: boolean }
  /** ALTER FUNCTION/PROCEDURE … SECURITY INVOKER：改成按调用者执行的函数。 */
  invoker?: Name
  inFunction: boolean
  aliases: Array<{ name: string; line: number }>
  relations: Array<{ name: string; line: number }>
  setsSearchPath: boolean
  switchesRole: boolean
  /** CREATE SCHEMA 建的 schema。 */
  schemas: Name[]
}

const WORD_START = /[A-Za-z_\u0080-\uffff]/
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/

export function tokenize(text: string, firstLine = 1): Token[] {
  const tokens: Token[] = []
  let line = firstLine
  let i = 0
  let escapeNext = false
  const lines = (part: string): number => part.split('\n').length - 1
  while (i < text.length) {
    const char = text[i] as string
    const next = text[i + 1]
    if (char === '\n') {
      line++
      i++
    } else if (/\s/.test(char)) {
      i++
    } else if (char === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (char === '/' && next === '*') {
      // 注释可以嵌套
      let depth = 0
      do {
        if (text.startsWith('/*', i)) {
          depth++
          i += 2
        } else if (text.startsWith('*/', i)) {
          depth--
          i += 2
        } else {
          if (text[i] === '\n') line++
          i++
        }
      } while (depth > 0 && i < text.length)
    } else if (char === "'") {
      const escapes = escapeNext
      escapeNext = false
      const start = line
      let value = ''
      i++
      while (i < text.length) {
        const c = text[i] as string
        if (escapes && c === '\\') {
          value += text[i + 1] ?? ''
          i += 2
          continue
        }
        if (c === "'") {
          if (text[i + 1] === "'") {
            value += "'"
            i += 2
            continue
          }
          i++
          break
        }
        if (c === '\n') line++
        value += c
        i++
      }
      tokens.push({ kind: 'string', text: value, line: start, dollar: false })
    } else if (char === '"') {
      let value = ''
      i++
      while (i < text.length) {
        const c = text[i] as string
        if (c === '"') {
          if (text[i + 1] === '"') {
            value += '"'
            i += 2
            continue
          }
          i++
          break
        }
        if (c === '\n') line++
        value += c
        i++
      }
      tokens.push({ kind: 'word', text: value, line, quoted: true })
    } else if (char === '$' && DOLLAR_TAG.test(text.slice(i, i + 64))) {
      const tag = (text.slice(i).match(DOLLAR_TAG) as RegExpMatchArray)[0]
      const start = line
      const end = text.indexOf(tag, i + tag.length)
      const body = end === -1 ? text.slice(i + tag.length) : text.slice(i + tag.length, end)
      tokens.push({ kind: 'string', text: body, line: start, dollar: true })
      line += lines(body)
      i = end === -1 ? text.length : end + tag.length
    } else if (WORD_START.test(char)) {
      let j = i + 1
      while (j < text.length && WORD_PART.test(text[j] as string)) j++
      const word = text.slice(i, j).toLowerCase()
      // E'…'：反斜杠转义的字符串，前缀不是词
      if (word === 'e' && text[j] === "'") escapeNext = true
      else tokens.push({ kind: 'word', text: word, line, quoted: false })
      i = j
    } else if (/[0-9]/.test(char)) {
      let j = i + 1
      while (j < text.length && /[0-9.eE]/.test(text[j] as string) && !(text[j] === '.' && text[j + 1] === '.')) j++
      tokens.push({ kind: 'punct', text: text.slice(i, j), line })
      i = j
    } else if (char === ':' && next === ':') {
      tokens.push({ kind: 'punct', text: '::', line })
      i += 2
    } else {
      tokens.push({ kind: 'punct', text: char, line })
      i++
    }
  }
  return tokens
}

const isWord = (token: Token | undefined, ...texts: string[]): boolean => token?.kind === 'word' && !token.quoted && (texts.length === 0 || texts.includes(token.text))
const isPunct = (token: Token | undefined, text: string): boolean => token?.kind === 'punct' && token.text === text
const anyWord = (token: Token | undefined): token is Extract<Token, { kind: 'word' }> => token?.kind === 'word'

/** 关系后面的这些词不是别名，是句子接下来的部分。 */
const NOT_ALIAS = new Set([
  'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'on', 'using', 'group', 'order', 'limit', 'offset', 'having',
  'window', 'union', 'intersect', 'except', 'returning', 'set', 'values', 'for', 'fetch', 'into', 'select', 'default', 'tablesample', 'with', 'loop',
  'then', 'when', 'else', 'end', 'and', 'or', 'not', 'is', 'in', 'strict', 'do', 'overriding',
])

/** 关系名后面的这些词不是关系：触发器的 UPDATE ON/OF，外键的 ON UPDATE CASCADE，FOR UPDATE 加锁等。 */
const NOT_RELATION = new Set(['on', 'of', 'or', 'cascade', 'restrict', 'set', 'no', 'nowait', 'skip', 'select', 'values', 'default', 'with'])

/** SQL 文本里的句子：按分号分开；函数、DO 块的正文再读一遍，接在后面。 */
export function statements(text: string, firstLine = 1): Statement[] {
  const tokens = tokenize(text, firstLine)
  const result: Statement[] = []
  let start = 0
  for (let i = 0; i <= tokens.length; i++) {
    if (i < tokens.length && !isPunct(tokens[i], ';')) continue
    if (i > start) result.push(...statement(tokens.slice(start, i)))
    start = i + 1
  }
  return result
}

/** CREATE/ALTER/DROP 后面认的对象种类（MATERIALIZED VIEW 按 VIEW 认）。 */
const KINDS = new Set(['table', 'view', 'function', 'procedure', 'sequence', 'type', 'domain', 'aggregate', 'index', 'schema'])
/** CREATE 和种类之间可以有的词。 */
const MODIFIERS = new Set(['or', 'replace', 'global', 'local', 'temp', 'temporary', 'unlogged', 'foreign', 'recursive', 'materialized', 'unique', 'concurrently'])

function statement(tokens: Token[]): Statement[] {
  const found: Statement = { line: tokens[0]?.line ?? 0, refs: [], targets: [], writes: [], tables: [], view: false, aliases: [], relations: [], setsSearchPath: false, switchesRole: false, schemas: [], inFunction: false }
  const nested: Statement[] = []
  const creates = isWord(tokens[0], 'create')
  let at = 1
  if (creates && isWord(tokens[at], 'or') && isWord(tokens[at + 1], 'replace')) at += 2
  const isFunction = creates && isWord(tokens[at], 'function', 'procedure')
  // DO 块的正文是句子里第一个字符串（DO $$…$$、DO LANGUAGE x '…'）
  let doBody = isWord(tokens[0], 'do')

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    const previous = tokens[i - 1]
    const next = tokens[i + 1]

    // 正文：CREATE FUNCTION … AS '…'/$$…$$，DO 块
    if (token.kind === 'string' && ((isFunction && isWord(previous, 'as')) || doBody)) {
      const inner = statements(token.text, token.line)
      nested.push(...(doBody ? inner : inner.map(item => ({ ...item, inFunction: true }))))
      doBody = false
      continue
    }

    // a.b：前面也是点的（a.b.c 的 b）不算
    if (anyWord(token) && isPunct(next, '.') && !isPunct(previous, '.')) {
      const after = tokens[i + 2]
      if (anyWord(after) || isPunct(after, '*')) {
        found.refs.push({ schema: token.text, name: after?.text ?? '*', line: token.line, references: isWord(previous, 'references') })
      }
    }

    // 别名：x AS 别名（后面不跟点和括号）；CTE 名字 AS [NOT] [MATERIALIZED] (
    if (isWord(token, 'as')) {
      if (anyWord(next) && !isPunct(tokens[i + 2], '.') && !isPunct(tokens[i + 2], '(')) found.aliases.push({ name: next.text, line: next.line })
      let k = i + 1
      if (isWord(tokens[k], 'not')) k++
      if (isWord(tokens[k], 'materialized')) k++
      if (isPunct(tokens[k], '(') && anyWord(previous)) found.aliases.push({ name: previous.text, line: previous.line })
    }

    // 写入：INSERT INTO、MERGE INTO、DELETE FROM、UPDATE [ONLY]、TRUNCATE [TABLE] [ONLY] 后面的关系
    const written =
      isWord(token, 'insert', 'merge') && isWord(next, 'into') ? i + 2
      : isWord(token, 'delete') && isWord(next, 'from') ? i + 2
      : isWord(token, 'update') ? i + 1
      : isWord(token, 'truncate') ? i + (isWord(next, 'table') ? 2 : 1)
      : -1
    if (written !== -1) {
      const k = isWord(tokens[written], 'only') ? written + 1 : written
      const name = isWord(tokens[k]) && NOT_RELATION.has((tokens[k] as Extract<Token, { kind: 'word' }>).text) ? undefined : qualified(tokens, k)
      if (name) found.writes.push(name)
    }

    // FROM/JOIN/UPDATE/USING/INTO 后面的关系不写 AS 的别名：关系 别名[, 关系 别名…]
    if (isWord(token, 'from', 'join', 'update', 'using', 'into')) {
      let k = i + 1
      for (;;) {
        while (isWord(tokens[k], 'only', 'lateral')) k++
        const first = tokens[k]
        if (anyWord(first) && !(isWord(first) && NOT_RELATION.has(first.text))) {
          k++
          while (isPunct(tokens[k], '.') && anyWord(tokens[k + 1])) k += 2
        } else if (!isPunct(first, '(')) break
        const relation = anyWord(first) ? (tokens[k - 1] as Extract<Token, { kind: 'word' }>) : undefined
        const call = isPunct(tokens[k], '(')
        if (call) k = closing(tokens, k) + 1
        const alias = tokens[k]
        if (anyWord(alias) && !isWord(alias, 'as') && !(isWord(alias) && NOT_ALIAS.has(alias.text))) {
          found.aliases.push({ name: alias.text, line: alias.line })
          k++
        } else if (relation && !call && !isWord(alias, 'as')) found.relations.push({ name: relation.text, line: relation.line })
        if (!isPunct(tokens[k], ',')) break
        k++
      }
    }
  }

  // 建、改、删的对象：CREATE [修饰] 种类 [IF NOT EXISTS] 名字；ALTER 种类 [IF EXISTS] [ONLY] 名字；DROP 种类 [IF EXISTS] 名字[, 名字…]
  const action = isWord(tokens[0], 'create', 'alter', 'drop') ? (tokens[0] as Extract<Token, { kind: 'word' }>).text : undefined
  if (action) {
    let k = 1
    while (action === 'create' && isWord(tokens[k]) && MODIFIERS.has((tokens[k] as Extract<Token, { kind: 'word' }>).text)) k++
    if (action !== 'create' && isWord(tokens[k], 'materialized')) k++
    const kind = isWord(tokens[k]) ? (tokens[k] as Extract<Token, { kind: 'word' }>).text : undefined
    if (kind && KINDS.has(kind)) {
      k++
      if (isWord(tokens[k], 'if')) k += isWord(tokens[k + 1], 'not') ? 3 : 2
      if (isWord(tokens[k], 'only')) k++
      found.view = action === 'create' && kind === 'view'
      for (;;) {
        const name = qualified(tokens, k)
        if (!name) break
        const target = kind === 'schema' ? { schema: name.name, name: name.name, line: name.line } : name
        found.targets.push(target)
        if (action === 'create' && kind === 'table') found.tables.push(target)
        if (action === 'create' && kind === 'schema') found.schemas.push(target)
        k += name.schema === undefined ? 1 : 3
        if (action !== 'drop' || !isPunct(tokens[k], ',')) break
        k++
      }
      // 挪 schema：ALTER 种类 名字 SET SCHEMA 新 schema
      const set = tokens.findIndex((item, index) => isWord(item, 'set') && isWord(tokens[index + 1], 'schema'))
      const moved = tokens[set + 2]
      const name = found.targets[0]
      if (action === 'alter' && set !== -1 && anyWord(moved) && name) {
        const target = { schema: moved.text, name: name.name, line: name.line }
        found.targets.push(target)
        if (kind === 'table') found.tables.push(target)
      }
    }
  }

  found.targets.push(...attachedTo(tokens))

  // 改 search_path：SET [SESSION|LOCAL] search_path …（也包括 ALTER ROLE/DATABASE … SET search_path）、RESET search_path、set_config('search_path', …)。
  // 建函数、改函数时的 SET search_path 是函数自己的设置，不算
  const altersFunction = isWord(tokens[0], 'alter') && isWord(tokens[1], 'function', 'procedure', 'routine')
  const ownSetting = isFunction || altersFunction
  if (altersFunction && security(tokens) === 'invoker') {
    const name = qualified(tokens, 2)
    if (name) found.invoker = name
  }
  found.setsSearchPath = tokens.some((token, index) => {
    if (isWord(token, 'reset') && isWord(tokens[index + 1], 'search_path') && !ownSetting) return true
    if (isWord(token, 'set') && !ownSetting) {
      const at = isWord(tokens[index + 1], 'session', 'local') ? index + 2 : index + 1
      if (isWord(tokens[at], 'search_path')) return true
    }
    const value = tokens[index + 2]
    return isWord(token, 'set_config') && isPunct(tokens[index + 1], '(') && value?.kind === 'string' && value.text === 'search_path'
  })

  // 切身份：SET [SESSION|LOCAL] ROLE、SET [SESSION|LOCAL] SESSION AUTHORIZATION、RESET ROLE、RESET SESSION AUTHORIZATION、set_config('role', …)。
  // 角色、库上的 SET role 也算（登录时就切了）。建函数、改函数时的 SET role 是函数自己的设置，规则要求函数一律 SECURITY DEFINER，库会拒绝，不在这里算。
  // UPDATE … SET role = … 是给叫 role 的列赋值，不算
  const update = tokens.findIndex(token => isWord(token, 'update'))
  found.switchesRole = tokens.some((token, index) => {
    if (ownSetting && isWord(token, 'set', 'reset')) return false
    if (update !== -1 && update < index && isWord(token, 'set', 'reset')) return false
    if (isWord(token, 'reset')) return isWord(tokens[index + 1], 'role') || (isWord(tokens[index + 1], 'session') && isWord(tokens[index + 2], 'authorization'))
    if (isWord(token, 'set')) {
      const at = isWord(tokens[index + 1], 'local') || (isWord(tokens[index + 1], 'session') && !isWord(tokens[index + 2], 'authorization')) ? index + 2 : index + 1
      return isWord(tokens[at], 'role') || (isWord(tokens[at], 'session') && isWord(tokens[at + 1], 'authorization'))
    }
    const value = tokens[index + 2]
    return isWord(token, 'set_config') && isPunct(tokens[index + 1], '(') && value?.kind === 'string' && value.text.toLowerCase() === 'role'
  })

  if (isFunction) {
    const name = qualified(tokens, at + 1)
    if (name) found.function = { ...name, ...searchPath(tokens), securityDefiner: security(tokens) === 'definer' }
  }
  return [found, ...nested]
}

/** COMMENT ON、GRANT/REVOKE … ON 后面可以有的种类词。 */
const OBJECT_WORDS = new Set([
  'table', 'view', 'materialized', 'foreign', 'function', 'procedure', 'routine', 'sequence', 'type', 'domain', 'aggregate', 'index', 'schema', 'column',
  'large', 'object',
])

/**
 * 挂在别的对象上、或者改别的对象的句子，给出那个对象：CREATE TRIGGER/POLICY/INDEX … ON 名字、CREATE RULE … TO 名字；
 * COMMENT ON [种类] 名字（COMMENT ON TRIGGER/POLICY/RULE/CONSTRAINT 名字 ON 表）；GRANT/REVOKE … ON [种类] 名字[, …] 或 ON ALL … IN SCHEMA s。
 */
function attachedTo(tokens: Token[]): Name[] {
  const onAfter = (from: number): number => tokens.findIndex((token, index) => index >= from && isWord(token, 'on'))
  const word = (k: number): string | undefined => (isWord(tokens[k]) ? (tokens[k] as Extract<Token, { kind: 'word' }>).text : undefined)
  if (isWord(tokens[0], 'create')) {
    let k = 1
    while (word(k) && (MODIFIERS.has(word(k) as string) || word(k) === 'constraint')) k++
    const kind = word(k)
    if (kind === 'rule') {
      const on = onAfter(k)
      const to = tokens.findIndex((token, index) => index > on && on !== -1 && isWord(token, 'to'))
      const name = to === -1 ? undefined : qualified(tokens, to + 1)
      return name ? [name] : []
    }
    if (kind === 'trigger' || kind === 'policy' || kind === 'index') {
      const on = onAfter(k)
      const name = on === -1 ? undefined : qualified(tokens, isWord(tokens[on + 1], 'only') ? on + 2 : on + 1)
      return name ? [name] : []
    }
    return []
  }
  if (isWord(tokens[0], 'comment') && isWord(tokens[1], 'on')) {
    let k = 2
    if (isWord(tokens[k], 'trigger', 'policy', 'rule', 'constraint')) {
      const on = onAfter(k + 1)
      const name = on === -1 ? undefined : qualified(tokens, on + 1)
      return name ? [name] : []
    }
    const column = isWord(tokens[k], 'column')
    const schema = isWord(tokens[k], 'schema')
    while (word(k) && OBJECT_WORDS.has(word(k) as string) && !isPunct(tokens[k + 1], '.')) k++
    const parts = dotted(tokens, k)
    if (column) parts.pop()
    if (schema && parts[0]) return [{ schema: parts[0].text, name: parts[0].text, line: parts[0].line }]
    return parts.length >= 2 ? [{ schema: (parts[0] as Extract<Token, { kind: 'word' }>).text, name: (parts[1] as Extract<Token, { kind: 'word' }>).text, line: (parts[0] as Token).line }] : []
  }
  if (isWord(tokens[0], 'grant', 'revoke')) {
    const on = onAfter(1)
    if (on === -1) return []
    const inSchema = tokens.findIndex((token, index) => index > on && isWord(token, 'in') && isWord(tokens[index + 1], 'schema'))
    if (isWord(tokens[on + 1], 'all') && inSchema !== -1) {
      const schema = tokens[inSchema + 2]
      return anyWord(schema) ? [{ schema: schema.text, name: schema.text, line: schema.line }] : []
    }
    let k = on + 1
    const schemaKind = isWord(tokens[k], 'schema')
    while (word(k) && OBJECT_WORDS.has(word(k) as string) && !isPunct(tokens[k + 1], '.')) k++
    const names: Name[] = []
    for (;;) {
      const name = qualified(tokens, k)
      if (!name) break
      names.push(schemaKind ? { schema: name.name, name: name.name, line: name.line } : name)
      k += name.schema === undefined ? 1 : 3
      if (isPunct(tokens[k], '(')) k = closing(tokens, k) + 1
      if (!isPunct(tokens[k], ',')) break
      k++
    }
    return names
  }
  return []
}

/** 点连起来的名字的各段：a.b.c。 */
function dotted(tokens: Token[], k: number): Array<Extract<Token, { kind: 'word' }>> {
  const parts: Array<Extract<Token, { kind: 'word' }>> = []
  let token = tokens[k]
  while (anyWord(token)) {
    parts.push(token)
    if (!isPunct(tokens[k + 1], '.')) break
    k += 2
    token = tokens[k]
  }
  return parts
}

/** 名字或 schema.名字。 */
function qualified(tokens: Token[], k: number): { schema?: string; name: string; line: number } | undefined {
  const first = tokens[k]
  if (!anyWord(first)) return undefined
  const second = tokens[k + 2]
  if (isPunct(tokens[k + 1], '.') && anyWord(second)) return { schema: first.text, name: second.text, line: first.line }
  return { name: first.text, line: first.line }
}

/** 建函数、改函数时写的 [EXTERNAL] SECURITY DEFINER / INVOKER。正文是字符串，不会误认。 */
function security(tokens: Token[]): 'definer' | 'invoker' | undefined {
  const at = tokens.findIndex((item, index) => isWord(item, 'security') && isWord(tokens[index + 1], 'definer', 'invoker'))
  return at === -1 ? undefined : ((tokens[at + 1] as Extract<Token, { kind: 'word' }>).text as 'definer' | 'invoker')
}

/** 函数定义里 SET search_path = / TO 后面的值（逗号分开）。FROM CURRENT 给出空列表。 */
function searchPath(tokens: Token[]): { searchPath?: string[] } {
  const set = tokens.findIndex((item, index) => isWord(item, 'set') && isWord(tokens[index + 1], 'search_path'))
  if (set === -1) return {}
  let k = set + 2
  if (!isPunct(tokens[k], '=') && !isWord(tokens[k], 'to')) return { searchPath: [] }
  k++
  const values: string[] = []
  for (;;) {
    const value = tokens[k]
    if (isWord(value, 'from')) break
    if (value?.kind !== 'word' && value?.kind !== 'string') break
    values.push(value.text)
    if (!isPunct(tokens[k + 1], ',')) break
    k += 2
  }
  return { searchPath: values }
}

/** 从开括号找到配对的闭括号；没配上就到末尾。 */
function closing(tokens: Token[], open: number): number {
  let depth = 0
  for (let k = open; k < tokens.length; k++) {
    if (isPunct(tokens[k], '(')) depth++
    else if (isPunct(tokens[k], ')') && --depth === 0) return k
  }
  return tokens.length - 1
}

/** 库里存的 search_path 设置（proconfig 里 search_path= 后面那段）：逗号分开，双引号里的照原样。 */
export function parseSearchPath(value: string): string[] {
  const items: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string
    if (c === '"') {
      if (quoted && value[i + 1] === '"') {
        current += '"'
        i++
      } else quoted = !quoted
    } else if (c === ',' && !quoted) {
      items.push(current.trim())
      current = ''
    } else current += c
  }
  items.push(current.trim())
  return items.filter(item => item !== '')
}
