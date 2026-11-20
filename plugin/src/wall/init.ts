// modwall init：按现有目录生成配置草稿。只认常见的目录名，认不出的留空，由 agent 照 setup 技能补好、再用 modwall check 核对。
// 模块根目录分属几个应用目录时，按应用分组起草，应用名取应用目录的名字。应用目录从这几处找：
//   工作区包：pnpm-workspace.yaml 的 packages、package.json 的 workspaces（有 package.json、路径对上的目录；仓库根目录本身不算）；
//   常见的 apps/*、services/*、packages/*（下面有代码的子目录，不要求是工作区包：Go、Python 的服务没有 package.json）。
// 认不出来的应用目录（比如不是工作区包、又不在这几个目录下的小程序）不起草，它下面的代码列为没有归属，由接入的 agent 手动补一组应用配置。
// 在每个应用目录里按同样的常见目录名找模块根目录、共享层、装配层；找到模块根目录的应用目录有两个以上才按应用分组。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AppConfig, Config } from './config.ts'
import { isCode, isTest, unreadDirectory } from './files.ts'
import { globToRegExp } from '../base/glob.ts'
import { ownerOf, placeInRoots } from './layout.ts'

/** 常见的模块根目录：下面有子目录才算。 */
const ROOTS = ['src/modules', 'modules', 'src/features', 'features', 'app/modules']
/** 常见的共享层目录。 */
const SHARED = ['src/shared', 'shared', 'src/common', 'common', 'src/lib', 'lib']
/** 常见的程序入口文件和装配目录。 */
const APP_FILES = ['src/main.ts', 'src/main.tsx', 'src/main.js', 'src/index.ts', 'src/index.tsx', 'src/index.js', 'src/app.ts', 'src/app.js', 'main.py', 'app.py', 'main.go']
const APP_DIRS = ['src/app']
/** 常见的不归 modwall 管的目录：脚本、迁移。 */
const OUTSIDE_DIRS = ['scripts', 'migrations', 'tools']
/** 常见的放应用的目录：下面每个有代码的子目录是一个应用目录。 */
const APP_PARENTS = ['apps', 'services', 'packages']

const DEFAULT_ENTRY = ['index.ts', 'index.tsx', 'index.js', '__init__.py']

const isDir = (root: string, path: string): boolean => statSync(join(root, path), { throwIfNoEntry: false })?.isDirectory() === true
const hasSubdirs = (root: string, path: string): boolean =>
  isDir(root, path) && readdirSync(join(root, path), { withFileTypes: true }).some(entry => entry.isDirectory() && !entry.name.startsWith('.'))

/** 一个应用目录（dir 为空是仓库根目录）里起草的划分，和这个目录里不归 modwall 管的路径。 */
function draftApp(root: string, files: readonly string[], dir: string): { app: AppConfig; outside: string[] } {
  const at = (path: string): string => (dir ? `${dir}/${path}` : path)
  const present = new Set(files)
  const hasCode = (path: string): boolean => files.some(file => file.startsWith(`${path}/`) && isCode(file) && !isTest(file))
  const roots = ROOTS.map(at).filter(path => hasSubdirs(root, path))
  const inRoot = (path: string): boolean => roots.some(rootDir => path === rootDir || path.startsWith(`${rootDir}/`))
  const shared = SHARED.map(at)
    .filter(path => !inRoot(path) && hasCode(path))
    .map(path => `${path}/**`)
  // 直接放在模块根目录下、名字是入口文件名的（Python 包的 __init__.py、汇总各模块的 index.ts）：点名归装配层
  const rootFiles = files.filter(path => {
    const place = placeInRoots({ roots }, path)
    return place !== undefined && place.name === undefined && DEFAULT_ENTRY.some(name => path === `${place.root}/${name}`)
  })
  const app = [
    ...APP_FILES.map(at).filter(path => present.has(path)),
    ...APP_DIRS.map(at)
      .filter(path => !inRoot(path) && hasCode(path))
      .map(path => `${path}/**`),
    ...rootFiles,
  ]
  // 这一层的构建配置（vite.config.ts 这类）和脚本、迁移目录
  const top = (path: string): boolean => (dir ? path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/') : !path.includes('/'))
  const configs = files.filter(path => top(path) && isCode(path) && /\.config\.[^.]+$/.test(path))
  const outside = [
    ...configs,
    ...OUTSIDE_DIRS.map(at)
      .filter(path => hasCode(path))
      .map(path => `${path}/**`),
  ]
  return { app: { roots, shared, app, entry: DEFAULT_ENTRY, map: {} }, outside }
}

/** pnpm-workspace.yaml 的 packages：只读这一个列表（每行 "- 路径规则"），不是完整的 YAML 解析。 */
function pnpmPackages(root: string): string[] {
  const file = join(root, 'pnpm-workspace.yaml')
  if (!existsSync(file)) return []
  const patterns: string[] = []
  let inPackages = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages || line.trim() === '' || line.trim().startsWith('#')) continue
    const item = /^\s+-\s*(['"]?)(.+?)\1\s*(?:#.*)?$/.exec(line)
    if (!item) {
      if (!/^\s/.test(line)) inPackages = false
      continue
    }
    patterns.push(item[2] as string)
  }
  return patterns
}

/** package.json 的 workspaces：数组，或 { packages: [...] }。 */
function npmWorkspaces(root: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: unknown }
    const list = Array.isArray(raw.workspaces) ? raw.workspaces : (raw.workspaces as { packages?: unknown } | undefined)?.packages
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** 仓库里的应用目录：工作区包、常见的 apps/*、services/*、packages/*；互相嵌套的只留外面那个。 */
export function appDirs(root: string, files: readonly string[]): string[] {
  const found = new Set<string>()
  const workspaces = [...pnpmPackages(root), ...npmWorkspaces(root)].map(item => item.replace(/^(?:\.\/)+/, '').replace(/\/+$/, ''))
  const include = workspaces.filter(item => item !== '' && item !== '.' && !item.startsWith('!')).map(item => globToRegExp(item))
  const exclude = workspaces.filter(item => item.startsWith('!')).map(item => globToRegExp(item.slice(1).replace(/^(?:\.\/)+/, '')))
  for (const path of files) {
    if (!path.endsWith('/package.json') || unreadDirectory(path) !== undefined) continue
    const dir = path.slice(0, -'/package.json'.length)
    if (include.some(reg => reg.test(dir)) && !exclude.some(reg => reg.test(dir))) found.add(dir)
  }
  for (const path of files) {
    if (!isCode(path) || isTest(path) || unreadDirectory(path) !== undefined) continue
    const [parent, child, ...rest] = path.split('/')
    if (parent !== undefined && APP_PARENTS.includes(parent) && child !== undefined && rest.length > 0) found.add(`${parent}/${child}`)
  }
  const dirs = [...found].sort()
  return dirs.filter(dir => !dirs.some(other => other !== dir && dir.startsWith(`${other}/`)))
}

/** files：工作区里现有的文件。 */
export function draftConfig(root: string, files: readonly string[]): Config {
  const base = draftApp(root, files, '')
  const apps = appDirs(root, files)
    .map(dir => ({ dir, ...draftApp(root, files, dir) }))
    .filter(item => item.app.roots.length > 0)
  let draft: Config
  if (apps.length >= 2) {
    // 应用名取应用目录的名字；两个应用目录同名（apps/web、services/web）时用整个路径，/ 换成 -
    const names = apps.map(item => basename(item.dir))
    const grouped: Record<string, AppConfig> = {}
    apps.forEach((item, index) => {
      const name = names.filter(other => other === names[index]).length > 1 ? item.dir.split('/').join('-') : (names[index] as string)
      grouped[name] = item.app
    })
    draft = { apps: grouped, shared: [], outside: [...base.outside, ...apps.flatMap(item => item.outside)], allow: [] }
  } else {
    draft = { ...base.app, outside: base.outside, allow: [] }
  }
  // LayerMap 不读的目录（提交进仓库的 vendor/、agent 目录里的脚本）里没被忽略的代码：不在模块、共享层、装配层里的，起草进 outside。
  // 在那些范围里的不起草（会和它们重叠），留给 R5 报出来，换个目录名
  for (const path of files) {
    if (!isCode(path)) continue
    const owner = ownerOf(draft, path)
    if (owner.kind !== 'none' || !owner.unread || owner.within) continue
    const rule = `${owner.unread}/**`
    if (!draft.outside.includes(rule)) draft.outside.push(rule)
  }
  return draft
}
