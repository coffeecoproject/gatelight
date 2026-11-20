// "测试写法"在项目里的东西：.testcraft/ 目录下的清单（checklist/）和暂定的规则（rules/）。没有这个目录的仓库没接入。
// 它不检查测试写得好不好，也不让 agent 写任何证明：写测试的约定在 write-tests 技能里，这里只管清单的提醒。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hasFile } from '../base/git.ts'

export const TESTCRAFT_DIR = '.testcraft'
export const RULES_DIR = `${TESTCRAFT_DIR}/rules`
export const CHECKLIST_DIR = `${TESTCRAFT_DIR}/checklist`

/** 接入了：分叉点或工作区里有 .testcraft/。 */
export function joined(root: string, fork?: string): boolean {
  return existsSync(join(root, TESTCRAFT_DIR)) || (fork !== undefined && hasFile(root, fork, TESTCRAFT_DIR))
}
