// 读项目根目录的 testpace.json（项目约定，方案第 4 节）。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONFIG_FILE = 'testpace.json'
export const COMMAND_KEYS = ['fast', 'files', 'full'] as const
export type CommandKey = (typeof COMMAND_KEYS)[number]

/** 接入说明（插件里的 setup 技能）。没有 testpace.json 时指给 agent 看，Codex 这类没有技能的环境也能直接读。 */
export const SETUP_GUIDE = fileURLToPath(new URL('../skills/setup/SKILL.md', import.meta.url))

export interface Config {
  fast?: string
  files?: string
  full?: string
  ignore: string[]
}

export interface LoadedConfig {
  config?: Config
  /** 配置本身的问题：文件缺失、格式不对、字段缺失或拼错。 */
  problems: string[]
}

export function loadConfig(root: string): LoadedConfig {
  const path = join(root, CONFIG_FILE)
  if (!existsSync(path)) return { problems: [`仓库根目录没有 ${CONFIG_FILE}，接入说明见 ${SETUP_GUIDE}`] }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { problems: [`${CONFIG_FILE} 不是合法的 JSON：${(error as Error).message}`] }
  }
  return parseConfig(raw)
}

export function parseConfig(raw: unknown): LoadedConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problems: [`${CONFIG_FILE} 应该是一个对象`] }
  }
  const problems: string[] = []
  const config: Config = { ignore: [] }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(COMMAND_KEYS as readonly string[]).includes(key) && key !== 'ignore') problems.push(`未知字段 "${key}"`)
  }
  for (const key of COMMAND_KEYS) {
    const value = record[key]
    if (value === undefined) problems.push(`缺少 "${key}" 命令`)
    else if (typeof value !== 'string' || value.trim() === '') problems.push(`"${key}" 应该是非空字符串`)
    else config[key] = value
  }
  const ignore = record.ignore
  if (ignore !== undefined) {
    if (!Array.isArray(ignore) || ignore.some(item => typeof item !== 'string' || item === '')) {
      problems.push('"ignore" 应该是路径规则的字符串数组')
    } else {
      config.ignore = ignore as string[]
    }
  }
  return { config, problems }
}

/** 命令的第一个词（跳过开头的 `FOO=bar` 环境变量赋值）。 */
export function commandWord(command: string): string | undefined {
  for (const word of command.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    return word.replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

/** 在仓库根目录用 sh 的 `command -v` 找命令，内建命令、PATH 和相对路径都认。 */
export function commandExists(root: string, command: string): boolean {
  const word = commandWord(command)
  if (!word) return false
  try {
    execFileSync('/bin/sh', ['-c', 'command -v -- "$1"', 'sh', word], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
