// "测试写法"的测试共用：示例项目（examples/craft-sample）的 git 副本、跑 testcraft 命令、写文件。
// 环境（去掉 agent 的标记、测试自己的全局 git 配置）和临时目录用整个插件测试共用的那份（../helpers.ts）。

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENV as BASE_ENV, tempDir } from '../helpers.ts'

export { tempDir }

export const BIN = fileURLToPath(new URL('../../bin/testcraft', import.meta.url))
/** testpace 的命令：整组（testpace full）里有"测试写法"的一段。 */
export const TESTPACE = fileURLToPath(new URL('../../bin/testpace', import.meta.url))
/** 钩子入口：整个插件只有一个，各模块的话都从它出去。 */
export const HOOK = fileURLToPath(new URL('../../hooks/testpace.ts', import.meta.url))
export const SAMPLE = fileURLToPath(new URL('../../../examples/craft-sample', import.meta.url))

// 副本放在系统临时目录下（见 copy.ts）：测试给一个自己的，好查用完有没有删掉。
export const TMP = tempDir('testcraft-tmp-')
export const ENV: NodeJS.ProcessEnv = { ...BASE_ENV, TMPDIR: TMP }

export interface Result {
  code: number | null
  out: string
}

export function testcraft(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Result {
  const r = spawnSync(BIN, args, { cwd, env: { ...ENV, ...env }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

export function sh(cwd: string, script: string): string {
  return execFileSync('/bin/sh', ['-c', script], { cwd, encoding: 'utf8', env: ENV })
}

export function write(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

/** 示例项目放进新仓库，提交到 main，切到 feature 分支。 */
export function sampleRepo(setup?: (repo: string) => void): string {
  const repo = join(tempDir('testcraft-repo-'), 'repo')
  cpSync(SAMPLE, repo, { recursive: true })
  setup?.(repo)
  sh(repo, 'git init -q -b main && git add -A && git commit -qm init && git checkout -qb feature')
  return repo
}

export function commitOnMain(repo: string, message: string): void {
  sh(repo, `git checkout -q main && git add -A && git commit -qm "${message}" && git checkout -q feature && git merge -q main`)
}

export const MEMBER_PRICE = `
export function memberPrice(amount, member) {
  if (member.level === 'gold') {
    return amount * 0.9
  }
  return amount
}
`

export const TEST_HEAD = `import assert from 'node:assert/strict'
import { test } from 'node:test'
`
