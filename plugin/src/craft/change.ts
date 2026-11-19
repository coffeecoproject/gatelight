// 这次改动的全貌：分叉点、改了哪些文件、各是什么文件。weaken、prove、status、停止门共用。

import { posix } from 'node:path'
import { type Change, changesSince, fileAt, fileNow, forkPoint, isFileAt } from '../base/git.ts'
import { matchesAny } from '../base/glob.ts'
import { judgingFile } from '../base/judging.ts'
import { type Config, joined, loadConfig, readTestpace, TESTPACE_FILE, type TestpaceCommands } from './config.ts'
import { kindOf, type Kind, testSide } from './files.ts'
import { hash } from './store.ts'

export interface Changed extends Change {
  kind: Kind
  /** 改名前的路径是什么文件（status 为 R）。 */
  oldKind?: Kind
}

/** 这个改动属于测试这一侧：现在是，或者改名前是测试、测试辅助、测试数据。 */
export function onTestSide(change: Changed): boolean {
  return testSide(change.kind) || (change.oldKind !== undefined && testSide(change.oldKind))
}

/** 改的是 testpace.json 里 ignore 的文件（改名的，两头都是）：不影响测试。 */
export function ignoredChange(s: Snapshot, change: Changed): boolean {
  return matchesAny(change.path, s.ignored) && (change.oldPath === undefined || matchesAny(change.oldPath, s.ignored))
}

export interface Snapshot {
  root: string
  base: string
  branch: string
  /** 这次改动按它判的配置（见 config.ts 的 effectiveConfig）。 */
  config: Config
  problems: string[]
  /** 配置里分支上改了、这次不算的地方。 */
  deferred: string[]
  changes: Changed[]
  /** testpace.json 的命令现在和在分叉点上调到的脚本（改了就算改了测试的约定），见 contractOf。 */
  contractFiles: Set<string>
  /** 命令调到的 package.json 脚本名（现在和分叉点上的），见 contractOf。 */
  contractScripts: Set<string>
  /** 分叉点上 testpace.json 的 ignore：项目定下的、改了不影响测试的文件。分支上加的不算。 */
  ignored: string[]
  filesCommand?: string
}

export type Opened = { snapshot: Snapshot } | { problem: string; code: 'notJoined' | 'usage' }

export function open(root: string): Opened {
  const base = forkPoint(root)
  if ('problem' in base) {
    // 找不到分叉点时只看工作区：没有 .testcraft/ 就是没接入（testcraft weaken 是全局登记的，别的仓库照常过）
    if (!joined(root)) return { problem: '这个仓库没有接入 testcraft（没有 .testcraft/ 目录）', code: 'notJoined' }
    return { problem: base.problem, code: 'usage' }
  }
  if (!joined(root, base.commit)) return { problem: '这个仓库没有接入 testcraft（没有 .testcraft/ 目录）', code: 'notJoined' }
  const { config, problems, deferred } = loadConfig(root, base.commit)
  const changes = changesSince(root, base.commit).map(change => ({
    ...change,
    kind: kindOf(change.path, config),
    ...(change.oldPath ? { oldKind: kindOf(change.oldPath, config) } : {}),
  }))
  const testpace = judgingFile(root, base.commit, TESTPACE_FILE)
  const now = readTestpace(testpace.now)
  const current = contractOf(now, path => fileNow(root, path))
  const testpaceBefore = readTestpace(testpace.before)
  const before = contractOf(testpaceBefore, path =>
    isFileAt(root, base.commit, path) ? fileAt(root, base.commit, path) : undefined,
  )
  return {
    snapshot: {
      root,
      base: base.commit,
      branch: base.branch,
      config,
      problems,
      deferred,
      changes,
      contractFiles: new Set([...current.files, ...before.files]),
      contractScripts: new Set([...current.scripts, ...before.scripts]),
      ignored: testpaceBefore?.ignore ?? [],
      ...(now?.files ? { filesCommand: now.files } : {}),
    },
  }
}

/** 命令里写到的仓库内文件（只认路径的样子，必须是普通文件）。 */
const FILE_TOKEN = /(?:^|[\s"'=(])((?:\.\/)?[\w.-]+(?:\/[\w.-]+)+|[\w-]+\.(?:sh|mjs|cjs|js|ts|py|ya?ml|json))(?=$|[\s"');])/gm
/** 用变量拼的路径：`${dir}/x.sh`、`$(dirname "$0")/x.sh`、`$DIR/x.sh`，取后面那段。 */
const VAR_PATH = /(?:\}|\)|\$\w+)\/((?:[\w.-]+\/)*[\w.-]+)(?=$|[\s"');])/gm
/** shell 脚本里，紧跟在这些命令后面的文件是脚本要跑的（不是 .sh 的也算，比如 node scripts/check.mjs）。 */
const RUNS_FILE = /(?:^|[\s;&|(])(?:node|bash|sh|zsh|python3?|tsx|ts-node|bun|deno\s+run|npx\s+tsx|exec|source|\.)\s+(?:-[\w-]+(?:[= ][^\s-]\S*)?\s+)*["']?$/
/** 放脚本的目录。 */
const SCRIPT_DIR = /(^|\/)(scripts?|tools?|ci|bin)\//
/** 命令里调到的 package.json 脚本：npm run x、pnpm x、pnpm --filter web x、yarn workspace web x、npm test。 */
const SCRIPT_CALL =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:--filter|-F|--dir|-C|--prefix)[\s=]\S+\s+|workspace\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*(?:run(?:-script)?\s+(?:--?[\w-]+\s+)*)?([\w:.-]+)/g

export interface Contract {
  /** 测试的约定文件。 */
  files: Set<string>
  /** 命令调到的 package.json 脚本名（连同 pre、post）：哪个 package.json 里的同名脚本改了都算改约定。 */
  scripts: Set<string>
}

/** 去掉 shell 脚本的注释：整行的、行尾的（# 前面是空白）。 */
function shellCode(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/(^|\s)#.*$/, ''))
    .join('\n')
}

/**
 * 测试的约定：testpace.json 的三条命令直接写到的文件；命令调到的 package.json 脚本（连同脚本再调的脚本）写到的文件；
 * 这些 shell 脚本再调到的 .sh 文件、交给 node、python 这类命令跑的文件和 package.json 脚本（注释里提到的不算）。
 * 不去别的文件正文里猜路径（会把业务代码、迁移当成约定）。
 * 别的约定文件（比如测试用的 compose 文件）写在 .testcraft/config.json 的 "contract"。
 */
export function contractOf(commands: TestpaceCommands | undefined, read: (path: string) => string | undefined): Contract {
  const files = new Set<string>()
  const scripts = new Set<string>()
  if (!commands) return { files, scripts }
  let bodies: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(read('package.json') ?? '{}') as { scripts?: unknown }
    if (parsed.scripts && typeof parsed.scripts === 'object') bodies = parsed.scripts as Record<string, unknown>
  } catch {
    // package.json 坏了：只看命令本身
  }
  /** script：这段文字是哪个 shell 脚本的内容（命令和 package.json 脚本为 undefined）。 */
  const queue: Array<{ text: string; depth: number; script?: string }> = [commands.fast, commands.files, commands.full]
    .filter((text): text is string => text !== undefined)
    .map(text => ({ text, depth: 0 }))
  const take = (path: string, depth: number): void => {
    if (files.has(path) || path.includes('node_modules') || path.startsWith('../')) return
    const content = read(path)
    if (content === undefined) return
    files.add(path)
    if (path.endsWith('.sh')) queue.push({ text: content, depth: depth + 1, script: path })
  }
  while (queue.length) {
    const { text: raw, depth, script } = queue.shift() as (typeof queue)[number]
    if (depth > 4) continue
    const text = script ? shellCode(raw) : raw
    // shell 脚本里只认 .sh 和交给 node 这类命令跑的文件；相对路径按仓库根目录找，找不到再按脚本所在目录找
    const wanted = (path: string, index: number): boolean => {
      if (!script || path.endsWith('.sh')) return true
      // 交给 node、python 这类命令跑的文件：只认脚本目录里的（和这个 shell 脚本同一个目录，或 scripts/、tools/ 这类目录），
      // 测试脚本起的业务代码（node src/server.mjs）不算
      const before = text.slice(text.lastIndexOf('\n', index - 1) + 1, index)
      if (!RUNS_FILE.test(before.slice(0, before.search(/\S*$/)))) return false
      const dir = posix.dirname(script)
      const file = posix.normalize(path.replace(/^\.\//, ''))
      return SCRIPT_DIR.test(file) || (dir !== '.' && (file.startsWith(`${dir}/`) || !file.includes('/')))
    }
    const resolveFrom = (path: string): string[] => {
      const plain = posix.normalize(path.replace(/^\.\//, ''))
      return script ? [plain, posix.normalize(posix.join(posix.dirname(script), plain))] : [plain]
    }
    for (const match of text.matchAll(FILE_TOKEN)) {
      const path = match[1] as string
      const index = (match.index as number) + match[0].indexOf(path)
      if (wanted(path, index)) for (const candidate of resolveFrom(path)) take(candidate, depth)
    }
    for (const match of text.matchAll(VAR_PATH)) {
      const path = match[1] as string
      // 变量多半是脚本所在目录，先按它找
      if (wanted(path, match.index as number)) for (const candidate of resolveFrom(path).reverse()) take(candidate, depth)
    }
    for (const match of text.matchAll(SCRIPT_CALL)) {
      const called = match[1] === 't' ? 'test' : (match[1] as string)
      for (const name of [`pre${called}`, called, `post${called}`]) {
        if (scripts.has(name)) continue
        scripts.add(name)
        const body = bodies[name]
        if (typeof body === 'string') queue.push({ text: body, depth: depth + 1 })
      }
    }
  }
  return { files, scripts }
}

/** 工作区里这些文件现在的内容摘要。 */
export function contentKey(root: string, base: string, paths: Iterable<string>, ...extra: string[]): string {
  const parts: Array<string | undefined> = [base, ...extra]
  for (const path of [...paths].sort()) parts.push(path, fileNow(root, path))
  return hash(...parts)
}
