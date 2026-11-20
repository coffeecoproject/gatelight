// R6 数据库越界的判定：迁移文件那部分（modwall check，不连库）在这里；库里的现状由 dbcheck.ts 查，两边共用这里的判法和改法。
//   引用别的模块的内部 schema（入口 schema 可以，算进 R2 的边）；外键跨模块；共享层引用模块的 schema；
//   视图建在别的模块的入口上；直接写别的模块入口里的视图；在自己以外的 schema 里建、改、删对象（共享层也不建、删模块的）；入口 schema 里建表；
//   函数没把 search_path 设成本模块的内部 schema 加 pg_temp、不是 SECURITY DEFINER；迁移、函数里改 search_path；迁移里切身份、建 schema；
//   别名、没起别名的表名和模块的 schema 同名（检查按名字认 schema，同名的会被当成跨模块引用）。
// 模块的代码里切身份（按固定写法认文字）也在这里：应用代码里只有装配层和共享层可以切。
// 函数里切身份不用查文字：函数一律 SECURITY DEFINER，Postgres 不让 SECURITY DEFINER 的函数切身份。

import { apiOf, type Database, internalOf, SHARED_SCHEMA, type SchemaOwner, schemaLabel } from './database.ts'
import { isCode } from './files.ts'
import { label, type Module, type Owner } from './layout.ts'
import type { Edge, Violation } from './rules.ts'
import { type Statement, statements } from './sql.ts'

/** 引用的 schema 怎么判：from 是写它的模块（undefined 是共享层）。 */
export type Crossing =
  | { kind: 'internal'; schema: string; owner: Extract<SchemaOwner, { kind: 'internal' }> }
  | { kind: 'shared-to-module'; schema: string; owner: Extract<SchemaOwner, { kind: 'internal' | 'api' }> }
  | { kind: 'api'; schema: string; owner: Extract<SchemaOwner, { kind: 'api' }> }

/** 引用了 schema 的 x.y 怎么判。不是模块 schema 的名字（别名、pg_catalog、public 里扩展的对象）不管；本模块和 shared 可以引用。 */
export function crossing(database: Database, from: Module | undefined, schema: string): Crossing | undefined {
  const owner = database.schemas.get(schema)
  if (!owner || owner.kind === 'shared') return undefined
  if (from === undefined) return { kind: 'shared-to-module', schema, owner }
  if (owner.module.id === from.id) return undefined
  return owner.kind === 'internal' ? { kind: 'internal', schema, owner } : { kind: 'api', schema, owner }
}

/** 函数该设的 search_path：本模块的内部 schema（共享层是 shared），后面跟 pg_temp。 */
export function expectedSearchPath(from: Module | undefined): string {
  return `${from === undefined ? SHARED_SCHEMA : internalOf(from)}, pg_temp`
}

export function searchPathOk(from: Module | undefined, values: readonly string[]): boolean {
  return values.join(', ') === expectedSearchPath(from)
}

/**
 * 句子里会被当成 schema 的名字：别名、CTE 名和任何模块的 schema 同名的；没起别名的表名和会被当成跨模块引用的 schema 同名的。
 * 这些名字限定的 x.y 在这句里不再当成 schema 引用，只报名字。
 */
export function nameClashes(database: Database, from: Module | undefined, statement: Statement): Array<{ name: string; line: number; alias: boolean }> {
  const moduleSchema = (name: string): boolean => {
    const owner = database.schemas.get(name)
    return owner !== undefined && owner.kind !== 'shared'
  }
  return [
    ...statement.aliases.filter(alias => moduleSchema(alias.name)).map(alias => ({ ...alias, alias: true })),
    // FROM 里写的是这句的 CTE 名的，不是表
    ...statement.relations
      .filter(relation => crossing(database, from, relation.name) && !statement.aliases.some(alias => alias.name === relation.name))
      .map(relation => ({ ...relation, alias: false })),
  ]
}

/** 句子直接写的别的模块入口里的对象（写别的模块的内部 schema 按引用内部报，共享层写模块按共享层引用模块报）。 */
export function writtenApis(database: Database, from: Module | undefined, statement: Statement): Array<{ target: string; line: number; module: Module }> {
  return statement.writes.flatMap(write => {
    const found = write.schema === undefined ? undefined : crossing(database, from, write.schema)
    return found?.kind === 'api' ? [{ target: `${write.schema}.${write.name}`, line: write.line, module: found.owner.module }] : []
  })
}

export const FIXES = {
  shared: '共享层只放没有业务含义的结构（比如迁移记录表），不能引用模块的 schema：把对象和读写挪回所属模块；真正通用的结构放进 shared。',
  apiTable: (module: Module, api: string) => `入口 schema 只放给别的模块用的视图和函数：表建在 ${module.id} 的内部 schema ${internalOf(module)} 里，在 ${api} 里建视图或函数给别的模块用。`,
  foreignKey: (module: string) => `模块之间不建外键：只存 ${module} 的 id，存在性和删除规则由应用经 ${module} 的入口保证（删除一般改成软删除）。`,
  searchPath: (expected: string) =>
    `函数一律带 SET search_path = ${expected}：不写全名的就是本模块的对象，引用别的模块、shared 要写带 schema 的全名；pg_temp 放最后，别人建的同名临时表才骗不了以提供方身份执行的函数。`,
  setsSearchPath: '迁移和函数里不改 search_path：跑迁移的工具已经把它设成本模块的内部 schema，函数用自己的 SET search_path。要用别的 schema 的对象，写带 schema 的全名。',
  switchesRole:
    "迁移里不切身份（SET ROLE、RESET ROLE、SET SESSION AUTHORIZATION、set_config('role', …)，在角色、库上设 role 也算）：跑迁移的工具已经切成本模块的角色。要别的模块做事，在它的迁移里做，或者调用它入口里的函数（以它的角色执行）。",
  createsSchema: '迁移里不建 schema：跑迁移的工具按模块目录建好模块的角色和两个 schema（共享层的 shared 也由它建），迁移只在里面建对象。删掉这句。',
  codeSwitchesRole:
    "模块的代码不自己切身份：连接在事务开头由装配层或共享层里那个切身份的小函数切成本模块的角色。要别的模块的数据，经它的代码入口或数据库入口。这里写的其实不是 SQL（注释、说明文字）的，换个说法。",
  missingRole: (role: string) =>
    `跑迁移的工具发现一个模块目录，就建同名的角色和它的两个 schema（共享层是 shared 角色和 shared schema），已有就跳过：CREATE ROLE ${role} NOLOGIN。`,
  roleAttributes: (role: string) =>
    `模块和共享层的角色只用来切身份，本身不能登录、没有特权：ALTER ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB；能在库里建 schema 的，REVOKE CREATE ON DATABASE … FROM ${role}（授给 PUBLIC 的也要收回）。`,
  publicCreate: 'public 里不放对象：REVOKE CREATE ON SCHEMA public FROM PUBLIC（Postgres 14 默认授给所有角色），授给这个角色的也收回。',
  owner: (role: string) =>
    `模块的两个 schema 和里面的对象归模块的角色，shared 的归 shared 角色：迁移切成这个角色执行，建出来的就归它；已有的用 ALTER … OWNER TO ${role} 改，再查迁移工具有没有切身份。`,
  createPrivilege: (schema: string, owner: string, role: string) =>
    `只有 ${owner} 能在 ${schema} 里建对象，别的模块要什么让它在自己的迁移里加：REVOKE CREATE ON SCHEMA ${schema} FROM ${role}（授给 PUBLIC 的也收回）；是经成员关系继承来的，把成员关系设成不继承或去掉。`,
  internalPrivilege: (schema: string, role: string) =>
    `内部 schema 只有模块自己能用，别的模块经入口：REVOKE ALL ON SCHEMA ${schema} FROM ${role}（授给 PUBLIC 的也收回）；是 ${role} 经成员关系继承来的（比如登录账号），把成员关系设成不继承（NOINHERIT，Postgres 16 起 GRANT … WITH INHERIT FALSE）或去掉。`,
  securityDefiner:
    '函数一律 SECURITY DEFINER：以所在模块（共享层）的角色执行，入口函数才碰得到内部的表，函数里也切不了身份（Postgres 不让）。建函数时写上（CREATE OR REPLACE 不写会改回按调用者执行），不用 SECURITY INVOKER；要 COMMIT 的过程拆开或放到应用代码里。',
  securityInvoker: (module: Module) =>
    `入口视图以 ${module.id} 的角色读它内部的表，别的模块的角色用不了 ${internalOf(module)}：去掉 security_invoker（ALTER VIEW … RESET (security_invoker)）。`,
  connect: (database: string, accounts: string[]) =>
    `库只让本项目的两个账号连：角色是整个 Postgres 实例共用的，同一个实例上别的项目有同名的模块角色时，它的登录账号连进这个库就能切成这个角色、读写这个模块。建库那一步收回、授予：REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC；GRANT CONNECT ON DATABASE ${database} TO ${accounts.join(', ')}。`,
  account: (role: string) =>
    `程序的登录账号、跑迁移的账号要能登录，本身没有权限，只能切成模块的角色：不是超级用户（超级用户不受权限限制，越界查不出来），不拥有任何对象（拥有的对象改归所属模块的角色）。还没有就建：CREATE ROLE ${role} LOGIN NOINHERIT，再把它加进各模块角色的成员。`,
  alias: '表、列的别名、CTE 的名字、函数里的变量不能和模块的 schema 同名，否则会被当成跨模块引用：换个名字。',
  bareRelation: (name: string) => `表名 ${name} 和模块的 schema 同名：给它起个别名（FROM … AS 别名），用别名限定列，不用表名，否则 ${name}.列 会被当成跨模块引用。`,
  internal: (module: Module, schema: string) =>
    `要 ${module.id} 的数据，在函数或代码里走它的入口 schema ${apiOf(module)} 里的视图、函数，或者 ${module.id} 的代码入口；入口里没有，就在 ${apiOf(module)} 新增（作为单独的一小步）。${schema} 其实是表名、别名或变量的，改个和模块 schema 不同的名字。`,
  viewOnApi: (module: Module) =>
    `不在别的模块的入口上建视图（BEGIN ATOMIC 写正文的函数也一样）：Postgres 不让删被依赖的视图，${module.id} 以后就改不动自己的入口了。跨模块的读取写在函数正文（plpgsql，或 AS $$…$$ 的 sql 函数）或应用代码里，经 ${apiOf(module)}。`,
  foreignSchema: (owner: string) =>
    `一个模块的迁移只在自己的内部、入口两个 schema 里建、改、删对象（挂触发器、规则、策略、索引，写注释、授权也算）：${owner}里的对象由它自己的迁移改；要它改，在它那边加迁移（入口只加不改）。`,
  writeApi: (module: Module) => `跨模块写入走对方入口里的函数，不直接写 ${apiOf(module)} 里的视图：在 ${module.id} 的入口里加一个做这件事的函数（作为单独的一小步），再调用它。`,
}

/** R6 里迁移文件那部分：读每个库的迁移，给出越界和数据库里模块之间的引用（R2 用）。read：读仓库里的文件。 */
export function migrationViolations(databases: readonly Database[], read: (path: string) => string): { violations: Violation[]; edges: Edge[] } {
  const violations: Violation[] = []
  const edges: Edge[] = []
  for (const database of databases) {
    for (const { path, module } of database.migrations) {
      const who = module ? `${module.id} 模块的迁移` : '共享层的迁移'
      const add = (line: number, key: string, where: string, fix: string): void => {
        violations.push({ rule: 'R6', key: `R6 ${path} ${key}`, where: [`${path}:${line}（${who}）${where}`], fix })
      }
      for (const statement of statements(read(path))) {
        const clashes = nameClashes(database, module, statement)
        for (const clash of clashes) {
          const label = schemaLabel(clash.name, database.schemas.get(clash.name) as SchemaOwner)
          if (clash.alias) add(clash.line, `别名 ${clash.name}`, `的别名 ${clash.name} 和 ${label} 同名`, FIXES.alias)
          else add(clash.line, `表名 ${clash.name}`, `引用的表 ${clash.name} 没起别名，和 ${label} 同名`, FIXES.bareRelation(clash.name))
        }
        const clashing = new Set(clashes.map(clash => clash.name))
        const targets = new Set(statement.targets.map(target => `${target.schema}.${target.name}:${target.line}`))

        if (statement.setsSearchPath) add(statement.line, '改 search_path', '改了 search_path', FIXES.setsSearchPath)
        // 函数正文里切身份由库拒绝（函数一律 SECURITY DEFINER）
        if (statement.switchesRole && !statement.inFunction) add(statement.line, '切身份', '切了身份', FIXES.switchesRole)
        for (const schema of statement.schemas) add(schema.line, `建 schema ${schema.name}`, `建了 schema ${schema.name}`, FIXES.createsSchema)
        const created = new Set(statement.schemas.map(schema => `${schema.name}:${schema.line}`))

        // 建、改、删的对象只能在自己的 schema 里（共享层只能在 shared 里）；建 schema 上面报了
        for (const target of statement.targets) {
          if (target.schema === undefined || created.has(`${target.name}:${target.line}`)) continue
          const owner = database.schemas.get(target.schema)
          if (!owner || (owner.kind === 'shared' ? module === undefined : owner.module.id === module?.id)) continue
          const where = `在 ${schemaLabel(target.schema, owner)} 里建、改或删了 ${target.name}`
          add(target.line, `改 ${target.schema}.${target.name}`, where, module ? FIXES.foreignSchema(schemaLabel(target.schema, owner)) : FIXES.shared)
        }

        for (const ref of statement.refs) {
          if (clashing.has(ref.schema)) continue
          const found = crossing(database, module, ref.schema)
          // 建、改、删的对象本身已经按上面报了
          if (!found || targets.has(`${ref.schema}.${ref.name}:${ref.line}`)) continue
          const target = `${ref.schema}.${ref.name}`
          if (found.kind === 'shared-to-module') {
            add(ref.line, `引用 ${target}`, `引用了 ${schemaLabel(ref.schema, found.owner)}：${target}`, FIXES.shared)
            continue
          }
          edges.push({ from: (module as Module).id, to: found.owner.module.id, site: `${path}:${ref.line}`, what: `引用了 ${target}` })
          if (ref.references) add(ref.line, `外键 ${target}`, `建了指向 ${found.owner.module.id} 模块的外键：REFERENCES ${target}`, FIXES.foreignKey(found.owner.module.id))
          else if (found.kind === 'internal') add(ref.line, `引用 ${target}`, `引用了 ${schemaLabel(ref.schema, found.owner)}：${target}`, FIXES.internal(found.owner.module, ref.schema))
          else if (statement.view) add(ref.line, `视图建在 ${target}`, `的视图建在 ${found.owner.module.id} 模块的入口上：${target}`, FIXES.viewOnApi(found.owner.module))
        }

        for (const written of writtenApis(database, module, statement)) {
          add(written.line, `写 ${written.target}`, `直接写了 ${written.module.id} 模块入口里的 ${written.target}`, FIXES.writeApi(written.module))
        }

        for (const table of statement.tables) {
          const owner = table.schema === undefined ? undefined : database.schemas.get(table.schema)
          // 别的模块的入口按"在自己以外的 schema 里建对象"报了
          if (owner?.kind !== 'api' || owner.module.id !== module?.id) continue
          add(table.line, `入口建表 ${table.schema}.${table.name}`, `在入口 schema ${table.schema} 里建表 ${table.name}`, FIXES.apiTable(owner.module, table.schema as string))
        }

        const fn = statement.function
        const nameOf = (item: { schema?: string; name: string }): string => (item.schema === undefined ? item.name : `${item.schema}.${item.name}`)
        if (fn && !fn.securityDefiner) add(fn.line, `函数 ${nameOf(fn)} 身份`, `的函数 ${nameOf(fn)} 不是 SECURITY DEFINER`, FIXES.securityDefiner)
        if (statement.invoker) {
          const name = nameOf(statement.invoker)
          add(statement.invoker.line, `函数 ${name} 身份`, `把函数 ${name} 改成了 SECURITY INVOKER`, FIXES.securityDefiner)
        }
        if (fn && !searchPathOk(module, fn.searchPath ?? [])) {
          const name = nameOf(fn)
          const said =
            fn.searchPath === undefined ? '没有设 search_path' : fn.searchPath.length ? `的 search_path 设成了 ${fn.searchPath.join(', ')}` : '的 search_path 不是写定的值（FROM CURRENT）'
          add(fn.line, `函数 ${name} search_path`, `的函数 ${name} ${said}，要设成 ${expectedSearchPath(module)}`, FIXES.searchPath(expectedSearchPath(module)))
        }
      }
    }
  }
  return { violations, edges }
}

/** 代码里切身份的固定写法：SET [LOCAL|SESSION] ROLE、RESET ROLE、SESSION AUTHORIZATION、set_config('role', …)。不分大小写。 */
const SWITCH_ROLE = /\b(?:re)?set\s+(?:(?:local|session)\s+)?role\b|\bsession\s+authorization\b|\bset_config\s*\(\s*['"`]role['"`]/giu

/**
 * 模块的代码里切身份：用库的应用里，归模块的代码文件和迁移目录以外的 .sql（应用自己的查询），测试文件不算。装配层、共享层可以切（那个切身份的小函数在这里）。
 * modwall 不解析代码里的 SQL，只按文字认固定写法；拼出来的认不出。owner：按路径看文件归谁。read：读仓库里的文件。
 */
export function codeRoleSwitches(databases: readonly Database[], files: readonly string[], owner: (path: string) => Owner, read: (path: string) => string): Violation[] {
  const violations: Violation[] = []
  const migrations = new Set(databases.flatMap(database => database.migrations.map(migration => migration.path)))
  for (const path of files) {
    if (!isCode(path) && !(path.endsWith('.sql') && !migrations.has(path))) continue
    const at = owner(path)
    if (at.kind !== 'module' || !databases.some(database => database.app.name === at.app)) continue
    const text = read(path)
    for (const match of text.matchAll(SWITCH_ROLE)) {
      const line = text.slice(0, match.index).split('\n').length
      violations.push({ rule: 'R6', key: `R6 ${path} 切身份 ${line}`, where: [`${path}:${line}（${label(at)}）切了数据库的身份：${match[0].replace(/\s+/g, ' ')}`], fix: FIXES.codeSwitchesRole })
    }
  }
  return violations
}
