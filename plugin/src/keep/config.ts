// "代码规范"在项目里的配置：.codekeep/config.json。没有 .codekeep/ 目录的仓库没接入，它不出声、不加检查。
//   checks     规范检查的命令（类型检查、lint、格式），直接写工具命令，不经过项目的脚本；整组里依次跑
//   eslint     拿来比"生效的规则"的 eslint：config 是配置文件（按它对每个代码文件算生效的规则），
//              suppressions 是批量豁免文件（eslint --suppress-all 生成的，不写就是仓库根目录的 eslint-suppressions.json）
//   prettier   开着时比格式检查查哪些文件（prettier 在仓库根目录跑，查 git 收的文件）
//   tsconfig   拿来比严格选项的 tsconfig 文件
//   secrets    开着时整组里用 gitleaks 扫这次的提交和没提交的改动
//   styles     前端只准写在这里的具体外观：theme 是主题文件，ui 是组件层目录（只看里面的样式文件）；改了要用户同意（styles.ts）
// 这份配置是评判用的配置（base/judging.ts），走"用户同意后生效"：改松的地方见 loosen.ts。

import { existsSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileNow, hasFile } from '../base/git.ts'

export const KEEP_DIR = '.codekeep'
export const CONFIG_PATH = `${KEEP_DIR}/config.json`
/** eslint 批量豁免文件的默认位置（eslint 自己的默认名字，相对仓库根目录）。 */
export const DEFAULT_SUPPRESSIONS = 'eslint-suppressions.json'

export interface Check {
  name: string
  command: string
}

export interface EslintConfig {
  config: string
  suppressions: string
}

/** 主题文件和组件层目录：前端代码里具体的颜色、尺寸只准写在这两处。 */
export interface StylesConfig {
  theme: string[]
  ui: string[]
}

export interface Config {
  checks: Check[]
  eslint?: EslintConfig
  tsconfig: string[]
  prettier: boolean
  secrets: boolean
  styles?: StylesConfig
}

export interface Parsed {
  config?: Config
  problems: string[]
}

/** 接入了：分叉点或工作区里有 .codekeep/。 */
export function joined(root: string, fork?: string): boolean {
  return existsSync(join(root, KEEP_DIR)) || (fork !== undefined && hasFile(root, fork, KEEP_DIR))
}

const KEYS = ['checks', 'eslint', 'tsconfig', 'prettier', 'secrets', 'styles']
const ESLINT_KEYS = ['config', 'suppressions']
const STYLES_KEYS = ['theme', 'ui']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 仓库里的相对路径：去掉开头的 ./；不能是绝对路径，不能有 ..、空段、通配。 */
function relativePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const plain = value.replace(/^(?:\.\/)+/, '')
  if (plain === '' || plain.startsWith('/') || plain.includes('\\') || /[*?[\]{}]/.test(plain)) return undefined
  if (plain.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  return posix.normalize(plain) === plain ? plain : undefined
}

/**
 * 读配置的文字，只看写法（字段、类型、路径的写法），不看文件在不在：分叉点那一版也用它读。
 * 工作区这一版另用 missingFiles 查写到的文件在不在。
 */
export function parseConfig(text: string): Parsed {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { problems: [`${CONFIG_PATH} 不是合法的 JSON：${(error as Error).message}`] }
  }
  if (!isRecord(raw)) return { problems: [`${CONFIG_PATH} 应该是一个对象`] }
  const problems: string[] = []
  const extra = Object.keys(raw).filter(key => !KEYS.includes(key))
  if (extra.length) problems.push(`${CONFIG_PATH} 有未知字段 ${extra.map(key => `"${key}"`).join('、')}（认得的有 ${KEYS.join('、')}）`)

  const checks: Check[] = []
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    problems.push(`${CONFIG_PATH} 的 "checks" 要写成非空数组，每条 { "name": 名字, "command": 命令 }`)
  } else {
    raw.checks.forEach((item: unknown, index) => {
      const where = `checks 的第 ${index + 1} 条`
      if (!isRecord(item)) return void problems.push(`${where} 应该是 { "name": 名字, "command": 命令 }`)
      const unknown = Object.keys(item).filter(key => key !== 'name' && key !== 'command')
      if (unknown.length) problems.push(`${where} 有未知字段 ${unknown.map(key => `"${key}"`).join('、')}`)
      const { name, command } = item
      if (typeof name !== 'string' || name.trim() === '' || /[\n\r]/.test(name)) return void problems.push(`${where} 要写名字（name，一行）`)
      if (typeof command !== 'string' || command.trim() === '') return void problems.push(`${where}（${name}）要写命令（command）`)
      if (checks.some(check => check.name === name.trim())) return void problems.push(`${where} 的名字 "${name}" 和前面的重复了`)
      checks.push({ name: name.trim(), command: command.trim() })
    })
  }

  let eslint: EslintConfig | undefined
  if (raw.eslint !== undefined) {
    const value = raw.eslint
    if (!isRecord(value)) problems.push(`${CONFIG_PATH} 的 "eslint" 应该是 { "config": 配置文件, "suppressions": 豁免文件（可选） }`)
    else {
      const unknown = Object.keys(value).filter(key => !ESLINT_KEYS.includes(key))
      if (unknown.length) problems.push(`${CONFIG_PATH} 的 "eslint" 有未知字段 ${unknown.map(key => `"${key}"`).join('、')}`)
      const config = relativePath(value.config)
      if (config === undefined) problems.push(`${CONFIG_PATH} 的 "eslint.config" 要写 eslint 配置文件（仓库里的相对路径，比如 "eslint.config.mjs"）`)
      const suppressions = value.suppressions === undefined ? DEFAULT_SUPPRESSIONS : relativePath(value.suppressions)
      if (suppressions === undefined) problems.push(`${CONFIG_PATH} 的 "eslint.suppressions" 要写批量豁免文件（仓库里的相对路径）`)
      if (config !== undefined && suppressions !== undefined) eslint = { config, suppressions }
    }
  }

  const tsconfig = raw.tsconfig === undefined ? [] : paths(raw.tsconfig, 'tsconfig', 'tsconfig 文件', problems)
  for (const key of ['prettier', 'secrets']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') problems.push(`${CONFIG_PATH} 的 "${key}" 要写 true 或 false`)
  }

  const styles = raw.styles === undefined ? undefined : stylesOf(raw.styles, problems)

  if (problems.length || tsconfig === undefined) return { problems }
  return {
    config: { checks, ...(eslint ? { eslint } : {}), tsconfig, prettier: raw.prettier === true, secrets: raw.secrets === true, ...(styles ? { styles } : {}) },
    problems,
  }
}

/** "styles"：theme、ui 各是一组路径，至少写一组。 */
function stylesOf(value: unknown, problems: string[]): StylesConfig | undefined {
  const shape = `{ "theme": [主题文件], "ui": [组件层目录] }`
  if (!isRecord(value)) return void problems.push(`${CONFIG_PATH} 的 "styles" 应该是 ${shape}`)
  const unknown = Object.keys(value).filter(key => !STYLES_KEYS.includes(key))
  if (unknown.length) problems.push(`${CONFIG_PATH} 的 "styles" 有未知字段 ${unknown.map(key => `"${key}"`).join('、')}`)
  if (value.theme === undefined && value.ui === undefined) return void problems.push(`${CONFIG_PATH} 的 "styles" 要写 theme、ui 里的至少一项：${shape}`)
  const theme = value.theme === undefined ? [] : paths(value.theme, 'styles.theme', '主题文件', problems)
  const ui = value.ui === undefined ? [] : paths(value.ui, 'styles.ui', '组件层目录', problems)
  return theme && ui ? { theme, ui } : undefined
}

/** 一组仓库里的文件：非空数组，不重复。 */
function paths(value: unknown, name: string, what: string, problems: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${CONFIG_PATH} 的 "${name}" 要写成非空数组，每项是${what}（仓库里的相对路径）`)
    return undefined
  }
  const found = problems.length
  const result: string[] = []
  for (const item of value) {
    const path = relativePath(item)
    if (path === undefined) problems.push(`${name} 里的 ${JSON.stringify(item)} 要写${what}（仓库里的相对路径，不用通配）`)
    else if (result.includes(path)) problems.push(`${name} 里的 "${path}" 写了两次`)
    else result.push(path)
  }
  return problems.length > found ? undefined : result
}

/** 工作区这一版配置里写到、却不在的文件和目录（批量豁免文件可以还没有）。 */
export function missingFiles(root: string, config: Config): string[] {
  const listed = [...(config.eslint ? [config.eslint.config] : []), ...config.tsconfig, ...(config.styles?.theme ?? [])]
  const dirs = config.styles?.ui ?? []
  return [
    ...listed.filter(path => fileNow(root, path) === undefined).map(path => `${CONFIG_PATH} 里写的 ${path} 不在（要写仓库里现有的文件）`),
    ...dirs.filter(dir => !statSync(join(root, dir), { throwIfNoEntry: false })?.isDirectory()).map(dir => `${CONFIG_PATH} 里写的 ${dir} 不在（要写仓库里现有的目录）`),
  ]
}
