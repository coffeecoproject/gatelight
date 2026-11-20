import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { modwall, sh, tempDir, write } from './helpers.ts'

describe('modwall init', () => {
  test('按现有目录生成配置草稿，列出还没有归属的代码文件；已经有配置时不覆盖', () => {
    const repo = join(tempDir('modwall-init-'), 'repo')
    for (const path of ['src/modules/booking/index.ts', 'src/modules/billing/index.ts', 'src/shared/money.ts', 'src/main.ts', 'scripts/seed.ts', 'vite.config.ts', 'src/legacy/old.ts', 'tests/a.test.ts']) {
      write(repo, path, 'export const x = 1\n')
    }
    sh(repo, 'git init -q -b main && git add -A && git commit -qm init')
    const r = modwall(repo, ['init'])
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(JSON.parse(readFileSync(join(repo, '.modwall/config.json'), 'utf8')), {
      roots: ['src/modules'],
      shared: ['src/shared/**'],
      app: ['src/main.ts'],
      entry: ['index.ts', 'index.tsx', 'index.js', '__init__.py'],
      map: {},
      outside: ['vite.config.ts', 'scripts/**'],
      allow: [],
    })
    assert.match(r.out, /还有 1 个代码文件没有归属（R5）.*\n {2}· src\/legacy\/old\.ts 没有归属/)

    const again = modwall(repo, ['init'])
    assert.equal(again.code, 2)
    assert.match(again.out, /不覆盖/)
  })

  test('LayerMap 不读的目录里没被忽略的代码：模块之外的起草进 outside；被忽略的不管；模块里的不起草，列为没有归属', () => {
    const repo = join(tempDir('modwall-init-'), 'repo')
    write(repo, '.gitignore', 'node_modules/\n')
    for (const path of ['src/modules/booking/index.ts', 'src/modules/booking/vendor/u.ts', 'third_party/Vendor/lib.go', 'third_party/Vendor/sub/more.go', '.claude/hooks/x.ts', 'node_modules/pkg/index.js']) {
      write(repo, path, 'export const x = 1\n')
    }
    sh(repo, 'git init -q -b main && git add -A && git commit -qm init')
    const r = modwall(repo, ['init'])
    assert.equal(r.code, 0, r.out)
    const config = JSON.parse(readFileSync(join(repo, '.modwall/config.json'), 'utf8'))
    assert.deepEqual(config.outside, ['.claude/**', 'third_party/Vendor/**'])
    assert.match(r.out, /还有 1 个代码文件没有归属（R5）.*\n {2}· src\/modules\/booking\/vendor\/u\.ts 在 LayerMap 不读的目录/)
    assert.doesNotMatch(r.out, /配置有问题/)
  })

  test('模块根目录下直接放着入口文件名的文件（Python 包的 __init__.py）：点名写进草稿的 app', () => {
    const repo = join(tempDir('modwall-init-'), 'repo')
    for (const path of ['app/modules/__init__.py', 'app/modules/booking/__init__.py', 'app/modules/helper.py']) write(repo, path, '')
    sh(repo, 'git init -q -b main && git add -A && git commit -qm init')
    const r = modwall(repo, ['init'])
    assert.equal(r.code, 0, r.out)
    const config = JSON.parse(readFileSync(join(repo, '.modwall/config.json'), 'utf8'))
    assert.deepEqual([config.roots, config.app], [['app/modules'], ['app/modules/__init__.py']])
    // 名字不是入口文件名的照旧列为没有归属
    assert.match(r.out, /还有 1 个代码文件没有归属（R5）.*\n {2}· app\/modules\/helper\.py 直接放在模块根目录 app\/modules 下/)
    assert.doesNotMatch(r.out, /配置有问题/)
  })
})
