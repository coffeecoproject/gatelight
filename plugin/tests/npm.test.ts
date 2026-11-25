// npm 包 gatelight：包里带什么（package.json 的 files、bin），和 npx gatelight setup/remove antigravity（setup.mjs）怎么装、怎么卸。
// 包按 files 列表复制到临时目录的 node_modules/gatelight/ 下再跑，和 npx 装下来的一样；家目录、全局 git 配置都用临时的。
// 四份清单的版本一致在 agents.test.ts；固定入口怎么挑 Antigravity 装的版本也在那里。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PLUGIN_NAME, VERSION } from '../src/base/version.ts'
import { ENV, globalGitConfig, tempDir } from './helpers.ts'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const PKG = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')) as { files: string[]; bin: Record<string, string> }

/** 按 files 列表把包复制到 node_modules/gatelight/ 下（npm 总会带上 package.json），返回包的目录。 */
function packed(): string {
  const dir = join(tempDir('testpace-npm-'), 'node_modules', PLUGIN_NAME)
  for (const entry of ['package.json', ...PKG.files]) cpSync(join(PLUGIN, entry), join(dir, entry), { recursive: true })
  return dir
}
const PACKED = packed()

/** Antigravity 的插件目录里 gatelight 那一份。 */
const target = (home: string): string => join(home, '.gemini', 'config', 'plugins', PLUGIN_NAME)

/** 在这个家目录里跑一次 npx gatelight <args>（跑的是复制出来的包里的 setup.mjs）。 */
function npx(home: string, args: string[], env: NodeJS.ProcessEnv = {}): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(PACKED, PKG.bin[PLUGIN_NAME]), ...args], { env: { ...ENV, HOME: home, ...env }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

const manifest = (dir: string): { name: string; version: string } => JSON.parse(readFileSync(join(dir, '.antigravity-plugin', 'plugin.json'), 'utf8'))
const executable = (file: string): boolean => (statSync(file).mode & 0o111) !== 0

describe('npm 包的内容', () => {
  test('files 列的每一项都在 plugin/ 下；包里带着三份插件清单、hooks.json、mcp_config.json、.mcp.json、bin 下的三条命令、entry/command、setup.mjs，不带 tests/、tsconfig.json', () => {
    for (const entry of PKG.files) assert.ok(existsSync(join(PLUGIN, entry)), `files 里的 ${entry} 不在 plugin/ 下`)
    const required = [
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
      '.antigravity-plugin/plugin.json',
      'hooks.json',
      'mcp_config.json',
      '.mcp.json',
      'bin/testpace',
      'bin/modwall',
      'bin/testcraft',
      'entry/command',
      'setup.mjs',
      'src/cli.ts',
    ]
    for (const file of required) assert.ok(existsSync(join(PACKED, file)), `包里没有 ${file}`)
    assert.ok(!existsSync(join(PACKED, 'tests')), '包里不带 tests/')
    assert.ok(!existsSync(join(PACKED, 'tsconfig.json')), '包里不带 tsconfig.json')
  })

  test('npm 的 bin 只有 gatelight 一条、指向 setup.mjs：testpace、modwall、testcraft 不放进去（入口归 testpace install 管）', () => {
    assert.deepEqual(PKG.bin, { [PLUGIN_NAME]: 'setup.mjs' })
  })

  test('包的根上有许可证（和仓库根上的 LICENSE 一字不差）和说明（npm 页面显示它），npm 不用列进 files 也总会带上', () => {
    assert.equal(readFileSync(join(PLUGIN, 'LICENSE'), 'utf8'), readFileSync(join(PLUGIN, '..', 'LICENSE'), 'utf8'), 'plugin/LICENSE 和仓库根上的不一样')
    assert.match(readFileSync(join(PLUGIN, 'README.md'), 'utf8'), /npx gatelight setup antigravity/)
  })
})

describe('npx gatelight setup/remove antigravity', () => {
  test('没装时 setup 装上：清单是 gatelight 这一版，files 列的各项都在、不带 tests/，bin/testpace 和 entry/command 可执行', () => {
    const home = tempDir('testpace-home-')
    const r = npx(home, ['setup', 'antigravity'])
    assert.equal(r.code, 0, r.out)
    const dir = target(home)
    assert.deepEqual([manifest(dir).name, manifest(dir).version], [PLUGIN_NAME, VERSION])
    for (const entry of PKG.files) assert.ok(existsSync(join(dir, entry)), `装上的没有 ${entry}`)
    assert.ok(!existsSync(join(dir, 'tests')))
    assert.ok(executable(join(dir, 'bin', 'testpace')))
    assert.ok(executable(join(dir, 'entry', 'command')))
    assert.deepEqual(readdirSync(join(home, '.gemini', 'config', 'plugins')), [PLUGIN_NAME], '旁边不留复制到一半的目录')
  })

  test('setup 只复制插件：不在 ~/.local/bin 放入口，不改全局 git 配置', () => {
    const home = tempDir('testpace-home-')
    const gitconfig = globalGitConfig()
    const before = readFileSync(gitconfig, 'utf8')
    const r = npx(home, ['setup', 'antigravity'], { GIT_CONFIG_GLOBAL: gitconfig })
    assert.equal(r.code, 0, r.out)
    assert.ok(!existsSync(join(home, '.local')), '不放固定入口')
    assert.equal(readFileSync(gitconfig, 'utf8'), before)
    assert.deepEqual(readdirSync(home), ['.gemini'])
  })

  test('setup 装上的那份，固定入口找得到：~/.local/bin/testpace 转给 Antigravity 插件目录里的 bin/testpace', () => {
    const home = tempDir('testpace-home-')
    assert.equal(npx(home, ['setup', 'antigravity']).code, 0)
    const entry = join(home, '.local', 'bin', 'testpace')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    copyFileSync(join(target(home), 'entry', 'command'), entry)
    // 假的 node：过得了 bin/node.sh 的版本检查，真跑时把参数原样打出来，看 bin/testpace 起的是哪一份的 cli.ts
    const node = join(tempDir('testpace-fake-node-'), 'node')
    writeFileSync(node, '#!/bin/sh\ncase "$1" in -e) exit 0 ;; esac\necho "$@"\n', { mode: 0o755 })
    const r = spawnSync(entry, ['status'], { env: { ...ENV, HOME: home, TESTPACE_NODE: node }, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, `--disable-warning=ExperimentalWarning ${join(target(home), 'bin')}/../src/cli.ts status\n`)
  })

  test('已经装着旧版本时 setup 换成这一版，旧文件不残留，说从哪一版换成哪一版；同一版本时说重新装了一遍', () => {
    const home = tempDir('testpace-home-')
    const dir = target(home)
    assert.equal(npx(home, ['setup', 'antigravity']).code, 0)
    writeFileSync(join(dir, '.antigravity-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN_NAME, version: '0.1.0' }, null, 2))
    writeFileSync(join(dir, 'old.txt'), '旧版本才有的文件')

    const upgraded = npx(home, ['setup', 'antigravity'])
    assert.equal(upgraded.code, 0, upgraded.out)
    assert.ok(upgraded.out.includes(`从 0.1.0 换成 ${VERSION}`), upgraded.out)
    assert.equal(manifest(dir).version, VERSION)
    assert.ok(!existsSync(join(dir, 'old.txt')), '旧文件不残留')
    assert.deepEqual(readdirSync(join(home, '.gemini', 'config', 'plugins')), [PLUGIN_NAME], '旁边不留旧的那份')

    const again = npx(home, ['setup', 'antigravity'])
    assert.equal(again.code, 0, again.out)
    assert.ok(again.out.includes(`${PLUGIN_NAME} ${VERSION} 重新装了一遍`), again.out)
    assert.equal(manifest(dir).version, VERSION)
  })

  test('目标是链接（开发用的）时 setup、remove 都不动它，退出码 1', () => {
    const home = tempDir('testpace-home-')
    const real = tempDir('testpace-agy-plugin-')
    mkdirSync(join(real, '.antigravity-plugin'))
    writeFileSync(join(real, '.antigravity-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN_NAME, version: '0.1.0' }))
    mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true })
    symlinkSync(real, target(home))
    for (const command of ['setup', 'remove']) {
      const r = npx(home, [command, 'antigravity'])
      assert.equal(r.code, 1, `${command}：${r.out}`)
      assert.equal(readlinkSync(target(home)), real, command)
      assert.equal(manifest(real).version, '0.1.0', command)
      assert.deepEqual(readdirSync(real), ['.antigravity-plugin'], command)
    }
  })

  test('目标是别的东西（一个文件、或清单名字不同的插件）时 setup 不覆盖、remove 不删，退出码 1', () => {
    const asFile = tempDir('testpace-home-')
    mkdirSync(join(asFile, '.gemini', 'config', 'plugins'), { recursive: true })
    writeFileSync(target(asFile), '别的东西')
    const otherPlugin = tempDir('testpace-home-')
    mkdirSync(join(target(otherPlugin), '.antigravity-plugin'), { recursive: true })
    writeFileSync(join(target(otherPlugin), '.antigravity-plugin', 'plugin.json'), JSON.stringify({ name: 'other', version: '9.9.9' }))
    for (const command of ['setup', 'remove']) {
      const file = npx(asFile, [command, 'antigravity'])
      assert.equal(file.code, 1, `${command}：${file.out}`)
      assert.equal(readFileSync(target(asFile), 'utf8'), '别的东西', command)
      const other = npx(otherPlugin, [command, 'antigravity'])
      assert.equal(other.code, 1, `${command}：${other.out}`)
      assert.deepEqual(manifest(target(otherPlugin)), { name: 'other', version: '9.9.9' }, command)
      assert.deepEqual(readdirSync(target(otherPlugin)), ['.antigravity-plugin'], command)
    }
  })

  test('remove 删掉装着的 gatelight，退出码 0；没装时说没装，退出码 0', () => {
    const home = tempDir('testpace-home-')
    assert.equal(npx(home, ['setup', 'antigravity']).code, 0)
    const removed = npx(home, ['remove', 'antigravity'])
    assert.equal(removed.code, 0, removed.out)
    assert.ok(!existsSync(target(home)))
    const none = npx(home, ['remove', 'antigravity'])
    assert.equal(none.code, 0, none.out)
    assert.ok(none.out.includes('没有装'), none.out)
  })

  test('用法不对（没参数、setup claude、install antigravity）退出码 2，什么都不写', () => {
    for (const args of [[], ['setup', 'claude'], ['install', 'antigravity']]) {
      const home = tempDir('testpace-home-')
      const r = npx(home, args)
      assert.equal(r.code, 2, `${args.join(' ')}：${r.out}`)
      assert.deepEqual(readdirSync(home), [], args.join(' '))
    }
  })
})
