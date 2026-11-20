import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type Config, parseConfig } from '../../src/wall/config.ts'
import { Layout } from '../../src/wall/layout.ts'
import { miniprogramRefs } from '../../src/wall/miniprogram.ts'
import { importViolations } from '../../src/wall/rules.ts'
import { modwall, sh, tempDir, write } from './helpers.ts'

const M = 'miniprogram'

/** 小程序项目的文件：路径 → 内容。 */
const FILES: Record<string, string> = {
  [`${M}/app.json`]: JSON.stringify({ pages: [], usingComponents: { 'app-button': '/shared/components/app-button/app-button' } }),
  [`${M}/app.ts`]: '',
  [`${M}/shared/components/app-button/app-button.ts`]: '',
  [`${M}/shared/styles/base.wxss`]: '',
  [`${M}/shared/templates/empty.wxml`]: '',
  [`${M}/shared/utils/format.wxs`]: '',
  [`${M}/modules/booking/components/record-sheet/record-sheet.js`]: '',
  [`${M}/modules/booking/pages/list/parts/inner-card/inner-card.json`]: '{}',
  [`${M}/modules/booking/pages/list/list.wxss`]: '',
  [`${M}/modules/home/pages/home/home.json`]: JSON.stringify(
    {
      usingComponents: {
        'record-sheet': '/modules/booking/components/record-sheet/record-sheet',
        'inner-card': '../../../booking/pages/list/parts/inner-card/inner-card',
        'van-button': '@vant/weapp/button/index',
        'plugin-map': 'plugin://map/map',
        gone: '/modules/booking/components/gone/gone',
      },
    },
    null,
    2,
  ),
  [`${M}/modules/home/pages/home/home.wxml`]: '<import src="/shared/templates/empty.wxml"/>\n<include src="../../../booking/pages/list/list"/>\n<wxs src="/shared/utils/format.wxs" module="f"/>\n',
  [`${M}/modules/home/pages/home/home.wxss`]: '@import "/shared/styles/base.wxss";\n@import "../../../booking/pages/list/list";\n',
}
FILES[`${M}/modules/booking/pages/list/list.wxml`] = ''

const files = Object.keys(FILES)
const refs = miniprogramRefs(files, path => FILES[path] as string)

describe('读小程序的引用', () => {
  test('usingComponents 的组件、wxml 的 import/include/wxs、wxss 的 @import：/ 从 app.json 所在目录算，. 从文件所在目录算；npm 包和插件不管；对不上文件的列出来', () => {
    assert.deepEqual(
      refs.imports.map(fact => `${fact.from.split('/').at(-1)}:${fact.line} → ${fact.to}`),
      [
        `app.json:1 → ${M}/shared/components/app-button/app-button.ts`,
        `home.json:3 → ${M}/modules/booking/components/record-sheet/record-sheet.js`,
        `home.json:4 → ${M}/modules/booking/pages/list/parts/inner-card/inner-card.json`,
        `home.wxml:1 → ${M}/shared/templates/empty.wxml`,
        `home.wxml:2 → ${M}/modules/booking/pages/list/list.wxml`,
        `home.wxml:3 → ${M}/shared/utils/format.wxs`,
        `home.wxss:1 → ${M}/shared/styles/base.wxss`,
        `home.wxss:2 → ${M}/modules/booking/pages/list/list.wxss`,
      ],
    )
    assert.deepEqual(refs.unresolved, [`${M}/modules/home/pages/home/home.json:7 写的 "/modules/booking/components/gone/gone"`])
  })

  test('没有 app.json 的仓库不读', () => {
    assert.deepEqual(miniprogramRefs([`${M}/modules/home/pages/home/home.json`], path => FILES[path] as string), { imports: [], unresolved: [] })
  })
})

function layout(): Layout {
  const parsed = parseConfig(JSON.stringify({ roots: [`${M}/modules`], shared: [`${M}/shared/**`], app: [`${M}/app.*`], entry: ['index.ts'] }))
  return new Layout(parsed.config as Config, files)
}

describe('小程序的引用照 R1、R2、R3 判', () => {
  test('别的模块 components/ 第一层的组件是对外的，可以用；别处的组件、模板、样式报 R1，改法各不相同', () => {
    const vs = importViolations(layout(), { imports: refs.imports, unresolved: [] })
    assert.deepEqual(
      vs.map(v => `${v.rule} ${v.where[0]?.split('）')[1]}`),
      [
        `R1 用了 booking 模块的内部文件 ${M}/modules/booking/pages/list/parts/inner-card/inner-card.json`,
        `R1 import 了 booking 模块的内部文件 ${M}/modules/booking/pages/list/list.wxml`,
        `R1 import 了 booking 模块的内部文件 ${M}/modules/booking/pages/list/list.wxss`,
      ],
    )
    assert.match(vs[0]?.fix as string, /^改成用 booking 对外的组件（miniprogram\/modules\/booking\/components\/ 下第一层的组件）；这个组件该给别的模块用，就挪进/)
    assert.match(vs[1]?.fix as string, /^小程序的模板、样式不能经入口导出：几个模块都用的，搬进共享层/)
  })

  test('共享层用模块的组件报 R3；经组件成环报 R2', () => {
    const extra = {
      imports: [
        ...refs.imports.filter(fact => fact.to.includes('/components/record-sheet/')),
        { from: `${M}/shared/components/app-button/app-button.json`, line: 1, to: `${M}/modules/booking/components/record-sheet/record-sheet.js`, specifier: '' },
        { from: `${M}/modules/booking/components/record-sheet/record-sheet.json`, line: 1, to: `${M}/modules/home/components/x/x.ts`, specifier: '' },
      ],
      unresolved: [],
    }
    const keys = importViolations(new Layout(layout().config, [...files, `${M}/modules/home/components/x/x.ts`]), extra).map(v => v.key)
    assert.deepEqual(keys, ['R2 booking home', `R3 ${M}/shared/components/app-button/app-button.json → ${M}/modules/booking/components/record-sheet/record-sheet.js`])
  })
})

describe('modwall check 里的小程序', () => {
  test('页面用了别的模块页面里的组件：R1 拦；用对方 components/ 里的不拦', () => {
    const repo = join(tempDir('modwall-mp-'), 'repo')
    write(repo, '.modwall/config.json', JSON.stringify({ roots: [`${M}/modules`], shared: [`${M}/shared/**`], app: [`${M}/app.ts`, `${M}/app.json`], entry: ['index.ts'] }))
    write(repo, `${M}/app.json`, '{"pages":["modules/home/pages/home/home"]}\n')
    write(repo, `${M}/app.ts`, 'App({})\n')
    write(repo, `${M}/modules/booking/components/record-sheet/record-sheet.ts`, 'Component({})\n')
    write(repo, `${M}/modules/booking/pages/list/card/card.ts`, 'Component({})\n')
    write(repo, `${M}/modules/home/pages/home/home.ts`, 'Page({})\n')
    write(repo, `${M}/modules/home/pages/home/home.json`, `${JSON.stringify({ usingComponents: { sheet: '/modules/booking/components/record-sheet/record-sheet' } })}\n`)
    sh(repo, 'git init -q -b main && git add -A && git commit -qm init && git checkout -qb feature')
    const clean = modwall(repo, ['check'])
    assert.equal(clean.code, 0, clean.out)

    write(repo, `${M}/modules/home/pages/home/home.json`, `${JSON.stringify({ usingComponents: { sheet: '/modules/booking/components/record-sheet/record-sheet', card: '../../../booking/pages/list/card/card' } })}\n`)
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /R1 绕过入口（1 处）\n {2}✗ miniprogram\/modules\/home\/pages\/home\/home\.json:1（home 模块）用了 booking 模块的内部文件 miniprogram\/modules\/booking\/pages\/list\/card\/card\.ts\n {4}改法：改成用 booking 对外的组件/)
  })
})
