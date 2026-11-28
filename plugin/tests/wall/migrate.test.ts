// modwall migrate、modwall db bootstrap 的命令这一层：参数、选哪个应用的库、配置有问题时不跑、执行 SQL 的命令的退出码怎么算。
// 用假的 psql；脚本在真库上做了什么（权限、迁移记录）在 migrate-postgres.ts（16、17 各一个测试文件）。

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fakePsql, modwall, sampleRepo, write } from './helpers.ts'

const DATABASE = { migrations: 'migrations', shared: 'src/shared/migrations', login: '<module>_app', migrator: 'migrator' }
const COMMANDS = [
  { name: 'modwall migrate', args: ['migrate'] },
  { name: 'modwall db bootstrap', args: ['db', 'bootstrap'] },
]

function dbRepo(config: Record<string, unknown> = { database: DATABASE }): string {
  return sampleRepo(dir => {
    write(dir, '.modwall/config.json', JSON.stringify({ roots: ['src/modules'], shared: ['src/shared/**'], app: ['src/main.ts'], entry: ['index.ts'], outside: ['scripts/**'], ...config }))
    write(dir, 'src/modules/billing/migrations/20260101000000_billing.sql', 'CREATE TABLE invoices (id int);\n')
  })
}

describe('modwall migrate、db bootstrap 的用法', () => {
  test('--psql 和 --print 必须给且只给一个：都不给、都给是用法错误（退出码 2），不跑命令', () => {
    const repo = dbRepo()
    for (const { name, args } of COMMANDS) {
      const none = modwall(repo, args)
      assert.equal(none.code, 2, none.out)
      assert.match(none.out, new RegExp(`^${name} 要用 --psql 告诉它用什么命令执行 SQL.*，或者用 --print 只输出脚本`))
      const psql = fakePsql([])
      const both = modwall(repo, [...args, '--print', '--psql', psql.command])
      assert.equal(both.code, 2, both.out)
      assert.match(both.out, new RegExp(`^${name}：--psql 和 --print 只用一个`))
      assert.equal(existsSync(psql.stdin), false, `${name} 没有跑 --psql 的命令`)
    }
  })

  test('--print 只把脚本写到标准输出；--psql 时同一段脚本从标准输入交给命令（在 sh 里跑），命令成功就通过', () => {
    const repo = dbRepo()
    for (const { name, args } of COMMANDS) {
      const printed = modwall(repo, [...args, '--print'])
      assert.equal(printed.code, 0, printed.out)
      assert.match(printed.out, new RegExp(`^-- ${name} 生成`))
      assert.match(printed.out, /\\set ON_ERROR_STOP on/)
      const psql = fakePsql(['psql 说的话'])
      const ran = modwall(repo, [...args, '--psql', psql.command])
      assert.equal(ran.code, 0, ran.out)
      assert.equal(readFileSync(psql.stdin, 'utf8'), printed.out, `${name}：交给命令的就是 --print 输出的那段`)
      assert.match(ran.out, /psql 说的话/, '命令的输出原样给用户')
    }
    assert.match(modwall(repo, ['migrate', '--print']).out, /src\/modules\/billing\/migrations\/20260101000000_billing\.sql/)
  })

  test('几个应用都写了 database：要用 --app 指定，生成的是那个应用的库的脚本', () => {
    const repo = sampleRepo(dir => {
      const app = (name: string) => ({
        roots: [`apps/${name}/modules`], shared: [`apps/${name}/shared/**`], entry: ['index.ts'],
        database: { ...DATABASE, shared: `apps/${name}/shared/migrations`, login: `${name}_<module>`, migrator: `${name}_migrator` },
      })
      write(dir, '.modwall/config.json', JSON.stringify({ apps: { web: app('web'), server: app('server') }, outside: ['scripts/**', 'src/**'] }))
      write(dir, 'apps/web/modules/pages/index.ts', 'export const a = 1\n')
      write(dir, 'apps/server/modules/orders/index.ts', 'export const b = 1\n')
    })
    for (const { name, args } of COMMANDS) {
      const which = modwall(repo, [...args, '--print'])
      assert.equal(which.code, 2, which.out)
      assert.match(which.out, new RegExp(`^${name}：web、server 几个应用都写了 database，用 --app 指定哪个应用的库`))
      const unknown = modwall(repo, [...args, '--print', '--app', 'mobile'])
      assert.equal(unknown.code, 2, unknown.out)
      assert.match(unknown.out, /没有写了 database 的应用叫 mobile（写了的有：web、server）/)
      const server = modwall(repo, [...args, '--print', '--app', 'server'])
      assert.equal(server.code, 0, server.out)
      assert.match(server.out, new RegExp(`^-- ${name} 生成（server 应用）`))
      assert.match(server.out, /server_migrator/)
      assert.doesNotMatch(server.out, /web_/)
    }
    const migrate = modwall(repo, ['migrate', '--print', '--app', 'server']).out
    assert.match(migrate, /CREATE SCHEMA IF NOT EXISTS "orders_api"/)
    assert.doesNotMatch(migrate, /pages/)
  })

  test('modwall help 里 migrate 说运行账号的密码从环境变量 MODWALL_LOGIN_PASSWORD 读', () => {
    const help = modwall(dbRepo(), ['help'])
    assert.equal(help.code, 0, help.out)
    assert.match(help.out, /modwall migrate .*\n(?: {20,}.*\n)*? {20,}环境变量 MODWALL_LOGIN_PASSWORD 是各运行账号的密码/)
  })

  test('配置有问题、配置里没有 database：用法错误（退出码 2），不跑命令', () => {
    const clash = dbRepo({ database: { ...DATABASE, migrator: 'modules_app' } })
    const none = dbRepo({})
    for (const { name, args } of COMMANDS) {
      const psql = fakePsql([])
      const broken = modwall(clash, [...args, '--psql', psql.command])
      assert.equal(broken.code, 2, broken.out)
      assert.match(broken.out, new RegExp(`^${name}：配置有问题（.modwall/config.json），先改好：\n {2}✗ 各模块的组角色 modules_app`))
      const missing = modwall(none, [...args, '--psql', psql.command])
      assert.equal(missing.code, 2, missing.out)
      assert.match(missing.out, /里没有写 database/)
      assert.equal(existsSync(psql.stdin), false, `${name} 没有跑 --psql 的命令`)
      assert.equal(modwall(clash, [...args, '--print']).code, 2, '--print 也不输出脚本')
    }
  })

  test('脚本出错（psql 带 ON_ERROR_STOP 退出码 3）：没通过（退出码 1），说出错的那一步整步回滚了', () => {
    const repo = dbRepo()
    for (const { name, args } of COMMANDS) {
      const r = modwall(repo, [...args, '--psql', fakePsql(['ERROR:  permission denied'], 3).command])
      assert.equal(r.code, 1, r.out)
      assert.match(r.out, new RegExp(`${name}：没做完，出错的那一步整步回滚了`))
    }
  })

  test('执行 SQL 的命令别的失败（连不上库这类）、命令不存在：没跑成（退出码 2）', () => {
    const repo = dbRepo()
    for (const { name, args } of COMMANDS) {
      const failed = modwall(repo, [...args, '--psql', fakePsql(['psql: error: connection refused'], 2).command])
      assert.equal(failed.code, 2, failed.out)
      assert.match(failed.out, new RegExp(`${name}：执行 SQL 的命令失败（退出码 2，`))
      const missing = modwall(repo, [...args, '--psql', 'modwall-no-such-psql'])
      assert.equal(missing.code, 2, missing.out)
      assert.match(missing.out, /执行 SQL 的命令失败（退出码 127/)
    }
  })
})
