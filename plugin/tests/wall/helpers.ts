// "模块边界"的测试共用：示例项目（examples/wall-sample）的 git 副本、跑 modwall 命令、钩子、写文件、假的 layermap。
// 环境（去掉 agent 的标记、测试自己的全局 git 配置）和临时目录用整个插件测试共用的那份（../helpers.ts）。

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENV as BASE_ENV, tempDir } from '../helpers.ts'

export { tempDir }

export const BIN = fileURLToPath(new URL('../../bin/modwall', import.meta.url))
/** testpace 的命令：整组（testpace full）里有"模块边界"的一段。 */
export const TESTPACE = fileURLToPath(new URL('../../bin/testpace', import.meta.url))
/** 钩子入口：整个插件只有一个，各模块的话都从它出去。 */
export const HOOK = fileURLToPath(new URL('../../hooks/testpace.ts', import.meta.url))
export const SAMPLE = fileURLToPath(new URL('../../../examples/wall-sample', import.meta.url))

// LayerMap 的地图放在测试自己的目录里，不碰本机的缓存。
export const ENV: NodeJS.ProcessEnv = { ...BASE_ENV, LAYERMAP_CACHE: tempDir('modwall-layermap-') }

export interface Result {
  code: number | null
  out: string
}

export function modwall(cwd: string, args: string[], env: NodeJS.ProcessEnv = ENV): Result {
  const r = spawnSync(BIN, args, { cwd, env, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

export function sh(cwd: string, script: string): string {
  return execFileSync('/bin/sh', ['-c', script], { cwd, encoding: 'utf8', env: ENV })
}

export function write(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

/** 改工作区里的 .modwall/config.json。 */
export function editConfig(repo: string, change: (config: Record<string, any>) => void): void {
  const file = join(repo, '.modwall/config.json')
  const config = JSON.parse(readFileSync(file, 'utf8'))
  change(config)
  writeFileSync(file, JSON.stringify(config, null, 2))
}

/** 示例项目放进新仓库，提交到 main，切到 feature 分支。setup 在提交之前改示例项目。 */
export function sampleRepo(setup?: (repo: string) => void): string {
  const repo = join(tempDir('modwall-repo-'), 'repo')
  cpSync(SAMPLE, repo, { recursive: true })
  setup?.(repo)
  sh(repo, 'git init -q -b main && git add -A && git commit -qm init && git checkout -qb feature')
  return repo
}

/** 一个假的 layermap：script 是 sh 脚本的正文。返回 PATH 换成它的环境。 */
export function fakeLayermap(script: string): NodeJS.ProcessEnv {
  const dir = tempDir('modwall-fakebin-')
  const file = join(dir, 'layermap')
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
  return { ...ENV, PATH: `${dir}:${ENV.PATH}` }
}

/** 没有 layermap 的环境：PATH 里只留 git 和 node 所在的目录。 */
export function withoutLayermap(): NodeJS.ProcessEnv {
  const keep = (name: string): string => dirname(execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim())
  return { ...ENV, PATH: [...new Set([keep('git'), keep('node'), '/usr/bin', '/bin'])].join(':') }
}

/** 跑一次钩子（当成 Claude Code 发来的）：返回它输出的 JSON（没输出为 undefined）。 */
export function hook(cwd: string, event: string, extra: Record<string, unknown> = {}): Record<string, any> | undefined {
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', HOOK, 'claude'], {
    input: JSON.stringify({ hook_event_name: event, cwd, ...extra }),
    env: ENV,
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim() ? JSON.parse(r.stdout) : undefined
}

/** modwall check 交给确认工具的编号和文字，以及弹窗里的各项（去掉编号）。 */
export function pendingOf(out: string): { id: string; text: string; items: string[] } {
  const id = /^id：(\S+)$/m.exec(out)?.[1]
  const text = /^-----\n([\s\S]*?)\n-----$/m.exec(out)?.[1]
  if (!id || !text) throw new Error(`输出里没有要确认的编号和文字：\n${out}`)
  const items = text.split('\n').flatMap(line => /^\d+\. (.*)$/.exec(line)?.[1] ?? [])
  return { id, text, items }
}
