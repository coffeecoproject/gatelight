// testpace.json 里归"跑测试"的部分：三条命令（fast、files、full）和找测试文件的规则（tests）。
// 文件本身、ignore 和未知字段由底座读（base/contract.ts）；这里校验自己的字段，交给底座合到一起。

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { type Contract, CONTRACT_FILE, countedIgnore, loadContract, parseContract } from '../base/contract.ts'
import { PROJECT_ENV } from '../base/execute.ts'

export const COMMAND_KEYS = ['fast', 'files', 'full'] as const
export type CommandKey = (typeof COMMAND_KEYS)[number]
/** testpace.json 里归这个模块的字段。 */
export const FIELDS = [...COMMAND_KEYS, 'tests'] as const

/** 接入说明（插件里的 setup 技能）。没有 testpace.json 时指给 agent 看，Codex 这类没有技能的环境也能直接读。 */
export const SETUP_GUIDE = fileURLToPath(new URL('../../skills/setup/SKILL.md', import.meta.url))

export interface Config {
  fast?: string
  files?: string
  /** 整组里测试以外的检查（类型检查、构建这些）。测试由 testpace 按 tests 找出来交给 files 跑。 */
  full?: string
  /** 找测试文件的路径规则；以 ! 开头的是排除。整组跑的就是它们找到的全部文件。 */
  tests: string[]
  /** 现在认的 ignore 规则（见 base/contract.ts 的 effectiveIgnore）。 */
  ignore: string[]
  /** 写了但要合并后才生效的 ignore 规则（分支上新加的）。 */
  deferredIgnore?: string[]
}

export interface LoadedConfig {
  config?: Config
  /** 配置本身的问题：文件缺失、格式不对、字段缺失或拼错。 */
  problems: string[]
}

/** 读这个模块的字段：写对的读出来，写得不对的说明问题。 */
function readFields(record: Record<string, unknown>): { fields: Omit<Config, 'ignore'>; problems: string[] } {
  const problems: string[] = []
  const fields: Omit<Config, 'ignore'> = { tests: [] }
  for (const key of COMMAND_KEYS) {
    const value = record[key]
    if (value === undefined) problems.push(`缺少 "${key}" 命令`)
    else if (typeof value !== 'string' || value.trim() === '') problems.push(`"${key}" 应该是非空字符串`)
    else fields[key] = value
  }
  const tests = record.tests
  if (tests === undefined) problems.push('缺少 "tests"：找测试文件的路径规则，比如 ["**/*.test.ts"]')
  else if (!Array.isArray(tests) || tests.length === 0 || tests.some(item => typeof item !== 'string' || item === '' || item === '!')) {
    problems.push('"tests" 应该是路径规则的非空字符串数组，以 ! 开头的是排除')
  } else if (tests.every(item => (item as string).startsWith('!'))) {
    problems.push('"tests" 里至少要有一条不以 ! 开头的规则')
  } else {
    fields.tests = tests as string[]
  }
  return { fields, problems }
}

/** 交给底座的校验（Module.contractProblems）。 */
export function contractProblems(raw: Record<string, unknown>): string[] {
  return readFields(raw).problems
}

/** 从底座读出的约定里取这个模块的配置。问题是整个文件的（底座的字段、各模块的字段合在一起）。 */
export function configOf(contract: Contract): LoadedConfig {
  if (!contract.raw) return { problems: contract.problems }
  return { config: { ...readFields(contract.raw).fields, ignore: contract.ignore }, problems: contract.problems }
}

/** 工作区里的约定。 */
export function loadConfig(root: string): LoadedConfig {
  const contract = loadContract(root)
  if (!contract) return { problems: [`仓库根目录没有 ${CONTRACT_FILE}，接入说明见 ${SETUP_GUIDE}`] }
  const loaded = configOf(contract)
  if (!loaded.config) return loaded
  // ignore 按默认分支上原来那份认：分支上新加的规则合并后才生效
  const { rules, deferred } = countedIgnore(root, contract)
  return { ...loaded, config: { ...loaded.config, ignore: rules, ...(deferred.length ? { deferredIgnore: deferred } : {}) } }
}

export function parseConfig(raw: unknown): LoadedConfig {
  return configOf(parseContract(raw))
}

/** 命令的第一个词（跳过开头的 `FOO=bar` 环境变量赋值）。 */
export function commandWord(command: string): string | undefined {
  for (const word of command.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    return word.replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

/** 在仓库根目录用 sh 的 `command -v` 找命令，内建命令、PATH 和相对路径都认。PATH 和跑项目命令时一样，testpace 自己也找得到。 */
export function commandExists(root: string, command: string): boolean {
  const word = commandWord(command)
  if (!word) return false
  try {
    execFileSync('/bin/sh', ['-c', 'command -v -- "$1"', 'sh', word], { cwd: root, env: PROJECT_ENV, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
