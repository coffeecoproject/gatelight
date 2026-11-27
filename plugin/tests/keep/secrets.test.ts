// 扫密钥（secrets: true）：用本机装着的 gitleaks 扫这次改动——分叉点之后的提交，加上没提交的改动（已暂存、没暂存、没跟踪的）；
// 分叉点之前的旧提交不管；输出打码；代码里的 gitleaks:allow 注释不认；不动真实的索引。

import assert from 'node:assert/strict'
import { chmodSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { codekeep, ENV, eslintConfig, keepConfig, keepRepo, sh, tempDir, write } from './helpers.ts'

/** 一个 gitleaks 认得出的 GitHub token（运行时拼出来，测试代码里不放像密钥的字符串）。 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const token = (seed: number): string => `ghp_${Array.from({ length: 36 }, (_, i) => ALPHABET[(i * 7 + seed) % ALPHABET.length]).join('')}`
const leak = (seed: number, comment = ''): string => `export const token = '${token(seed)}'${comment}\n`

const CONFIG = { '.codekeep/config.json': keepConfig({ checks: [{ name: 'lint', command: 'true' }], secrets: true }) }
const LEAKED = /\ngitleaks 在这次改动里扫出了疑似密钥（上面列出，已打码）。改法：\n[\s\S]*\ncodekeep check：没通过，1 项：\n {2}✗ gitleaks 扫出了疑似密钥（上面列出）\n/
const commitAll = (repo: string): string => sh(repo, "git add -A && git commit -qm 'change'")

describe('扫密钥', () => {
  test('分叉点之前就有的不管；这次没有新密钥：通过', () => {
    const repo = keepRepo({ ...CONFIG, 'src/old.js': leak(3) })
    write(repo, 'src/a.js', 'export const a = 1\n')
    commitAll(repo)
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /规范检查都过了（lint）；这次改动里没扫出密钥。/)
  })

  test('分叉点之后的提交里有密钥：没通过，输出里打了码', () => {
    const repo = keepRepo(CONFIG)
    write(repo, 'src/config.js', leak(5))
    commitAll(repo)
    // 后面的提交删掉了也照样算：密钥还在这个分支的历史里
    write(repo, 'src/config.js', 'export const token = process.env.TOKEN\n')
    commitAll(repo)
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, LEAKED)
    assert.match(r.out, /RuleID:\s+github-pat/)
    assert.ok(!r.out.includes(token(5)), '密钥打了码')
  })

  /** 跑一次检查：扫出了密钥；真实的索引没动，临时文件删掉了。返回检查前 git status 的样子。 */
  const scanned = (repo: string): string => {
    const tmp = tempDir('codekeep-tmp-')
    const before = sh(repo, 'git status --porcelain=v1 --untracked-files=all')
    const r = codekeep(repo, ['check'], { TMPDIR: tmp })
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, LEAKED)
    assert.equal(sh(repo, 'git status --porcelain=v1 --untracked-files=all'), before, '真实的索引没动')
    assert.deepEqual(readdirSync(tmp), [])
    return before
  }

  test('没提交的改动：没跟踪的新文件、没暂存的修改都扫；真实的索引不动，临时文件删掉', () => {
    const repo = keepRepo({ ...CONFIG, 'src/a.js': 'export const a = 1\n' })
    write(repo, 'src/new.js', leak(7))
    assert.equal(scanned(repo), '?? src/new.js\n')
    sh(repo, 'rm src/new.js')
    write(repo, 'src/a.js', leak(11))
    assert.equal(scanned(repo), ' M src/a.js\n')
    sh(repo, 'git add src/a.js')
    assert.equal(scanned(repo), 'M  src/a.js\n')
  })

  test('没提交的改动：已暂存的新文件也扫', () => {
    const repo = keepRepo(CONFIG)
    write(repo, 'src/new.js', leak(19))
    sh(repo, 'git add src/new.js')
    assert.equal(scanned(repo), 'A  src/new.js\n')
  })

  test('代码里的 gitleaks:allow 注释不认', () => {
    const repo = keepRepo(CONFIG)
    write(repo, 'src/config.js', leak(13, ' // gitleaks:allow'))
    commitAll(repo)
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, LEAKED)
  })

  test('lint 有错、检查命令没过：照样扫密钥，三项一起列出，退出码 1', () => {
    const config = keepConfig({ checks: [{ name: 'types', command: 'exit 1' }], eslint: { config: 'eslint.config.mjs' }, secrets: true })
    const repo = keepRepo({ '.codekeep/config.json': config, 'eslint.config.mjs': eslintConfig({ 'no-var': 'error' }) })
    write(repo, 'src/bad.js', 'var b = 1\nexport { b }\n')
    write(repo, 'src/config.js', leak(17))
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /RuleID:\s+github-pat/)
    assert.match(
      r.out,
      /\ncodekeep check：没通过，3 项：\n {2}✗ lint 有 1 个错误（上面列出；批量豁免文件在这里不起作用）\n {2}✗ 规范检查"types"没过（退出码 1）\n {2}✗ gitleaks 扫出了疑似密钥（上面列出）\n/,
    )
  })

  test('密钥没扫成（gitleaks 没跑成）：列成一项，退出码 2，别的没过的照样列出', () => {
    const bin = tempDir('codekeep-gitleaks-')
    write(bin, 'gitleaks', '#!/bin/sh\necho 坏了 >&2\nexit 2\n')
    chmodSync(join(bin, 'gitleaks'), 0o755)
    const repo = keepRepo({ '.codekeep/config.json': keepConfig({ checks: [{ name: 'types', command: 'exit 1' }], secrets: true }) })
    const r = codekeep(repo, ['check'], { PATH: `${bin}:${ENV.PATH}` })
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /\n密钥没扫成：gitleaks 扫提交时没跑成（退出码 2）\n/)
    assert.match(r.out, /\ncodekeep check：没通过，2 项：\n {2}✗ 规范检查"types"没过（退出码 1）\n {2}✗ 密钥没扫成（上面说了原因）\n/)
  })
})
