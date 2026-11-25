#!/usr/bin/env node
// npm 包的命令：npx gatelight setup antigravity / npx gatelight remove antigravity。
// Antigravity 的插件市场只收官方和合作方的，装法是把插件目录放进 ~/.gemini/config/plugins/<名字>/：这里把这个包复制过去。
// Claude Code、Codex 从各自的插件市场装（市场目录里写的是 npm 来源），不走这里。
// 写成纯 JS：包在 node_modules 下面时 node 不肯直接跑 TypeScript（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）。
// 复制到 Antigravity 的目录以后，插件里的 TypeScript 在那里跑，不受影响。

import { cpSync, existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = dirname(fileURLToPath(import.meta.url))
const { name, version, files } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
const target = join(process.env.HOME || homedir(), '.gemini', 'config', 'plugins', name)
const USAGE = `用法：
  npx ${name} setup antigravity    把 ${name} 装进 Antigravity（${target}），已装的换成这一版
  npx ${name} remove antigravity   从 Antigravity 卸掉

Claude Code、Codex 从各自的插件市场装，见 README。`

/** target 现在是什么：没有、开发用的链接、装着的 gatelight、别的东西。 */
function current() {
  let stat
  try {
    stat = lstatSync(target)
  } catch {
    return { kind: 'none' }
  }
  if (stat.isSymbolicLink()) return { kind: 'link', to: readlinkSync(target) }
  try {
    const manifest = JSON.parse(readFileSync(join(target, '.antigravity-plugin', 'plugin.json'), 'utf8'))
    if (manifest.name === name) return { kind: 'ours', version: manifest.version }
  } catch {
    // 读不出清单的按别的东西算
  }
  return { kind: 'other' }
}

function refuseLink(to) {
  console.error(`${target} 是指向 ${to} 的链接（开发用的），不动它。要换成 npm 上的版本，先删掉这个链接再运行。`)
  return 1
}

function setup() {
  const now = current()
  if (now.kind === 'link') return refuseLink(now.to)
  if (now.kind === 'other') {
    console.error(`${target} 已经有别的东西（不是 ${name} 的插件），没有覆盖。确认不要它后删掉，再运行。`)
    return 1
  }
  // 先复制到旁边，整份到位后再换上去：中途出错不会留下半份插件
  const staging = `${target}.new-${process.pid}`
  const old = `${target}.old-${process.pid}`
  try {
    for (const entry of ['package.json', ...files]) {
      cpSync(join(pkg, entry), join(staging, entry), { recursive: true })
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  if (now.kind === 'ours') renameSync(target, old)
  renameSync(staging, target)
  rmSync(old, { recursive: true, force: true })
  console.log(now.kind !== 'ours'
    ? `已把 ${name} ${version} 装进 Antigravity：${target}`
    : now.version === version
      ? `已把 Antigravity 里的 ${name} ${version} 重新装了一遍：${target}`
      : `已把 Antigravity 里的 ${name} 从 ${now.version} 换成 ${version}：${target}`)
  console.log('新开一个 Antigravity 对话生效。')
  return 0
}

function remove() {
  const now = current()
  if (now.kind === 'link') return refuseLink(now.to)
  if (now.kind === 'none') {
    console.log(`Antigravity 里没有装 ${name}（${target} 不存在）。`)
    return 0
  }
  if (now.kind === 'other') {
    console.error(`${target} 不是 ${name} 的插件，没有删。`)
    return 1
  }
  rmSync(target, { recursive: true, force: true })
  console.log(`已从 Antigravity 卸掉 ${name} ${now.version}（删了 ${target}）。新开的对话里就没有了。`)
  if (existsSync(join(process.env.HOME || homedir(), '.local', 'bin', 'testpace'))) {
    console.log('~/.local/bin 下的 testpace、modwall、testcraft 入口留着：别的 agent 装着的 gatelight 还用它们，一个都没装时它们会说没装。')
  }
  return 0
}

const [command, agent] = process.argv.slice(2)
if (agent !== 'antigravity' || (command !== 'setup' && command !== 'remove')) {
  console.error(USAGE)
  process.exit(2)
}
process.exit(command === 'setup' ? setup() : remove())
