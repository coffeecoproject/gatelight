import jest from 'eslint-plugin-jest'
import tseslint from 'typescript-eslint'

// 只查一件事：每个测试都要有断言（testpace 的默认测试检查）。测试用 node:test，没有自带开关，靠 lint 看代码。
// node:test 不加 --test-only 时不认 .only，testpace run node-test 不加它，所以不用另查 .only。
export default [
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
