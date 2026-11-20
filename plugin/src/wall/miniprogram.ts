// 小程序里代码以外的引用：LayerMap 不读 .json、.wxml、.wxss，modwall 自己读出来，当成 import 照 R1、R2、R3 判。
//   页面、组件的 .json 里 usingComponents 的组件路径（组件的 .ts/.js/.json/.wxml 之一）
//   .wxml 里 <import src>、<include src>、<wxs src>
//   .wxss 里 @import
// 以 / 开头的路径从小程序根目录（有 app.json 的目录）算，以 . 开头的从文件所在目录算；别的写法（npm 包、plugin://）不管。
// 对上项目里的文件的给出 import；以 / 或 . 开头、却对不上文件的列为"没检查到"。

import { posix } from 'node:path'
import type { ImportFact } from './layermap.ts'

/** 读出来的小程序引用：对上文件的（imports）和对不上的（unresolved，"文件:行 写的路径"）。 */
export interface MiniprogramRefs {
  imports: ImportFact[]
  unresolved: string[]
}

const COMPONENT_FILES = ['.ts', '.js', '.json', '.wxml']
const TEMPLATE = /<(?:import|include|wxs)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/g
const STYLE_IMPORT = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g

/** 文件里第几行（从 1 开始）。 */
const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length

/** 小程序根目录：有 app.json 的目录，取离文件最近的那个。 */
function rootOf(roots: readonly string[], path: string): string | undefined {
  return roots.filter(root => root === '' || path.startsWith(`${root}/`)).sort((a, b) => b.length - a.length)[0]
}

export function miniprogramRefs(files: readonly string[], read: (path: string) => string): MiniprogramRefs {
  const roots = files.filter(path => path === 'app.json' || path.endsWith('/app.json')).map(path => posix.dirname(path).replace(/^\.$/, ''))
  const result: MiniprogramRefs = { imports: [], unresolved: [] }
  if (roots.length === 0) return result
  const present = new Set(files)

  for (const from of files) {
    if (!/\.(?:json|wxml|wxss)$/.test(from)) continue
    const root = rootOf(roots, from)
    if (root === undefined) continue
    const found: Array<{ specifier: string; index: number; candidates: (path: string) => string[] }> = []
    let text: string
    try {
      text = read(from)
    } catch {
      continue
    }
    if (from.endsWith('.json')) {
      let usingComponents: unknown
      try {
        usingComponents = (JSON.parse(text) as { usingComponents?: unknown }).usingComponents
      } catch {
        continue
      }
      if (typeof usingComponents !== 'object' || usingComponents === null) continue
      for (const value of Object.values(usingComponents)) {
        if (typeof value !== 'string') continue
        found.push({ specifier: value, index: text.indexOf(JSON.stringify(value)), candidates: path => COMPONENT_FILES.map(ext => `${path}${ext}`) })
      }
    } else if (from.endsWith('.wxml')) {
      for (const match of text.matchAll(TEMPLATE)) {
        const specifier = match[1] as string
        const ext = /<wxs\b/.test(match[0]) ? '.wxs' : '.wxml'
        found.push({ specifier, index: match.index, candidates: path => (posix.extname(path) ? [path] : [`${path}${ext}`]) })
      }
    } else if (from.endsWith('.wxss')) {
      for (const match of text.matchAll(STYLE_IMPORT)) {
        found.push({ specifier: match[1] as string, index: match.index, candidates: path => (posix.extname(path) ? [path] : [`${path}.wxss`]) })
      }
    } else continue

    for (const { specifier, index, candidates } of found) {
      const base = specifier.startsWith('/') ? posix.join(root, specifier.slice(1)) : specifier.startsWith('.') ? posix.join(posix.dirname(from), specifier) : undefined
      if (base === undefined) continue
      const line = lineAt(text, Math.max(index, 0))
      const to = base.startsWith('../') ? undefined : candidates(posix.normalize(base)).find(path => present.has(path))
      if (to === undefined) result.unresolved.push(`${from}:${line} 写的 "${specifier}"`)
      else if (to !== from) result.imports.push({ from, line, to, specifier })
    }
  }
  return result
}
