// 打开一个仓库：是否接入、分叉点、工作区和分叉点上的配置、工作区里的文件。check、status、会话说明、停止门、改文件前的检查共用。
// 分叉点、两版配置都向底座要（base/git.ts 的 forkPoint、base/judging.ts）：.modwall/config.json 是评判用的配置，
// 走"用户同意后生效"那条路——和分叉点那一版比，放宽的列出来让用户确认（loosen.ts）。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentBranch, fileNow, filesNow, forkPoint } from '../base/git.ts'
import { judgingFile } from '../base/judging.ts'
import { hash } from '../base/records.ts'
import { type Config, CONFIG_PATH, joined, MODWALL_DIR, parseConfig, readConfig } from './config.ts'
import { isCode, isTest } from './files.ts'
import { Layout } from './layout.ts'
import { type ConfigSide, looseningItems } from './loosen.ts'
import type { PassRecord, Store } from './store.ts'

export interface Project {
  root: string
  /** 和默认分支的分叉点；找不到时 baseProblem 说明原因。 */
  base?: { commit: string; branch: string }
  baseProblem?: string
  /** 当前分支名（日志用）。 */
  branch: string
  now: ConfigSide & { exists: boolean; problems: string[] }
  /** 分叉点上能用的配置（文件在、校验通过）。 */
  before: { config?: Config }
  /** 工作区里现有的文件（被 git 忽略的不算；LayerMap 不读的目录里的也算）。 */
  files: string[]
}

export type Opened = { project: Project } | { notJoined: true }

export function openProject(root: string): Opened {
  const found = forkPoint(root)
  const base = found.commit === undefined ? undefined : { commit: found.commit, branch: found.branch }
  if (!joined(root, found.commit)) return { notJoined: true }
  // 算不出分叉点时没有改之前那一版可比：check 说没法检查，这里只给工作区现在这一版
  const judging = base ? judgingFile(root, base.commit, CONFIG_PATH) : { before: undefined, now: fileNow(root, CONFIG_PATH) }
  const loaded = readConfig(judging.now)
  const beforeConfig = judging.before === undefined ? undefined : parseConfig(judging.before).config
  return {
    project: {
      root,
      ...(found.commit === undefined ? { baseProblem: found.problem } : { base }),
      branch: currentBranch(root) ?? 'HEAD',
      now: {
        exists: loaded.exists,
        problems: loaded.problems,
        hasDir: existsSync(join(root, MODWALL_DIR)),
        ...(loaded.config ? { config: loaded.config } : {}),
      },
      before: beforeConfig ? { config: beforeConfig } : {},
      files: filesNow(root),
    },
  }
}

export function layoutOf(project: Project, config: Config): Layout {
  return new Layout(config, project.files)
}

/**
 * 影响检查结果的文件：代码文件，JSON（配置、路径别名、包清单、小程序页面配置），Python 和 Go 的项目文件，SQL（迁移），小程序的模板和样式。
 * 测试文件不算：检查不看测试发起的引用，算进来的话只改测试也要重跑。正式代码引用测试文件那种越界，整组里的 modwall check 照查（整组不看通过记录）。
 */
const MATTERS = (path: string): boolean =>
  !isTest(path) && (isCode(path) || /\.(?:json|toml|sql|wxml|wxss)$/.test(path) || /(?:^|\/)go\.(?:mod|work)$/.test(path))

/** contentKey 的算法的名字：算法变了要改它，会话起点里以前记的样子就不算了（见 base/baseline.ts）。 */
export const CONTENT_FORMAT = 'content-2'

/**
 * 当前内容的摘要：影响检查结果的文件。通过记录、会话起点都按它记。
 * 不含分叉点上的配置：检查过不过和分叉点有关的只有放宽项，记在通过记录里（checkPassed）。含了的话，
 * 分支改过配置、快进到默认分支后分叉点变成自己，合并前刚通过的记录就对不上了。
 */
export function contentKey(project: Project): string {
  const parts: string[] = [project.base ? 'base' : 'no-base']
  for (const path of project.files.filter(MATTERS).sort()) {
    parts.push(path)
    try {
      parts.push(readFileSync(join(project.root, path), 'utf8'))
    } catch {
      parts.push('\u0000unreadable')
    }
  }
  return hash(...parts)
}

/** 检查通过时要记的：通过时和分叉点比出来的放宽项（都经用户同意过，不然过不了）。 */
export function passRecord(project: Project): PassRecord {
  return { at: Date.now(), loosening: looseningItems(project.before.config, project.now).map(item => item.text) }
}

/**
 * 当前内容 modwall check 通过过：有这份内容的通过记录，现在和分叉点比出来的放宽项都在通过时那一组里。
 * 分叉点挪了（快进、合进默认分支）放宽项只会少；多出来的没经用户同意，要重跑。
 */
export function checkPassed(project: Project, store: Store): boolean {
  const record = store.passes.get(contentKey(project))
  if (!record) return false
  return looseningItems(project.before.config, project.now).every(item => record.loosening.includes(item.text))
}

/** 这个仓库现在的内容摘要（重新打开一遍）；没接入时为 undefined。写通过记录前用它核对内容没变。 */
export function currentKey(root: string): string | undefined {
  const opened = openProject(root)
  return 'project' in opened ? contentKey(opened.project) : undefined
}
