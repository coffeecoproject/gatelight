// .codekeep/config.json 的写法：哪些写法认、哪些算配置问题。

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseConfig } from '../../src/keep/config.ts'

const parse = (config: unknown): ReturnType<typeof parseConfig> => parseConfig(JSON.stringify(config))
const CHECKS = [{ name: 'lint', command: 'eslint .' }]
/** 这份配置读不出来：它的问题（一行一个）。 */
const problems = (config: unknown): string => {
  const parsed = parse(config)
  assert.equal(parsed.config, undefined, JSON.stringify(config))
  return parsed.problems.join('\n')
}

describe('.codekeep/config.json 的写法', () => {
  test('只写 checks 也行：eslint、tsconfig 不比，prettier、secrets 默认关', () => {
    assert.deepEqual(parse({ checks: CHECKS }), { config: { checks: CHECKS, tsconfig: [], prettier: false, secrets: false }, problems: [] })
    assert.deepEqual(parse({ checks: CHECKS, eslint: { config: './eslint.config.mjs' }, tsconfig: ['tsconfig.json', 'web/tsconfig.json'], prettier: true, secrets: true }).config, {
      checks: CHECKS,
      eslint: { config: 'eslint.config.mjs' },
      tsconfig: ['tsconfig.json', 'web/tsconfig.json'],
      prettier: true,
      secrets: true,
    })
  })

  test('checks 必须写成非空数组，每条要有名字和命令，名字不能重复', () => {
    assert.match(problems({}), /"checks" 要写成非空数组/)
    assert.match(problems({ checks: [] }), /"checks" 要写成非空数组/)
    assert.match(problems({ checks: [{ name: 'lint' }] }), /checks 的第 1 条（lint）要写命令/)
    assert.match(problems({ checks: [{ command: 'eslint .' }] }), /checks 的第 1 条 要写名字/)
    assert.match(problems({ checks: [...CHECKS, { name: 'lint', command: 'tsc' }] }), /checks 的第 2 条 的名字 "lint" 和前面的重复了/)
  })

  test('不认识的字段算配置问题（顶层、eslint 里、checks 的一条里）；eslint 只认 config，写了批量豁免文件 suppressions 也算', () => {
    assert.match(problems({ checks: CHECKS, biome: true }), /有未知字段 "biome"/)
    assert.match(problems({ checks: CHECKS, eslint: { config: 'eslint.config.mjs', ignore: [] } }), /"eslint" 有未知字段 "ignore"/)
    assert.match(problems({ checks: CHECKS, eslint: { config: 'eslint.config.mjs', suppressions: 'eslint-suppressions.json' } }), /"eslint" 有未知字段 "suppressions"/)
    assert.match(problems({ checks: [{ ...CHECKS[0], timeout: 5 }] }), /checks 的第 1 条 有未知字段 "timeout"/)
  })

  test('路径要写仓库里的相对路径：绝对路径、..、通配都算配置问题', () => {
    for (const bad of ['/etc/eslint.config.mjs', '../eslint.config.mjs', 'a/../eslint.config.mjs', '*.mjs', 'config/{a,b}.mjs']) {
      assert.match(problems({ checks: CHECKS, eslint: { config: bad } }), /"eslint\.config" 要写 eslint 配置文件/)
      assert.match(problems({ checks: CHECKS, tsconfig: [bad] }), /tsconfig 里的 .+ 要写tsconfig 文件/)
    }
    assert.match(problems({ checks: CHECKS, tsconfig: [] }), /"tsconfig" 要写成非空数组/)
    assert.match(problems({ checks: CHECKS, tsconfig: ['tsconfig.json', './tsconfig.json'] }), /tsconfig 里的 "tsconfig\.json" 写了两次/)
  })

  test('styles 可以只写 theme 或只写 ui，没写的一项是空的；不写 styles 就没有这一项', () => {
    assert.deepEqual(parse({ checks: CHECKS, styles: { theme: ['./src/theme.ts'] } }).config?.styles, { theme: ['src/theme.ts'], ui: [] })
    assert.deepEqual(parse({ checks: CHECKS, styles: { ui: ['src/ui', 'admin/src/ui'] } }).config?.styles, { theme: [], ui: ['src/ui', 'admin/src/ui'] })
    assert.deepEqual(parse({ checks: CHECKS, styles: { theme: ['src/theme.ts'], ui: ['src/ui'] } }).config?.styles, { theme: ['src/theme.ts'], ui: ['src/ui'] })
    assert.equal(parse({ checks: CHECKS }).config?.styles, undefined)
  })

  test('styles 写错算配置问题：不是对象、有别的字段、theme 和 ui 都没写、写成空数组、路径重复、绝对路径或通配', () => {
    for (const bad of [['src/ui'], 'src/ui', true]) assert.match(problems({ checks: CHECKS, styles: bad }), /"styles" 应该是 \{ "theme": \[主题文件\], "ui": \[组件层目录\] \}/)
    assert.match(problems({ checks: CHECKS, styles: { theme: ['src/theme.ts'], colors: ['src/colors.ts'] } }), /"styles" 有未知字段 "colors"/)
    assert.match(problems({ checks: CHECKS, styles: {} }), /"styles" 要写 theme、ui 里的至少一项/)
    assert.match(problems({ checks: CHECKS, styles: { theme: [] } }), /"styles\.theme" 要写成非空数组，每项是主题文件/)
    assert.match(problems({ checks: CHECKS, styles: { ui: 'src/ui' } }), /"styles\.ui" 要写成非空数组，每项是组件层目录/)
    assert.match(problems({ checks: CHECKS, styles: { ui: ['src/ui', './src/ui'] } }), /styles\.ui 里的 "src\/ui" 写了两次/)
    for (const bad of ['/src/theme.ts', '../theme.ts', 'src/*.css', 'src/{a,b}.ts']) {
      assert.match(problems({ checks: CHECKS, styles: { theme: [bad] } }), /styles\.theme 里的 .+ 要写主题文件（仓库里的相对路径，不用通配）/)
      assert.match(problems({ checks: CHECKS, styles: { ui: [bad] } }), /styles\.ui 里的 .+ 要写组件层目录（仓库里的相对路径，不用通配）/)
    }
  })

  test('prettier、secrets 只认 true、false；不是 JSON 的读不出来', () => {
    assert.match(problems({ checks: CHECKS, prettier: 'yes' }), /"prettier" 要写 true 或 false/)
    assert.match(problems({ checks: CHECKS, secrets: 1 }), /"secrets" 要写 true 或 false/)
    assert.match(parseConfig('{ checks: [] }').problems.join(), /不是合法的 JSON/)
  })
})
