// 写文件那一刻的"只走入口"：agent 要写进文件的新文字里，有没有直接引用别的模块的内部文件。
// 这是 R1（绕过入口）提前到改文件之前的那一部分：越界在写的那一刻就拦下，不等到跑 modwall check。
// 只做看文字就能判断的事（钩子进程里不建 LayerMap 的图）：
//   只管 TypeScript / JavaScript 文件里用相对路径写的引用（./、../）；别名、包名这类要解析才知道指向哪的不管。
//   引用的是样式、图片、数据这类不是代码的文件不管。配置里给这个文件写了 R1 例外的不管。
// 这里放过的不等于没越界：完整的判断照旧由 modwall check 做（rules.ts 的 importViolations）。

import { posix } from 'node:path'
import { moduleId, type Scheme } from './config.ts'
import { label, type Owner, ownerIn, placeInRoots } from './layout.ts'

const SCRIPT = /\.[cm]?[jt]sx?$/u
/** import … from '…'、export … from '…'、import '…'、import('…')、require('…') 里用相对路径写的那一段。 */
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]*)\1/gu

const withoutExtension = (name: string): string => name.replace(/\.[^./]+$/u, '')

/** 新文字里用相对路径引用的文件（相对仓库根目录，照写的样子，可能没有扩展名）。整行注释里的不算。 */
export function relativeImports(path: string, text: string): Array<{ spec: string; target: string }> {
  const found: Array<{ spec: string; target: string }> = []
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    for (const match of line.matchAll(RELATIVE_IMPORT)) {
      const spec = match[2] as string
      const target = posix.normalize(posix.join(posix.dirname(path), spec)).replace(/\/$/u, '')
      if (!target.startsWith('../')) found.push({ spec, target })
    }
  }
  return found
}

/**
 * path 这个文件要写进 text：里面有没有绕过入口引用了别的模块的内部文件。有就返回拒绝的原因（带改法），没有返回 undefined。
 * owner 是 path 的归属。
 */
export function entryBypass(scheme: Scheme, path: string, owner: Owner, text: string): string | undefined {
  if (!SCRIPT.test(path)) return undefined
  if (owner.kind !== 'module' && owner.kind !== 'app') return undefined
  if (scheme.allow.some(entry => entry.rule === 'R1' && entry.from === path)) return undefined
  const from = owner.kind === 'module' ? moduleId(owner.app, owner.name) : undefined
  for (const { spec, target } of relativeImports(path, text)) {
    const extension = posix.extname(target)
    if (extension !== '' && !SCRIPT.test(target)) continue
    // 目标可能是模块目录本身（引目录就是引它的入口）：补一段再认归属
    const to = ownerIn(scheme, `${target}/_`)
    if (to.kind !== 'module' || to.mapped) continue
    const id = moduleId(to.app, to.name)
    if (id === from) continue
    const app = scheme.apps.find(item => item.name === to.app)
    const place = app && placeInRoots(app, `${target}/_`)
    if (!app || !place?.name) continue
    const dir = `${place.root}/${place.name}`
    const rest = target === dir ? '' : target.slice(dir.length + 1)
    const entries = app.entry.map(withoutExtension)
    if (rest === '' || (!rest.includes('/') && entries.includes(withoutExtension(rest)))) continue
    const names = app.entry.filter(name => SCRIPT.test(name)).join('、')
    return (
      `modwall（R1 绕过入口）：${path}（${label(owner)}）要 import ${id} 模块的内部文件（${spec}）。` +
      `改成从 ${id} 的入口引用（${dir}/ 下的 ${names}）；入口里没有，就先在对方入口新增导出（作为单独的一小步），再从入口引用。`
    )
  }
  return undefined
}
