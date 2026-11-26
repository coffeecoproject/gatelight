// 读文件就能比的放松：.codekeep/config.json、eslint 的批量豁免文件、gitleaks 的忽略文件和配置、biome 的配置。和分叉点那一版比，
// 放松的列成条目交给底座的用户确认（base/confirm.ts）；收紧的（加检查、豁免变少）不问。
// eslint、tsconfig 生效的配置要跑工具才算得出来，见 eslint.ts、tsconfig.ts。
//
// 每一项的改之前、改成什么写成能区分同一项改动的内容：同一条检查的同一次改命令在哪个分支上都是同一项，共用一次同意；
// 删的、改的是另一份内容，就是另一项，要重新同意。

import type { ConfirmItem } from '../base/confirm.ts'
import type { Judging } from '../base/judging.ts'
import { hash } from '../base/records.ts'
import { CONFIG_PATH, type Config, KEEP_DIR } from './config.ts'
import { ruleName, stable } from './eslint.ts'

/** gitleaks 的忽略文件和配置（仓库根目录；gitleaks 在仓库根目录跑时用的就是这两个）。 */
export const GITLEAKS_IGNORE = '.gitleaksignore'
export const GITLEAKS_CONFIG = '.gitleaks.toml'
/** biome 的配置（仓库根目录）。第一期不比 biome 生效的规则，改了就按"程序看不出"问。 */
export const BIOME_CONFIGS = ['biome.json', 'biome.jsonc']

/** 删掉整个配置：before 是分叉点上能用的配置。 */
export function removedItem(before: Config, hasDir: boolean): ConfirmItem {
  return {
    before: stable(before),
    after: '',
    text: `${hasDir ? `删掉了配置文件 ${CONFIG_PATH}` : `删掉了整个 ${KEEP_DIR}/ 目录`}：以后不再跑规范检查（类型检查、lint、格式${before.secrets ? '、密钥扫描' : ''}），规范改松了也没人发现`,
  }
}

/** .codekeep/config.json 里放松的地方。 */
export function configItems(before: Config, now: Config): ConfirmItem[] {
  const items: ConfirmItem[] = []
  for (const check of before.checks) {
    // 命令一样的照样在跑，换了名字也不算放松
    if (now.checks.some(item => item.command === check.command)) continue
    const same = now.checks.find(item => item.name === check.name)
    if (same) {
      items.push({
        before: stable(['check', check.name, check.command]),
        after: stable(['check', same.name, same.command]),
        text: [`规范检查"${check.name}"的命令改了，程序看不出是改松还是改紧`, `原来：${check.command}`, `现在：${same.command}`].join('\n'),
      })
    } else {
      items.push({
        before: stable(['check', check.name, check.command]),
        after: '',
        text: [`删掉了规范检查"${check.name}"：以后整组里不再跑它`, `原来的命令：${check.command}`].join('\n'),
      })
    }
  }
  if (before.eslint) {
    if (!now.eslint) {
      items.push({ before: stable(['eslint', before.eslint]), after: '', text: '不再比 eslint 生效的规则（删掉了 eslint 一项）：以后 lint 规则改松了程序看不出来' })
    } else {
      if (now.eslint.config !== before.eslint.config) {
        items.push({
          before: stable(['eslint.config', before.eslint.config]),
          after: stable(['eslint.config', now.eslint.config]),
          text: `拿来比规则的 eslint 配置文件从 ${before.eslint.config} 换成了 ${now.eslint.config}：程序看不出两份是不是一回事，lint 实际用的可能不是这一份`,
        })
      }
      if (now.eslint.suppressions !== before.eslint.suppressions) {
        items.push({
          before: stable(['eslint.suppressions', before.eslint.suppressions]),
          after: stable(['eslint.suppressions', now.eslint.suppressions]),
          text: `eslint 的批量豁免文件从 ${before.eslint.suppressions} 换成了 ${now.eslint.suppressions}：换过去的那份里豁免了什么没和原来的比`,
        })
      }
    }
  }
  for (const tsconfig of before.tsconfig.filter(path => !now.tsconfig.includes(path))) {
    items.push({ before: stable(['tsconfig', tsconfig]), after: '', text: `不再比 ${tsconfig} 的严格选项：以后这份类型检查配置改松了程序看不出来` })
  }
  if (before.prettier && !now.prettier) {
    items.push({ before: stable(['prettier', true]), after: stable(['prettier', false]), text: '不再比格式检查查哪些文件（关掉了 prettier 一项）：以后往忽略文件里加路径、躲开格式检查，程序看不出来' })
  }
  if (before.secrets && !now.secrets) items.push({ before: stable(['secrets', true]), after: stable(['secrets', false]), text: '关掉了密钥扫描（secrets）：以后提交里带了密钥、密码，整组不再拦' })
  for (const path of before.styles?.theme.filter(item => !now.styles?.theme.includes(item)) ?? []) {
    items.push({ before: stable(['styles.theme', path]), after: '', text: `不再管主题文件 ${path}（从 styles 里去掉了）：以后改它不再问你` })
  }
  for (const dir of before.styles?.ui.filter(item => !now.styles?.ui.includes(item)) ?? []) {
    items.push({ before: stable(['styles.ui', dir]), after: '', text: `不再管组件层目录 ${dir} 里的样式文件（从 styles 里去掉了）：以后改这些样式不再问你` })
  }
  return items
}

/** 批量豁免文件：文件 → 规则 → 豁免了几处。读不出来时是 undefined。 */
type Suppressions = Map<string, number>

function suppressionsOf(text: string): Suppressions | undefined {
  try {
    const raw = JSON.parse(text) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const counts: Suppressions = new Map()
    for (const [file, rules] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof rules !== 'object' || rules === null) return undefined
      for (const [rule, entry] of Object.entries(rules as Record<string, unknown>)) {
        const count = (entry as { count?: unknown } | null)?.count
        if (typeof count !== 'number') return undefined
        counts.set(`${file}\0${rule}`, count)
      }
    }
    return counts
  } catch {
    return undefined
  }
}

/** 列出来的最多几处。 */
const SHOWN = 20

/** eslint 的批量豁免文件里，哪条规则、哪个文件豁免的数量变多了：合成一项。 */
export function suppressionsItem(path: string, judging: Judging): ConfirmItem | undefined {
  if (judging.now === undefined) return undefined
  const now = suppressionsOf(judging.now)
  const before = judging.before === undefined ? new Map<string, number>() : suppressionsOf(judging.before)
  if (!now || !before) {
    if (judging.before === judging.now) return undefined
    return {
      before: hash(judging.before),
      after: hash(judging.now),
      text: `eslint 的批量豁免文件 ${path} 改了，${!now ? '现在这一版' : '分叉点那一版'}读不出来，程序看不出是不是多豁免了`,
    }
  }
  const more = [...now].filter(([key, count]) => count > (before.get(key) ?? 0)).sort(([a], [b]) => (a < b ? -1 : 1))
  if (more.length === 0) return undefined
  const lines = more.slice(0, SHOWN).map(([key, count]) => {
    const [file, rule] = key.split('\0')
    return `${file}：${ruleName(rule ?? '')} 从 ${before.get(key) ?? 0} 处变成 ${count} 处`
  })
  if (more.length > SHOWN) lines.push(`……还有 ${more.length - SHOWN} 处`)
  return {
    before: stable(more.map(([key]) => [key, before.get(key) ?? 0])),
    after: stable(more),
    text: [`eslint 的批量豁免文件 ${path} 多豁免了 ${more.length} 处：这些地方违反了规则也照样通过`, ...lines].join('\n'),
  }
}

/** .gitleaksignore 的条目（每行一条，# 开头的是注释）。 */
const entries = (text: string | undefined): string[] =>
  (text ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))

/** gitleaks 的忽略文件多了条目、配置改了（配置是 TOML，程序看不出方向，改了就问）。 */
export function gitleaksItems(ignore: Judging, config: Judging): ConfirmItem[] {
  const items: ConfirmItem[] = []
  const before = entries(ignore.before)
  const added = [...new Set(entries(ignore.now).filter(line => !before.includes(line)))].sort()
  if (added.length) {
    items.push({
      before: '',
      after: stable(['gitleaksignore', added]),
      text: [`${GITLEAKS_IGNORE} 新加了 ${added.length} 条忽略：扫密钥时这些发现不再算`, ...added.slice(0, SHOWN), ...(added.length > SHOWN ? [`……还有 ${added.length - SHOWN} 条`] : [])].join('\n'),
    })
  }
  if (config.before !== config.now) {
    const what = config.before === undefined ? '新加了' : config.now === undefined ? '删掉了' : '改了'
    items.push({ before: hash(config.before), after: hash(config.now), text: `gitleaks 的配置 ${GITLEAKS_CONFIG} ${what}，程序看不出扫密钥是改松还是改紧` })
  }
  return items
}

/** biome 的配置改了（新加、删掉、改了内容）：第一期不比它生效的规则，程序看不出方向，改了就问。 */
export function biomeItem(path: string, config: Judging): ConfirmItem | undefined {
  if (config.before === config.now) return undefined
  const what = config.before === undefined ? '新加了' : config.now === undefined ? '删掉了' : '改了'
  return { before: hash(config.before), after: hash(config.now), text: `biome 的配置 ${path} ${what}，程序看不出 lint、格式规则是改松还是改紧` }
}
