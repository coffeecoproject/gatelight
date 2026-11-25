// 检查整个项目：配置、R1–R5、R6 里迁移文件和模块代码切身份那部分、放宽项是否经用户同意；R4 和入口新增导出只提示；LayerMap 没看全的地方照列。
// modwall check 和 modwall status 共用。没有 LayerMap 时只剩按路径判断的 R5、读迁移文件的 R6 和配置保护，检查不通过。
// 放宽项用户同意过没有问底座（base/confirm.ts）：这里只交条目，不弹窗、不存同意记录。

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { askUser } from '../base/confirm.ts'
import { EXIT } from '../base/exit.ts'
import { pathsAt } from '../base/git.ts'
import type { Repo } from '../base/repo.ts'
import { CONFIG_PATH } from './config.ts'
import { unreadSql } from './database.ts'
import { codeRoleSwitches, migrationViolations } from './dbrules.ts'
import { type ChangeFacts, type ProjectImports, readChanges, readImports } from './layermap.ts'
import { miniprogramRefs } from './miniprogram.ts'
import type { Layout, Module } from './layout.ts'
import { looseningItems } from './loosen.ts'
import { layoutOf, type Project } from './project.ts'
import { statements } from './sql.ts'
import {
  BLOCKING_RULES,
  behaviorHints,
  entryExports,
  existingChangeHints,
  type MigrationAlter,
  type Hint,
  importViolations,
  RULE_NAMES,
  uncheckedItems,
  unownedFiles,
  type Violation,
  withAssets,
} from './rules.ts'
import { branchKey, type Store } from './store.ts'

export interface Report {
  /** 配置有错：别的都不查。 */
  configProblems: string[]
  /** 配置有错里有路径重叠。 */
  overlapping: boolean
  /** layermap imports 用不了：R1、R2、R3 没查（R4 和入口清单也就没查）；R5、R6 照常查了。 */
  layermapProblem?: string
  /** 只有 layermap check 没跑成：R1–R3 照常查了，R4 和入口新增导出这次没查。 */
  changesProblem?: string
  violations: Violation[]
  loosening: Loosening
  /** 有还没同意的放宽项时：说给 agent 的话（怎么调确认工具，编号和弹窗文字）。 */
  ask?: string[]
  /** 配置删掉了（放宽项里有这一项）：规则不再查。 */
  removed: boolean
  behavior: Hint[]
  entryExports: Hint[]
  unchecked: string[]
  layout?: Layout
}

export type Loosening = Array<{ item: string; confirmed: boolean }>

/** 配置能不能用：有错（problems）、删掉了（removed）、能用（给出划分）。check 和确认工具共用。 */
export type Prepared = { problems: string[]; overlapping: boolean } | { removed: true } | { layout: Layout }

export function prepare(project: Project): Prepared {
  const { now, before } = project
  if (now.problems.length) return { problems: now.problems, overlapping: false }
  if (!now.config) {
    if (before.config) return { removed: true }
    const problem = now.hasDir
      ? `有 .modwall/ 目录但没有 ${CONFIG_PATH}：用 modwall init 按现有目录生成配置草稿`
      : `工作区里删掉了 .modwall/，分叉点上的 ${CONFIG_PATH} 又不在或校验不过：没有能用的配置，没法判断这次放宽了什么。要继续用 modwall 就恢复配置；要退出，先在默认分支上把配置改好，再删掉 .modwall/`
    return { problems: [problem], overlapping: false }
  }
  const layout = layoutOf(project, now.config)
  return layout.problems.length ? { problems: layout.problems, overlapping: layout.overlapping } : { layout }
}

/** 弹窗开头说这是什么的半句。 */
export const LOOSEN_HEADING = '这次改动里放宽模块边界规则的地方'

/**
 * 和分叉点上的配置比，放宽了哪些、各自用户同意过没有。配置要能用（或删掉了）才有意义。
 * 有没同意的，底座把它们按编号存好，ask 是让 agent 去调确认工具的话。
 */
export function looseningOf(project: Project, repo: Repo): { loosening: Loosening; ask?: string[] } {
  const items = looseningItems(project.before.config, project.now)
  const asked = askUser(repo, 'wall', LOOSEN_HEADING, items)
  return {
    loosening: items.map(item => ({ item: item.text, confirmed: asked.confirmed.includes(item) })),
    ...(asked.ask ? { ask: asked.ask.lines } : {}),
  }
}

export function analyze(project: Project, repo: Repo): Report {
  const report: Report = { configProblems: [], overlapping: false, violations: [], loosening: [], removed: false, behavior: [], entryExports: [], unchecked: [] }
  const prepared = prepare(project)
  if ('problems' in prepared) {
    report.configProblems = prepared.problems
    report.overlapping = prepared.overlapping
    return report
  }
  const loosened = looseningOf(project, repo)
  report.loosening = loosened.loosening
  if (loosened.ask) report.ask = loosened.ask
  if ('removed' in prepared) {
    report.removed = true
    return report
  }
  const { layout } = prepared
  report.layout = layout
  const read = (path: string): string => readFileSync(join(project.root, path), 'utf8')
  const database = migrationViolations(layout.databases, read)
  // 小程序的 .json、.wxml、.wxss 里的引用 LayerMap 不读，modwall 自己读，和 import 一起判
  const miniprogram = miniprogramRefs(project.files, read)
  const switches = codeRoleSwitches(layout.databases, project.files, path => layout.owner(path), read)
  report.violations = [...unownedFiles(layout, project.files), ...database.violations, ...switches]

  let facts: ProjectImports | undefined
  const imports = readImports(project.root)
  if (imports.ok) {
    const assets = withAssets(imports.value, project.files)
    facts = { imports: [...assets.imports, ...miniprogram.imports], unresolved: assets.unresolved }
    // 数据库里模块之间的引用和代码的 import 一起算环
    report.violations = [...importViolations(layout, facts, database.edges), ...report.violations]
  } else {
    report.layermapProblem = imports.problem
  }
  let changes: ChangeFacts | undefined
  if (project.base && imports.ok) {
    const changed = readChanges(project.root, project.base.commit)
    if (changed.ok) {
      changes = changed.value
      report.behavior = behaviorHints(layout, changes)
      report.behavior.push(...existingChangeHints(layout, changes, freshModules(project.root, project.base.commit, layout), migrationAlters(project.root, project.base.commit, layout, read)))
      report.entryExports = entryExports(layout, changes)
    } else {
      report.changesProblem = changed.problem
    }
  }
  report.unchecked = [
    ...uncheckedItems(layout, facts, changes),
    ...miniprogram.unresolved.map(text => `${text}：小程序的引用没对上项目里的文件`),
    ...unreadSql(layout.databases, project.files, path => layout.owner(path)).map(path => `${path}：不在迁移目录里，R6 只查它有没有切身份（应用自己的查询文件可以不管；是迁移的话放进迁移目录）`),
  ]
  return report
}

/** 这次新建的模块：分叉点上还没有它的目录。 */
function freshModules(root: string, base: string, layout: Layout): Set<string> {
  const existed = pathsAt(root, base, layout.modules.map(module => module.dir))
  return new Set(layout.modules.filter(module => !existed.has(module.dir)).map(module => module.id))
}

/** 已有模块这次新加的迁移里，改、删已有对象的句子（函数正文里的不算）。 */
function migrationAlters(root: string, base: string, layout: Layout, read: (path: string) => string): MigrationAlter[] {
  const owned = layout.databases.flatMap(database => database.migrations).filter((migration): migration is { path: string; module: Module } => migration.module !== undefined)
  const existed = pathsAt(root, base, owned.map(migration => migration.path))
  return owned
    .filter(migration => !existed.has(migration.path))
    .flatMap(({ path, module }) => statements(read(path)).filter(statement => statement.alters && !statement.inFunction).map(statement => ({ module, path, line: statement.line })))
}

/** R1–R3、R5、R6 都查了：配置能用、layermap imports 跑成了。只有这样的检查，越界列表才完整。 */
function complete(report: Report): boolean {
  return report.configProblems.length === 0 && !report.removed && report.layermapProblem === undefined
}

export function exitCode(report: Report): number {
  if (report.configProblems.length || report.layermapProblem || report.changesProblem) return EXIT.usage
  if (report.violations.length || report.loosening.some(item => !item.confirmed)) return EXIT.fail
  return EXIT.ok
}

const LIMIT = 50

function list<T>(items: T[], line: (item: T) => string[]): string[] {
  const lines = items.slice(0, LIMIT).flatMap(line)
  if (items.length > LIMIT) lines.push(`  ……还有 ${items.length - LIMIT} 条`)
  return lines
}

/** 越界按规则分组；一组的改法都一样时只写一次。modwall db check 也用。 */
export function violationLines(violations: Violation[]): string[] {
  const lines: string[] = []
  for (const rule of BLOCKING_RULES) {
    const group = violations.filter(violation => violation.rule === rule)
    if (group.length === 0) continue
    const same = group.every(violation => violation.fix === group[0]?.fix)
    lines.push(`${rule} ${RULE_NAMES[rule]}（${group.length} 处）`)
    lines.push(
      ...list(group, violation => [
        `  ✗ ${violation.where[0]}`,
        ...violation.where.slice(1).map(text => `      ${text}`),
        ...(same ? [] : [`    改法：${violation.fix}`]),
      ]),
    )
    if (same) lines.push(`    改法：${group[0]?.fix}`)
  }
  return lines
}

/** 放宽项要用户同意：怎么调确认工具由底座说（report.ask），这里只加上这是什么、不同意时怎么办。 */
function confirmLines(report: Report, count: number): string[] {
  return [`放宽规则 ${count} 项（和分叉点上的配置比），要用户同意。用户不同意的，改回去，按越界的改法改代码。`, ...(report.ask ?? [])]
}

export function formatReport(report: Report): string {
  const code = exitCode(report)
  const lines: string[] = []
  if (report.configProblems.length) {
    lines.push(`modwall check：配置有问题（${CONFIG_PATH}），先改好再检查：`, ...report.configProblems.map(text => `  ✗ ${text}`))
    if (report.overlapping) lines.push('各项的路径不能重叠：一个代码文件只能属于模块、共享层、装配层、映射、outside 里的一项。')
    return lines.join('\n')
  }
  const unconfirmed = report.loosening.filter(item => !item.confirmed).map(item => item.item)
  if (report.removed) {
    lines.push(unconfirmed.length ? 'modwall check：没通过。' : 'modwall check：通过。配置删掉了，用户同意过：这份改动退出 modwall，不再检查。')
    if (unconfirmed.length) lines.push('', ...confirmLines(report, unconfirmed.length))
    return lines.join('\n')
  }

  if (code === EXIT.ok) lines.push('modwall check：通过。项目里没有越界。')
  else if (report.layermapProblem) lines.push('modwall check：没通过，LayerMap 用不了，R1、R2、R3、R4 和入口新增导出都没查（R5、R6 照常查了）：', `  ${report.layermapProblem}`)
  else if (report.changesProblem) {
    lines.push('modwall check：没通过，这次改动增删的关系没读到，R4 和入口新增导出没查（R1、R2、R3、R5、R6 照常查了，结果在下面）：', `  ${report.changesProblem}`)
  } else lines.push('modwall check：没通过。')

  if (report.violations.length) {
    lines.push('', `越界 ${report.violations.length} 处（按项目当前的全部代码算，要改到清零）：`, ...violationLines(report.violations))
  }
  if (unconfirmed.length) lines.push('', ...confirmLines(report, unconfirmed.length))
  else if (report.loosening.length) lines.push('', `放宽规则 ${report.loosening.length} 项，用户都同意过。`)

  const hints: string[] = []
  if (report.behavior.length) {
    hints.push(`R4 ${RULE_NAMES.R4}（${report.behavior.length} 处，先只提示）`)
    hints.push(...list(report.behavior, hint => [`  · ${hint.where}`, `    建议：${hint.fix}`]))
  }
  if (report.entryExports.length) {
    hints.push('这次给模块的入口新增了导出（不算违规，留作试点数据；不要为了过 R1 把内部的东西全从入口导出）：')
    hints.push(...list(report.entryExports, hint => [`  · ${hint.where}`]))
  }
  if (report.unchecked.length) {
    hints.push('没检查到（LayerMap 标明没看全的地方，不拦）：')
    hints.push(...list(report.unchecked, text => [`  · ${text}`]))
  }
  if (hints.length) lines.push('', '提示：', ...hints)
  return lines.join('\n')
}

/**
 * 记一份检查日志：哪条规则、哪个位置，上一次（同一分支）的越界这次改正了哪些。
 * 两次都查全了才比：没查全的那次越界列表不完整，不算改正，也不作为下一次比较的基准。
 */
export function logCheck(store: Store, project: Project, report: Report): void {
  const violations = report.violations.map(violation => violation.key)
  const whole = complete(report)
  const key = branchKey(project.branch)
  const before = whole ? (store.last.get(key)?.violations ?? []) : []
  if (whole) store.last.put(key, { violations, at: Date.now() })
  const entry = {
    kind: 'check',
    at: Date.now(),
    branch: project.branch,
    base: project.base?.commit,
    result: ['pass', 'fail', 'error'][exitCode(report)],
    complete: whole,
    violations,
    fixed: before.filter(key => !violations.includes(key)),
    configProblems: report.configProblems.length,
    layermapProblem: report.layermapProblem,
    changesProblem: report.changesProblem,
    loosening: report.loosening.length,
    unconfirmed: report.loosening.filter(item => !item.confirmed).length,
    behaviorHints: report.behavior.map(hint => hint.where),
    entryExports: report.entryExports.length,
    unchecked: report.unchecked.length,
  }
  writeFileSync(store.logPath('modwall-check'), `${JSON.stringify(entry, null, 1)}\n`)
}
