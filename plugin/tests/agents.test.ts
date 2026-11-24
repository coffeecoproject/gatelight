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
import { sampleRepo as craftRepo, testcraft } from './craft/helpers.ts'
import { modwall, ENV as WALL_ENV, sampleRepo as wallRepo } from './wall/helpers.ts'

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

  test('在 Codex 的沙箱里 modwall 不做检查（check、status、db check），什么都不记，说明要提权；提权后照常检查', () => {
    const repo = wallRepo()
    const ran = join(tempDir('modwall-psql-'), 'ran')
    const sandboxed = { ...WALL_ENV, CODEX_THREAD_ID: 't', CODEX_SANDBOX: 'seatbelt' }
    for (const args of [['check'], ['status'], ['db', 'check', '--psql', `touch '${ran}'`]]) {
      const r = modwall(repo, args, sandboxed)
      assert.equal(r.code, 2, `${args.join(' ')}\n${r.out}`)
      assert.match(r.out, /^modwall 要在 Codex 的沙箱外跑：.+申请提权（在沙箱外）重新运行这条命令。/, args.join(' '))
    }
    assert.equal(existsSync(join(repo, '.git', 'testpace')), false, '不留日志、不留通过记录')
    assert.equal(existsSync(ran), false, 'db check 没有跑 --psql 给的命令')

    const escalated = { ...WALL_ENV, CODEX_THREAD_ID: 't' }
    const r = modwall(repo, ['check'], escalated)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /modwall check：通过/)
    assert.match(modwall(repo, ['status'], escalated).out, /当前内容 modwall check 通过过/)
  })

  test('在 Codex 的沙箱里 modwall init、help 照常跑', () => {
    const repo = wallRepo(dir => rmSync(join(dir, '.modwall'), { recursive: true }))
    const sandboxed = { ...WALL_ENV, CODEX_THREAD_ID: 't', CODEX_SANDBOX: 'seatbelt' }
    const init = modwall(repo, ['init'], sandboxed)
    assert.equal(init.code, 0, init.out)
    assert.ok(existsSync(join(repo, '.modwall', 'config.json')), '生成了配置草稿')
    const help = modwall(repo, ['help'], sandboxed)
    assert.equal(help.code, 0, help.out)
    assert.equal(help.out, modwall(repo, ['help']).out, '和终端里一样')
  })

  test('在 Codex 的沙箱里 testcraft 照常跑（checklist、status），输出和终端里一样', () => {
    const repo = craftRepo()
    const sandboxed = { CODEX_THREAD_ID: 't', CODEX_SANDBOX: 'seatbelt' }
    for (const args of [['checklist'], ['status']]) {
      const r = testcraft(repo, args, sandboxed)
      const terminal = testcraft(repo, args)
      assert.equal(r.code, terminal.code, `${args.join(' ')}\n${r.out}`)
      assert.notEqual(r.code, 2, `${args.join(' ')}\n${r.out}`)
      assert.equal(r.out, terminal.out, args.join(' '))
    }
  })

  test('modwall 写不了记录目录时说清楚，不崩出堆栈', () => {
    const repo = wallRepo()
    const store = join(repo, '.git', 'testpace')
    mkdirSync(store)
    chmodSync(store, 0o555)
    try {
      const r = modwall(repo, ['check'])
      assert.equal(r.code, 2, r.out)
      assert.match(r.out, /^modwall 写不了 .+testpace.*（EACCES）。在 agent 的沙箱里时，申请提权（在沙箱外）重新运行这条命令。$/m)
      assert.doesNotMatch(r.out, /\n\s+at /, '没有 Node 堆栈')
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
  test('会话开始说明节奏和 Codex 的前提；固定命令入口列出没放的是哪几条，testpace 没放时说合并门也找不到它，都放好了不提；会话记录放在插件数据目录', () => {
    const data = tempDir('testpace-codex-data-')
    const home = tempDir('testpace-home-')
    withEnv({ CLAUDE_PLUGIN_DATA: data, HOME: home, GIT_CONFIG_GLOBAL: globalGitConfig() }, () => {
      const repo = sampleRepo()
      const start = (session: string, agent: 'codex' | 'claude' = 'codex'): string =>
        String((handle({ hook_event_name: 'SessionStart', session_id: session, cwd: repo }, Date.now(), agent) as Output)?.hookSpecificOutput?.additionalContext)
      const dir = join(home, '.local', 'bin')
      const gateBlind = '合并门的 git 钩子也找不到 testpace（找不到就不检查）'
      const context = start('cx')
      assert.match(context, /用 testpace 管测试节奏/)
      assert.match(context, /在 Codex 里：testpace 的命令要写 \.git\/testpace\/、项目的测试常要开端口和网络，在沙箱里跑不了，每次申请提权在沙箱外跑。/)
      assert.ok(context.includes(`这台机器还没放 testpace、modwall、testcraft 的固定命令入口（放在 ${dir}）`), context)
      assert.ok(context.includes(gateBlind), context)
      assert.ok(context.includes(`同意后在沙箱外跑 ${join(PLUGIN, 'bin', 'testpace')} install`), context)
      assert.ok(existsSync(join(data, 'sessions', 'cx.json')), '会话碰过的仓库记在 Codex 给的插件数据目录里')

      // 只放了 testpace（比如放固定入口时还只有这一条）：说另外两条，不说合并门
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'testpace'), readFileSync(join(PLUGIN, 'entry', 'command')))
      const partly = start('cx2')
      assert.ok(partly.includes(`这台机器还没放 modwall、testcraft 的固定命令入口（放在 ${dir}）`), partly)
      assert.ok(!partly.includes(gateBlind), '合并门的钩子只靠 testpace 的入口')

      for (const command of ['modwall', 'testcraft']) writeFileSync(join(dir, command), readFileSync(join(PLUGIN, 'entry', 'command')))
      assert.doesNotMatch(start('cx3'), /固定命令入口/, '都放好了不再说')
      assert.doesNotMatch(start('cl', 'claude'), /在 Codex 里/, 'Claude Code 的会话不说 Codex 的前提')
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

  test('Claude Code 往终端面板里打的 git 命令也拦：它开的标签带着 CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS，没有 CLAUDECODE', () => {
    const terminal = { CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS: 's' }
    assert.deepEqual(currentAgent(terminal), { kind: 'claude', sandboxed: false }, '算 Claude Code 的命令；会话号不在这个变量里取')
    const repo = gatedRepo()
    change(repo)
    const r = spawnSync('/bin/sh', ['-c', 'git commit -qam m'], { cwd: repo, env: { ...ENV, ...terminal, PATH: `${BIN_DIR}:${ENV.PATH}` }, encoding: 'utf8' })
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
  test('install 在 ~/.local/bin 放上 testpace、modwall、testcraft 的入口（同一份脚本）；用哪个名字叫，就转给装着的最高版本的插件里同名的命令；同名的别的文件不覆盖，其余照放', () => {
    const home = tempDir('testpace-home-')
    const env = { ...ENV, HOME: home, GIT_CONFIG_GLOBAL: globalGitConfig() }
    const repo = sampleRepo()
    const source = readFileSync(join(PLUGIN, 'entry', 'command'), 'utf8')
    const entry = (command: string): string => join(home, '.local', 'bin', command)
    const installed = testpace(repo, ['install'], env)
    assert.equal(installed.code, 0, installed.out)
    for (const command of ['testpace', 'modwall', 'testcraft']) assert.equal(readFileSync(entry(command), 'utf8'), source, command)
    assert.match(testpace(repo, ['status'], env).out, /固定命令入口（.+）：testpace、modwall、testcraft 已放好\n/)

    // 插件里每条命令都说出自己的名字，看得出转给了哪一份的哪一条
    const fake = (base: string, version: string, complete = true): void => {
      const bin = join(base, PLUGIN_NAME, version, 'bin')
      mkdirSync(bin, { recursive: true })
      for (const command of ['testpace', 'modwall', 'testcraft'])
        writeFileSync(join(bin, command), `#!/bin/sh\necho "${command} ${base.includes('.codex') ? 'codex' : 'claude'} ${version} $*"\n`, { mode: 0o755 })
      if (complete) {
        mkdirSync(join(base, PLUGIN_NAME, version, 'src'), { recursive: true })
        writeFileSync(join(base, PLUGIN_NAME, version, 'src', 'cli.ts'), '')
      }
    }
    const run = (command = 'testpace') => spawnSync(entry(command), ['status'], { env, encoding: 'utf8' })
    const none = run()
    assert.equal(none.status, 2, '找不到装着的插件：退出码 2（配置问题）')
    assert.match(none.stderr, /^testpace：这台机器上没找到装着的、完整的 gatelight 插件/)
    const noneModwall = run('modwall')
    assert.equal(noneModwall.status, 2)
    assert.match(noneModwall.stderr, /^modwall：这台机器上没找到装着的、完整的 gatelight 插件/, '报错里说的是被叫的那条命令')
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
    assert.equal(run().stdout, 'testpace claude 0.10.0 status\n', '按版本号比，不按字面')
    fake(join(home, '.codex', 'plugins', 'cache', 'x'), '0.10.0', false)
    assert.equal(run().stdout, 'testpace claude 0.10.0 status\n', '版本一样时 Codex 那份缺 src/（缓存只复制了一部分）：不用它')
    fake(join(home, '.codex', 'plugins', 'cache', 'x'), '0.11.0', false)
    assert.equal(run().stdout, 'testpace claude 0.10.0 status\n', '残缺的那份版本再高也不用')
    fake(join(home, '.codex', 'plugins', 'cache', 'x'), '0.11.0')
    assert.equal(run().stdout, 'testpace codex 0.11.0 status\n', 'Codex 装的更新就用 Codex 的')
    assert.equal(run('modwall').stdout, 'modwall codex 0.11.0 status\n', '用哪个名字叫就转给同名的命令')
    assert.equal(run('testcraft').stdout, 'testcraft codex 0.11.0 status\n')
    rmSync(join(home, '.codex'), { recursive: true })
    claudeInstalls('0.9.0')
    assert.equal(run().stdout, 'testpace claude 0.9.0 status\n', '降级到 0.9.0 后缓存里留下的 0.10.0 不算')

    // 只有 modwall 那里是别的文件：它不动，另外两条照放
    rmSync(entry('testpace'))
    rmSync(entry('testcraft'))
    writeFileSync(entry('modwall'), '#!/bin/sh\necho 别的工具\n')
    const refused = testpace(repo, ['install'], env)
    assert.equal(refused.code, 2)
    assert.ok(refused.out.includes(`固定命令入口没放上：${entry('modwall')} 已经有别的文件，没有覆盖`), refused.out)
    assert.ok(!refused.out.includes(`${entry('testpace')} 已经有别的文件`), refused.out)
    assert.equal(readFileSync(entry('modwall'), 'utf8'), '#!/bin/sh\necho 别的工具\n')
    assert.equal(readFileSync(entry('testpace'), 'utf8'), source)
    assert.equal(readFileSync(entry('testcraft'), 'utf8'), source)
  })

  test('status 用一行说三条命令的固定入口，状态一样的并在一起', () => {
    const home = tempDir('testpace-home-')
    const env = { ...ENV, HOME: home, GIT_CONFIG_GLOBAL: globalGitConfig() }
    const repo = sampleRepo()
    const dir = join(home, '.local', 'bin')
    const line = (): string | undefined => testpace(repo, ['status'], env).out.split('\n').find(l => l.startsWith('固定命令入口'))
    // 只放过旧版本的 testpace 入口的机器
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'testpace'), '#!/bin/sh\n# testpace 固定入口：旧版本放的\nexit 2\n', { mode: 0o755 })
    assert.equal(
      line(),
      `固定命令入口（${dir}）：testpace 是旧版本放的，跑 testpace install 更新；` +
        'modwall、testcraft 没放：插件的 bin 目录不在 PATH 上的地方（Codex 的命令、合并门的钩子）找不到。用户同意后跑 testpace install 放上',
    )
    writeFileSync(join(dir, 'testpace'), readFileSync(join(PLUGIN, 'entry', 'command')))
    writeFileSync(join(dir, 'testcraft'), '#!/bin/sh\necho 别的工具\n')
    assert.equal(
      line(),
      `固定命令入口（${dir}）：testpace 已放好；` +
        'modwall 没放：插件的 bin 目录不在 PATH 上的地方（Codex 的命令、合并门的钩子）找不到。用户同意后跑 testpace install 放上；' +
        'testcraft 那里是别的文件，没有放',
    )
  })

  test('会话开始时：旧版本放的入口换成这一版的；没放过的不放（只放过 testpace 的机器上，modwall、testcraft 也不放）；同名的别的文件不动', () => {
    const home = tempDir('testpace-home-')
    const entry = (command: string): string => join(home, '.local', 'bin', command)
    const current = readFileSync(join(PLUGIN, 'entry', 'command'), 'utf8')
    const old = '#!/bin/sh\n# testpace 固定入口：旧版本放的\nexit 2\n'
    withEnv({ CLAUDE_PLUGIN_DATA: tempDir('testpace-data-'), HOME: home, GIT_CONFIG_GLOBAL: globalGitConfig() }, () => {
      const repo = sampleRepo()
      const start = (session: string): unknown => handle({ hook_event_name: 'SessionStart', session_id: session, cwd: repo }, Date.now(), 'claude')
      start('e1')
      for (const command of ['testpace', 'modwall', 'testcraft'])
        assert.equal(existsSync(entry(command)), false, `${command} 没放过：放是全局安装，要用户同意后跑 testpace install`)

      // 改名之前的版本放的：按旧名字找插件，找不到装着的那份
      mkdirSync(join(home, '.local', 'bin'), { recursive: true })
      writeFileSync(entry('testpace'), old, { mode: 0o755 })
      start('e2')
      assert.equal(readFileSync(entry('testpace'), 'utf8'), current)
      assert.equal(existsSync(entry('modwall')), false, '只有旧的 testpace 入口：另外两条也要用户同意后才放')
      assert.equal(existsSync(entry('testcraft')), false)
      // 会话不在接入了的仓库里也更新：入口是这台机器的，不是哪个仓库的；每条按各自的情况换
      writeFileSync(entry('testpace'), old, { mode: 0o755 })
      writeFileSync(entry('testcraft'), old, { mode: 0o755 })
      handle({ hook_event_name: 'SessionStart', session_id: 'e3', cwd: home }, Date.now(), 'claude')
      assert.equal(readFileSync(entry('testpace'), 'utf8'), current)
      assert.equal(readFileSync(entry('testcraft'), 'utf8'), current)
      assert.equal(existsSync(entry('modwall')), false)

      writeFileSync(entry('testpace'), '#!/bin/sh\necho 别的工具\n')
      start('e4')
      assert.equal(readFileSync(entry('testpace'), 'utf8'), '#!/bin/sh\necho 别的工具\n')

      // 写不进去（只读）：入口还是旧的，会话说明照常给
      rmSync(entry('testpace'))
      writeFileSync(entry('testpace'), old, { mode: 0o555 })
      const told = start('e5') as Output
      assert.match(String(told?.hookSpecificOutput?.additionalContext), /用 testpace 管测试节奏/)
      assert.match(readFileSync(entry('testpace'), 'utf8'), /旧版本放的/)
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
