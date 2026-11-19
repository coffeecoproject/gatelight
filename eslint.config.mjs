import jest from 'eslint-plugin-jest'
import tseslint from 'typescript-eslint'

// 查两件事。
// 一、每个测试都要有断言（testpace 的默认测试检查）。测试用 node:test，没有自带开关，靠 lint 看代码。
//    node:test 不加 --test-only 时不认 .only，testpace run node-test 不加它，所以不用另查 .only。
// 二、底座（plugin/src/base）不引用检查模块（plugin/src/pace）和装配的文件：底座不认识任何模块，
//    模块要底座做的事通过 base/module.ts 的入口交给它（见整体设计方案.md）。
export default [
  {
    files: ['plugin/src/base/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['**/pace/**', '../cli.ts', '../modules.ts'], message: '底座不引用检查模块和装配的文件：模块的事通过 base/module.ts 的入口交给底座。' }],
      }],
    },
  },
  {
    files: ['plugin/tests/*.test.ts'],
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
