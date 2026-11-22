// 多个 agent：认 agent、Codex 的命令和 hook、合并门的版本只升不降、固定命令入口、两份插件清单。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { currentAgent } from '../src/base/agent.ts'
import { HOOK_COMMAND } from '../src/base/gate.ts'
import { handle } from '../src/base/hook.ts'
import { byRunner } from '../src/pace/report.ts'
import type { PaceRun } from '../src/pace/record.ts'
import { compareVersions, PLUGIN_NAME, VERSION } from '../src/base/version.ts'
import { BIN_DIR, ENV, gatedRepo, globalGitConfig, runs, sampleRepo, sh, tempDir, testpace } from './helpers.ts'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

type Output = { hookSpecificOutput?: { additionalContext?: string }; systemMessage?: string } | undefined

function change(repo: string, text = '// 改过\n'): void {
  writeFileSync(join(repo, 'src', 'price.mjs'), `${readFileSync(join(repo, 'src', 'price.mjs'), 'utf8')}${text}`)
}

/** 在一段时间里换掉进程的环境变量（hook 的判断在本进程里跑）。 */
function withEnv<T>(change: Record<string, string | undefined>, run: () => T): T {
  const saved = Object.fromEntries(Object.keys(change).map(key => [key, process.env[key]]))
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  apply(change)
  try {
    return run()
  } finally {
    apply(saved)
  }
}

describe('认 agent', () => {
  test('Codex 优先：从 Claude Code 里启动的 Codex 带着 CLAUDECODE 也算 Codex；dsh 认 DSH_SHELL；终端里的不算', () => {
    assert.deepEqual(currentAgent({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'c' }), { kind: 'claude', session: 'c', sandboxed: false })
    assert.deepEqual(currentAgent({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'c', CODEX_THREAD_ID: 'x', CODEX_SANDBOX: 'seatbelt' }), {
      kind: 'codex',
      session: 'x',
      sandboxed: true,
    })
    assert.deepEqual(currentAgent({ CODEX_THREAD_ID: 'x' }), { kind: 'codex', session: 'x', sandboxed: false })
    assert.deepEqual(currentAgent({ CLAUDECODE: '1', DSH_SHELL: '1', DSH_SESSION_ID: 'd' }), { kind: 'dsh', session: 'd', sandboxed: false })
    assert.equal(currentAgent({ PATH: '/bin' }), undefined)
  })

  test('版本号按数字比较', () => {
    assert.ok(compareVersions('0.10.0', '0.9.5') > 0)
    assert.ok(compareVersions('0.5.0', '0.5.1') < 0)
    assert.equal(compareVersions('1.0', '1.0.0'), 0)
  })

  test('报告按谁跑的分开：记了版本没有 agent 的是终端，版本也没有的是旧版本写的；只有一种时不分', () => {
    const record = (agent: PaceRun['agent'], kind: PaceRun['kind'], durationMs: number, version = VERSION): PaceRun => ({
      id: `${agent}-${durationMs}`, kind, worktree: '/r', tree: 't', treeAtEnd: 't', startedAt: 1, durationMs, exitCode: 0, result: 'pass', log: '/l',
      ...(agent ? { agent } : {}),
      ...(version ? { version } : {}),
    })
    assert.deepEqual(byRunner([record('claude', 'full', 10), record('claude', 'fast', 5)]), [])
    assert.deepEqual(
      byRunner([record('claude', 'full', 10), record('codex', 'full', 30), record('codex', 'files', 5), record(undefined, 'fast', 2), record(undefined, 'fast', 1, '')]),
      [
        { runner: 'Codex', count: 2, totalMs: 35, fulls: 1 },
        { runner: 'Claude Code', count: 1, totalMs: 10, fulls: 1 },
        { runner: '终端', count: 1, totalMs: 2, fulls: 0 },
        { runner: '未记录（旧版本）', count: 1, totalMs: 1, fulls: 0 },
      ],
    )
  })
})

describe('Codex 的命令', () => {
  test('在 Codex 的沙箱里不跑测试、不看结果（status 要记下看过），什么都不记，说明要提权', () => {
    const repo = sampleRepo()
    const sandboxed = { ...ENV, CODEX_THREAD_ID: 't', CODEX_SANDBOX: 'seatbelt' }
    for (const args of [['full'], ['focused'], ['files', 'tests/price.test.mjs'], ['verify'], ['status']]) {
      const r = testpace(repo, args, sandboxed)
      assert.equal(r.code, 2, args.join(' '))
      assert.match(r.out, /^testpace 要在 Codex 的沙箱外跑/)
    }
    assert.deepEqual(runs(repo), [])
    assert.equal(testpace(repo, ['full'], { ...ENV, CODEX_THREAD_ID: 't' }).code, 0, '提权后（不带 CODEX_SANDBOX）照常跑')
  })

  test('写不了记录目录时说清楚，不只抛一句写入被拒', () => {
    const repo = sampleRepo()
    const store = join(repo, '.git', 'testpace')
    mkdirSync(store)
    chmodSync(store, 0o555)
    try {
      const r = testpace(repo, ['files', 'tests/price.test.mjs'])
      assert.equal(r.code, 2)
      assert.match(r.out, /^testpace 写不了 .+testpace.+（EACCES）。在 agent 的沙箱里时，申请提权（在沙箱外）重新运行这条命令。/)
    } finally {
      chmodSync(store, 0o755)
    }
  })

  test('运行记录带上 agent 和版本；会话号取 Codex 的，不取继承来的 Claude Code 会话号', () => {
    const repo = sampleRepo()
    assert.equal(testpace(repo, ['full'], { ...ENV, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'claude-s', CODEX_THREAD_ID: 'codex-t' }).code, 0)
    assert.equal(testpace(repo, ['files', 'tests/price.test.mjs']).code, 0)
    const [full, files] = runs(repo)
    assert.deepEqual([full?.agent, full?.session, full?.version], ['codex', 'codex-t', VERSION])
    assert.deepEqual([files?.agent, files?.session, files?.version], [undefined, undefined, VERSION], '终端里跑的不记 agent')
  })
})

describe('Codex 的 hook', () => {
  test('会话开始说明节奏和 Codex 的前提；没放固定命令入口时给出插件里 testpace 的完整路径；会话记录放在插件数据目录', () => {
    const data = tempDir('testpace-codex-data-')
    const home = tempDir('testpace-home-')
    withEnv({ CLAUDE_PLUGIN_DATA: data, HOME: home, GIT_CONFIG_GLOBAL: globalGitConfig() }, () => {
      const repo = sampleRepo()
      const context = String((handle({ hook_event_name: 'SessionStart', session_id: 'cx', cwd: repo }, Date.now(), 'codex') as Output)?.hookSpecificOutput?.additionalContext)
      assert.match(context, /用 testpace 管测试节奏/)
      assert.match(context, /在 Codex 里：testpace 的命令要写 \.git\/testpace\/、项目的测试常要开端口和网络，在沙箱里跑不了，每次申请提权在沙箱外跑。/)
      assert.ok(context.includes(`这台机器还没放 testpace 的固定命令入口（${join(home, '.local', 'bin', 'testpace')}）`))
      assert.ok(context.includes(`同意后在沙箱外跑 ${join(PLUGIN, 'bin', 'testpace')} install`))
      assert.ok(existsSync(join(data, 'sessions', 'cx.json')), '会话碰过的仓库记在 Codex 给的插件数据目录里')

      mkdirSync(join(home, '.local', 'bin'), { recursive: true })
      writeFileSync(join(home, '.local', 'bin', 'testpace'), readFileSync(join(PLUGIN, 'entry', 'testpace')))
      const placed = String((handle({ hook_event_name: 'SessionStart', session_id: 'cx2', cwd: repo }, Date.now(), 'codex') as Output)?.hookSpecificOutput?.additionalContext)
      assert.doesNotMatch(placed, /固定命令入口/, '放好了不再说')
      const claude = String((handle({ hook_event_name: 'SessionStart', session_id: 'cl', cwd: repo }, Date.now(), 'claude') as Output)?.hookSpecificOutput?.additionalContext)
      assert.doesNotMatch(claude, /在 Codex 里/, 'Claude Code 的会话不说 Codex 的前提')
    })
  })

  test('执行命令的工具按名字认，不分大小写：Codex 的 apply_patch 输入里也有字符串的 command，不当命令解析', () => {
    withEnv({ CLAUDE_PLUGIN_DATA: tempDir('testpace-data-'), GIT_CONFIG_GLOBAL: globalGitConfig() }, () => {
      const repo = sampleRepo()
      const pre = (agent: 'codex' | 'dsh', session: string, input: Record<string, unknown>): Output => {
        handle({ hook_event_name: 'SessionStart', session_id: session, cwd: repo }, Date.now(), agent)
        return handle({ hook_event_name: 'PreToolUse', session_id: session, cwd: repo, ...input }, Date.now(), agent) as Output
      }
      assert.match(String(pre('codex', 'c1', { tool_name: 'Bash', tool_input: { command: 'node scripts/full.mjs' } })?.hookSpecificOutput?.additionalContext), /改用 testpace full/)
      // 实测时 Codex 的补丁：tool_input.command 是补丁正文
      const patch = '*** Begin Patch\n*** Update File: README.md\n@@\n node scripts/full.mjs\n+说明\n*** End Patch\n'
      assert.equal(pre('codex', 'c2', { tool_name: 'apply_patch', tool_input: { command: patch } }), undefined)
      assert.match(String(pre('dsh', 'd1', { tool_name: 'bash', tool_input: { command: 'node scripts/full.mjs' } })?.hookSpecificOutput?.additionalContext), /改用 testpace full/)
    })
  })

  test('codex.sh 找到 node 交给入口，说明是 Codex；hooks/codex.json 把用到的事件都交给它', () => {
    const repo = sampleRepo()
    const env = { ...ENV, TESTPACE_NODE: process.execPath, CLAUDE_PLUGIN_DATA: tempDir('testpace-data-'), HOME: tempDir('testpace-home-'), GIT_CONFIG_GLOBAL: globalGitConfig() }
    const r = spawnSync('sh', [join(PLUGIN, 'hooks', 'codex.sh')], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', cwd: repo, source: 'startup' }),
      env,
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /在 Codex 里：/)

    const { hooks } = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'codex.json'), 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>
    }
    const registered = Object.fromEntries(Object.entries(hooks).map(([event, entries]) => [event, entries.map(entry => entry.matcher ?? '')]))
    assert.deepEqual(registered, { SessionStart: [''], PreToolUse: ['^(Bash|apply_patch)$'], PostToolUse: ['^Bash$'], Stop: [''] }, '工具调用前看执行命令的 Bash 和改文件的 apply_patch，调用后只看 Bash')
    for (const entries of Object.values(hooks)) assert.equal(entries[0]!.hooks[0]!.command, 'sh "${PLUGIN_ROOT}/hooks/codex.sh"')
  })
})

describe('合并门在两个 agent 之间', () => {
  test('Codex 的 git 命令也拦', () => {
    const repo = gatedRepo()
    change(repo)
    const r = spawnSync('/bin/sh', ['-c', 'git commit -qam m'], { cwd: repo, env: { ...ENV, CODEX_THREAD_ID: 't', PATH: `${BIN_DIR}:${ENV.PATH}` }, encoding: 'utf8' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /testpace 合并门：这次要把 main 更新到/)
  })

  test('更新的版本配的钩子：会话开始不改回去、status 不报问题；更旧的照常更新；正文没变只是版本旧的不重配', () => {
    const global = globalGitConfig()
    withEnv({ GIT_CONFIG_GLOBAL: global }, () => {
      const repo = sampleRepo()
      const configure = (command: string): void => {
        // 钩子命令里有单引号，不经过 sh
        for (const [key, value] of [['hook.testpace.event', 'reference-transaction'], ['hook.testpace.command', command]]) {
          spawnSync('git', ['config', '--file', global, key!, value!], { cwd: repo, env: ENV })
        }
      }
      const configured = (): string => sh(repo, `git config --file '${global}' --get hook.testpace.command`).trim()
      // 正文也不同（更新的版本改了钩子命令）：正文一样的不用看版本
      const newer = HOOK_COMMAND.replace(`: testpace ${VERSION};`, ': testpace 99.0.0;').replace('testpace_gate() {', 'testpace_gate() { :;')
      configure(newer)
      handle({ hook_event_name: 'SessionStart', session_id: 'v1', cwd: repo }, Date.now(), 'claude')
      assert.equal(configured(), newer, '另一个 agent 里装的更新版本配的，不改回去')
      assert.match(testpace(repo, ['status'], { ...ENV, GIT_CONFIG_GLOBAL: global }).out, /合并门：已装上/)
      const older = HOOK_COMMAND.replace(`: testpace ${VERSION};`, ': testpace 0.0.1;')
      configure(older)
      handle({ hook_event_name: 'SessionStart', session_id: 'v2', cwd: repo }, Date.now(), 'claude')
      assert.equal(configured(), older, '正文和这一版一样：发版不用重配')
      assert.match(testpace(repo, ['status'], { ...ENV, GIT_CONFIG_GLOBAL: global }).out, /合并门：已装上/)
      configure(older.replace('testpace_gate() {', 'testpace_gate() { :;'))
      handle({ hook_event_name: 'SessionStart', session_id: 'v3', cwd: repo }, Date.now(), 'claude')
      assert.equal(configured(), HOOK_COMMAND, '正文不同、版本更旧的更新成这一版')
    })
  })
})

describe('固定命令入口', () => {
  test('install 放到 ~/.local/bin/testpace；它转给这台机器上装着的最高版本；同名的别的文件不覆盖', () => {
    const home = tempDir('testpace-home-')
    const env = { ...ENV, HOME: home, GIT_CONFIG_GLOBAL: globalGitConfig() }
    const repo = sampleRepo()
    const installed = testpace(repo, ['install'], env)
    assert.equal(installed.code, 0, installed.out)
    const entry = join(home, '.local', 'bin', 'testpace')
    assert.equal(readFileSync(entry, 'utf8'), readFileSync(join(PLUGIN, 'entry', 'testpace'), 'utf8'))
    assert.match(testpace(repo, ['status'], env).out, /固定命令入口（.+）：已放好/)

    const fake = (base: string, version: string, complete = true): void => {
      const bin = join(base, PLUGIN_NAME, version, 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'testpace'), `#!/bin/sh\necho "${base.includes('.codex') ? 'codex' : 'claude'} ${version} $*"\n`, { mode: 0o755 })
      if (complete) {
        mkdirSync(join(base, PLUGIN_NAME, version, 'src'), { recursive: true })
        writeFileSync(join(base, PLUGIN_NAME, version, 'src', 'cli.ts'), '')
      }
    }
    const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync(entry, ['status'], { env: { ...env, ...extra }, encoding: 'utf8' })
    const none = run()
    assert.equal(none.status, 2, '找不到装着的插件：退出码 2（配置问题）')
    assert.match(none.stderr, /没找到装着的、完整的 gatelight 插件/)
    // Claude Code 只认安装记录里的：卸载、降级后缓存里留下的旧目录不算
    const claudeCache = join(home, '.claude', 'plugins', 'cache', 'm')
    const record = join(home, '.claude', 'plugins', 'installed_plugins.json')
    const claudeInstalls = (version: string): void =>
      writeFileSync(record, JSON.stringify({ version: 2, plugins: { [`${PLUGIN_NAME}@m`]: [{ scope: 'user', installPath: join(claudeCache, PLUGIN_NAME, version), version }] } }, null, 2))
    fake(claudeCache, '0.9.0')
    fake(claudeCache, '0.10.0')
    assert.equal(run().status, 2, '没有安装记录：缓存里有也算没装')
    claudeInstalls('0.10.0')
    fake(join(home, '.codex', 'plugins', 'cache', 'x'), '0.9.5')
    assert.equal(run().stdout, 'claude 0.10.0 status\n', '按版本号比，不按字面')
    fake(join(home, '.codex', 'plugins', 'cache', 'x'), '0.10.0', false)
    assert.equal(run().stdout, 'claude 0.10.0 status\n', '版本一样时 Codex 那份缺 src/（缓存只复制了一部分）：不用它')
    fake(join(home, '.codex', 'plugins', 'cache', 'x'), '0.11.0', false)
    assert.equal(run().stdout, 'claude 0.10.0 status\n', '残缺的那份版本再高也不用')
    fake(join(home, '.codex', 'plugins', 'cache', 'x'), '0.11.0')
    assert.equal(run().stdout, 'codex 0.11.0 status\n', 'Codex 装的更新就用 Codex 的')
    rmSync(join(home, '.codex'), { recursive: true })
    claudeInstalls('0.9.0')
    assert.equal(run().stdout, 'claude 0.9.0 status\n', '降级到 0.9.0 后缓存里留下的 0.10.0 不算')

    writeFileSync(entry, '#!/bin/sh\necho 别的工具\n')
    const refused = testpace(repo, ['install'], env)
    assert.equal(refused.code, 2)
    assert.match(refused.out, /固定命令入口没放上：.+已经有别的文件，没有覆盖/)
    assert.equal(readFileSync(entry, 'utf8'), '#!/bin/sh\necho 别的工具\n')
  })

  test('会话开始时：旧版本放的入口换成这一版的；没放过的不放；同名的别的文件不动', () => {
    const home = tempDir('testpace-home-')
    const entry = join(home, '.local', 'bin', 'testpace')
    const current = readFileSync(join(PLUGIN, 'entry', 'testpace'), 'utf8')
    withEnv({ CLAUDE_PLUGIN_DATA: tempDir('testpace-data-'), HOME: home, GIT_CONFIG_GLOBAL: globalGitConfig() }, () => {
      const repo = sampleRepo()
      const start = (session: string): unknown => handle({ hook_event_name: 'SessionStart', session_id: session, cwd: repo }, Date.now(), 'claude')
      start('e1')
      assert.equal(existsSync(entry), false, '没放过：放是全局安装，要用户同意后跑 testpace install')

      // 改名之前的版本放的：按旧名字找插件，找不到装着的那份
      mkdirSync(join(home, '.local', 'bin'), { recursive: true })
      writeFileSync(entry, '#!/bin/sh\n# testpace 固定入口：旧版本放的\nexit 2\n', { mode: 0o755 })
      start('e2')
      assert.equal(readFileSync(entry, 'utf8'), current)
      // 会话不在接入了的仓库里也更新：入口是这台机器的，不是哪个仓库的
      writeFileSync(entry, '#!/bin/sh\n# testpace 固定入口：旧版本放的\nexit 2\n', { mode: 0o755 })
      handle({ hook_event_name: 'SessionStart', session_id: 'e3', cwd: home }, Date.now(), 'claude')
      assert.equal(readFileSync(entry, 'utf8'), current)

      writeFileSync(entry, '#!/bin/sh\necho 别的工具\n')
      start('e4')
      assert.equal(readFileSync(entry, 'utf8'), '#!/bin/sh\necho 别的工具\n')

      // 写不进去（只读）：入口还是旧的，会话说明照常给
      rmSync(entry)
      writeFileSync(entry, '#!/bin/sh\n# testpace 固定入口：旧版本放的\nexit 2\n', { mode: 0o555 })
      const told = start('e5') as Output
      assert.match(String(told?.hookSpecificOutput?.additionalContext), /用 testpace 管测试节奏/)
      assert.match(readFileSync(entry, 'utf8'), /旧版本放的/)
    })
  })

  test('两份插件清单版本一致；插件的名字各处一样（两份市场清单、确认工具所在的服务）；Codex 的 marketplace 指向 plugin 目录', () => {
    const claude = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'))
    const codex = JSON.parse(readFileSync(join(PLUGIN, '.codex-plugin', 'plugin.json'), 'utf8'))
    assert.equal(codex.version, claude.version)
    assert.equal(claude.name, 'gatelight')
    assert.equal(codex.name, claude.name)
    assert.equal(PLUGIN_NAME, claude.name)
    // agent 看到的确认工具全名里带着插件名和服务名：服务名和插件名一样，提示里说"调用 <插件名> 的工具"才对得上
    const mcp = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8'))
    assert.deepEqual(Object.keys(mcp.mcpServers), [claude.name])
    const claudeMarket = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'))
    assert.deepEqual(claudeMarket.plugins.map((p: { name: string; source: unknown }) => [p.name, p.source]), [[claude.name, './plugin']])
    assert.equal(codex.hooks, './hooks/codex.json')
    assert.equal(codex.skills, './skills/')
    const market = JSON.parse(readFileSync(join(ROOT, '.agents', 'plugins', 'marketplace.json'), 'utf8'))
    assert.deepEqual(market.plugins.map((p: { name: string; source: unknown }) => [p.name, p.source]), [[claude.name, { source: 'local', path: './plugin' }]])
  })
})
