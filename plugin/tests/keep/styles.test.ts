// 前端具体的外观只准写在主题文件和组件层目录的样式文件里，这两处改了要用户同意：和分叉点那一版比，一个文件一项，按行列出原来和现在。
// 先在比较这一层把各种改动说清（临时仓库里直接比，不跑 codekeep），再用 codekeep check 走几遍：配置问题、首次接入、同意后不再问。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { StylesConfig } from '../../src/keep/config.ts'
import { stylesItems } from '../../src/keep/styles.ts'
import { userAgrees } from '../helpers.ts'
import { codekeep, keepConfig, keepRepo, pendingOf, write } from './helpers.ts'

const THEME = "export const theme = {\n  colorPrimary: '#1677ff',\n  borderRadius: 6,\n  fontSize: 14,\n}\n"
const styles = (theme: string[], ui: string[] = []): StylesConfig => ({ theme, ui })
/** 分叉点上放着 files 的仓库，切到分支后写上 changes（值为 undefined 的删掉），和分叉点比出的各项。 */
function itemsAfter(files: Record<string, string>, changes: Record<string, string | undefined>, before: StylesConfig, now: StylesConfig = before): string[] {
  const repo = keepRepo(files, { modules: false })
  for (const [path, text] of Object.entries(changes)) {
    if (text === undefined) rmSync(join(repo, path))
    else write(repo, path, text)
  }
  return stylesItems(repo, 'main', before, now).map(item => item.text)
}

describe('主题文件改了', () => {
  test('内容改了：一个文件一项，头一句说删掉几行、新加几行和页面会跟着变，下面逐行列原来和现在', () => {
    const now = THEME.replace("'#1677ff'", "'#ff4d4f'").replace('fontSize: 14,', 'fontSize: 16,\n  lineHeight: 1.6,')
    assert.deepEqual(itemsAfter({ 'src/theme.ts': THEME }, { 'src/theme.ts': now }, styles(['src/theme.ts'])), [
      [
        '主题文件 src/theme.ts 改了（删掉 2 行、新加 3 行）：页面上用到这些颜色、尺寸的地方都会跟着变',
        "原来：colorPrimary: '#1677ff',",
        '原来：fontSize: 14,',
        "现在：colorPrimary: '#ff4d4f',",
        '现在：fontSize: 16,',
        '现在：lineHeight: 1.6,',
      ].join('\n'),
    ])
  })

  test('改的行多：最多列 10 行，多的写"……还有 K 行"', () => {
    const before = `${Array.from({ length: 8 }, (_, i) => `--size-${i}: ${i}px;`).join('\n')}\n`
    const now = before.replace(/(\d)px/g, '$10px')
    const [item] = itemsAfter({ 'src/theme.css': before }, { 'src/theme.css': now }, styles(['src/theme.css']))
    const lines = item?.split('\n') ?? []
    assert.equal(lines[0], '主题文件 src/theme.css 改了（删掉 8 行、新加 8 行）：页面上用到这些颜色、尺寸的地方都会跟着变')
    assert.equal(lines.length, 12, item)
    assert.deepEqual(lines.slice(1, 3), ['原来：--size-0: 0px;', '原来：--size-1: 1px;'])
    assert.deepEqual(lines.slice(9, 11), ['现在：--size-0: 00px;', '现在：--size-1: 10px;'])
    assert.equal(lines[11], '……还有 6 行')
  })

  test('只是缩进、行尾空白、空行变了：不问；没改的不问', () => {
    const reformatted = `\n${THEME.replace(/^ {2}/gm, '    ').replace('borderRadius: 6,', 'borderRadius: 6,   \n\n')}\n\n`
    assert.deepEqual(itemsAfter({ 'src/theme.ts': THEME }, { 'src/theme.ts': reformatted }, styles(['src/theme.ts'])), [])
    assert.deepEqual(itemsAfter({ 'src/theme.ts': THEME }, {}, styles(['src/theme.ts'])), [])
  })
})

describe('组件层目录里的样式文件改了', () => {
  const UI = {
    'src/ui/button.css': '.button {\n  padding: 4px 12px;\n}\n',
    'src/ui/card.less': '.card { margin: 8px; }\n',
    'src/ui/Button.tsx': "import './button.css'\nexport const Button = () => null\n",
  }

  test('新加、删掉、改了内容的样式文件各一项；删掉的不列行', () => {
    const items = itemsAfter(
      UI,
      { 'src/ui/button.css': '.button {\n  padding: 6px 16px;\n}\n', 'src/ui/card.less': undefined, 'src/ui/chart/chart.scss': '.chart {\n  height: 240px;\n}\n' },
      styles([], ['src/ui']),
    )
    assert.deepEqual(items, [
      '组件层的样式文件 src/ui/button.css 改了（删掉 1 行、新加 1 行）：用到它的组件在页面上的样子会变，要到页面上看\n原来：padding: 4px 12px;\n现在：padding: 6px 16px;',
      '删掉了组件层的样式文件 src/ui/card.less：用到它的组件在页面上的样子会变，要到页面上看',
      '新加了组件层的样式文件 src/ui/chart/chart.scss（3 行）：用到它的组件在页面上的样子会变，要到页面上看\n现在：.chart {\n现在：height: 240px;\n现在：}',
    ])
  })

  test('.css、.less、.scss、.sass、.styl 都算样式文件；组件代码（.tsx、.js）改了、新加了不问', () => {
    const changes = Object.fromEntries(['a.css', 'b.less', 'c.scss', 'd.sass', 'e.styl'].map(name => [`src/ui/${name}`, '.x { color: red; }\n']))
    const items = itemsAfter(UI, { ...changes, 'src/ui/Button.tsx': "export const Button = () => 'changed'\n", 'src/ui/Card.js': 'export const Card = 1\n' }, styles([], ['src/ui']))
    assert.deepEqual(
      items.map(item => item.split('\n')[0]),
      ['a.css', 'b.less', 'c.scss', 'd.sass', 'e.styl'].map(name => `新加了组件层的样式文件 src/ui/${name}（1 行）：用到它的组件在页面上的样子会变，要到页面上看`),
    )
  })

  test('组件层目录外的样式文件改了不问', () => {
    assert.deepEqual(itemsAfter({ ...UI, 'src/pages/home.css': '.home {}\n' }, { 'src/pages/home.css': '.home { margin: 3px; }\n' }, styles([], ['src/ui'])), [])
  })

  test('主题文件同时在组件层目录里：只按主题文件算一次', () => {
    const items = itemsAfter({ ...UI, 'src/ui/theme.css': ':root { --primary: #1677ff; }\n' }, { 'src/ui/theme.css': ':root { --primary: #ff4d4f; }\n' }, styles(['src/ui/theme.css'], ['src/ui']))
    assert.deepEqual(
      items.map(item => item.split('\n')[0]),
      ['主题文件 src/ui/theme.css 改了（删掉 1 行、新加 1 行）：页面上用到这些颜色、尺寸的地方都会跟着变'],
    )
  })
})

describe('只比两版配置里都写着的路径', () => {
  test('这次新写进 styles 的主题文件、组件层目录：不比、不问', () => {
    const files = { 'src/theme.ts': THEME, 'src/brand.ts': 'export const brand = 1\n', 'src/ui/button.css': '.button {}\n' }
    const changes = { 'src/brand.ts': 'export const brand = 2\n', 'src/ui/button.css': '.button { padding: 4px; }\n' }
    assert.deepEqual(itemsAfter(files, changes, styles(['src/theme.ts']), styles(['src/theme.ts', 'src/brand.ts'], ['src/ui'])), [])
  })
})

const CHECKS = [{ name: 'lint', command: 'true' }]
const STYLED = keepConfig({ checks: CHECKS, styles: { theme: ['src/theme.ts'], ui: ['src/ui'] } })
const FRONT = { 'src/theme.ts': THEME, 'src/ui/button.css': '.button {\n  padding: 4px 12px;\n}\n' }

describe('codekeep check 里的主题和组件层', () => {
  test('主题文件改了：要用户同意，同意后通过；再改一次又问新的', () => {
    const repo = keepRepo({ '.codekeep/config.json': STYLED, ...FRONT })
    write(repo, 'src/theme.ts', THEME.replace('fontSize: 14,', 'fontSize: 16,'))
    let r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const asked = pendingOf(r.out)
    assert.deepEqual(asked.items, ['主题文件 src/theme.ts 改了（删掉 1 行、新加 1 行）：页面上用到这些颜色、尺寸的地方都会跟着变'])
    assert.match(asked.text, /\n {3}原来：fontSize: 14,\n {3}现在：fontSize: 16,/)

    userAgrees(repo, asked.id, asked.text)
    r = codekeep(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /规范改松 1 项，用户都同意过/)

    write(repo, 'src/theme.ts', THEME.replace('fontSize: 14,', 'fontSize: 18,'))
    r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(pendingOf(r.out).items, ['主题文件 src/theme.ts 改了（删掉 1 行、新加 1 行）：页面上用到这些颜色、尺寸的地方都会跟着变'])
    assert.match(pendingOf(r.out).text, /原来：fontSize: 14,\n {3}现在：fontSize: 18,/)
  })

  test('从 styles 里去掉主题文件、组件层目录：各要用户同意一项，去掉的路径里的改动不再比', () => {
    const repo = keepRepo({ '.codekeep/config.json': STYLED, ...FRONT })
    write(repo, '.codekeep/config.json', keepConfig({ checks: CHECKS }))
    write(repo, 'src/theme.ts', THEME.replace('fontSize: 14,', 'fontSize: 16,'))
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(pendingOf(r.out).items, [
      '不再管主题文件 src/theme.ts（从 styles 里去掉了）：以后改它不再问你',
      '不再管组件层目录 src/ui 里的样式文件（从 styles 里去掉了）：以后改这些样式不再问你',
    ])
  })

  test('首次接入、已接入后这次才写上 styles：主题、组件层改了都不问', () => {
    const fresh = keepRepo(FRONT)
    write(fresh, '.codekeep/config.json', STYLED)
    write(fresh, 'src/theme.ts', THEME.replace('fontSize: 14,', 'fontSize: 16,'))
    let r = codekeep(fresh, ['check'])
    assert.equal(r.code, 0, r.out)

    const joined = keepRepo({ '.codekeep/config.json': keepConfig({ checks: CHECKS }), ...FRONT })
    write(joined, '.codekeep/config.json', STYLED)
    write(joined, 'src/theme.ts', THEME.replace('fontSize: 14,', 'fontSize: 16,'))
    write(joined, 'src/ui/button.css', '.button { padding: 0; }\n')
    r = codekeep(joined, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /规范配置没有改松（和分叉点上的比）/)
  })

  test('styles 写的主题文件不在、组件层目录不在或不是目录：配置问题，退出码 2', () => {
    const repo = keepRepo({ '.codekeep/config.json': keepConfig({ checks: CHECKS }), 'src/ui.css': '.x {}\n' })
    write(repo, '.codekeep/config.json', keepConfig({ checks: CHECKS, styles: { theme: ['src/theme.ts'], ui: ['src/ui.css', 'src/widgets'] } }))
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /✗ \.codekeep\/config\.json 里写的 src\/theme\.ts 不在（要写仓库里现有的文件）/)
    assert.match(r.out, /✗ \.codekeep\/config\.json 里写的 src\/ui\.css 不在（要写仓库里现有的目录）/)
    assert.match(r.out, /✗ \.codekeep\/config\.json 里写的 src\/widgets 不在（要写仓库里现有的目录）/)
  })
})
