// 测试共用：示例项目副本、跑 testpace 命令、读记录。

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { fileURLToPath } from 'node:url'
// 先装配：把检查模块登记给底座（测试里直接调 hook 的判断、读约定时要用）
import '../src/modules.ts'
import { AGENTS } from '../src/base/agent.ts'
import { HOOK_COMMAND } from '../src/base/gate.ts'

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

// 家目录也换成测试自己的：固定命令入口放在 ~/.local/bin 下（testpace、modwall、testcraft，base/entry.ts），会话说明要看它在不在、是不是这一版放的。
// 测试不读也不改用户真实的那份；要测入口的测试另给一个家目录。测试起的命令（ENV）跟着用这个。
// 这层隔离要比"会写家目录的代码"先落到默认分支（见 .testcraft/checklist/outside-repo-writes.md）。
// npm 放在家目录里的两样（下载缓存、用户设置）接着用用户的：模块边界的测试真起 layermap，它在一个新的缓存目录里
// 头一次跑要用 npm 装自己（tests/wall/helpers.ts 给的是临时目录）。缓存跟着家目录换掉的话，每个测试文件都整包重新下载。
process.env.npm_config_cache ??= join(homedir(), '.npm')
process.env.npm_config_userconfig ??= join(homedir(), '.npmrc')
const testHome = mkdtempSync(join(tmpdir(), 'testpace-home-'))
process.env.HOME = testHome

// node:test 会把 NODE_TEST_CONTEXT 传给子进程，示例项目里的 node --test 看到它就跳过所有测试文件。
// 插件数据目录也不带：测试不写真实的会话记录。Codex 的目录（CODEX_HOME，固定入口按它找 Codex 装的插件）也不带。
// 各 agent 的标记、会话号、沙箱变量也不带（在 Claude Code、Codex 里跑测试时有）：
// 测试里的 git 命令默认是用户在终端里的操作，要当成 agent 的命令时测试自己给。
const DROPPED = new Set([
  'NODE_TEST_CONTEXT',
  'CLAUDE_PLUGIN_DATA',
  'PLUGIN_DATA',
  'CODEX_HOME',
  // 外层 testpace 给的交结果的文件也不带：测试里起的 testpace run 不把结果交给跑这些测试的那次
  'TESTPACE_RESULTS',
  // 外层 testpace 这一轮的运行 id 也不带：测试里的 testpace hold 默认是终端里起的
  'TESTPACE_RUN',
  ...Object.values(AGENTS).flatMap(agent => [...agent.markers, agent.session, ...(agent.sandbox ? [agent.sandbox] : [])]),
])
export const ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !DROPPED.has(key)))
// 测试进程里直接调的 hook 判断也不写真实的会话记录：插件数据目录（Claude Code、Codex 的 CLAUDE_PLUGIN_DATA，Antigravity 的 PLUGIN_DATA）
// 从本进程的环境里也去掉，要的测试自己给临时目录。
delete process.env.CLAUDE_PLUGIN_DATA
delete process.env.PLUGIN_DATA

/** 在一段时间里换掉本进程的环境变量（hook 的判断在本进程里跑）；值为 undefined 的去掉。 */
export function withEnv<T>(change: Record<string, string | undefined>, run: () => T): T {
  const saved = Object.fromEntries(Object.keys(change).map(key => [key, process.env[key]]))
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  apply(change)
  try {
    return run()
  } finally {
    apply(saved)
  }
}

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

/**
 * 改工作区里的 testpace.json，不提交。要当成"项目本来就这样配"的，改完在默认分支上提交（commit）：
 * 留着不提交、或在分支上提交，是"这次改动改了约定"——改命令、缩小 tests 规则要用户同意后整组才跑，新加的 ignore 合并后才生效。
 */
export function setConfig(repo: string, change: Record<string, unknown>): void {
  const config = JSON.parse(readFileSync(join(repo, 'testpace.json'), 'utf8'))
  writeFileSync(join(repo, 'testpace.json'), JSON.stringify({ ...config, ...change }))
}

const dirs: string[] = []

/** 测试里加进整组的一段：一条 sh 命令；borrows 是它要借用工作区（底座给它这一轮的运行 id）。 */
export interface ExtraStep {
  command: string
  borrows?: boolean
}

/**
 * 起一次整组，最前面多几段：一个只在测试里有的模块交出这几段，排在插件自己的模块之前。
 * 用来测底座怎么跑各模块交的段（顺序、一段没过就停、借用工作区），不靠哪个具体的检查模块。
 * 返回要起的程序和参数（在仓库目录里起，等同 testpace full）。
 */
export function fullWithSteps(steps: ExtraStep[]): { program: string; args: string[] } {
  const src = fileURLToPath(new URL('../src', import.meta.url))
  const extra = steps.map((step, index) => ({
    kind: 'extra',
    name: `加的第 ${index + 1} 段`,
    title: `加的段 ${step.command}`,
    header: `加的段：${step.command}`,
    command: step.command,
    args: [],
    ...(step.borrows ? { borrows: true } : {}),
  }))
  const file = join(tempDir('testpace-full-'), 'full.mjs')
  writeFileSync(
    file,
    [
      `import ${JSON.stringify(`${src}/modules.ts`)}`,
      `import { EXIT } from ${JSON.stringify(`${src}/base/exit.ts`)}`,
      `import { full } from ${JSON.stringify(`${src}/base/full.ts`)}`,
      `import { modules, registerModules } from ${JSON.stringify(`${src}/base/module.ts`)}`,
      `import { openRepo } from ${JSON.stringify(`${src}/base/repo.ts`)}`,
      `registerModules([{ name: 'extra', fullPart: () => ({ steps: ${JSON.stringify(extra)} }) }, ...modules()])`,
      'const repo = openRepo(process.cwd())',
      'process.exitCode = repo ? await full(repo, undefined) : EXIT.usage',
      '',
    ].join('\n'),
  )
  return { program: process.execPath, args: ['--disable-warning=ExperimentalWarning', file] }
}

/**
 * 当成由 testpace 的 files、focused、full 起的 testpace run：给它交结果的位置（见 results.ts），跑完读出交回的结果，
 * 每个写成 "结果 名字"（重试后才过的结果后加" 重试后"），排好序。
 */
export function reported(cwd: string, args: string[], env: NodeJS.ProcessEnv = ENV): { code: number | null; out: string; results: string[] } {
  const file = join(tempDir('testpace-results-'), 'results.jsonl')
  const r = spawnSync(BIN, args, { cwd, env: { ...env, TESTPACE_RESULTS: file }, encoding: 'utf8' })
  const results = existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
        const { name, status, retried } = JSON.parse(line) as { name: string; status: string; retried?: boolean }
        return `${status}${retried ? ' 重试后' : ''} ${name}`
      })
    : []
  return { code: r.status, out: r.stdout + r.stderr, results: results.sort() }
}

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
after(() => rmSync(testHome, { recursive: true, force: true }))
