// 打开一个仓库：是否接入、分叉点、工作区和分叉点上的配置、工作区里的文件。check、status、会话说明、停止门、改文件前的检查共用。
// 分叉点、两版配置都向底座要（base/git.ts 的 forkPoint、base/judging.ts）：.modwall/config.json 是评判用的配置，
// 走"用户同意后生效"那条路——和分叉点那一版比，放宽的列出来让用户确认（loosen.ts）。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentBranch, fileNow, filesNow, forkPoint } from '../base/git.ts'
import { judgingFile } from '../base/judging.ts'
import { hash } from '../base/records.ts'
import { type Config, CONFIG_PATH, joined, MODWALL_DIR, parseConfig, readConfig } from './config.ts'
import { isCode } from './files.ts'
import { Layout } from './layout.ts'
import { type ConfigSide, configText } from './loosen.ts'

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

/** 影响检查结果的文件：代码文件（含测试），JSON（配置、路径别名、包清单、小程序页面配置），Python 和 Go 的项目文件，SQL（迁移），小程序的模板和样式。 */
const MATTERS = (path: string): boolean => isCode(path) || /\.(?:json|toml|sql|wxml|wxss)$/.test(path) || /(?:^|\/)go\.(?:mod|work)$/.test(path)

/** contentKey 的算法的名字：算法变了要改它，会话起点里以前记的样子就不算了（见 base/baseline.ts）。 */
export const CONTENT_FORMAT = 'content-1'

/**
 * 当前内容的摘要：分叉点上的配置加上影响检查结果的文件。通过记录、会话起点都按它记。
 * 检查能不能过，和分叉点有关的只有那里的配置（放宽项和它比；R4、入口清单只是提示），所以不记分叉点的提交号：
 * 在默认分支上提交、默认分支往前走，都不让通过记录失效；分叉点上的配置变了才失效。
 */
export function contentKey(project: Project): string {
  const parts: string[] = [project.base ? (project.before.config ? configText(project.before.config) : 'no-config') : 'no-base']
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

/** 这个仓库现在的内容摘要（重新打开一遍）；没接入时为 undefined。写通过记录前用它核对内容没变。 */
export function currentKey(root: string): string | undefined {
  const opened = openProject(root)
  return 'project' in opened ? contentKey(opened.project) : undefined
}
