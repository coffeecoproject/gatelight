// 前端具体的外观只准写在主题文件和组件层目录的样式文件里，这两处改了要用户同意。
// 读文件就能比：和分叉点那一版比，主题文件、组件层目录里的样式文件（.css、.less、.scss 这类）新加、删掉、改了内容的，
// 一个文件列一项，按行列出原来和现在。只是空白、空行变了的不问。组件层目录里别的文件（组件代码、取数）不管。
// 只比两边配置里都写着的路径：这次新写进配置的（首次接入、新加的目录）不比。

import type { ConfirmItem } from '../base/confirm.ts'
import { type Judging, judgingDir, judgingFile } from '../base/judging.ts'
import { hash } from '../base/records.ts'
import type { StylesConfig } from './config.ts'
import { stable } from './eslint.ts'

/** 组件层目录里算样式文件的。 */
export const isStyle = (path: string): boolean => /\.(css|less|s[ac]ss|styl)$/.test(path)

/** 一项里最多列几行。 */
const SHOWN = 10

const linesOf = (text: string | undefined): string[] =>
  (text ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')

/** a 里有、b 里没有的行，按 a 的顺序；同样的行按次数算。 */
function minus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>()
  for (const line of b) left.set(line, (left.get(line) ?? 0) + 1)
  return a.filter(line => {
    const count = left.get(line) ?? 0
    if (count > 0) left.set(line, count - 1)
    return count === 0
  })
}

/** 一个文件两版之间的一项：只是空白、空行变了的没有。what 是这个文件在弹窗里的叫法，then 是改了以后会怎样。 */
function fileItem(path: string, judging: Judging, what: string, then: string): ConfirmItem | undefined {
  const before = linesOf(judging.before)
  const now = linesOf(judging.now)
  const removed = minus(before, now)
  const added = minus(now, before)
  if (removed.length === 0 && added.length === 0 && (judging.before === undefined) === (judging.now === undefined)) return undefined
  const head =
    judging.before === undefined
      ? `新加了${what} ${path}（${now.length} 行）：${then}`
      : judging.now === undefined
        ? `删掉了${what} ${path}：${then}`
        : `${what} ${path} 改了（删掉 ${removed.length} 行、新加 ${added.length} 行）：${then}`
  const lines = [...removed.map(line => `原来：${line}`), ...added.map(line => `现在：${line}`)]
  const shown = judging.now === undefined ? [] : lines.slice(0, SHOWN)
  if (judging.now !== undefined && lines.length > SHOWN) shown.push(`……还有 ${lines.length - SHOWN} 行`)
  return { before: stable(['style', path, hash(judging.before)]), after: stable(['style', path, hash(judging.now)]), text: [head, ...shown].join('\n') }
}

/** 主题文件、组件层的样式文件改了的：一个文件一项。 */
export function stylesItems(root: string, fork: string, before: StylesConfig, now: StylesConfig): ConfirmItem[] {
  const items: ConfirmItem[] = []
  const themes = before.theme.filter(path => now.theme.includes(path))
  for (const path of themes) {
    const item = fileItem(path, judgingFile(root, fork, path), '主题文件', '页面上用到这些颜色、尺寸的地方都会跟着变')
    if (item) items.push(item)
  }
  const seen = new Set(themes)
  for (const dir of before.ui.filter(path => now.ui.includes(path))) {
    for (const [path, judging] of judgingDir(root, fork, dir)) {
      if (!isStyle(path) || seen.has(path)) continue
      seen.add(path)
      const item = fileItem(path, judging, '组件层的样式文件', '用到它的组件在页面上的样子会变，要到页面上看')
      if (item) items.push(item)
    }
  }
  return items
}
