// 读文件就比得出来的放松：.codekeep/config.json、eslint 的批量豁免文件、gitleaks 的忽略文件和配置、biome 的配置。
// 和分叉点那一版比，放松的才成为要用户确认的一项；收紧的不问。要跑工具才比得出来的见 eslint、tsconfig、prettier 的测试。

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type Config, parseConfig } from '../../src/keep/config.ts'
import { biomeItem, configItems, gitleaksItems, suppressionsItem } from '../../src/keep/loosen.ts'

const BASE = {
  checks: [
    { name: 'types', command: 'tsc --noEmit' },
    { name: 'lint', command: 'eslint . --max-warnings 0' },
  ],
  eslint: { config: 'eslint.config.mjs' },
  tsconfig: ['tsconfig.json', 'web/tsconfig.json'],
  prettier: true,
  secrets: true,
}
const config = (change: Record<string, unknown> = {}): Config => {
  const parsed = parseConfig(JSON.stringify({ ...BASE, ...change }))
  assert.ok(parsed.config, parsed.problems.join('\n'))
  return parsed.config
}
/** 从 BASE 改成 change 后，各项的头一行。 */
const loosened = (change: Record<string, unknown>): string[] => configItems(config(), config(change)).map(item => item.text.split('\n')[0] ?? '')

describe('.codekeep/config.json 改松了哪些', () => {
  test('没改、只收紧（加检查、加 tsconfig、打开开关）：不问', () => {
    assert.deepEqual(loosened({}), [])
    const looser = config({ prettier: false, secrets: false, tsconfig: ['tsconfig.json'], checks: BASE.checks.slice(0, 1) })
    assert.deepEqual(configItems(looser, config({ checks: [...BASE.checks, { name: 'format', command: 'prettier --check .' }] })), [])
  })

  test('检查的命令改了、检查删了：各算一项；同一条命令换个名字不算', () => {
    assert.deepEqual(loosened({ checks: [BASE.checks[0], { name: 'lint', command: 'eslint .' }] }), ['规范检查"lint"的命令改了，程序看不出是改松还是改紧'])
    assert.deepEqual(loosened({ checks: BASE.checks.slice(0, 1) }), ['删掉了规范检查"lint"：以后整组里不再跑它'])
    assert.deepEqual(loosened({ checks: [{ name: '类型检查', command: 'tsc --noEmit' }, { name: 'eslint', command: 'eslint . --max-warnings 0' }] }), [])
  })

  test('删掉 eslint 一项、删掉一个 tsconfig、换 eslint 配置文件或豁免文件的位置：各算一项', () => {
    assert.deepEqual(loosened({ eslint: undefined }), ['不再比 eslint 生效的规则（删掉了 eslint 一项）：以后 lint 规则改松了程序看不出来'])
    assert.deepEqual(loosened({ tsconfig: ['tsconfig.json'] }), ['不再比 web/tsconfig.json 的严格选项：以后这份类型检查配置改松了程序看不出来'])
    assert.deepEqual(loosened({ eslint: { config: 'eslint.loose.mjs', suppressions: 'other.json' } }), [
      '拿来比规则的 eslint 配置文件从 eslint.config.mjs 换成了 eslint.loose.mjs：程序看不出两份是不是一回事，lint 实际用的可能不是这一份',
      'eslint 的批量豁免文件从 eslint-suppressions.json 换成了 other.json：换过去的那份里豁免了什么没和原来的比',
    ])
  })

  test('prettier、secrets 从开改成关：各算一项', () => {
    assert.deepEqual(loosened({ prettier: false, secrets: false }), [
      '不再比格式检查查哪些文件（关掉了 prettier 一项）：以后往忽略文件里加路径、躲开格式检查，程序看不出来',
      '关掉了密钥扫描（secrets）：以后提交里带了密钥、密码，整组不再拦',
    ])
  })
})

describe('eslint 的批量豁免文件', () => {
  const file = (counts: Record<string, Record<string, number>>): string =>
    JSON.stringify(Object.fromEntries(Object.entries(counts).map(([path, rules]) => [path, Object.fromEntries(Object.entries(rules).map(([rule, count]) => [rule, { count }]))])))
  const BEFORE = file({ 'src/a.ts': { 'no-console': 2 } })

  test('豁免数变多、新加文件或规则的条目：合成一项，逐处写明从几处变成几处', () => {
    const now = file({ 'src/a.ts': { 'no-console': 3, '@typescript-eslint/no-explicit-any': 1 }, 'src/b.ts': { complexity: 1 } })
    const item = suppressionsItem('eslint-suppressions.json', { before: BEFORE, now })
    assert.equal(
      item?.text,
      [
        'eslint 的批量豁免文件 eslint-suppressions.json 多豁免了 3 处：这些地方违反了规则也照样通过',
        'src/a.ts：不许用 any 跳过类型（@typescript-eslint/no-explicit-any） 从 0 处变成 1 处',
        'src/a.ts：不许留调试用的 console（no-console） 从 2 处变成 3 处',
        'src/b.ts：函数复杂度上限（分支的多少）（complexity） 从 0 处变成 1 处',
      ].join('\n'),
    )
    // 分叉点上还没有这个文件：现在有的都算新加的豁免
    assert.match(suppressionsItem('eslint-suppressions.json', { before: undefined, now: BEFORE })?.text ?? '', /多豁免了 1 处/)
  })

  test('豁免变少、删掉条目、删掉整个文件：不问', () => {
    assert.equal(suppressionsItem('eslint-suppressions.json', { before: BEFORE, now: file({ 'src/a.ts': { 'no-console': 1 } }) }), undefined)
    assert.equal(suppressionsItem('eslint-suppressions.json', { before: BEFORE, now: file({}) }), undefined)
    assert.equal(suppressionsItem('eslint-suppressions.json', { before: BEFORE, now: undefined }), undefined)
  })

  test('改了又读不出来：程序看不出是不是多豁免了，也算一项', () => {
    assert.match(suppressionsItem('eslint-suppressions.json', { before: BEFORE, now: '{' })?.text ?? '', /现在这一版读不出来，程序看不出是不是多豁免了/)
  })
})

describe('gitleaks、biome 的配置', () => {
  test('.gitleaksignore 新加的条目合成一项（注释、空行、删掉的不算）；.gitleaks.toml 新加、改了、删掉都算一项', () => {
    const none = { before: undefined, now: undefined }
    const ignore = { before: '# 旧的\na.js:github-pat:1\n', now: '# 旧的\nb.js:github-pat:3\n\nc.js:generic-api-key:9\n' }
    assert.deepEqual(
      gitleaksItems(ignore, none).map(item => item.text),
      ['.gitleaksignore 新加了 2 条忽略：扫密钥时这些发现不再算\nb.js:github-pat:3\nc.js:generic-api-key:9'],
    )
    assert.deepEqual(gitleaksItems({ before: ignore.before, now: '' }, none), [])
    for (const [toml, what] of [
      [{ before: undefined, now: '[extend]\nuseDefault = true\n' }, '新加了'],
      [{ before: 'a', now: 'b' }, '改了'],
      [{ before: 'a', now: undefined }, '删掉了'],
    ] as const) {
      assert.deepEqual(gitleaksItems(none, toml).map(item => item.text), [`gitleaks 的配置 .gitleaks.toml ${what}，程序看不出扫密钥是改松还是改紧`])
    }
  })

  test('biome 的配置新加、改了、删掉都算一项，没变的不问', () => {
    assert.equal(biomeItem('biome.json', { before: '{}', now: '{"linter":{"enabled":false}}' })?.text, 'biome 的配置 biome.json 改了，程序看不出 lint、格式规则是改松还是改紧')
    assert.equal(biomeItem('biome.jsonc', { before: undefined, now: '{}' })?.text, 'biome 的配置 biome.jsonc 新加了，程序看不出 lint、格式规则是改松还是改紧')
    assert.equal(biomeItem('biome.json', { before: '{}', now: undefined })?.text, 'biome 的配置 biome.json 删掉了，程序看不出 lint、格式规则是改松还是改紧')
    assert.equal(biomeItem('biome.json', { before: '{}', now: '{}' }), undefined)
  })
})
