// 读文件就比得出来的放松：.codekeep/config.json、gitleaks 的忽略文件和配置、biome 的配置。
// 和分叉点那一版比，放松的才成为要用户确认的一项；收紧的不问。要跑工具才比得出来的见 eslint、tsconfig、prettier 的测试。

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type Config, parseConfig } from '../../src/keep/config.ts'
import { biomeItem, configItems, gitleaksItems } from '../../src/keep/loosen.ts'

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

  test('删掉 eslint 一项、删掉一个 tsconfig、换 eslint 配置文件：各算一项', () => {
    assert.deepEqual(loosened({ eslint: undefined }), ['不再比 eslint 生效的规则（删掉了 eslint 一项）：以后 lint 规则改松了程序看不出来'])
    assert.deepEqual(loosened({ tsconfig: ['tsconfig.json'] }), ['不再比 web/tsconfig.json 的严格选项：以后这份类型检查配置改松了程序看不出来'])
    assert.deepEqual(loosened({ eslint: { config: 'eslint.loose.mjs' } }), [
      '拿来比规则的 eslint 配置文件从 eslint.config.mjs 换成了 eslint.loose.mjs：程序看不出两份是不是一回事，lint 实际用的可能不是这一份',
    ])
  })

  test('prettier、secrets 从开改成关：各算一项', () => {
    assert.deepEqual(loosened({ prettier: false, secrets: false }), [
      '不再比格式检查查哪些文件（关掉了 prettier 一项）：以后往忽略文件里加路径、躲开格式检查，程序看不出来',
      '关掉了密钥扫描（secrets）：以后提交里带了密钥、密码，整组不再拦',
    ])
  })
})

describe('styles（主题文件、组件层目录）去掉了哪些', () => {
  const STYLES = { theme: ['src/theme.ts', 'admin/src/theme.ts'], ui: ['src/ui', 'admin/src/ui'] }

  test('从 styles 里去掉一个主题文件、一个组件层目录：各算一项', () => {
    const before = config({ styles: STYLES })
    const texts = configItems(before, config({ styles: { theme: ['src/theme.ts'], ui: ['admin/src/ui'] } })).map(item => item.text)
    assert.deepEqual(texts, [
      '不再管主题文件 admin/src/theme.ts（从 styles 里去掉了）：以后改它不再问你',
      '不再管组件层目录 src/ui 里的样式文件（从 styles 里去掉了）：以后改这些样式不再问你',
    ])
  })

  test('整个去掉 styles：写着的每个路径各算一项', () => {
    assert.deepEqual(configItems(config({ styles: STYLES }), config()).map(item => item.text), [
      '不再管主题文件 src/theme.ts（从 styles 里去掉了）：以后改它不再问你',
      '不再管主题文件 admin/src/theme.ts（从 styles 里去掉了）：以后改它不再问你',
      '不再管组件层目录 src/ui 里的样式文件（从 styles 里去掉了）：以后改这些样式不再问你',
      '不再管组件层目录 admin/src/ui 里的样式文件（从 styles 里去掉了）：以后改这些样式不再问你',
    ])
  })

  test('新写上 styles、往里加路径：不问', () => {
    assert.deepEqual(configItems(config(), config({ styles: STYLES })), [])
    assert.deepEqual(configItems(config({ styles: { theme: ['src/theme.ts'] } }), config({ styles: STYLES })), [])
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
