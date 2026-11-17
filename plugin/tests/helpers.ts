// 测试共用：示例项目副本、跑 testpace 命令、读记录。

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AGENTS } from '../src/agent.ts'
import { HOOK_COMMAND } from '../src/gate.ts'

export const BIN = fileURLToPath(new URL('../bin/testpace', import.meta.url))
/** 插件的 bin 目录：Claude Code 里它在 Bash 工具的 PATH 上，合并门的 git 钩子靠它找到 testpace。 */
export const BIN_DIR = fileURLToPath(new URL('../bin', import.meta.url))
export const SAMPLE = fileURLToPath(new URL('../../examples/sample', import.meta.url))

// 全局 git 配置换成测试自己的：合并门的钩子配在全局配置里，测试不读也不改用户真实的那份（~/.gitconfig）。
// 里面只放提交要用的身份；要全局配合并门的测试另给一份。
const globalConfigDir = mkdtempSync(join(tmpdir(), 'testpace-gitconfig-'))
export function globalGitConfig(): string {
  const file = join(mkdtempSync(join(globalConfigDir, 'c-')), 'gitconfig')
  writeFileSync(file, '[user]\n\tname = t\n\temail = t@t\n')
  return file
}
process.env.GIT_CONFIG_GLOBAL = globalGitConfig()

// node:test 会把 NODE_TEST_CONTEXT 传给子进程，示例项目里的 node --test 看到它就跳过所有测试文件。
// 插件数据目录也不带：测试不写真实的会话记录。Codex 的目录（CODEX_HOME，固定入口按它找 Codex 装的插件）也不带。
// 各 agent 的标记、会话号、沙箱变量也不带（在 Claude Code、Codex 里跑测试时有）：
// 测试里的 git 命令默认是用户在终端里的操作，要当成 agent 的命令时测试自己给。
const DROPPED = new Set([
  'NODE_TEST_CONTEXT',
  'CLAUDE_PLUGIN_DATA',
  'CODEX_HOME',
  ...Object.values(AGENTS).flatMap(agent => [...agent.markers, agent.session, ...(agent.sandbox ? [agent.sandbox] : [])]),
])
export const ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !DROPPED.has(key)))

export interface Result {
  code: number | null
  out: string
}

export function testpace(cwd: string, args: string[], env: NodeJS.ProcessEnv = ENV): Result {
  const r = spawnSync(BIN, args, { cwd, env, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

export function sh(cwd: string, script: string): string {
  return execFileSync('/bin/sh', ['-c', script], { cwd, encoding: 'utf8', env: ENV })
}

export function runs(repo: string): Array<Record<string, unknown>> {
  const file = join(repo, '.git', 'testpace', 'runs.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

export function setConfig(repo: string, change: Record<string, unknown>): void {
  const config = JSON.parse(readFileSync(join(repo, 'testpace.json'), 'utf8'))
  writeFileSync(join(repo, 'testpace.json'), JSON.stringify({ ...config, ...change }))
}

const dirs: string[] = []

/** 测试结束时删掉的临时目录。 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

export const commit = (dir: string, message: string): string =>
  sh(dir, `git add -A && git -c user.name=t -c user.email=t@t commit -qm '${message}'`)

/** 复制示例项目，建成一个有一次提交的 git 仓库。 */
export function sampleRepo(): string {
  const dir = tempDir('testpace-sample-')
  cpSync(SAMPLE, dir, { recursive: true })
  sh(dir, 'git init -q -b main')
  commit(dir, 'init')
  return dir
}

/**
 * 示例项目副本，合并门在把关：钩子配在这个仓库自己的 git 配置里，和 testpace install 配在全局配置里一样生效，
 * 只是不影响别的测试仓库。
 */
export function gatedRepo(): string {
  const dir = sampleRepo()
  execFileSync('git', ['config', 'hook.testpace.event', 'reference-transaction'], { cwd: dir, env: ENV })
  execFileSync('git', ['config', 'hook.testpace.command', HOOK_COMMAND], { cwd: dir, env: ENV })
  const r = testpace(dir, ['status'])
  if (!/合并门：已装上/.test(r.out)) throw new Error(`合并门没在把关（测试要 git 2.54 以上）：\n${r.out}`)
  return dir
}

/**
 * 当成 agent 在 Claude Code 里跑的命令：带着 CLAUDECODE，PATH 上有 testpace。
 * env 只给要改的变量；给了 PATH 就整个换掉（不加这个插件的 bin 目录）。
 */
export function agent(cwd: string, script: string, env: NodeJS.ProcessEnv = {}): Result {
  const r = spawnSync('/bin/sh', ['-c', script], {
    cwd,
    env: { ...ENV, CLAUDECODE: '1', PATH: `${BIN_DIR}:${ENV.PATH}`, ...env },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

after(() => {
  for (const dir of [...dirs, globalConfigDir]) rmSync(dir, { recursive: true, force: true })
})
