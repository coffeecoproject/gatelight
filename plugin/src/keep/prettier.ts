// 格式检查查哪些文件：用项目自己装的 prettier 的程序接口（getFileInfo），对仓库里每个文件（git 收的）算格式检查
// 查不查（被 .prettierignore、.gitignore 忽略的不查，认不出写法的不查），分叉点那一版和现在比。
// 算放松的：原来查、现在不查了的文件（往忽略文件里加了路径）。只比两边都有的文件。
// prettier 的写法选项（单引号、行宽这些）改了只是换风格，不算放松。

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConfirmItem } from '../base/confirm.ts'
import { stable } from './eslint.ts'

/** prettier 在仓库根目录跑时读的忽略文件（相对仓库根目录）。 */
const IGNORE_FILES = ['.gitignore', '.prettierignore']

type GetFileInfo = (path: string, options: { ignorePath: string[] }) => Promise<{ ignored: boolean; inferredParser: string | null }>

/** 项目自己装的 prettier（从仓库根目录往上找）。找不到时抛错。 */
export async function loadPrettier(root: string): Promise<GetFileInfo> {
  let entry: string
  try {
    entry = createRequire(join(root, 'noop.js')).resolve('prettier')
  } catch {
    throw new Error('项目里没装 prettier（从仓库根目录往上找不到），先装好依赖')
  }
  const module = (await import(pathToFileURL(entry).href)) as { getFileInfo?: GetFileInfo; default?: { getFileInfo?: GetFileInfo } }
  const getFileInfo = module.getFileInfo ?? module.default?.getFileInfo
  if (typeof getFileInfo !== 'function') throw new Error(`${entry} 里没有 getFileInfo 的程序接口`)
  return getFileInfo
}

/** 在 tree（仓库或分叉点的临时 worktree）里，这些文件（相对 tree）中格式检查查的那些。算不出来时抛错。 */
export async function checkedFiles(getFileInfo: GetFileInfo, tree: string, files: string[]): Promise<Set<string>> {
  const ignorePath = IGNORE_FILES.map(file => join(tree, file))
  const checked = new Set<string>()
  for (const file of files) {
    const info = await getFileInfo(join(tree, file), { ignorePath })
    if (!info.ignored && info.inferredParser !== null) checked.add(file)
  }
  return checked
}

/** 列出来的文件最多几个。 */
const SHOWN = 20

/** 原来查、现在不查了的文件，合成一项。now 只含两边都有的文件里现在查的；compared 是两边都有的文件。 */
export function prettierItem(before: Set<string>, now: Set<string>, compared: string[]): ConfirmItem | undefined {
  const dropped = compared.filter(file => before.has(file) && !now.has(file)).sort()
  if (dropped.length === 0) return undefined
  return {
    before: stable(['format-checked', dropped]),
    after: stable(['format-unchecked', dropped]),
    text: [
      `${dropped.length} 个文件不再做格式检查（被 .prettierignore 之类的忽略了）：以后这些文件格式乱了也照样通过`,
      ...dropped.slice(0, SHOWN),
      ...(dropped.length > SHOWN ? [`……还有 ${dropped.length - SHOWN} 个`] : []),
    ].join('\n'),
  }
}
