// tsconfig 生效的选项改松了哪些：用项目自己的 tsc --showConfig 算（extends 合并好、strict 展开好），和分叉点那一版比。

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { codekeep, keepConfig, keepRepo, pendingOf, write } from './helpers.ts'

const tsconfig = (value: Record<string, unknown>): string => `${JSON.stringify(value, null, 2)}\n`
const FILES = {
  '.codekeep/config.json': keepConfig({ checks: [{ name: 'types', command: 'true' }], tsconfig: ['tsconfig.json'] }),
  'tsconfig.base.json': tsconfig({ compilerOptions: { strict: true, noEmit: true, allowJs: true } }),
  'tsconfig.json': tsconfig({ extends: './tsconfig.base.json', include: ['src', 'scripts'], exclude: ['src/vendor'] }),
  'src/a.js': 'export const a = 1\n',
  'src/legacy/old.js': 'export const old = 1\n',
  'scripts/build.js': 'export const build = 1\n',
}

describe('tsconfig 改松了哪些', () => {
  test('在被继承的配置里关掉 strict：算一项，写明跟着关掉的那几项', () => {
    const repo = keepRepo(FILES)
    write(repo, 'tsconfig.base.json', tsconfig({ compilerOptions: { strict: false, noEmit: true, allowJs: true } }))
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const asked = pendingOf(r.out)
    assert.deepEqual(asked.items, ['类型检查的配置 tsconfig.json 改松了：'])
    assert.match(
      asked.text,
      /\n {3}关掉了 strict（严格类型检查的总开关），跟着关掉了 noImplicitAny、strictNullChecks、strictFunctionTypes、strictBindCallApply、strictPropertyInitialization、strictBuiltinIteratorReturn、noImplicitThis、alwaysStrict、useUnknownInCatchVariables：以后这些类型问题都不再报\n/,
    )
  })

  test('strict 开着、单独关掉其中一项，开了 skipLibCheck，include 少了、exclude 多了：合成一项，一行一处', () => {
    const repo = keepRepo(FILES)
    write(repo, 'tsconfig.json', tsconfig({ extends: './tsconfig.base.json', compilerOptions: { strictNullChecks: false, skipLibCheck: true }, include: ['src'], exclude: ['src/vendor', 'src/legacy'] }))
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const { text } = pendingOf(r.out)
    assert.match(
      text,
      new RegExp(
        [
          '1\\. 类型检查的配置 tsconfig\\.json 改松了：',
          '   关掉了 strictNullChecks（可能是空值（null、undefined）的地方要先判断）：以后这类问题类型检查不再报',
          '   开了 skipLibCheck：以后不检查依赖库和 \\.d\\.ts 文件里的类型声明',
          '   include 去掉了 "scripts"：这些文件可能不再做类型检查',
          '   exclude 新加了 "src/legacy"：这些文件可能不再做类型检查',
          '',
        ].join('\n'),
      ),
    )
  })

  test('打开更严的选项、include 多了、exclude 少了：不问', () => {
    const repo = keepRepo(FILES)
    write(repo, 'tsconfig.json', tsconfig({ extends: './tsconfig.base.json', compilerOptions: { noUncheckedIndexedAccess: true }, include: ['src', 'scripts', 'tools'], exclude: [] }))
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /规范配置没有改松/)
  })
})
