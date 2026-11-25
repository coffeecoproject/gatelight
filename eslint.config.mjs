import jest from 'eslint-plugin-jest'
import tseslint from 'typescript-eslint'

// 查两件事。
// 一、每个测试都要有断言（testpace 的默认测试检查）。测试用 node:test，没有自带开关，靠 lint 看代码。
//    node:test 不加 --test-only 时不认 .only，testpace run node-test 不加它，所以不用另查 .only。
// 二、模块的边界（见整体设计方案.md）：
//    底座（plugin/src/base）不引用检查模块（pace 跑测试、craft 测试写法、wall 模块边界、keep 代码规范）和装配的文件：底座不认识任何模块，
//    模块要底座做的事通过 base/module.ts 的入口交给它；
//    检查模块之间不互相引用，只引用底座。
const boundary = (files, group, message) => ({
  files,
  languageOptions: { parser: tseslint.parser },
  rules: { 'no-restricted-imports': ['error', { patterns: [{ group, message }] }] },
})

export default [
  boundary(['plugin/src/base/**/*.ts'], ['**/pace/**', '**/craft/**', '**/wall/**', '**/keep/**', '../cli.ts', '../testcraft.ts', '../modwall.ts', '../codekeep.ts', '../modules.ts'], '底座不引用检查模块和装配的文件：模块的事通过 base/module.ts 的入口交给底座。'),
  boundary(['plugin/src/pace/**/*.ts'], ['**/craft/**', '**/wall/**', '**/keep/**'], '检查模块之间不互相引用：只引用底座（base/）。'),
  boundary(['plugin/src/craft/**/*.ts'], ['**/pace/**', '**/wall/**', '**/keep/**'], '检查模块之间不互相引用：只引用底座（base/）。'),
  boundary(['plugin/src/wall/**/*.ts'], ['**/pace/**', '**/craft/**', '**/keep/**'], '检查模块之间不互相引用：只引用底座（base/）。'),
  boundary(['plugin/src/keep/**/*.ts'], ['**/pace/**', '**/craft/**', '**/wall/**'], '检查模块之间不互相引用：只引用底座（base/）。'),
  {
    files: ['plugin/tests/*.test.ts', 'plugin/tests/craft/*.test.ts', 'plugin/tests/wall/*.test.ts', 'plugin/tests/keep/*.test.ts'],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { jest },
    rules: {
      'jest/expect-expect': ['error', {
        // 插件认不出从 node:test 导入的 test，按名字补上。
        additionalTestBlockFunctions: ['test'],
        assertFunctionNames: ['assert', 'assert.*', 't.assert.*'],
      }],
    },
  },
]
