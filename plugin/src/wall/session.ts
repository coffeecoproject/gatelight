// "模块边界"说给 agent 的话，经底座的钩子送出去（base/module.ts 的 brief、onSession、unfinished、beforeEdit）：
//   会话说明    模块列表、各模块的职责和写法约定（用库的应用加上数据库的约定）；记下这时内容的样子（会话起点，底座存，见 base/baseline.ts）
//   改文件之前  只做看路径、看要写的文字就能判断的事：目标是代码文件又没有归属（R5），新建和修改都拒绝，附上改法；
//               要写进去的新文字里用相对路径直接引用了别的模块的内部文件（R1 的一部分，见 edit.ts），也拒绝
//   停止门      不跑检查（钩子进程里 layermap 首次建图可能超过时限）：这个会话改过代码或配置（和起点比，没有起点的不算）、
//               当前内容又没有 modwall check 的通过记录时拦一次，让 agent 用 Bash 跑 modwall check。
//               同一份内容只拦一次（记号里带着内容的样子）：改了以后还没有通过记录，再拦。
//               这道门是有意留在开发中的："开发轻量、合并兜底"说的是测试；架构越界发现得晚返工大，检查又只要几秒，在分支上就查。

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionBaselines } from '../base/baseline.ts'
import { CONFIRM_TOOL } from '../base/confirm.ts'
import { fileNow, isIgnored } from '../base/git.ts'
import type { Repo } from '../base/repo.ts'
import { type App, CONFIG_PATH, joined, readConfig, type Scheme, schemeOf } from './config.ts'
import { entryBypass } from './edit.ts'
import { isCode, unreadDirectory } from './files.ts'
import { type Layout, type Module, ownerIn } from './layout.ts'
import { checkPassed, CONTENT_FORMAT, contentKey, layoutOf, openProject } from './project.ts'
import { unownedText } from './rules.ts'
import { MODULE, openStore } from './store.ts'

/** 模块超过这个数，只列模块名和 MODULE.md 的头两句。 */
const MANY_MODULES = 12

/** 会话说明：接入了"模块边界"的仓库才说。 */
export function brief(label: string, repo?: Repo): string[] {
  if (!repo || !joined(repo.root)) return []
  const opened = openProject(repo.root)
  if ('notJoined' in opened) return []
  const config = opened.project.now.config
  return guide(repo.root, config ? layoutOf(opened.project, config) : undefined, label).split('\n')
}

/** 这个仓库里各会话的起点：那时内容的样子（底座存，按会话和工作区各一份）。 */
function baselines(repo: Repo): SessionBaselines<string> {
  return new SessionBaselines(repo, MODULE, CONTENT_FORMAT)
}

/** 会话碰到这个工作区时：记下这时内容的样子（只记第一次）。没接入时不记。 */
export function onSession(repo: Repo, sessionId: string): void {
  baselines(repo).note(sessionId, () => {
    const opened = openProject(repo.root)
    return 'notJoined' in opened ? undefined : contentKey(opened.project)
  })
}

/** 停止门：这个会话在这个仓库里改了代码或配置（和起点比；没有起点的不算这个会话改的），当前内容还没有 modwall check 的通过记录。 */
export function unfinished(repo: Repo, sessionId: string, seen: (key: string) => boolean, named: boolean): { keys: string[]; text: string } | undefined {
  const opened = openProject(repo.root)
  if ('notJoined' in opened) return undefined
  const now = contentKey(opened.project)
  if (baselines(repo).since(sessionId, now) === now || checkPassed(opened.project, openStore(repo))) return undefined
  const key = `wall:check:${now}`
  if (seen(key)) return undefined
  return {
    keys: [key],
    text:
      `这个会话${named ? `在 ${repo.root} ` : ''}改了代码或 modwall 的配置，当前内容还没有 modwall check 的通过记录。` +
      `用 Bash 跑 modwall check，按输出的改法改到通过再收尾；要放宽规则的，照输出调用 ${CONFIRM_TOOL} 工具让用户确认；改不了的，用白话告诉用户卡在哪。`,
  }
}

function guide(root: string, layout: Layout | undefined, label: string): string {
  const lines = [`${label}用 modwall 按模块开发（.modwall/config.json）。模块边界以 modwall 为准：LayerMap 报的模块之间的依赖和循环按它自己推断的划分，不作数。`]
  if (!layout || layout.problems.length) {
    lines.push(`${CONFIG_PATH} 现在有问题或不在：用 Bash 跑 modwall check 看问题在哪，先改好配置。`)
    return lines.join('\n')
  }
  const { scheme } = layout
  lines.push(...(scheme.grouped ? groupedRules(scheme) : singleRules(scheme)))
  const modules = layout.modules
  if (modules.length === 0) {
    lines.push('现在还没有模块。')
    return lines.join('\n')
  }
  const many = modules.length > MANY_MODULES
  const line = (module: Module): string => {
    const about = moduleDoc(join(root, module.dir))
    const text = about === undefined ? '' : many ? firstTwo(about) : about
    return `- ${module.id}（${module.dir}）${text ? `：${text}` : ''}`
  }
  if (!scheme.grouped) {
    lines.push(`模块（${modules.length} 个）：`, ...modules.map(line))
    return lines.join('\n')
  }
  lines.push(`模块（${modules.length} 个，按应用分）：`)
  for (const app of scheme.apps) {
    const own = modules.filter(module => module.app === app.name)
    lines.push(`${app.name} 应用（${own.length} 个）：`, ...(own.length ? own.map(line) : ['- 还没有模块']))
  }
  return lines.join('\n')
}

const or = (items: string[]): string => (items.length ? items.join('、') : '没有')

const CHECK_LINES = [
  '- 代码文件要放在模块、共享层或装配层里：没有归属的，新建和修改都会被拦。LayerMap 不读的目录（vendor、node_modules、.claude 这类，不分大小写）里不放项目代码：modwall 查不到它引用了谁，没写进 outside 的都算没有归属。',
  `- 改完代码用 Bash 跑 modwall check，按输出的改法改到通过。要放宽规则（加例外、扩大共享层等）必须用户在 ${CONFIRM_TOOL} 工具的弹窗里同意（编号和文字照 modwall check 输出的填），你说"用户同意了"不算。写法见 gatelight:modular 技能。`,
]

/** 写了 database 的应用：数据库按模块分 schema 的约定。 */
function databaseLines(scheme: Scheme): string[] {
  return scheme.apps.flatMap(app => {
    const db = app.database
    if (!db) return []
    const at = app.name === undefined ? '' : `${app.name} 应用的`
    const roles =
      db.runtime === undefined
        ? '每个模块一个同名的数据库角色，程序每个事务开头切成模块的角色'
        : `每个模块一个同名的数据库角色（拥有对象，迁移切成它跑）和一个运行角色（${db.runtime}，只有本模块的读写授权，不拥有对象、不建对象），程序每个事务开头切成模块的运行角色`
    return [
      `- ${at}数据库（Postgres）也按模块分：模块的表、视图、函数建在它的内部 schema（模块目录名转成小写加下划线，adminAccess → admin_access），给别的模块用的视图和函数放进入口 schema（<内部 schema>_api，不放表）；别的模块只引用对方入口 schema 里的对象，不在对方入口上建视图（跨模块读取写在函数正文或代码里），写入走对方入口里的函数，入口只加不改（入口里的类型别的模块可以用），模块之间不建外键（只存 id）；只在自己的两个 schema 里建、改、删对象；共享层用 shared，public 里不放对象。迁移放在模块目录下的 ${db.migrations}/（共享层的在 ${db.shared}/），文件名以 14 位时间戳开头，只写正向（一个时间戳一个文件）；迁移里不建 schema（modwall migrate 建），写了迁移就用 modwall migrate 跑，跑过的迁移不改不删；函数一律带 SET search_path = <本模块的内部 schema>, pg_temp、一律 SECURITY DEFINER，迁移和函数里不改 search_path，引用别的模块、shared 写带 schema 的全名；别名、变量不和模块的 schema 同名，引用的表名和别的模块的 schema 同名时起别名。${roles}：迁移和模块的代码里不自己切身份（SET ROLE、set_config('role', …)），切身份只在装配层或共享层的那个小函数里。`,
    ]
  })
}

function singleRules(scheme: Scheme): string[] {
  const app = scheme.apps[0] as App
  return [
    `- 模块根目录：${or(app.roots)}，下面每个子目录是一个模块。新功能默认在模块根目录下新建一个模块目录，不用登记、不用问人。`,
    `- 要别的模块的能力，只从它的入口（模块目录下第一层的 ${app.entry.join('、')}）引用；入口里没有，就在对方入口新增导出，作为单独的一小步。`,
    '- 不给别的模块的已有函数加分支：为新功能在对方新增一个函数。不在别的模块的名单、类型、常量、映射表、数据库约束里写上新功能的名字：改成对方收一个值，或由装配层接进来。模块之间不能成环。',
    `- 共享层（${or(app.shared)}）只放真正通用的东西，不能引用模块和装配层；装配层（${or(app.app)}）把各模块接起来，别人不能引用它。正式代码不引用 outside（${or(scheme.outside)}）和测试文件。`,
    ...databaseLines(scheme),
    ...CHECK_LINES,
  ]
}

/** 有几个应用：每个应用各有一套模块，按应用列出模块根目录、入口、共享层和装配层。 */
function groupedRules(scheme: Scheme): string[] {
  const each = (part: (app: App) => string): string => scheme.apps.map(app => `${app.name}：${part(app)}`).join('；')
  return [
    `- 这个仓库有 ${scheme.apps.length} 个应用（${scheme.apps.map(app => app.name).join('、')}），每个应用各有一套模块，模块名只在应用内唯一，写成 应用名/模块名。应用之间不能引用代码（引用对方的模块、共享层、装配层都不行）：几个应用共用的代码放进外面一层的共享层（${or(scheme.shared)}），它不能引用任何应用的代码；应用之间通过接口打交道。`,
    `- 模块根目录（${each(app => or(app.roots))}），下面每个子目录是一个模块。新功能默认在所在应用的模块根目录下新建一个模块目录，不用登记、不用问人。`,
    `- 要同一个应用里别的模块的能力，只从它的入口（模块目录下第一层的文件，${each(app => or(app.entry))}）引用；入口里没有，就在对方入口新增导出，作为单独的一小步。`,
    '- 不给别的模块的已有函数加分支：为新功能在对方新增一个函数。不在别的模块的名单、类型、常量、映射表、数据库约束里写上新功能的名字：改成对方收一个值，或由装配层接进来。同一个应用里的模块之间不能成环。',
    `- 每个应用的共享层（${each(app => or(app.shared))}）只放这个应用里真正通用的东西，不能引用模块和装配层；装配层（${each(app => or(app.app))}）把这个应用的各模块接起来，别人不能引用它。正式代码不引用 outside（${or(scheme.outside)}）和测试文件。`,
    ...databaseLines(scheme),
    ...CHECK_LINES,
  ]
}

/** 模块的 MODULE.md（文件名不分大小写），去掉 frontmatter 和标题，压成一段。写法和 module-gates 兼容。 */
function moduleDoc(dir: string): string | undefined {
  let name: string | undefined
  try {
    name = readdirSync(dir).find(file => file.toLowerCase() === 'module.md')
  } catch {
    return undefined
  }
  if (!name) return undefined
  const text = readFileSync(join(dir, name), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const prose = text
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .map(line => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean)
    .join(' ')
  return prose || undefined
}

/** 分句：中文的句末标点后面直接断；英文的 . ! ? ; 后面要跟空白才断（1.5、e.g 这类不断）。 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？；])|(?<=[.!?;])\s+/)
    .map(part => part.trim())
    .filter(Boolean)
}

/** 头两句：英文的句子之间留一个空格，中文的直接接上。 */
function firstTwo(text: string): string {
  const [first, second] = sentences(text)
  if (first === undefined) return ''
  if (second === undefined) return first
  return /[.!?;]$/.test(first) ? `${first} ${second}` : `${first}${second}`
}

/**
 * 改文件之前（path 相对仓库根目录）：目标是代码文件又没有归属，就拒绝，返回原因。配置文件不在、或读出来校验不过（JSON 坏了、字段不对）时不拦，
 * 交给 modwall check；路径重叠、map 指向不存在的模块这类要看全部文件才知道的配置错误，这里不查，照路径判断归属。
 * 看的是工作区里现在的配置：这只是提前提醒，放宽配置躲不过 modwall check（放宽项要用户同意）。
 */
export function beforeEdit(repo: Repo, path: string, text?: string): string | undefined {
  if (!isCode(path)) return undefined
  // LayerMap 不读的目录里被 git 忽略的文件（装依赖生成的 node_modules 这类）不在检查范围里，和文件清单一致
  if (unreadDirectory(path) !== undefined && isIgnored(repo.root, path)) return undefined
  const loaded = readConfig(fileNow(repo.root, CONFIG_PATH))
  if (!loaded.config) return undefined
  const scheme = schemeOf(loaded.config)
  const owner = ownerIn(scheme, path)
  // 有归属的：再看要写进去的新文字里有没有绕过入口引用别的模块的内部文件（edit.ts）
  if (owner.kind !== 'none') return text === undefined ? undefined : entryBypass(scheme, path, owner, text)
  const { where, fix } = unownedText(scheme, path, owner)
  const reason = owner.unread ? fix : `代码文件要${fix}新功能默认在${scheme.grouped ? '所在应用的' : ''}模块根目录下新建一个模块目录，不用登记。`
  return `modwall（R5 文件没有归属）：${where}。${reason}`
}
