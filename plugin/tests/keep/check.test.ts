// codekeep check 的主流程：接没接入、配置写得对不对、先比放松再跑 lint 和检查、首次接入不问、分叉点配置有不认的字段、删掉配置要用户同意、沙箱里不跑。

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { userAgrees } from '../helpers.ts'
import { codekeep, eslintConfig, keepConfig, keepRepo, pendingOf, sh, tempDir, write } from './helpers.ts'

/** 检查命令跑过就往这个文件里记一行名字：看跑了哪几条、按什么顺序。 */
function ranLog(): { log: string; ran: () => string[]; check: (name: string, exit?: number) => { name: string; command: string } } {
  const log = join(tempDir('codekeep-ran-'), 'ran')
  return {
    log,
    ran: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    check: (name, exit = 0) => ({ name, command: `echo ${name} >> '${log}'; exit ${exit}` }),
  }
}

const TSCONFIG = `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, allowJs: true }, include: ['src'] })}\n`
const CODE = { 'src/a.js': 'export const a = 1\n' }

describe('接入', () => {
  test('没有 .codekeep/ 的仓库没接入：check 说明不检查，退出码 0', () => {
    const repo = keepRepo(CODE)
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.equal(r.out, '这个仓库没有接入 codekeep（没有 .codekeep/ 目录），不检查。\n')
  })

  test('首次接入（分叉点上还没有配置）：不比、不问，直接跑检查', () => {
    const { check, ran } = ranLog()
    const repo = keepRepo({ ...CODE, 'eslint.config.mjs': eslintConfig({ 'no-console': 'error' }), 'tsconfig.json': TSCONFIG })
    write(repo, '.codekeep/config.json', keepConfig({ checks: [check('types'), check('format')], eslint: { config: 'eslint.config.mjs' }, tsconfig: ['tsconfig.json'], secrets: false }))
    // 同一次改动里 eslint、tsconfig 也放松了：首次接入照样不问
    write(repo, 'eslint.config.mjs', eslintConfig({}))
    write(repo, 'tsconfig.json', TSCONFIG.replace('"strict":true', '"strict":false'))
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /codekeep check：通过。规范配置没有改松（和分叉点上的比）；规范检查都过了（lint、types、format）。/)
    assert.deepEqual(ran(), ['types', 'format'])
  })
})

describe('配置和环境问题：退出码 2，不跑检查', () => {
  test('配置写错、写到的文件不在：列出问题', () => {
    const { check, ran } = ranLog()
    const repo = keepRepo({ ...CODE, '.codekeep/config.json': keepConfig({ checks: [check('lint')] }) })
    write(repo, '.codekeep/config.json', keepConfig({ checks: [check('lint')], extra: 1 }))
    let r = codekeep(repo, ['check'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /^codekeep check：配置有问题（\.codekeep\/config\.json），先改好再检查：\n {2}✗ .*有未知字段 "extra"/)

    write(repo, '.codekeep/config.json', keepConfig({ checks: [check('lint')], eslint: { config: 'eslint.config.mjs' }, tsconfig: ['tsconfig.json'] }))
    r = codekeep(repo, ['check'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /✗ \.codekeep\/config\.json 里写的 eslint\.config\.mjs 不在/)
    assert.match(r.out, /✗ \.codekeep\/config\.json 里写的 tsconfig\.json 不在/)

    assert.deepEqual(ran(), [], '配置有问题时一条检查都没跑')
  })

  test('有 .codekeep/ 目录但没有配置文件：说照技能写好配置', () => {
    const repo = keepRepo({ ...CODE, '.codekeep/README.md': '待写\n' })
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /有 \.codekeep\/ 目录但没有 \.codekeep\/config\.json，照 gatelight:setup-codekeep 技能写好配置/)
  })

  test('现在这一版的 eslint、tsc、prettier 没装（算不出生效的配置）：环境问题', () => {
    const { check, ran } = ranLog()
    const config = keepConfig({ checks: [check('lint')], eslint: { config: 'eslint.config.mjs' }, tsconfig: ['tsconfig.json'], prettier: true })
    const repo = keepRepo({ ...CODE, '.codekeep/config.json': config, 'eslint.config.mjs': eslintConfig({}), 'tsconfig.json': TSCONFIG }, { modules: false })
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /现在这一版的规范配置算不出来，先修好（依赖没装的先装好）/)
    assert.match(r.out, /✗ eslint 生效的规则算不出来（eslint\.config\.mjs）：项目里没装 eslint/)
    assert.match(r.out, /✗ 格式检查查哪些文件算不出来（prettier）：项目里没装 prettier/)
    assert.match(r.out, /✗ tsconfig\.json 生效的选项算不出来：项目里没装 typescript/)
    assert.deepEqual(ran(), [])
  })

  test('在 Codex 的沙箱里不跑，说明要提权；提权后照常跑', () => {
    const { check, ran } = ranLog()
    const repo = keepRepo({ ...CODE, '.codekeep/config.json': keepConfig({ checks: [check('lint')] }) })
    const r = codekeep(repo, ['check'], { CODEX_THREAD_ID: 't', CODEX_SANDBOX: 'seatbelt' })
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /^codekeep 要在 Codex 的沙箱外跑：.+申请提权（在沙箱外）重新运行这条命令。/)
    assert.deepEqual(ran(), [])
    assert.equal(codekeep(repo, ['check'], { CODEX_THREAD_ID: 't' }).code, 0)
    assert.deepEqual(ran(), ['lint'])
  })
})

describe('先比放松，再依次跑检查', () => {
  test('检查按写的顺序跑，一条没过就停，退出码 1', () => {
    const { check, ran } = ranLog()
    const repo = keepRepo({ ...CODE, '.codekeep/config.json': keepConfig({ checks: [check('types'), check('lint', 3), check('format')] }) })
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /codekeep check：没通过，规范检查"lint"没过（退出码 3）。按上面的输出改代码；不要为了过关改松规范/)
    assert.deepEqual(ran(), ['types', 'lint'])
  })

  test('有没经用户同意的放松：不跑检查，退出码 1，最后是交给确认工具的话；同意后照常跑', () => {
    const { check, ran } = ranLog()
    const checks = [check('types'), check('lint')]
    const repo = keepRepo({ ...CODE, '.codekeep/config.json': keepConfig({ checks }) })
    write(repo, '.codekeep/config.json', keepConfig({ checks: checks.slice(0, 1) }))
    let r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^codekeep check：没通过。\n\n规范改松了 1 项（和分叉点上的比），要用户同意：\n {2}· 删掉了规范检查"lint"：以后整组里不再跑它\n/)
    assert.match(r.out, /这 1 项还没经用户确认。用户不会看命令输出，要调用 gatelight 的 confirm_with_user 工具/)
    assert.ok(r.out.trimEnd().endsWith('同意：按这样改。不同意：告诉 agent 改回去或换个做法。\n-----'), r.out)
    assert.deepEqual(ran(), [])

    const asked = pendingOf(r.out)
    assert.match(asked.text, /^这次改动里放松代码规范的地方，要你确认的有 1 项：\n\n1\. 删掉了规范检查"lint"：以后整组里不再跑它\n {3}原来的命令：echo lint/)
    userAgrees(repo, asked.id, asked.text)
    r = codekeep(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /通过。规范改松 1 项，用户都同意过；规范检查都过了（types）/)
    assert.deepEqual(ran(), ['types'])
  })
})

describe('lint：配了 eslint 的，codekeep 用项目的 eslint 直接查，跑在检查命令之前', () => {
  const LINTED = { '.codekeep/config.json': keepConfig({ checks: [{ name: 'types', command: 'true' }], eslint: { config: 'eslint.config.mjs' } }) }
  const BAD = 'var b = 1\nexport { b }\n'

  test('有错误：退出码 1，说 lint 有几个错误、列出错误（不列警告），检查命令不跑', () => {
    const { check, ran } = ranLog()
    const repo = keepRepo({ ...CODE, 'eslint.config.mjs': eslintConfig({ 'no-var': 'error', 'no-console': 'warn' }) })
    write(repo, '.codekeep/config.json', keepConfig({ checks: [check('types')], eslint: { config: 'eslint.config.mjs' } }))
    write(repo, 'src/bad.js', `${BAD}console.log(b)\nvar c = 2\nexport { c }\n`)
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /src\/bad\.js\n\s+1:1\s+error\s+.*no-var\n\s+4:1\s+error\s+.*no-var/)
    assert.doesNotMatch(r.out, /no-console/, '警告不列')
    assert.match(r.out, /codekeep check：没通过，lint 有 2 个错误（上面列出）/)
    assert.deepEqual(ran(), [], '检查命令不跑')
  })

  test('只有警告：通过，通过那一行写"lint，N 条警告"；被忽略的文件、不是代码的文件不查', () => {
    const { check, ran } = ranLog()
    const repo = keepRepo({ ...CODE, 'eslint.config.mjs': eslintConfig({ 'no-var': 'error', 'no-console': 'warn' }, "{ ignores: ['src/legacy/**'] }") })
    write(repo, '.codekeep/config.json', keepConfig({ checks: [check('types')], eslint: { config: 'eslint.config.mjs' } }))
    write(repo, 'src/warn.js', 'console.log(1)\nconsole.log(2)\n')
    write(repo, 'src/legacy/old.js', BAD)
    write(repo, 'notes.txt', 'var x = 1\n')
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /codekeep check：通过。规范配置没有改松（和分叉点上的比）；规范检查都过了（lint，2 条警告、types）。/)
    assert.deepEqual(ran(), ['types'])
  })

  test('eslint --suppress-all 生成的豁免文件不起作用：仓库根目录的、被 git 忽略的、名字大小写不同的、建成目录的，lint 有错照样没通过', () => {
    const repo = keepRepo({ ...CODE, ...LINTED, '.gitignore': 'node_modules\nignored/\n', 'eslint.config.mjs': eslintConfig({ 'no-var': 'error' }) })
    write(repo, 'src/bad.js', BAD)
    // 豁免文件是真的：eslint 命令行读了它就不报
    sh(repo, 'node_modules/.bin/eslint --suppress-all . >/dev/null')
    assert.equal(sh(repo, 'node_modules/.bin/eslint . >/dev/null && echo ok').trim(), 'ok', '命令行读了豁免文件就过')
    const generated = readFileSync(join(repo, 'eslint-suppressions.json'), 'utf8')
    assert.match(generated, /no-var/)

    const fails = (where: string): void => {
      const r = codekeep(repo, ['check'])
      assert.equal(r.code, 1, `${where}：${r.out}`)
      assert.match(r.out, /codekeep check：没通过，lint 有 1 个错误/, where)
    }
    fails('根目录')
    for (const [where, path] of [
      ['被 git 忽略的', 'ignored/eslint-suppressions.json'],
      ['名字大小写不同的', 'ESLint-Suppressions.json'],
      ['建成目录的', 'eslint-suppressions.json/eslint-suppressions.json'],
    ] as const) {
      rmSync(join(repo, 'eslint-suppressions.json'), { recursive: true, force: true })
      rmSync(join(repo, 'ignored'), { recursive: true, force: true })
      write(repo, path, generated)
      fails(where)
    }
  })

  test('检查命令里带 --suppress-all 本身不算没通过；lint 有错照样不过', () => {
    const checks = [{ name: 'lint-cli', command: 'true eslint . --suppress-all --suppressions-location lint/suppressions.json' }]
    const repo = keepRepo({ ...CODE, '.codekeep/config.json': keepConfig({ checks, eslint: { config: 'eslint.config.mjs' } }), 'eslint.config.mjs': eslintConfig({ 'no-var': 'error' }) })
    let r = codekeep(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /规范检查都过了（lint、lint-cli）/)

    write(repo, 'src/bad.js', BAD)
    r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /lint 有 1 个错误/)
  })

  test('lint 跑不起来（规则在 lint 时出错）：退出码 2', () => {
    const boom = "{ files: ['**/*.js'], plugins: { boom: { rules: { x: { create() { throw new Error('规则坏了') } } } } }, rules: { 'boom/x': 'error' } }"
    const repo = keepRepo({ ...CODE, ...LINTED, 'eslint.config.mjs': eslintConfig({}, boom) })
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /codekeep check：lint 没跑成（eslint\.config\.mjs）：.*规则坏了/)
  })
})

describe('分叉点上的配置有现在不认的字段', () => {
  test('老版本的 eslint.suppressions 去掉了、同时 lint 规则改松：照常比，改松的照样列出，另列一项不认的字段，都要用户同意', () => {
    const before = keepConfig({ checks: [{ name: 'types', command: 'true' }], eslint: { config: 'eslint.config.mjs', suppressions: 'eslint-suppressions.json' } })
    const repo = keepRepo({ ...CODE, '.codekeep/config.json': before, 'eslint.config.mjs': eslintConfig({ 'no-console': 'error' }) })
    write(repo, '.codekeep/config.json', keepConfig({ checks: [{ name: 'types', command: 'true' }], eslint: { config: 'eslint.config.mjs' } }))
    write(repo, 'eslint.config.mjs', eslintConfig({ 'no-console': 'off' }))
    let r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const asked = pendingOf(r.out)
    assert.deepEqual(asked.items, [
      '分叉点上的 .codekeep/config.json 有现在不认的字段，这几处程序看不出是改松还是改紧（别的照常比了）：',
      'lint 规则 不许留调试用的 console（no-console） 关掉了：以后不再查这一条',
    ])
    assert.match(asked.text, /"eslint" 有未知字段 "suppressions"/)

    userAgrees(repo, asked.id, asked.text)
    r = codekeep(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /规范改松 2 项，用户都同意过/)
  })

  test('配置被删掉、分叉点上的配置有不认的字段：照样读得出来，问删掉配置的那一项', () => {
    const before = keepConfig({ checks: [{ name: 'types', command: 'true' }], eslint: { config: 'eslint.config.mjs', suppressions: 'eslint-suppressions.json' } })
    const repo = keepRepo({ ...CODE, '.codekeep/config.json': before, 'eslint.config.mjs': eslintConfig({}) })
    rmSync(join(repo, '.codekeep'), { recursive: true })
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(pendingOf(r.out).items, ['删掉了整个 .codekeep/ 目录：以后不再跑规范检查（类型检查、lint、格式），规范改松了也没人发现'])
  })
})

describe('删掉配置', () => {
  test('删掉整个 .codekeep/ 躲不过：要用户同意，同意后这份改动退出 codekeep，不再跑检查', () => {
    const { check, ran } = ranLog()
    const repo = keepRepo({ ...CODE, '.codekeep/config.json': keepConfig({ checks: [check('lint')], secrets: true }) })
    rmSync(join(repo, '.codekeep'), { recursive: true })
    let r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const asked = pendingOf(r.out)
    assert.deepEqual(asked.items, ['删掉了整个 .codekeep/ 目录：以后不再跑规范检查（类型检查、lint、格式、密钥扫描），规范改松了也没人发现'])
    userAgrees(repo, asked.id, asked.text)
    r = codekeep(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /配置删掉了，用户同意过：这份改动退出 codekeep，不再检查/)
    assert.deepEqual(ran(), [])
  })

  test('只删配置文件、留着目录：也要用户同意', () => {
    const repo = keepRepo({ ...CODE, '.codekeep/config.json': keepConfig({ checks: [{ name: 'lint', command: 'true' }] }), '.codekeep/README.md': '说明\n' })
    sh(repo, 'git rm -q .codekeep/config.json')
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(pendingOf(r.out).items, ['删掉了配置文件 .codekeep/config.json：以后不再跑规范检查（类型检查、lint、格式），规范改松了也没人发现'])
  })
})
