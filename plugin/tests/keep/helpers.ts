// "代码规范"的测试共用：小的临时 git 仓库、跑 codekeep 命令、写文件、读要确认的条目。
// eslint、typescript 用 gatelight 仓库自己装着的那份（链接进临时仓库，不另外装）；环境和临时目录用整个插件测试共用的那份（../helpers.ts）。

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENV as BASE_ENV, tempDir } from '../helpers.ts'

export { tempDir }

export const BIN = fileURLToPath(new URL('../../bin/codekeep', import.meta.url))
/** testpace 的命令：接入了的仓库，整组（testpace full）里有"代码规范"的一段。 */
export const TESTPACE = fileURLToPath(new URL('../../bin/testpace', import.meta.url))
/** 钩子入口：整个插件只有一个，各模块的话都从它出去。 */
export const HOOK = fileURLToPath(new URL('../../hooks/testpace.ts', import.meta.url))

/** gatelight 仓库装着的 node_modules（里面有 eslint、typescript）：从这里往上找到的那份。 */
export const NODE_MODULES = ((): string => {
  const entry = createRequire(import.meta.url).resolve('eslint')
  return entry.slice(0, entry.lastIndexOf('/node_modules/') + '/node_modules'.length)
})()

export const ENV: NodeJS.ProcessEnv = BASE_ENV

export interface Result {
  code: number | null
  out: string
}

export function codekeep(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Result {
  const r = spawnSync(BIN, args, { cwd, env: { ...ENV, ...env }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

export function testpace(cwd: string, args: string[]): Result {
  const r = spawnSync(TESTPACE, args, { cwd, env: ENV, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

export function sh(cwd: string, script: string): string {
  return execFileSync('/bin/sh', ['-c', script], { cwd, encoding: 'utf8', env: ENV })
}

export function write(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

/** .codekeep/config.json 的内容。 */
export const keepConfig = (config: Record<string, unknown>): string => `${JSON.stringify(config, null, 2)}\n`

/** 一份只放 rules 的 eslint 配置：查全部 .js 文件，extra 是后面再加的配置对象（写成代码）。 */
export const eslintConfig = (rules: Record<string, unknown>, ...extra: string[]): string =>
  `export default [\n  { files: ['**/*.js'], rules: ${JSON.stringify(rules)} },\n${extra.map(item => `  ${item},\n`).join('')}]\n`

export interface RepoOptions {
  /** 仓库里的 node_modules 链到哪（默认 gatelight 装着的那份）；false 是不放。 */
  modules?: string | false
  /** 仓库放在这个目录下（默认一个新的临时目录）。 */
  parent?: string
}

/**
 * 一个新的 git 仓库：files 写进去提交到 main（分叉点），再切到 feature 分支。node_modules 是链接，不进版本库。
 */
export function keepRepo(files: Record<string, string>, options: RepoOptions = {}): string {
  const repo = join(options.parent ?? tempDir('codekeep-repo-'), 'repo')
  mkdirSync(repo, { recursive: true })
  write(repo, '.gitignore', 'node_modules\n')
  for (const [path, text] of Object.entries(files)) write(repo, path, text)
  const modules = options.modules ?? NODE_MODULES
  if (modules) symlinkSync(modules, join(repo, 'node_modules'), 'dir')
  sh(repo, 'git init -q -b main && git add -A && git commit -qm init && git checkout -qb feature')
  return repo
}

/** codekeep check 交给确认工具的编号和文字，以及弹窗里各项的头一行（去掉编号）。 */
export function pendingOf(out: string): { id: string; text: string; items: string[] } {
  const id = /^id：(\S+)$/m.exec(out)?.[1]
  const text = /^-----\n([\s\S]*?)\n-----$/m.exec(out)?.[1]
  if (!id || !text) throw new Error(`输出里没有要确认的编号和文字：\n${out}`)
  const items = text.split('\n').flatMap(line => /^\d+\. (.*)$/.exec(line)?.[1] ?? [])
  return { id, text, items }
}

/** 一个钩子事件（当成 Claude Code 发来的）：返回会话开始时说给 agent 的话。 */
export function sessionBrief(cwd: string): string {
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', HOOK, 'claude'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd }),
    env: ENV,
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim() ? String(JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '') : ''
}
