// 整组跑的测试：按 testpace.json 的 tests 规则，在工作区里找出全部测试文件。
// 由 testpace 自己找、交给 files 跑，新加的测试不用谁记得加进整组，就会被跑到。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../base/git.ts'
import { matcher } from '../base/glob.ts'

/** 规则选中这个路径：匹配某条规则，且不匹配以 ! 开头的排除规则。 */
export function testMatcher(patterns: string[]): (path: string) => boolean {
  const include = matcher(patterns.filter(pattern => !pattern.startsWith('!')))
  const exclude = matcher(patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1)))
  return path => include(path) && !exclude(path)
}

/** 工作区里规则选中的测试文件：已跟踪的和未跟踪、没被 .gitignore 忽略的，相对仓库根目录，按路径排序。 */
export function findTests(root: string, patterns: string[]): string[] {
  const selected = testMatcher(patterns)
  const paths = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0')
  // 已删除但还在索引里的文件不算
  return [...new Set(paths)].filter(path => path !== '' && selected(path) && existsSync(join(root, path))).sort()
}
