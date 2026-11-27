// eslint 生效的规则改松了哪些：对两边都有的每个代码文件，用项目自己的 eslint 算它实际用的规则，和分叉点那一版比。
// 先在比较这一层把各种放松说清（不跑 eslint），再用真的 eslint 在临时仓库里走几遍：按目录的覆盖、按目录的忽略都要抓到。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type Effective, eslintItems, type FileRules } from '../../src/keep/eslint.ts'
import { userAgrees } from '../helpers.ts'
import { codekeep, eslintConfig, keepConfig, keepRepo, pendingOf, write } from './helpers.ts'

const rules = (map: Record<string, unknown[]>, unusedDirectives = 0, noInlineConfig = false): Effective => ({ rules: map, unusedDirectives, noInlineConfig })
/** 每个文件都用同一份规则。 */
const same = (files: string[], effective: Effective | undefined): FileRules => new Map(files.map(file => [file, effective]))
const texts = (before: FileRules, now: FileRules): string[] => eslintItems(before, now).map(item => item.text)
const ONE = ['src/a.js']
const between = (was: Record<string, unknown[]>, is: Record<string, unknown[]>): string[] => texts(same(ONE, rules(was)), same(ONE, rules(is)))

describe('比较生效的规则', () => {
  test('规则没了、关掉、从报错降成警告：各算一项，常见规则写白话的名字', () => {
    assert.deepEqual(between({ 'no-console': [2] }, {}), ['lint 规则 不许留调试用的 console（no-console） 没了：以后不再查这一条\n影响的代码：src/a.js'])
    assert.deepEqual(between({ 'no-console': [2] }, { 'no-console': [0] }), ['lint 规则 不许留调试用的 console（no-console） 关掉了：以后不再查这一条\n影响的代码：src/a.js'])
    assert.deepEqual(between({ 'prefer-const': [2] }, { 'prefer-const': [1] }), ['lint 规则 prefer-const 从报错降成了警告：以后违反它也能通过检查\n影响的代码：src/a.js'])
  })

  test('上限类规则调大算放松（写数字、写成 { max }、不写数字用规则的默认值都认），调小不问', () => {
    assert.deepEqual(between({ 'max-depth': [2, 3] }, { 'max-depth': [2, 5] }), ['代码嵌套层数上限（max-depth）从 3 层调到 5 层：以后代码可以嵌套得更深，更难读\n影响的代码：src/a.js'])
    assert.deepEqual(between({ 'max-lines': [2, { max: 300, skipComments: true }] }, { 'max-lines': [2, { max: 500, skipComments: true }] }), [
      '单个文件的行数上限（max-lines）从 300 行调到 500 行：以后一个文件可以写得更长，更难读\n影响的代码：src/a.js',
    ])
    assert.deepEqual(between({ complexity: [2, 10] }, { complexity: [2] }), ['函数复杂度上限（分支的多少）（complexity）从 10 调到 20：以后一个函数里可以有更多分支，更难读、更难测\n影响的代码：src/a.js'])
    for (const rule of ['max-lines-per-function', 'max-params', 'max-nested-callbacks']) {
      assert.equal(between({ [rule]: [2, 5] }, { [rule]: [2, 6] }).length, 1, rule)
      assert.deepEqual(between({ [rule]: [2, 5] }, { [rule]: [2, 4] }), [], rule)
    }
  })

  test('别的参数改了：看不出方向，列出原来和现在问；参数只是写的顺序不同不算', () => {
    assert.deepEqual(between({ 'max-lines': [2, { max: 300, skipComments: true }] }, { 'max-lines': [2, { max: 300, skipComments: false }] }), [
      'lint 规则 单个文件的行数上限（max-lines） 的参数改了，程序看不出是改松还是改紧\n原来：[{"max":300,"skipComments":true}]\n现在：[{"max":300,"skipComments":false}]\n影响的代码：src/a.js',
    ])
    assert.equal(between({ quotes: [2, 'single'] }, { quotes: [2, 'double'] }).length, 1)
    assert.deepEqual(between({ 'id-length': [2, { min: 2, exceptions: ['i'] }] }, { 'id-length': [2, { exceptions: ['i'], min: 2 }] }), [])
  })

  describe('参数很长时只列改了的地方', () => {
    const RULE = 'no-restricted-syntax'
    const TITLE = `lint 规则 ${RULE} 的参数改了，程序看不出是改松还是改紧`
    const FILES = '影响的代码：src/a.js'
    const changed = (was: unknown[], is: unknown[]): string[] => between({ [RULE]: [2, ...was] }, { [RULE]: [2, ...is] })
    /** 一条很长的选择器，middle 是中间那一段。 */
    const long = (middle: string): { selector: string } => ({ selector: `${'a'.repeat(50)}${middle}${'b'.repeat(50)}` })

    test('原来、现在两段参数加起来不超过 300 个字：照旧整段列；超过的不再整段列', () => {
      // 一项字符串的参数整段是 ["…"]，比文字多 4 个字
      assert.deepEqual(changed(['x'.repeat(146)], ['y'.repeat(146)]), [`${TITLE}\n原来：["${'x'.repeat(146)}"]\n现在：["${'y'.repeat(146)}"]\n${FILES}`])
      assert.deepEqual(changed(['x'.repeat(147)], ['y'.repeat(146)]), [`${TITLE}\n第 1 项 原来："${'x'.repeat(147)}"\n第 1 项 现在："${'y'.repeat(146)}"\n${FILES}`])
    })

    test('个数一样：逐项对，只列改了的项，取不同的地方前后各 30 个字，截掉的用"…"', () => {
      const was = [long('ONE'), long('TWO'), long('SIX')]
      const is = [long('ONE'), long('XYZ'), long('SIX')]
      assert.deepEqual(changed(was, is), [`${TITLE}\n第 2 项 原来：…${'a'.repeat(30)}TWO${'b'.repeat(30)}…\n第 2 项 现在：…${'a'.repeat(30)}XYZ${'b'.repeat(30)}…\n${FILES}`])
    })

    test('一项里有两处不同：从第一处列到最后一处，中间不变的也带上，后面那处不漏', () => {
      const item = (first: string, second: string): { selector: string } => ({ selector: `${'a'.repeat(50)}${first}${'c'.repeat(100)}${second}${'b'.repeat(50)}` })
      const [text] = changed([item('X', 'Y'), long('ONE')], [item('P', 'Q'), long('ONE')])
      const middle = 'c'.repeat(100)
      assert.equal(
        text,
        `${TITLE}\n第 1 项 原来：…${'a'.repeat(30)}X${middle}Y${'b'.repeat(30)}…\n第 1 项 现在：…${'a'.repeat(30)}P${middle}Q${'b'.repeat(30)}…\n${FILES}`,
      )
    })

    test('个数不一样：逐项对齐，没变的不列；同一段里删一项、加一项的配成"改了"，只列改了的那段；多出来的整项列出来，不截断', () => {
      // 第 1 项改在 120 个字以后，后面又多了一项
      const deep = (middle: string): { selector: string } => ({ selector: `${'X'.repeat(150)}${middle}${'Y'.repeat(20)}` })
      assert.deepEqual(changed([deep('LIMIT12'), long('KEEP')], [deep('LIMIT20'), long('KEEP'), deep('NEW')]), [
        [
          TITLE,
          `第 1 项 原来：…${'X'.repeat(25)}LIMIT12${'Y'.repeat(20)}"}`,
          `第 1 项 现在：…${'X'.repeat(25)}LIMIT20${'Y'.repeat(20)}"}`,
          `多了现在的第 3 项：${JSON.stringify(deep('NEW'))}`,
          FILES,
        ].join('\n'),
      ])
    })

    test('加了一项、少了一项：列"多了现在的第 N 项""少了原来的第 N 项"和整项，没变的项不列', () => {
      const [a, b, c] = [long('A'), long('B'), long('C')]
      const x = { selector: 'x'.repeat(300) }
      assert.deepEqual(changed([a, b, c], [a, x, b, c]), [`${TITLE}\n多了现在的第 2 项：${JSON.stringify(x)}\n${FILES}`])
      assert.deepEqual(changed([a, b, c], [a, c]), [`${TITLE}\n少了原来的第 2 项：${JSON.stringify(b)}\n${FILES}`])
    })

    test('重复的项删掉一个（[A, A, B] 改成 [A, B]）：也列出少了的那一项', () => {
      const [a, b] = [long('A'), long('B')]
      assert.deepEqual(changed([a, a, b], [a, b]), [`${TITLE}\n少了原来的第 2 项：${JSON.stringify(a)}\n${FILES}`])
    })

    test('不设处数上限：改了 7 项就列 7 项', () => {
      const [text] = changed(
        Array.from({ length: 7 }, (_, index) => long(`OLD${index}`)),
        Array.from({ length: 7 }, (_, index) => long(`NEW${index}`)),
      )
      const lines = (text ?? '').split('\n')
      assert.deepEqual(
        lines.filter(line => / 项 现在：/.test(line)).map(line => /NEW\d/.exec(line)?.[0]),
        Array.from({ length: 7 }, (_, index) => `NEW${index}`),
      )
      assert.ok(!lines.some(line => line.includes('还有')), text)
    })

    test('按字截，不切坏 emoji', () => {
      assert.deepEqual(changed(['😀'.repeat(200)], [`${'😀'.repeat(100)}😁${'😀'.repeat(99)}`]), [
        `${TITLE}\n第 1 项 原来：…${'😀'.repeat(61)}…\n第 1 项 现在：…${'😀'.repeat(30)}😁${'😀'.repeat(30)}…\n${FILES}`,
      ])
    })
  })

  test('新加规则、从警告升成报错、原来就关着的规则删掉：不问', () => {
    assert.deepEqual(between({ 'no-console': [1], 'no-var': [0] }, { 'no-console': [2], eqeqeq: [2] }), [])
  })

  test('没用的"这里不查"注释（reportUnusedDisableDirectives）降级、关掉：算一项', () => {
    assert.deepEqual(texts(same(ONE, rules({}, 2)), same(ONE, rules({}, 1))), [
      '没用了的"这里不查"注释（eslint-disable）从报错改成警告（reportUnusedDisableDirectives）：以后用不上的这类注释可以留在代码里\n影响的代码：src/a.js',
    ])
    assert.deepEqual(texts(same(ONE, rules({}, 0)), same(ONE, rules({}, 2))), [])
  })

  test('代码里的"这里不查"注释从不起作用改成起作用（关掉 noInlineConfig）：算一项，影响的文件合成一项；打开、一直开着不问', () => {
    const files = ['src/a.js', 'src/b.js']
    assert.deepEqual(texts(same(files, rules({}, 0, true)), same(files, rules({}, 0, false))), [
      '代码里就地关规则的注释（eslint-disable、/* eslint 规则: off */）从不起作用改成起作用（关掉了 noInlineConfig）：以后在代码里写一句注释就能关掉规则，不用改配置\n影响的代码：src/a.js、src/b.js',
    ])
    assert.deepEqual(texts(same(files, rules({}, 0, false)), same(files, rules({}, 0, true))), [])
    assert.deepEqual(texts(same(files, rules({}, 0, true)), same(files, rules({}, 0, true))), [])
  })

  test('同一处改动出现在很多文件上合成一项，写明多少个文件；不再被 lint 的文件合成一项；这次新加的文件不比', () => {
    const files = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js']
    const before = same(files, rules({ 'no-console': [2] }))
    const now: FileRules = new Map([...same(files.slice(0, 4), rules({})), ['src/e.js', undefined], ['src/new.js', undefined]])
    assert.deepEqual(texts(before, now), [
      'lint 规则 不许留调试用的 console（no-console） 没了：以后不再查这一条\n影响的代码：src/a.js、src/b.js、src/c.js 等 4 个文件',
      '1 个文件不再被 lint（被忽略了，或 eslint 配置不再覆盖它们）：以后这些代码 lint 一条也不查\nsrc/e.js',
    ])
  })
})

const CHECKS = [{ name: 'types', command: 'true' }]
const TEMPLATE = fileURLToPath(new URL('../../skills/setup-codekeep/frontend.eslint.mjs', import.meta.url))
/** 前端规则模板像项目那样填好组件库那几项（不填载入就报错）：用 antd，确认框、空状态的正文参数也填上。 */
const frontendTemplate = (): string =>
  readFileSync(TEMPLATE, 'utf8')
    .replace(/^const COMPONENT_LIBRARY = .*$/m, "const COMPONENT_LIBRARY = 'antd'")
    .replace(/^const ENTRY_PROPS = .*$/m, "const ENTRY_PROPS = [['Popconfirm', 'description'], ['Empty', 'description'], ['Result', 'subTitle']]")
const JOINED = { '.codekeep/config.json': keepConfig({ checks: CHECKS, eslint: { config: 'eslint.config.mjs' } }) }
const CODE = { 'src/a.js': 'export const a = 1\n', 'src/b.js': 'export const b = 1\n', 'src/legacy/old.js': 'export const old = 1\n', 'src/legacy/older.js': 'export const older = 1\n' }

describe('用项目自己的 eslint 比（每个代码文件都算）', () => {
  test('只在某个目录下关掉规则（按目录的覆盖）：抓得到，只列那个目录下的文件；同意后不再问，又改松别的只问新的', () => {
    const repo = keepRepo({ ...JOINED, ...CODE, 'eslint.config.mjs': eslintConfig({ 'no-console': 'error', 'max-depth': ['error', 3] }) })
    write(repo, 'eslint.config.mjs', eslintConfig({ 'no-console': 'error', 'max-depth': ['error', 3] }, "{ files: ['src/legacy/**'], rules: { 'no-console': 'off' } }"))
    let r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const asked = pendingOf(r.out)
    assert.deepEqual(asked.items, ['lint 规则 不许留调试用的 console（no-console） 关掉了：以后不再查这一条'])
    assert.match(asked.text, /影响的代码：src\/legacy\/old\.js、src\/legacy\/older\.js\n/)
    assert.ok(r.out.trimEnd().endsWith('-----'), '输出最后是交给确认工具的话')

    userAgrees(repo, asked.id, asked.text)
    r = codekeep(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /规范改松 1 项，用户都同意过/)

    write(repo, 'eslint.config.mjs', eslintConfig({ 'no-console': 'error', 'max-depth': ['error', 4] }, "{ files: ['src/legacy/**'], rules: { 'no-console': 'off' } }"))
    r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const again = pendingOf(r.out)
    assert.deepEqual(again.items, ['代码嵌套层数上限（max-depth）从 3 层调到 4 层：以后代码可以嵌套得更深，更难读'])
    assert.match(again.text, /影响的代码：src\/a\.js、src\/b\.js、src\/legacy\/old\.js 等 4 个文件/)
  })

  test('某个目录下的 noInlineConfig 关掉了：一项，列出那个目录下的文件；新打开 noInlineConfig 不问', () => {
    const inline = "{ files: ['src/legacy/**'], linterOptions: { noInlineConfig: true } }"
    const repo = keepRepo({ ...JOINED, ...CODE, 'eslint.config.mjs': eslintConfig({ 'no-console': 'error' }, inline) })
    write(repo, 'eslint.config.mjs', eslintConfig({ 'no-console': 'error' }))
    let r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const asked = pendingOf(r.out)
    assert.deepEqual(asked.items, ['代码里就地关规则的注释（eslint-disable、/* eslint 规则: off */）从不起作用改成起作用（关掉了 noInlineConfig）：以后在代码里写一句注释就能关掉规则，不用改配置'])
    assert.match(asked.text, /影响的代码：src\/legacy\/old\.js、src\/legacy\/older\.js\n/)

    const tighter = keepRepo({ ...JOINED, ...CODE, 'eslint.config.mjs': eslintConfig({ 'no-console': 'error' }) })
    write(tighter, 'eslint.config.mjs', eslintConfig({ 'no-console': 'error' }, "{ files: ['**/*.js'], linterOptions: { noInlineConfig: true } }"))
    r = codekeep(tighter, ['check'])
    assert.equal(r.code, 0, r.out)
  })

  test('按目录忽略：原来查、现在不查的文件合成一项，列出文件', () => {
    const repo = keepRepo({ ...JOINED, ...CODE, 'eslint.config.mjs': eslintConfig({ 'no-console': 'error' }) })
    write(repo, 'eslint.config.mjs', eslintConfig({ 'no-console': 'error' }, "{ ignores: ['src/legacy/**'] }"))
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const asked = pendingOf(r.out)
    assert.deepEqual(asked.items, ['2 个文件不再被 lint（被忽略了，或 eslint 配置不再覆盖它们）：以后这些代码 lint 一条也不查'])
    assert.match(asked.text, /\n {3}src\/legacy\/old\.js\n {3}src\/legacy\/older\.js\n/)
  })

  test('加规则、调严：不问，照常跑 lint 和检查；这次新加的文件不比', () => {
    const repo = keepRepo({ ...JOINED, ...CODE, 'eslint.config.mjs': eslintConfig({ 'no-console': 'warn', 'max-depth': ['error', 5] }) })
    write(repo, 'eslint.config.mjs', eslintConfig({ 'no-console': 'error', 'max-depth': ['error', 2], eqeqeq: 'error' }, "{ ignores: ['src/new/**'] }"))
    write(repo, 'src/new/fresh.js', 'export const fresh = 1\n')
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /规范配置没有改松（和分叉点上的比）；规范检查都过了（lint、types）/)
  })

  test('biome 的配置改了：和 eslint 规则的放松一起列出来问', () => {
    const repo = keepRepo({ ...JOINED, ...CODE, 'eslint.config.mjs': eslintConfig({ 'no-console': 'error' }), 'biome.json': '{}\n' })
    write(repo, 'eslint.config.mjs', eslintConfig({}))
    write(repo, 'biome.json', '{"linter":{"enabled":false}}\n')
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(pendingOf(r.out).items, [
      'lint 规则 不许留调试用的 console（no-console） 没了：以后不再查这一条',
      'biome 的配置 biome.json 改了，程序看不出 lint、格式规则是改松还是改紧',
    ])
  })

  test('前端规则模板的 NAME_MAX 从 12 改成 20：只列改了的几处，看得到"超过 12 个字"和"超过 20 个字"，不整段列', () => {
    const template = frontendTemplate()
    const page = { 'src/pages/Orders.js': 'export const a = 1\n' }
    const repo = keepRepo({ ...JOINED, ...page, 'eslint.config.mjs': template })
    write(repo, 'eslint.config.mjs', template.replace(/^const NAME_MAX = 12$/m, 'const NAME_MAX = 20'))
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const asked = pendingOf(r.out)
    assert.equal(asked.items.length, 1, asked.text)
    assert.match(asked.items[0] ?? '', /no-restricted-syntax.* 的参数改了，程序看不出是改松还是改紧/)
    assert.match(asked.text, /超过 12 个字/)
    assert.match(asked.text, /超过 20 个字/)
    assert.doesNotMatch(asked.text, /原来：\[/, '不整段列参数')
    assert.ok(asked.text.length < 10_000, `整项 ${asked.text.length} 个字`)
  })

  test('前端规则模板的 ENTRY_PROPS 加一项（选择器后面多一段、条目个数也变了）：加的那段出现在弹窗文字里', () => {
    const template = frontendTemplate()
    const repo = keepRepo({ ...JOINED, 'src/pages/Orders.js': 'export const a = 1\n', 'eslint.config.mjs': template })
    const entryProps = /^const ENTRY_PROPS = \[(.*)\]$/m
    assert.match(template, entryProps)
    write(repo, 'eslint.config.mjs', template.replace(entryProps, "const ENTRY_PROPS = [$1, ['Card', 'title']]"))
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const asked = pendingOf(r.out)
    assert.equal(asked.items.length, 1, asked.text)
    assert.match(asked.items[0] ?? '', /no-restricted-syntax.* 的参数改了/)
    assert.match(asked.text, /JSXOpeningElement\[name\.name='Card'\] > JSXAttribute\[name\.name='title'\]/)
    assert.doesNotMatch(asked.text, /原来：\[/, '不整段列参数')
  })

  test('分叉点那一版的 eslint 配置算不出来：不当成没放松，列成"程序看不出"的一项问', () => {
    const repo = keepRepo({ ...JOINED, ...CODE, 'eslint.config.mjs': "throw new Error('分叉点上的配置坏了')\n" })
    write(repo, 'eslint.config.mjs', eslintConfig({ 'no-console': 'error' }))
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(pendingOf(r.out).items, ['lint 规则：分叉点那一版算不出来，程序看不出这次是改松还是改紧'])
    assert.match(r.out, /分叉点那一版算不出来的原因（不用给用户看）：\n {2}· eslint 生效的规则（分叉点那一版）：.*分叉点上的配置坏了/)
  })

  test('现在这一版一个代码文件都没 lint 到：配置问题，退出码 2，不跑检查', () => {
    const repo = keepRepo({ ...JOINED, ...CODE, 'eslint.config.mjs': eslintConfig({ 'no-console': 'error' }) })
    write(repo, 'eslint.config.mjs', eslintConfig({ 'no-console': 'error' }, "{ ignores: ['**'] }"))
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /现在这一版的规范配置算不出来.*\n {2}✗ eslint\.config\.mjs 一个代码文件都没 lint 到/)
    assert.doesNotMatch(r.out, /== 规范检查/)
  })
})
