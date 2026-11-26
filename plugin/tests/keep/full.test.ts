// "代码规范"接在底座上的部分：整组（testpace full）里的一段、会话开始时的说明。

import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runs } from '../helpers.ts'
import { keepConfig, keepRepo, sessionBrief, testpace, write } from './helpers.ts'

const TESTPACE_JSON = `${JSON.stringify({ fast: 'true', files: 'testpace run node-test', full: 'true', tests: ['tests/**/*.test.mjs'] })}\n`
/** 接入了 testpace、testcraft 的小仓库；keep 为 true 时也接入 codekeep。 */
const project = (keep: boolean, checks = [{ name: 'lint', command: 'true' }]): string =>
  keepRepo({
    'testpace.json': TESTPACE_JSON,
    'tests/a.test.mjs': "import test from 'node:test'\ntest('a', () => {})\n",
    '.testcraft/checklist/README': '清单目录\n',
    ...(keep ? { '.codekeep/config.json': keepConfig({ checks }) } : {}),
  })
const kinds = (repo: string): string[] => (runs(repo).at(-1)!.steps as Array<{ kind: string }>).map(step => step.kind)

describe('整组里的"代码规范"', () => {
  test('接入了的仓库：codekeep check 在清单之后、项目的整组检查之前跑，随插件一起装，不用另外登记', () => {
    const repo = project(true)
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(kinds(repo), ['craft', 'keep', 'full', 'tests'])
    assert.match(readFileSync(runs(repo).at(-1)!.log as string, 'utf8'), /===== testpace 代码规范的检查：codekeep check\n[\s\S]*codekeep check：通过。/)
  })

  test('规范检查没过：整组在这一段停下，后面的不跑', () => {
    const repo = project(true, [{ name: 'lint', command: 'exit 1' }])
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^整组失败：代码规范的检查（codekeep check）没通过，后面的没有跑/)
    assert.deepEqual(kinds(repo), ['craft', 'keep'])
  })

  test('删掉 .codekeep/ 躲不过这一段（按分叉点也算接入）；没接入的仓库没有这一段', () => {
    const repo = project(true)
    rmSync(join(repo, '.codekeep'), { recursive: true })
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /代码规范的检查（codekeep check）没通过/)
    assert.match(r.out, /删掉了整个 \.codekeep\/ 目录/)

    const outside = project(false)
    assert.equal(testpace(outside, ['full']).code, 0)
    assert.deepEqual(kinds(outside), ['craft', 'full', 'tests'])
  })
})

describe('会话开始时的说明', () => {
  test('工作区里有 .codekeep/ 才说：lint 由 codekeep 用项目的 eslint 直接查、不改松规范、批量豁免不起作用、"这里不查"的注释写理由、不放密钥', () => {
    const told = sessionBrief(project(true))
    assert.match(told, /这个仓库用 codekeep 管代码规范（\.codekeep\/）/)
    assert.match(told, /1\. 类型检查、lint、格式检查由 codekeep 在整组（testpace full）里跑：lint 由它用项目的 eslint 直接查/)
    assert.match(told, /不改松规范：不关规则、不把 error 降成 warn/)
    assert.match(told, /eslint 的批量豁免（eslint-suppressions\.json）在整组里不起作用，超标的改代码/)
    assert.match(told, /"这里不查"的注释（eslint-disable、@ts-expect-error 这类）必须写理由/)
    assert.match(told, /提交里不放密钥、密码/)
    assert.doesNotMatch(sessionBrief(project(false)), /codekeep/)
  })

  test('配置里写了 styles 的多说第 5 条前端约定，写明主题和组件层在哪；没写 styles 的不说', () => {
    const repo = project(true)
    assert.doesNotMatch(sessionBrief(repo), /5\. 前端/)
    write(repo, '.codekeep/config.json', keepConfig({ checks: [{ name: 'lint', command: 'true' }], styles: { theme: ['src/theme.ts'], ui: ['src/ui', 'admin/ui'] } }))
    const told = sessionBrief(repo)
    assert.match(told, /5\. 前端：页面上不加说明文字；组件不合适时不写样式、不写具体的值去补，告诉用户。/)
    assert.match(told, /具体的颜色、尺寸只写在主题 src\/theme\.ts、组件层 src\/ui 里的样式文件、组件层 admin\/ui 里的样式文件；/)
    assert.match(told, /前端文件里"这里不查"的注释不起作用，lint 报了就改代码。/)
  })
})
