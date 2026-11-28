// modwall 的命令：init、check、migrate、db bootstrap、db check、status。命令入口（src/modwall.ts）分发到这里。
// 找仓库、存记录、让用户确认、调 LayerMap 都用底座的；合并前的检查（check）是整组里的一段（见 full.ts），不用另外登记。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTRACT_FILE, loadContract } from '../base/contract.ts'
import { EXIT } from '../base/exit.ts'
import { filesNow } from '../base/git.ts'
import { matchesAny } from '../base/glob.ts'
import { LAYERMAP_COMMAND, LAYERMAP_MINIMUM, layermapVersion } from '../base/layermap.ts'
import { openRepo, type Repo } from '../base/repo.ts'
import { analyze, exitCode, formatReport, logCheck, prepare, type Report, violationLines } from './check.ts'
import { CONFIG_PATH, MODWALL_DIR, schemeOf } from './config.ts'
import type { Database } from './database.ts'
import { catalogViolations, readCatalog } from './dbcheck.ts'
import { bootstrapScript, fileReader, migrateScript, runScript } from './migrate.ts'
import { leaveReceipt } from './receipt.ts'
import { draftConfig } from './init.ts'
import type { Module } from './layout.ts'
import { configText } from './loosen.ts'
import { contentKey, currentKey, layoutOf, openProject, type Project } from './project.ts'
import { BLOCKING_RULES, unownedFiles } from './rules.ts'
import { openStore, type Store } from './store.ts'

const USAGE = `用法：
  modwall init        按现有目录生成配置草稿（${CONFIG_PATH}）
  modwall check       检查整个项目：R1–R5、R6 里迁移文件那部分、放宽项是否经用户同意；通过时记一条通过记录。
                      接入了的仓库，testpace full 里自动跑它
  modwall db bootstrap --psql "<执行 SQL 的命令>" | --print [--app <应用名>]
                      建库那一步：建程序的登录账号和跑迁移的账号，库只让这两个连（不设密码）。用超级用户连库
  modwall migrate --psql "<执行 SQL 的命令>" | --print [--app <应用名>]
                      建各模块和共享层的角色、schema、权限，按时间戳跑还没跑过的迁移。用跑迁移的账号连库；
                      --print 只输出脚本（打包上线用，线上只用 psql 跑它）
  modwall db check --psql "<执行 SQL 的命令>" [--app <应用名>]
                      查库里的现状（R6 里库的那部分），迁移跑完之后执行，用哪个账号连都行；
                      SQL 从标准输入交给 --psql 的命令，比如 --psql "psql \$DATABASE_URL"、
                      --psql "napbox exec postgres --temp \$ENV -- psql"；几个应用都写了 database 时用 --app 指定哪个应用的库
  modwall status      越界、例外和确认情况，LayerMap 和 testpace 有没有接上`

/** 退出码用底座的：0 通过；1 没通过；2 用法、配置或环境问题。 */

function repoHere(): Repo | undefined {
  const repo = openRepo(process.cwd())
  if (!repo) console.error('modwall 要在 git 仓库里运行。')
  return repo
}

function init(): number {
  const dir = repoHere()?.root
  if (!dir) return EXIT.usage
  if (existsSync(join(dir, CONFIG_PATH))) {
    console.error(`已经有 ${CONFIG_PATH} 了，不覆盖。要重来就先删掉它。`)
    return EXIT.usage
  }
  const config = draftConfig(dir, filesNow(dir))
  mkdirSync(join(dir, MODWALL_DIR), { recursive: true })
  const text = `${JSON.stringify(JSON.parse(configText(config)), null, 2)}\n`
  writeFileSync(join(dir, CONFIG_PATH), text)
  const lines = [`已生成配置草稿 ${CONFIG_PATH}（按常见的目录名认的，要核对）：`, ...text.trimEnd().split('\n').map(line => `  ${line}`)]
  const reopened = openProject(dir)
  const project = 'project' in reopened ? reopened.project : undefined
  if (project?.now.config) {
    const layout = layoutOf(project, project.now.config)
    if (schemeOf(config).apps.every(app => app.roots.length === 0)) lines.push('', '没认出模块根目录：把 roots 填成放模块的目录（它下面每个子目录是一个模块）。')
    if (layout.problems.length) lines.push('', '配置有问题：', ...layout.problems.map(text => `  ✗ ${text}`))
    const unowned = unownedFiles(layout, project.files)
    if (unowned.length) {
      lines.push('', `还有 ${unowned.length} 个代码文件没有归属（R5），把它们搬进模块、共享层或装配层，或者调整配置：`)
      lines.push(...unowned.slice(0, 20).map(violation => `  · ${violation.where[0]}`))
      if (unowned.length > 20) lines.push(`  ……还有 ${unowned.length - 20} 个`)
    }
  }
  lines.push('', '从现在起，没有归属的代码文件不能新建也不能修改。核对好之后跑 modwall check，把列出的越界改到清零；首次接入时整份配置要用户在弹窗里确认一次。')
  console.log(lines.join('\n'))
  return EXIT.ok
}

function open(): { project: Project; store: Store; repo: Repo } | number {
  const repo = repoHere()
  if (!repo) return EXIT.usage
  const opened = openProject(repo.root)
  if ('notJoined' in opened) {
    console.log('这个仓库没有接入 modwall（没有 .modwall/ 目录），不检查。')
    return EXIT.ok
  }
  return { project: opened.project, store: openStore(repo), repo }
}

function check(): number {
  const opened = open()
  if (typeof opened === 'number') return opened
  const { project, store, repo } = opened
  if (!project.base) {
    console.error(`没法检查：${project.baseProblem}（放宽项要和分叉点上的配置比）`)
    return EXIT.usage
  }
  // 按开始检查时的内容记通过记录
  const key = contentKey(project)
  const report = analyze(project, repo)
  console.log(formatReport(report))
  logCheck(store, project, report)
  const code = exitCode(report)
  if (code !== EXIT.ok) return code
  // 结论是按开始时的内容得出的：检查的过程中内容改过，这次不记、不算
  if (!store.passes.saveChecked(key, () => currentKey(project.root) ?? '', { at: Date.now() })) {
    console.log('\n检查过程中内容改过（检查是按开始时的样子做的），这次的结论不算：代码不再改动时重跑 modwall check。')
    return EXIT.fail
  }
  return EXIT.ok
}

interface DbArgs {
  psql?: string
  print: boolean
  app?: string
}

function dbArgs(command: string, args: string[], printable: boolean): DbArgs | undefined {
  const parsed: DbArgs = { print: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if ((arg === '--psql' || arg === '--app') && args[i + 1] !== undefined) {
      if (arg === '--psql') parsed.psql = args[++i]
      else parsed.app = args[++i]
    } else if (arg === '--print' && printable) parsed.print = true
    else {
      console.error(`不认识的参数：${arg}\n${USAGE}`)
      return undefined
    }
  }
  const psql = parsed.psql?.trim()
  if (parsed.print && psql) {
    console.error(`${command}：--psql 和 --print 只用一个。\n${USAGE}`)
    return undefined
  }
  if (!parsed.print && !psql) {
    const or = printable ? '，或者用 --print 只输出脚本' : ''
    console.error(`${command} 要用 --psql 告诉它用什么命令执行 SQL（比如 --psql "psql \$DATABASE_URL"）${or}。\n${USAGE}`)
    return undefined
  }
  return parsed
}

/** 按 --app 找要用的库：只有一个写了 database 的应用时不用写。 */
function databaseOf(command: string, appName: string | undefined): { project: Project; database: Database } | number {
  const opened = open()
  if (typeof opened === 'number') return opened
  const { project } = opened
  const prepared = prepare(project)
  if ('problems' in prepared) {
    console.error(`${command}：配置有问题（${CONFIG_PATH}），先改好：\n${prepared.problems.map(text => `  ✗ ${text}`).join('\n')}`)
    return EXIT.usage
  }
  if ('removed' in prepared) {
    console.error(`${command}：工作区里没有 ${CONFIG_PATH}，不知道模块怎么分。`)
    return EXIT.usage
  }
  const { databases } = prepared.layout
  if (databases.length === 0) {
    console.error(`${command}：${CONFIG_PATH} 里没有写 database（用 Postgres 的应用写 "database": { "migrations": …, "shared": … }）。`)
    return EXIT.usage
  }
  const named = databases.map(database => database.app.name)
  const database = appName === undefined ? (databases.length === 1 ? databases[0] : undefined) : databases.find(item => item.app.name === appName)
  if (!database) {
    console.error(
      appName === undefined
        ? `${command}：${named.join('、')} 几个应用都写了 database，用 --app 指定哪个应用的库。`
        : `${command}：没有写了 database 的应用叫 ${appName}（写了的有：${named.filter(Boolean).join('、') || '单应用的写法，不用 --app'}）。`,
    )
    return EXIT.usage
  }
  return { project, database }
}

/** modwall migrate、modwall db bootstrap：生成脚本，--print 输出，--psql 交给命令执行。脚本出错（psql 的退出码 3）算没通过，别的算没跑成。 */
function runDbScript(command: string, args: string[], script: (project: Project, database: Database) => string): number {
  const parsed = dbArgs(command, args, true)
  if (!parsed) return EXIT.usage
  const found = databaseOf(command, parsed.app)
  if (typeof found === 'number') return found
  const { project, database } = found
  const text = script(project, database)
  if (parsed.print) {
    process.stdout.write(text)
    return EXIT.ok
  }
  const r = runScript(project.root, parsed.psql as string, text)
  if (r.error !== undefined) {
    console.error(`${command}：执行 SQL 的命令没跑起来（${parsed.psql}）：${r.error}`)
    return EXIT.usage
  }
  if (r.status === 0) return EXIT.ok
  if (r.status === 3) {
    console.error(`${command}：没做完，出错的那一步整步回滚了（错误见上面）。`)
    return EXIT.fail
  }
  console.error(`${command}：执行 SQL 的命令失败（退出码 ${r.status}，命令：${parsed.psql}）：它要把标准输入的 SQL 交给 psql 执行。`)
  return EXIT.usage
}

/** modwall db check --psql "<命令>" [--app <应用名>]：不通过时退出码 1，没查成是 2。 */
function dbCheck(args: string[]): number {
  const parsed = dbArgs('modwall db check', args, false)
  if (!parsed) return EXIT.usage
  const psql = parsed.psql as string
  const found = databaseOf('modwall db check', parsed.app)
  if (typeof found === 'number') return found
  const { project, database } = found
  const catalog = readCatalog(project.root, psql)
  if (!catalog.ok) {
    console.error(`modwall db check：没查成，${catalog.problem}`)
    return EXIT.usage
  }
  const violations = catalogViolations(database, catalog.value)
  const which = database.app.name === undefined ? '' : `（${database.app.name} 应用的库）`
  leaveReceipt(database.app.name, violations.length === 0)
  if (violations.length === 0) {
    console.log(`modwall db check：通过${which}。库里没有越界。`)
    return EXIT.ok
  }
  console.log([`modwall db check：没通过${which}。`, '', `库里越界 ${violations.length} 处（改迁移，或用 modwall db bootstrap、modwall migrate 重建；不要直接改库）：`, ...violationLines(violations)].join('\n'))
  return EXIT.fail
}

function status(): number {
  const opened = open()
  if (typeof opened === 'number') return opened
  const { project, store, repo } = opened
  const lines: string[] = []
  lines.push(project.base ? `和 ${project.base.branch} 的分叉点 ${project.base.commit.slice(0, 8)} 比（当前分支 ${project.branch}）。` : `没算分叉点：${project.baseProblem}`)
  const report = analyze(project, repo)
  const config = project.now.config
  if (report.configProblems.length) lines.push('配置有问题：', ...report.configProblems.map(text => `  ✗ ${text}`))
  else if (config && report.layout) {
    const { modules, scheme } = report.layout
    const line = (module: Module, indent: string): string => `${indent}${module.id}（${module.dir}）入口：${module.entries.length ? module.entries.join('、') : '还没有'}`
    if (!scheme.grouped) {
      lines.push(`模块（${modules.length} 个）：`)
      for (const module of modules) lines.push(line(module, '  '))
    } else {
      lines.push(`模块（${modules.length} 个，按应用分）：`)
      for (const app of scheme.apps) {
        const own = modules.filter(module => module.app === app.name)
        lines.push(`  ${app.name} 应用（${own.length} 个）：`, ...(own.length ? own.map(module => line(module, '    ')) : ['    还没有模块']))
      }
    }
    lines.push(scheme.allow.length ? `例外（allow，${scheme.allow.length} 条）：` : '例外（allow）：没有')
    for (const entry of scheme.allow) lines.push(`  ${entry.rule} ${entry.from} → ${entry.to}：${entry.reason}`)
  }
  lines.push(...looseningStatus(report))
  if (!report.configProblems.length && !report.removed) {
    const counts = BLOCKING_RULES.map(rule => `${rule} ${report.violations.filter(violation => violation.rule === rule).length}`)
    if (report.layermapProblem) lines.push(`越界：只查了 R5、R6（${counts.slice(-2).join('、')}），LayerMap 用不了，R1–R4 没查`)
    else if (report.changesProblem) lines.push(`越界：${counts.join('、')}；R4 和入口新增导出没查（这次改动增删的关系没读到）`)
    else lines.push(`越界：${counts.join('、')}；R4 提示 ${report.behavior.length}（详情跑 modwall check）`)
  }
  lines.push(`通过记录：${store.passes.get(contentKey(project)) ? '当前内容 modwall check 通过过' : '当前内容还没有通过记录（modwall check）'}`)
  const version = layermapVersion()
  lines.push(
    version
      ? `LayerMap：${version}${report.layermapProblem ? `，用不了：${report.layermapProblem}` : report.changesProblem ? `，layermap check 没跑成：${report.changesProblem}` : '，能用'}（最低 ${LAYERMAP_MINIMUM}）`
      : `LayerMap：没找到 layermap 命令，要装 LayerMap 插件（${LAYERMAP_MINIMUM} 以上）；${LAYERMAP_COMMAND}`,
  )
  lines.push(...testpaceStatus(project, report.layout !== undefined && report.layout.databases.length > 0))
  console.log(lines.join('\n'))
  return EXIT.ok
}

function looseningStatus(report: Report): string[] {
  if (report.loosening.length === 0) return ['放宽项：没有（和分叉点上的配置比）']
  return ['放宽项（和分叉点上的配置比）：', ...report.loosening.map(item => `  ${item.confirmed ? '✓ 用户同意过' : '· 还没同意'}：${item.item}`)]
}

/**
 * 合并前谁来拦：接入了 testpace（有 testpace.json）的仓库，modwall check 是整组里的一段。
 * 写了 database 的，库里的现状要项目自己在整组里跑 modwall db check，这里只能看 testpace.json 的 full 里写没写。
 */
function testpaceStatus(project: Project, hasDatabase: boolean): string[] {
  const contract = loadContract(project.root)
  if (!contract) {
    return [
      `testpace：这个仓库没接入（没有 ${CONTRACT_FILE}）：会话说明、停止门、合并门都不管它，只能自己记得跑 modwall check。`,
      ...(hasDatabase ? ['数据库：库里的现状要在迁移跑完后用 modwall db check 查；没接入 testpace，要项目自己安排在测试里跑。'] : []),
    ]
  }
  const lines = ['testpace：接入了。modwall check 是整组（testpace full）里的一段，没通过就不留整组通过记录，合并门照常拦。']
  if (contract.raw === undefined) lines.push(`  ${CONTRACT_FILE} 读不了，没核对 ignore`)
  else if (matchesAny(CONFIG_PATH, contract.ignore)) {
    lines.push(`  ✗ ${CONTRACT_FILE} 的 ignore 盖住了 ${CONFIG_PATH}：改配置不会重跑整组，放宽规则就绕过了合并门。从 ignore 里去掉它。`)
  }
  if (hasDatabase) {
    const full = contract.raw?.full
    if (contract.raw === undefined) lines.push(`数据库：${CONTRACT_FILE} 读不了，没核对整组里有没有跑 modwall db check。`)
    else if (typeof full === 'string' && full.includes('modwall db check')) lines.push('数据库：testpace 的 full 里跑了 modwall db check。')
    else lines.push(`数据库：${CONTRACT_FILE} 的 full 里没看到 modwall db check。确认整组里迁移跑完后执行了它（写在 full 调用的脚本里的这里看不到）；没接上的话，库里的现状没人查。`)
  }
  return lines
}

/**
 * 在 agent 的沙箱里跑不了的子命令和它要做的事（见 base/commandline.ts）。
 * check、status 要 LayerMap 的地图：它存在项目外面，沙箱里更新不了，R1–R4 查不成，check 会给出假的"没通过"。
 * db check、db bootstrap、migrate 跑的是项目给的命令，要连数据库（--print 只输出脚本，不连）。init 只读写项目里的文件，不在里面。
 */
export function outside(argv: string[]): string | undefined {
  switch (argv[0]) {
    case 'check':
      return '让 LayerMap 更新它的地图（存在项目外面）、写 .git/testpace/ 的记录'
    case 'status':
      return '让 LayerMap 更新它的地图（存在项目外面）'
    case 'migrate':
      return argv.includes('--print') ? undefined : '跑 --psql 给的命令连数据库、改库'
    case 'db':
      if (argv[1] === 'check') return '跑 --psql 给的命令连数据库'
      return argv[1] === 'bootstrap' && !argv.includes('--print') ? '跑 --psql 给的命令连数据库、建账号' : undefined
    default:
      return undefined
  }
}

export function main(argv: string[]): number {
  switch (argv[0]) {
    case 'init':
      return init()
    case 'check':
      return check()
    case 'migrate':
      return runDbScript('modwall migrate', argv.slice(1), (project, database) => migrateScript(database, fileReader(project.root)))
    case 'db':
      if (argv[1] === 'check') return dbCheck(argv.slice(2))
      if (argv[1] === 'bootstrap') return runDbScript('modwall db bootstrap', argv.slice(2), (_, database) => bootstrapScript(database))
      console.error(`不认识的命令：db ${argv[1] ?? ''}\n${USAGE}`)
      return EXIT.usage
    case 'status':
      return status()
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE)
      return argv[0] === undefined ? EXIT.usage : EXIT.ok
    default:
      console.error(`不认识的命令：${argv[0]}\n${USAGE}`)
      return EXIT.usage
  }
}
