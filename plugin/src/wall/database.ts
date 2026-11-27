// 数据库按模块分：位置就是归属，不另外登记。
//   每个模块两个 schema：内部（模块目录名转成小写加下划线，adminAccess → admin_access）和入口（<内部>_api，只放视图和函数）；
//   共享层用 shared；public 里不放对象（扩展自带的除外）。
//   每个模块一个角色，名字就是它的内部 schema 名；共享层的角色叫 shared。程序的登录账号、跑迁移的账号不能和它们同名。
//   各模块的组角色叫 <登录账号>_modules，不能和上面这些同名。
//   配置写了运行角色模板（database.runtime）的，每个模块还有一个运行角色（模板里的 <module> 换成内部 schema 名），不能和上面这些角色、账号同名。
//   迁移放在每个模块目录下的 database.migrations 子目录、共享层的 database.shared 目录，文件名以 14 位的时间戳开头，不能重复（迁移只写正向，一个时间戳一个文件）。
// 这里只管划分：每个应用的库有哪些 schema、各归谁，迁移文件各归谁，以及这些算出来的配置错误。只看路径，layout.ts 用它。
// R6 的判定在 dbrules.ts（迁移文件那部分，modwall check）和 dbcheck.ts（库里的现状，modwall db check）。

import { type App, MODULE_PLACEHOLDER, PLAIN_NAME } from './config.ts'
import type { Module } from './layout.ts'

export const API_SUFFIX = '_api'
export const SHARED_SCHEMA = 'shared'
export const PUBLIC_SCHEMA = 'public'

/** 模块目录名转成 schema 名：驼峰和连字符都变成下划线，全小写。 */
export function schemaName(module: string): string {
  return module
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[-\s.]+/g, '_')
    .toLowerCase()
}

export type SchemaOwner = { kind: 'internal'; module: Module } | { kind: 'api'; module: Module } | { kind: 'shared' }

/** 迁移文件：owner 是它所在的模块，或者共享层（undefined）。 */
export interface Migration {
  path: string
  module?: Module
}

/** 一个应用的库。 */
export interface Database {
  app: App
  /** 模块的内部、入口 schema 和 shared 各归谁（public 不在里面）。 */
  schemas: Map<string, SchemaOwner>
  migrations: Migration[]
  problems: string[]
}

export const internalOf = (module: Module): string => schemaName(module.name)
export const apiOf = (module: Module): string => `${schemaName(module.name)}${API_SUFFIX}`
/** 模块的运行角色：配置的模板里的 <module> 换成模块的内部 schema 名。 */
export const runtimeOf = (module: Module, template: string): string => template.replace(MODULE_PLACEHOLDER, internalOf(module))
/** 各模块（和运行角色）的组角色：入口 schema、shared 的使用权授给它。按登录账号起名：角色整个实例共用，各项目各用各的。 */
export const groupOf = (login: string): string => `${login}_modules`

/** 这个 schema 归谁的说法，比如 orders 模块的内部 schema。 */
export function schemaLabel(schema: string, owner: SchemaOwner): string {
  if (owner.kind === 'shared') return `共享层的 schema ${schema}`
  return `${owner.module.id} 模块的${owner.kind === 'internal' ? '内部' : '入口'} schema ${schema}`
}

const TIMESTAMP = /^(\d{14})(?!\d)/

/** 写了 database 的应用各一个库：schema 和迁移文件，以及配置错误（schema 名撞了、迁移文件名不对、时间戳重复）。 */
export function databasesOf(apps: readonly App[], modules: readonly Module[], files: readonly string[]): Database[] {
  return apps.flatMap(app => {
    const config = app.database
    if (!config) return []
    const own = modules.filter(module => module.app === app.name)
    const problems: string[] = []
    const where = app.name === undefined ? '' : `${app.name} 应用的`
    const schemas = new Map<string, SchemaOwner>([[SHARED_SCHEMA, { kind: 'shared' }]])
    for (const module of own) {
      const internal = internalOf(module)
      if (!PLAIN_NAME.test(internal)) {
        problems.push(`${where}模块 ${module.dir} 的目录名转不成 schema 名（转出来是 "${internal}"，只能有字母、数字和下划线，不以数字开头）：给模块目录改个名字`)
        continue
      }
      const owners: Array<[string, SchemaOwner & { module: Module }]> = [
        [internal, { kind: 'internal', module }],
        [apiOf(module), { kind: 'api', module }],
      ]
      for (const [schema, owner] of owners) {
        const taken = schemas.get(schema)
        const reserved = schema === PUBLIC_SCHEMA || schema === 'information_schema' || schema.startsWith('pg_')
        if (taken || reserved) {
          const other = taken ? schemaLabel(schema, taken) : 'Postgres 保留的 schema'
          problems.push(`${where}${module.id} 模块的${owner.kind === 'internal' ? '内部' : '入口'} schema 叫 ${schema}，和 ${other} 撞了：给模块目录改个名字`)
        } else schemas.set(schema, owner)
      }
    }

    // 模块的角色和内部 schema 同名，共享层的角色叫 shared
    for (const key of ['login', 'migrator'] as const) {
      const owner = schemas.get(config[key])
      if (owner && owner.kind !== 'api') {
        const role = owner.kind === 'shared' ? '共享层的角色' : `${owner.module.id} 模块的角色`
        problems.push(`${where}database.${key} 的账号 ${config[key]} 和${role}同名：登录、迁移账号本身没有权限，只能切成模块的角色，换个名字`)
      }
    }
    if (config.runtime !== undefined) {
      for (const module of own) {
        const runtime = runtimeOf(module, config.runtime)
        const owner = schemas.get(runtime)
        const clash =
          owner && owner.kind !== 'api' ? (owner.kind === 'shared' ? '共享层的角色' : `${owner.module.id} 模块的角色`)
          : runtime === config.login ? '程序的登录账号（database.login）'
          : runtime === config.migrator ? '跑迁移的账号（database.migrator）'
          : undefined
        if (clash) problems.push(`${where}${module.id} 模块的运行角色 ${runtime}（database.runtime 是 ${config.runtime}）和${clash}同名：运行角色只有本模块的读写授权，换个模板`)
      }
    }
    const group = groupOf(config.login)
    const groupOwner = schemas.get(group)
    const groupClash =
      groupOwner && groupOwner.kind !== 'api' ? (groupOwner.kind === 'shared' ? '共享层的角色' : `${groupOwner.module.id} 模块的角色`)
      : group === config.migrator ? '跑迁移的账号（database.migrator）'
      : config.runtime !== undefined && own.some(module => runtimeOf(module, config.runtime as string) === group) ? '一个模块的运行角色'
      : undefined
    if (groupClash) problems.push(`${where}各模块的组角色 ${group}（按 database.login 起名）和${groupClash}同名：换个登录账号名或模块名`)

    const migrations: Migration[] = []
    const inDir = (dir: string): string[] => files.filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/') && path.endsWith('.sql'))
    for (const path of inDir(config.shared)) migrations.push({ path })
    for (const module of own) for (const path of inDir(`${module.dir}/${config.migrations}`)) migrations.push({ path, module })

    migrations.sort((a, b) => a.path.localeCompare(b.path))
    const stamps = new Map<string, string>()
    for (const { path } of migrations) {
      const file = path.slice(path.lastIndexOf('/') + 1)
      const stamp = TIMESTAMP.exec(file)?.[1]
      if (stamp === undefined) {
        problems.push(`迁移文件 ${path} 的文件名要以精确到秒的时间戳开头（14 位数字，比如 20261118093000_create_orders.sql）：迁移按时间戳统一排序执行`)
        continue
      }
      const other = stamps.get(stamp)
      if (other) problems.push(`迁移的时间戳重复：${other} 和 ${path} 都是 ${stamp}（各模块和共享层的迁移按时间戳统一排序执行），改成不同的时间。迁移只写正向，一个时间戳一个文件：不写回滚迁移（.down.sql 这类），按文件名排序执行的工具会把它当正向迁移跑`)
      else stamps.set(stamp, path)
    }
    return [{ app, schemas, migrations, problems }]
  })
}

/** 迁移目录以外的 .sql（应用自己的查询等）：在用库的应用的模块、共享层、装配层里，R6 不读。owner：按路径看文件归谁。 */
export function unreadSql(databases: readonly Database[], files: readonly string[], owner: (path: string) => { kind: string; app?: string }): string[] {
  const migrations = new Set(databases.flatMap(database => database.migrations.map(migration => migration.path)))
  return files.filter(path => {
    if (!path.endsWith('.sql') || migrations.has(path)) return false
    const at = owner(path)
    return (at.kind === 'module' || at.kind === 'shared' || at.kind === 'app') && databases.some(database => database.app.name === at.app)
  })
}
