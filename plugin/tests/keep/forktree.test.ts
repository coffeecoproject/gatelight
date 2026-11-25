// 分叉点那一版在系统临时目录里的临时 git worktree 上算：链上现在装着的 node_modules（仓库自己没有、靠上层目录的也算），
// 用完不管成没成都收掉（目录删掉、worktree 的登记也去掉）。

import assert from 'node:assert/strict'
import { readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { codekeep, keepConfig, keepRepo, NODE_MODULES, pendingOf, sh, tempDir, write } from './helpers.ts'

/** eslint 配置里引用一个装在 node_modules 里的插件：分叉点那一版的配置要找得到它，才算得出来。 */
const withPlugin = (level: string): string =>
  `import jest from 'eslint-plugin-jest'\nexport default [{ files: ['**/*.js'], plugins: { jest }, rules: { 'jest/no-focused-tests': '${level}' } }]\n`
const FILES = {
  '.codekeep/config.json': keepConfig({ checks: [{ name: 'lint', command: 'true' }], eslint: { config: 'eslint.config.mjs' } }),
  'eslint.config.mjs': withPlugin('error'),
  'src/a.js': 'export const a = 1\n',
}
const worktrees = (repo: string): number => sh(repo, 'git worktree list --porcelain').split('\n').filter(line => line.startsWith('worktree ')).length

describe('分叉点的临时 worktree', () => {
  test('仓库自己没有 node_modules、装在上层目录：临时 worktree 链上那一份，分叉点那一版算得出来；用完收掉', () => {
    const parent = tempDir('codekeep-parent-')
    symlinkSync(NODE_MODULES, join(parent, 'node_modules'), 'dir')
    const repo = keepRepo(FILES, { parent, modules: false })
    write(repo, 'eslint.config.mjs', withPlugin('warn'))
    const tmp = tempDir('codekeep-tmp-')
    const r = codekeep(repo, ['check'], { TMPDIR: tmp })
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(pendingOf(r.out).items, ['lint 规则 jest/no-focused-tests 从报错降成了警告：以后违反它也能通过检查'])
    assert.deepEqual(readdirSync(tmp), [], '临时目录删掉了')
    assert.equal(worktrees(repo), 1, '临时 worktree 的登记去掉了')
  })

  test('分叉点那一版算的时候出错：临时 worktree 照样收掉', () => {
    const repo = keepRepo({ ...FILES, 'eslint.config.mjs': "throw new Error('分叉点上的配置坏了')\n" })
    write(repo, 'eslint.config.mjs', withPlugin('error'))
    const tmp = tempDir('codekeep-tmp-')
    const r = codekeep(repo, ['check'], { TMPDIR: tmp })
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /分叉点那一版算不出来/)
    assert.deepEqual(readdirSync(tmp), [])
    assert.equal(worktrees(repo), 1)
  })
})
