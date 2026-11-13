// 测试共用：示例项目副本、跑 testpace 命令、读记录。

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { fileURLToPath } from 'node:url'

export const BIN = fileURLToPath(new URL('../bin/testpace', import.meta.url))
export const SAMPLE = fileURLToPath(new URL('../../examples/sample', import.meta.url))

// node:test 会把 NODE_TEST_CONTEXT 传给子进程，示例项目里的 node --test 看到它就跳过所有测试文件。
// 插件数据目录也不带：测试不写真实的会话记录。
const { NODE_TEST_CONTEXT: _, CLAUDE_PLUGIN_DATA: __, ...rest } = process.env
export const ENV: NodeJS.ProcessEnv = rest

export interface Result {
  code: number | null
  out: string
}

export function testpace(cwd: string, args: string[], env: NodeJS.ProcessEnv = ENV): Result {
  const r = spawnSync(BIN, args, { cwd, env, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

export function sh(cwd: string, script: string): string {
  return execFileSync('/bin/sh', ['-c', script], { cwd, encoding: 'utf8', env: ENV })
}

export function runs(repo: string): Array<Record<string, unknown>> {
  const file = join(repo, '.git', 'testpace', 'runs.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

export function setConfig(repo: string, change: Record<string, unknown>): void {
  const config = JSON.parse(readFileSync(join(repo, 'testpace.json'), 'utf8'))
  writeFileSync(join(repo, 'testpace.json'), JSON.stringify({ ...config, ...change }))
}

const dirs: string[] = []

/** 测试结束时删掉的临时目录。 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

export const commit = (dir: string, message: string): string =>
  sh(dir, `git add -A && git -c user.name=t -c user.email=t@t commit -qm '${message}'`)

/** 复制示例项目，建成一个有一次提交的 git 仓库。 */
export function sampleRepo(): string {
  const dir = tempDir('testpace-sample-')
  cpSync(SAMPLE, dir, { recursive: true })
  sh(dir, 'git init -q -b main')
  commit(dir, 'init')
  return dir
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
