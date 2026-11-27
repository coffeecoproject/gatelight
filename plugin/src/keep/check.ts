// codekeep check：整组里"代码规范"的那一段（见 full.ts），也可以单独跑。依次做下面几件事：1、2 没过就停（配置不对、放松没同意，后面查了也不算）；
// 3–5 互不依赖，一项没过也接着查，最后一起列出没过的。
//   1. 配置写得对不对（.codekeep/config.json），写到的文件在不在；现在这一版 eslint、prettier、tsconfig 生效的配置算不算得出来；
//   2. 和分叉点比，规范改松了哪些（loosen.ts、eslint.ts、prettier.ts、tsconfig.ts；biome 只看配置文件改没改），主题、组件层的样式改了哪些（styles.ts）。放松的条目交给底座的用户确认（askUser），
//      还没同意的这一段不过，照底座给的话让 agent 调确认工具。分叉点上还没有配置（首次接入）的不比、不问。
//      分叉点那一版算不出来的（工具在那一版上跑不起来），不当成没放松，列成"程序看不出"的一项，问。
//   3. 配了 eslint 的，用项目自己的 eslint 程序接口跑一遍 lint，有错误就不过（警告不拦）；eslint 起不来时停（环境问题）。不跑项目写的 lint 命令：
//      命令行会读批量豁免文件（放在哪、叫什么、写成目录都行），从外面猜不全；程序接口不读，查出来的就是代码按规则过没过。
//   4. 依次跑 checks 里的每条命令（从仓库根目录用 sh 跑）。
//   5. secrets 开着时用 gitleaks 扫这次改动（secrets.ts）。
// 退出码用底座的：0 通过；1 没通过；2 配置、环境问题（配置写错、工具没装、算不出分叉点）。

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { askUser, type ConfirmItem } from '../base/confirm.ts'
import { EXIT } from '../base/exit.ts'
import { PROJECT_ENV } from '../base/execute.ts'
import { filesNow, forkPoint } from '../base/git.ts'
import { judgingFile } from '../base/judging.ts'
import { hash } from '../base/records.ts'
import type { Repo } from '../base/repo.ts'
import { type Config, CONFIG_PATH, joined, KEEP_DIR, missingFiles, parseConfig } from './config.ts'
import { eslintItems, type FileRules, fileRules, isCode, lint, type Linted, loadEslint, stable } from './eslint.ts'
import { withForkTree } from './forktree.ts'
import { BIOME_CONFIGS, biomeItem, configItems, GITLEAKS_CONFIG, GITLEAKS_IGNORE, gitleaksItems, removedItem } from './loosen.ts'
import { checkedFiles, loadPrettier, prettierItem } from './prettier.ts'
import { scanSecrets } from './secrets.ts'
import { stylesItems } from './styles.ts'
import { findTsc, type TsSettings, tsconfigItem, tsSettings } from './tsconfig.ts'

/** 弹窗开头说这是什么的半句。 */
const HEADING = '这次改动里放松代码规范的地方'

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''

/** 现在这一版 eslint、prettier、tsconfig 生效的配置。files 是工作区里现有的文件。 */
interface NowSide {
  files: string[]
  eslint?: FileRules
  prettier?: Set<string>
  tsconfig: Map<string, TsSettings>
}

/** 现在这一版算出来；算不出来的、eslint 一个文件都不查的说清楚（配置、环境问题）。 */
async function nowSide(root: string, config: Config): Promise<NowSide | { problems: string[] }> {
  const problems: string[] = []
  const side: NowSide = { files: filesNow(root), tsconfig: new Map() }
  if (config.eslint) {
    try {
      const eslint = await loadEslint(root, config.eslint.config)
      side.eslint = await fileRules(eslint, root, config.eslint.config, side.files.filter(isCode))
      if (![...side.eslint.values()].some(Boolean)) problems.push(`${config.eslint.config} 一个代码文件都没 lint 到（都被忽略了，或配置没覆盖它们）`)
    } catch (error) {
      problems.push(`eslint 生效的规则算不出来（${config.eslint.config}）：${firstLine(error)}`)
    }
  }
  if (config.prettier) {
    try {
      side.prettier = await checkedFiles(await loadPrettier(root), root, side.files)
    } catch (error) {
      problems.push(`格式检查查哪些文件算不出来（prettier）：${firstLine(error)}`)
    }
  }
  for (const path of config.tsconfig) {
    try {
      side.tsconfig.set(path, tsSettings(findTsc(root, path), root, path))
    } catch (error) {
      problems.push(`${path} 生效的选项算不出来：${firstLine(error)}`)
    }
  }
  return problems.length ? { problems } : side
}

/** 放松的条目，和分叉点那一版算不出来的原因（只给 agent 看，不进弹窗）。 */
interface Loosened {
  items: ConfirmItem[]
  reasons: string[]
}

/** 分叉点那一版算不出来：列成"程序看不出"的一项。同意过一次后，现在这一版算出来的不变就不再问。 */
function unknownItem(kind: string, before: unknown, now: unknown, text: string): ConfirmItem {
  return { before: stable([kind, before]), after: hash(stable([kind, now])), text: `${text}：分叉点那一版算不出来，程序看不出这次是改松还是改紧` }
}

/** 要跑工具才比得出来的：eslint 生效的规则、格式检查查哪些文件、tsconfig 的严格选项。分叉点那一版在临时 worktree 里算。 */
async function toolItems(root: string, fork: string, before: Config, now: Config, side: NowSide): Promise<Loosened> {
  const result: Loosened = { items: [], reasons: [] }
  const lint = Boolean(before.eslint && side.eslint)
  const format = Boolean(before.prettier && side.prettier)
  const tsconfigs = before.tsconfig.filter(path => now.tsconfig.includes(path))
  if (!lint && !format && tsconfigs.length === 0) return result
  const unknown = {
    lint: (reason: string): void => {
      result.reasons.push(`eslint 生效的规则（分叉点那一版）：${reason}`)
      result.items.push(unknownItem('eslint-unknown', before.eslint, [...side.eslint!], 'lint 规则'))
    },
    format: (reason: string): void => {
      result.reasons.push(`格式检查查哪些文件（分叉点那一版）：${reason}`)
      result.items.push(unknownItem('prettier-unknown', true, [...side.prettier!].sort(), '格式检查查哪些文件'))
    },
    tsconfig: (path: string, reason: string): void => {
      result.reasons.push(`${path}（分叉点那一版）：${reason}`)
      result.items.push(unknownItem('tsconfig-unknown', path, side.tsconfig.get(path), `类型检查的配置 ${path}`))
    },
  }
  try {
    await withForkTree(root, fork, async tree => {
      // 两边都有的文件：这次新加的没有"原来"
      const shared = side.files.filter(file => existsSync(join(tree.root, file)))
      if (lint) {
        try {
          const eslint = await loadEslint(root, now.eslint!.config)
          const old = await fileRules(eslint, tree.root, before.eslint!.config, shared.filter(isCode))
          result.items.push(...eslintItems(old, side.eslint!))
        } catch (error) {
          unknown.lint(firstLine(error))
        }
      }
      if (format) {
        try {
          const old = await checkedFiles(await loadPrettier(root), tree.root, shared)
          const item = prettierItem(old, side.prettier!, shared)
          if (item) result.items.push(item)
        } catch (error) {
          unknown.format(firstLine(error))
        }
      }
      for (const path of tsconfigs) {
        try {
          const item = tsconfigItem(path, tsSettings(findTsc(root, path), tree.root, path), side.tsconfig.get(path)!)
          if (item) result.items.push(item)
        } catch (error) {
          unknown.tsconfig(path, firstLine(error))
        }
      }
    })
  } catch (error) {
    // 临时 worktree 建不起来：都算不出来
    const reason = `分叉点的临时 worktree 建不起来：${firstLine(error)}`
    result.items = []
    result.reasons = []
    if (lint) unknown.lint(reason)
    if (format) unknown.format(reason)
    for (const path of tsconfigs) unknown.tsconfig(path, reason)
  }
  return result
}

/** 和分叉点那一版比，放松了哪些。beforeText 是分叉点上的配置文件（没有就是首次接入，不比）。 */
async function loosened(root: string, fork: string, beforeText: string | undefined, now: Config, side: NowSide): Promise<Loosened> {
  if (beforeText === undefined) return { items: [], reasons: [] }
  // 分叉点那一版跳过现在不认的字段读：升级后去掉的字段不让整份比较落空，跳过的单列一项问
  const parsed = parseConfig(beforeText, true)
  const before = parsed.config
  if (!before) {
    return {
      items: [{ before: stable(['config-unknown', beforeText]), after: stable(['config-unknown', now]), text: `分叉点上的 ${CONFIG_PATH} 写得不对、读不出来，程序看不出这次规范是改松还是改紧` }],
      reasons: [`分叉点上的 ${CONFIG_PATH} 读不出来：${parsed.problems.join('；')}`],
    }
  }
  const skipped: ConfirmItem[] = parsed.skipped.length
    ? [
        {
          before: stable(['config-skipped', beforeText]),
          after: stable(['config-skipped', now]),
          text: [`分叉点上的 ${CONFIG_PATH} 有现在不认的字段，这几处程序看不出是改松还是改紧（别的照常比了）：`, ...parsed.skipped].join('\n'),
        },
      ]
    : []
  const tools = await toolItems(root, fork, before, now, side)
  const items = [...skipped, ...configItems(before, now), ...tools.items]
  if (before.secrets) items.push(...gitleaksItems(judgingFile(root, fork, GITLEAKS_IGNORE), judgingFile(root, fork, GITLEAKS_CONFIG)))
  for (const path of BIOME_CONFIGS) {
    const item = biomeItem(path, judgingFile(root, fork, path))
    if (item) items.push(item)
  }
  if (before.styles && now.styles) items.push(...stylesItems(root, fork, before.styles, now.styles))
  return { items, reasons: tools.reasons }
}

/** 一项的头一句：第一行以冒号结尾的（下面逐行列的），带上第二行。 */
function headline(text: string): string {
  const [first = '', second] = text.split('\n')
  return first.endsWith('：') && second ? `${first}${second}` : first
}

/** 没同意的放松：说给 agent 的话。 */
function askLines(items: ConfirmItem[], ask: string[], reasons: string[]): string[] {
  return [
    `规范改松了 ${items.length} 项（和分叉点上的比），要用户同意：`,
    ...items.map(item => `  · ${headline(item.text)}`),
    ...(reasons.length ? ['分叉点那一版算不出来的原因（不用给用户看）：', ...reasons.map(reason => `  · ${reason}`)] : []),
    '用户不同意的，改回去，按规范改代码。',
    ...ask,
  ]
}

/** 依次跑 checks 里的每条命令，一条没过也接着跑。返回没过的那几条和原因。 */
function runChecks(root: string, config: Config): Array<{ name: string; cause: string }> {
  const failed: Array<{ name: string; cause: string }> = []
  for (const check of config.checks) {
    console.log(`== 规范检查：${check.name}（${check.command}）`)
    const r = spawnSync('/bin/sh', ['-c', check.command], { cwd: root, env: PROJECT_ENV, stdio: ['ignore', 'inherit', 'inherit'] })
    if (r.status === 0) continue
    failed.push({ name: check.name, cause: r.status !== null ? `退出码 ${r.status}` : r.signal ? `被信号 ${r.signal} 终止` : `没能启动：${r.error?.message ?? ''}` })
  }
  return failed
}

export async function check(repo: Repo): Promise<number> {
  const { root } = repo
  const fork = forkPoint(root)
  if (!joined(root, fork.commit)) {
    console.log(`这个仓库没有接入 codekeep（没有 ${KEEP_DIR}/ 目录），不检查。`)
    return EXIT.ok
  }
  if ('problem' in fork) {
    console.error(`没法检查：${fork.problem}（规范改没改松要和分叉点上的配置比）`)
    return EXIT.usage
  }
  const judging = judgingFile(root, fork.commit, CONFIG_PATH)

  // 配置删掉了：分叉点上有能用的配置的，删掉算放松，用户同意过就退出 codekeep
  if (judging.now === undefined) {
    const before = judging.before === undefined ? undefined : parseConfig(judging.before, true).config
    if (!before) {
      const hasDir = existsSync(join(root, KEEP_DIR))
      console.error(
        hasDir
          ? `codekeep check：有 ${KEEP_DIR}/ 目录但没有 ${CONFIG_PATH}，照 gatelight:setup-codekeep 技能写好配置。`
          : `codekeep check：工作区里删掉了 ${KEEP_DIR}/，分叉点上的 ${CONFIG_PATH} 又不在或写得不对：没有能用的配置，没法判断这次改松了什么。要继续用 codekeep 就恢复配置；要退出，先在默认分支上把配置改好，再删掉 ${KEEP_DIR}/。`,
      )
      return EXIT.usage
    }
    const item = removedItem(before, existsSync(join(root, KEEP_DIR)))
    const asked = askUser(repo, 'keep', HEADING, [item])
    if (!asked.ask) {
      console.log('codekeep check：通过。配置删掉了，用户同意过：这份改动退出 codekeep，不再检查。')
      return EXIT.ok
    }
    console.log(['codekeep check：没通过。', '', ...askLines([item], asked.ask.lines, [])].join('\n'))
    return EXIT.fail
  }

  // 1. 配置
  const parsed = parseConfig(judging.now)
  const problems = parsed.config ? missingFiles(root, parsed.config) : parsed.problems
  if (!parsed.config || problems.length) {
    console.error([`codekeep check：配置有问题（${CONFIG_PATH}），先改好再检查：`, ...problems.map(text => `  ✗ ${text}`)].join('\n'))
    return EXIT.usage
  }
  const config = parsed.config
  const side = await nowSide(root, config)
  if ('problems' in side) {
    console.error([`codekeep check：现在这一版的规范配置算不出来，先修好（依赖没装的先装好）：`, ...side.problems.map(text => `  ✗ ${text}`)].join('\n'))
    return EXIT.usage
  }

  // 2. 放松
  const found = await loosened(root, fork.commit, judging.before, config, side)
  const asked = askUser(repo, 'keep', HEADING, found.items)
  if (asked.ask) {
    console.log(['codekeep check：没通过。', '', ...askLines(asked.pending, asked.ask.lines, found.reasons)].join('\n'))
    return EXIT.fail
  }
  const loosenedLine = found.items.length ? `规范改松 ${found.items.length} 项，用户都同意过` : '规范配置没有改松（和分叉点上的比）'

  // 3–5 互不依赖：一项没过也接着查后面的，最后一起说。只说第一项的话，接入时 lint 要分很多批改，这期间格式、类型、密钥都没人查
  const failures: string[] = []
  let blocked = false

  // 3. lint
  let linted: Linted | undefined
  if (config.eslint) {
    console.log(`== lint：codekeep 用项目的 eslint 查（${config.eslint.config}）`)
    try {
      const files = [...side.eslint!].filter(([, rules]) => rules).map(([file]) => file)
      linted = await lint(await loadEslint(root, config.eslint.config), root, config.eslint.config, files)
    } catch (error) {
      console.error(`\ncodekeep check：lint 没跑成（${config.eslint.config}）：${firstLine(error)}`)
      return EXIT.usage
    }
    if (linted.errors > 0) {
      console.log(linted.report)
      failures.push(`lint 有 ${linted.errors} 个错误（上面列出；批量豁免文件在这里不起作用）`)
    }
  }

  // 4. 规范检查
  for (const failed of runChecks(root, config)) failures.push(`规范检查"${failed.name}"没过（${failed.cause}）`)

  // 5. 密钥
  if (config.secrets) {
    const secrets = scanSecrets(root, fork.commit)
    if ('missing' in secrets) {
      console.error(
        `\n找不到 gitleaks（${CONFIG_PATH} 开着 secrets，要用它扫密钥）。这是装在这台机器上的工具，先问用户；同意后装：brew install gitleaks（没有 Homebrew 的见 https://github.com/gitleaks/gitleaks#installing）。`,
      )
      failures.push('密钥没扫：找不到 gitleaks')
      blocked = true
    } else if ('problem' in secrets) {
      console.error(`\n密钥没扫成：${secrets.problem}`)
      failures.push('密钥没扫成（上面说了原因）')
      blocked = true
    } else if ('leaks' in secrets) {
      console.log(
        [
          '',
          'gitleaks 在这次改动里扫出了疑似密钥（上面列出，已打码）。改法：',
          '  · 真的密钥、密码：从代码里拿掉，改成从环境变量或不进版本库的本地配置读，并告诉用户这个密钥可能已经泄露、要换掉。已经提交了的，要改写这个分支上的那几个提交才去得掉，先问用户。',
          '  · 测试用的假值：改成一眼看得出是假的写法（比如 test-password-not-real）。',
          `  · 确实不是密钥的：把那一条的 Fingerprint 加进 ${GITLEAKS_IGNORE}（算放松，整组会要用户确认）。`,
        ].join('\n'),
      )
      failures.push('gitleaks 扫出了疑似密钥（上面列出）')
    }
  }

  if (failures.length > 0) {
    console.log(
      [
        '',
        `codekeep check：没通过，${failures.length} 项：`,
        ...failures.map(text => `  ✗ ${text}`),
        '按上面的输出改；不要为了过关改松规范（关规则、降级、调高上限、加忽略），确实要改的先用白话跟用户讲清。',
      ].join('\n'),
    )
    return blocked ? EXIT.usage : EXIT.fail
  }

  const names = [...(linted ? [`lint${linted.warnings ? `，${linted.warnings} 条警告` : ''}`] : []), ...config.checks.map(item => item.name)].join('、')
  console.log(`\ncodekeep check：通过。${loosenedLine}；规范检查都过了（${names}）${config.secrets ? '；这次改动里没扫出密钥' : ''}。`)
  return EXIT.ok
}
