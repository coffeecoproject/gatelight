// Antigravity（桌面 App）：hook 的读写（判断在本进程里跑）、真的入口脚本 hooks/antigravity.sh、用户确认（调确认工具时弹窗）、
// 确认工具的服务按 mcp_config.json 起得来、合并门认它的命令。固定命令入口找 Antigravity 装的插件在 agents.test.ts。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { handle } from '../src/base/hook.ts'
import { commit, ENV, fakeLayermap, gatedRepo, globalGitConfig, sampleRepo, sh, tempDir, testpace, withEnv } from './helpers.ts'
import { sampleRepo as wallRepo } from './wall/helpers.ts'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url))

type Step = { systemMessage: { systemMessage: string; metadata?: { user_markdown?: string } } }
type AgyOutput = { decision?: string; reason?: string; injectSteps?: Step[] } | undefined

/** 在本进程里跑一次 Antigravity 的 hook 判断。 */
const agy = (input: Record<string, unknown>): AgyOutput => handle(input, Date.now(), 'antigravity') as AgyOutput

const start = (cwd: string | undefined, session: string): Record<string, unknown> => ({ hookEventName: 'SessionStart', conversationId: session, ...(cwd === undefined ? {} : { cwd }) })
const command = (cwd: string | undefined, line: string, session: string): Record<string, unknown> => ({
  hookEventName: 'PreToolUse',
  conversationId: session,
  ...(cwd === undefined ? {} : { cwd }),
  toolCall: { name: 'run_command', args: { CommandLine: line } },
})
const stop = (cwd: string, session: string, terminationReason = 'NO_TOOL_CALL'): Record<string, unknown> => ({ hookEventName: 'Stop', conversationId: session, cwd, terminationReason })
/** 调某个 MCP 服务的工具（Antigravity 里都经 call_mcp_tool）。 */
const mcpCall = (server: string, args: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  hookEventName: 'PreToolUse',
  conversationId: 'cf',
  toolCall: { name: 'call_mcp_tool', args: { ServerName: server, ToolName: 'confirm_with_user', Arguments: args } },
  ...extra,
})

/** 会话开始给模型的说明（injectSteps 第一步）。 */
const brief = (output: AgyOutput): string => String(output?.injectSteps?.[0]?.systemMessage.systemMessage)

/** 经真的入口脚本跑一次：和 hooks.json 一样在插件目录里跑 sh ./hooks/antigravity.sh。 */
function viaScript(input: unknown, env: NodeJS.ProcessEnv = ENV, dir = PLUGIN): { code: number | null; out: string; err: string } {
  const r = spawnSync('sh', ['./hooks/antigravity.sh'], { cwd: dir, input: typeof input === 'string' ? input : JSON.stringify(input), env, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

/** 一个假的 node：过得了 bin/node.sh 的版本检查（node -e ...），真跑脚本时照 body 做。用 TESTPACE_NODE 指给它。 */
function fakeNode(body: string): NodeJS.ProcessEnv {
  const file = join(tempDir('testpace-fake-node-'), 'node')
  writeFileSync(file, `#!/bin/sh\ncase "$1" in -e) exit 0 ;; esac\n${body}\n`, { mode: 0o755 })
  return { ...ENV, TESTPACE_NODE: file }
}

/** 找不到 node 的插件目录：入口脚本原样复制，bin/node.sh 换成什么都找不到的。 */
function withoutNode(): string {
  const dir = tempDir('testpace-agy-plugin-')
  mkdirSync(join(dir, 'hooks'))
  mkdirSync(join(dir, 'bin'))
  copyFileSync(join(PLUGIN, 'hooks', 'antigravity.sh'), join(dir, 'hooks', 'antigravity.sh'))
  writeFileSync(join(dir, 'bin', 'node.sh'), 'testpace_node() { return 1; }\n')
  return dir
}

/** 要用户确认的原文（检查写好的，多行）和 Antigravity 弹窗里的样子（压成一段）。 */
const CONFIRM_TEXT = '这次改动里放宽规则的地方，要你确认的有 2 项：\n\n1. 第一项\n   第二行说明\n\n2. 第二项\n\n同意：按这样改。'
const ONE_PARAGRAPH = '这次改动里放宽规则的地方，要你确认的有 2 项： 1. 第一项 第二行说明 2. 第二项 同意：按这样改。'
const HOOK_BROKE = /^gatelight 的 hook 出错了，这次确认没能弹窗给用户看，所以没有执行。/

describe('Antigravity 的 hook', () => {
  test('不干预时标准输出什么都不写、退出码 0：普通命令、不管的工具、命令执行完、用户取消的结束；输入坏了也一样，错误只写到标准错误', () => {
    const repo = sampleRepo()
    assert.equal(viaScript(start(repo, 'q1')).code, 0)
    for (const input of [
      command(repo, 'ls', 'q1'),
      { hookEventName: 'PreToolUse', conversationId: 'q1', cwd: repo, toolCall: { name: 'read_file', args: { Path: join(repo, 'package.json') } } },
      { hookEventName: 'PostToolUse', conversationId: 'q1', cwd: repo, toolCall: { name: 'run_command', args: { CommandLine: 'testpace full' } } },
      stop(repo, 'q1', 'USER_CANCELED'),
      stop(repo, 'q1'),
    ]) {
      assert.deepEqual(viaScript(input), { code: 0, out: '', err: '' }, JSON.stringify(input))
    }
    const broken = viaScript('{')
    assert.equal(broken.code, 0)
    assert.equal(broken.out, '', '输出 {} 也会把工具调用拦掉')
    assert.match(broken.err, /^testpace hook 出错，这次没有检查：/)
  })

  test('入口脚本出错（node 退出码非 0、找不到 node）时只写标准错误：退出码 0，标准输出为空', () => {
    const repo = sampleRepo()
    // 换成真的 node 时这条命令会被拒（直接跑 full），出错时不能变成拦下
    const full = command(repo, 'node scripts/full.mjs', 'e1')
    const crashed = viaScript(full, fakeNode('echo 假的 node 出错 >&2\nexit 3'))
    assert.equal(crashed.code, 0)
    assert.equal(crashed.out, '')
    assert.match(crashed.err, /testpace hook 异常退出（3），这次没有检查。/)
    const noNode = viaScript(full, ENV, withoutNode())
    assert.equal(noNode.code, 0)
    assert.equal(noNode.out, '')
    assert.match(noNode.err, /^testpace hook 没有运行：找不到 22\.18 以上的 node/)
  })

  test('拦改文件输出 decision deny 和原因（write_file、edit_file 都拦）', () => {
    const repo = wallRepo()
    const edit = (name: string, args: Record<string, unknown>): AgyOutput =>
      agy({ hookEventName: 'PreToolUse', conversationId: 'w1', cwd: repo, toolCall: { name, args } })
    const written = edit('write_file', { Path: join(repo, 'src', 'new.ts'), Content: 'export const a = 1\n' })
    assert.deepEqual(Object.keys(written ?? {}), ['decision', 'reason'])
    assert.equal(written?.decision, 'deny')
    assert.match(String(written?.reason), /^modwall（R5 文件没有归属）：src\/new\.ts 没有归属。/)
    assert.equal(edit('edit_file', { Path: join(repo, 'src', 'new.ts'), Replacement: 'export const a = 2\n' })?.decision, 'deny')
    assert.equal(edit('write_file', { Path: join(repo, 'README.md'), Content: '说明\n' }), undefined, '不拦的什么都不输出')
  })

  test('直接跑配置里的 full：第一次拒绝并说明改用 testpace full，同一会话里同一条命令第二次放行；换个会话再拦一次', () => {
    const repo = sampleRepo()
    agy(start(repo, 'f1'))
    assert.equal(agy(command(repo, 'ls', 'f1')), undefined)
    const first = agy(command(repo, 'node scripts/full.mjs', 'f1'))
    assert.deepEqual(Object.keys(first ?? {}), ['decision', 'reason'])
    assert.equal(first?.decision, 'deny')
    assert.match(String(first?.reason), /^这是 testpace.json 里 full 的检查[\s\S]*改用 testpace full/)
    assert.match(String(first?.reason), /（这条命令被 gatelight 拦了一次，只为了把上面的话交给你；看过后照它做，要跑的话再跑一次，同样的话不会再拦。）$/)
    assert.equal(agy(command(repo, 'node scripts/full.mjs', 'f1')), undefined, '同一会话第二次放行')
    agy(start(repo, 'f2'))
    assert.equal(agy(command(repo, 'node scripts/full.mjs', 'f2'))?.decision, 'deny', '拦过的按会话记')
  })

  test('会话不在接入的仓库里开始时，第一条碰到那个仓库的命令被拒一次来补说节奏，之后不再拦', () => {
    const repo = sampleRepo()
    const root = sh(repo, 'git rev-parse --show-toplevel').trim()
    const parent = tempDir('testpace-parent-')
    assert.equal(agy(start(parent, 'p1')), undefined)
    const told = agy(command(parent, `cd ${repo} && git status`, 'p1'))
    assert.equal(told?.decision, 'deny')
    assert.match(String(told?.reason), /用 testpace 管测试节奏[\s\S]*（这条命令被 gatelight 拦了一次/)
    assert.ok(String(told?.reason).includes(`${root} 这个仓库`), told?.reason)
    assert.equal(agy(command(parent, `cd ${repo} && git status`, 'p1')), undefined)
  })

  test('停止门不让结束时输出 decision continue 和原因；用户取消、出错的结束不管', () => {
    const repo = sampleRepo()
    agy(start(repo, 'st'))
    // Antigravity 的命令带着 ANTIGRAVITY_AGENT 和会话号：这个会话起的整组
    assert.equal(testpace(repo, ['full'], { ...ENV, ANTIGRAVITY_AGENT: '1', ANTIGRAVITY_CONVERSATION_ID: 'st' }).code, 0)
    assert.equal(agy(stop(repo, 'st', 'USER_CANCELED')), undefined)
    assert.equal(agy(stop(repo, 'st', 'ERROR')), undefined)
    const blocked = agy(stop(repo, 'st'))
    assert.deepEqual(Object.keys(blocked ?? {}), ['decision', 'reason'])
    assert.equal(blocked?.decision, 'continue')
    assert.match(String(blocked?.reason), /^这个会话跑的整组已经结束（通过），还没看结果。先跑 testpace status/)
  })

  test('提交了还没合：停止门只拦 agent（decision continue 和原因），没有给用户的那一行；技能写成"gatelight 的 merge"', () => {
    const repo = sampleRepo()
    sh(repo, 'git checkout -qb feat')
    agy(start(repo, 'un'))
    const text = `${sh(repo, 'cat src/price.mjs')}// 改过\n`
    agy({ hookEventName: 'PreToolUse', conversationId: 'un', cwd: repo, toolCall: { name: 'write_file', args: { Path: join(repo, 'src', 'price.mjs'), Content: text } } })
    writeFileSync(join(repo, 'src', 'price.mjs'), text)
    commit(repo, '改价格')
    assert.equal(testpace(repo, ['focused'], fakeLayermap({ files: [], tests: [], unmapped: [], incomplete: [] }).env).code, 0)
    const blocked = agy(stop(repo, 'un'))
    assert.deepEqual(Object.keys(blocked ?? {}), ['decision', 'reason'])
    assert.equal(blocked?.decision, 'continue')
    assert.match(String(blocked?.reason), /^这个会话提交了。分支 feat 攒了 1 个提交没合进 main（从 \d{4}-\d{2}-\d{2} 起，改了 1 个文件）：改价格。/)
    assert.match(String(blocked?.reason), /照 gatelight 的 merge 合/)
    assert.equal(agy(stop(repo, 'un')), undefined, '同一个提交只拦一次')
  })

  test('会话开始：给模型的说明放在 injectSteps 的 systemMessage 里；给用户的话放在另一步的 metadata.user_markdown 里，模型那边是空的', () => {
    withEnv({ GIT_CONFIG_GLOBAL: globalGitConfig() }, () => {
      const repo = sampleRepo()
      const first = agy(start(repo, 's1'))
      assert.equal(first?.injectSteps?.length, 2, JSON.stringify(first))
      assert.match(first!.injectSteps![0]!.systemMessage.systemMessage, /用 testpace 管测试节奏/)
      assert.equal(first!.injectSteps![0]!.systemMessage.metadata, undefined)
      assert.equal(first!.injectSteps![1]!.systemMessage.systemMessage, '')
      assert.match(String(first!.injectSteps![1]!.systemMessage.metadata?.user_markdown), /^testpace：在全局 git 配置里配上了合并门/)
      // 合并门配好了：没有给用户的话，只有一步
      const second = agy(start(repo, 's2'))
      assert.deepEqual(Object.keys(second ?? {}), ['injectSteps'])
      assert.equal(second?.injectSteps?.length, 1)
      assert.match(brief(second), /用 testpace 管测试节奏/)
    })
  })

  test('输入里没有 cwd、cwd 是空的，或不在接入的仓库里：不干预（不拿 hook 进程所在的插件目录顶替）', () => {
    const repo = sampleRepo()
    const outside = tempDir('testpace-none-')
    // hook 进程的目录是插件目录，它所在的 gatelight 仓库本身接入了 testpace
    for (const input of [start(undefined, 'n1'), command(undefined, 'node scripts/full.mjs', 'n1'), { ...command(repo, 'node scripts/full.mjs', 'n1'), cwd: '' }, { ...stop(repo, 'n1'), cwd: undefined }]) {
      assert.deepEqual(viaScript(input), { code: 0, out: '', err: '' }, JSON.stringify(input))
    }
    assert.equal(agy(start(outside, 'n2')), undefined)
    assert.equal(agy(command(outside, 'node scripts/full.mjs', 'n2')), undefined)
    assert.equal(agy({ hookEventName: 'PreToolUse', conversationId: 'n2', cwd: outside, toolCall: { name: 'write_file', args: { Path: join(outside, 'a.ts'), Content: '' } } }), undefined)
  })

  test('说给 Antigravity 模型的话里技能写成"gatelight 的 merge 技能"；Claude Code、Codex 的照原样写 gatelight:merge', () => {
    const repo = sampleRepo()
    const context = brief(agy(start(repo, 'k1')))
    assert.match(context, /照 gatelight 的 merge 技能合这个分支/)
    assert.doesNotMatch(context, /gatelight:[a-z]/)
    for (const agent of ['claude', 'codex'] as const) {
      const output = handle({ hook_event_name: 'SessionStart', session_id: `k-${agent}`, cwd: repo }, Date.now(), agent) as { hookSpecificOutput?: { additionalContext?: string } }
      assert.match(String(output?.hookSpecificOutput?.additionalContext), /照 gatelight:merge 技能合这个分支/, agent)
    }
    // 新仓库还没接入时提出接入的话也换
    const fresh = tempDir('testpace-fresh-')
    sh(fresh, 'git init -q -b main')
    assert.match(brief(agy(start(fresh, 'k2'))), /照 gatelight 的 setup 技能配好 testpace\.json/)
  })

  test('会话碰过的仓库记在 Antigravity 给的插件数据目录 PLUGIN_DATA 里（没有 CLAUDE_PLUGIN_DATA 时）', () => {
    const data = tempDir('testpace-agy-data-')
    withEnv({ CLAUDE_PLUGIN_DATA: undefined, PLUGIN_DATA: data }, () => {
      const repo = sampleRepo()
      const root = sh(repo, 'git rev-parse --show-toplevel').trim()
      agy(start(repo, 'd1'))
      const file = join(data, 'sessions', 'd1.json')
      assert.ok(existsSync(file), '记在 PLUGIN_DATA 下的 sessions/')
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).repos, [root])
    })
  })

  test('hooks.json 把会话开始、结束，和跑命令、写文件、改文件、调 MCP 工具之前都交给 antigravity.sh（在插件目录里跑）', () => {
    const { gatelight } = JSON.parse(readFileSync(join(PLUGIN, 'hooks.json'), 'utf8')) as {
      gatelight: Record<string, Array<{ matcher?: string; type?: string; command?: string; hooks?: Array<{ command: string }> }>>
    }
    const registered = Object.fromEntries(Object.entries(gatelight).map(([event, entries]) => [event, entries.map(entry => entry.matcher ?? '')]))
    assert.deepEqual(registered, { SessionStart: [''], PreToolUse: ['run_command', 'write_file', 'edit_file', 'call_mcp_tool'], Stop: [''] })
    for (const entries of Object.values(gatelight)) {
      for (const entry of entries) assert.equal(entry.command ?? entry.hooks?.[0]?.command, 'sh ./hooks/antigravity.sh')
    }
  })

  test('合并门也拦 Antigravity 的 git 命令（带着 ANTIGRAVITY_AGENT）', () => {
    const repo = gatedRepo()
    writeFileSync(join(repo, 'src', 'price.mjs'), `${readFileSync(join(repo, 'src', 'price.mjs'), 'utf8')}// 改过\n`)
    const r = spawnSync('/bin/sh', ['-c', 'git commit -qam m'], { cwd: repo, env: { ...ENV, ANTIGRAVITY_AGENT: '1', PATH: `${join(PLUGIN, 'bin')}:${ENV.PATH}` }, encoding: 'utf8' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /testpace 合并门：这次要把 main 更新到/)
  })
})

describe('Antigravity 里的用户确认', () => {
  test('调 gatelight_gatelight 的工具时弹窗问用户（force_ask），原文是 text、换行压成一段；没有 cwd、Arguments 是 JSON 文字时也一样', () => {
    const repo = sampleRepo()
    const expected = { decision: 'force_ask', reason: ONE_PARAGRAPH }
    const args = { repo, id: 'x', text: CONFIRM_TEXT }
    assert.deepEqual(agy(mcpCall('gatelight_gatelight', args, { cwd: repo })), expected)
    assert.deepEqual(agy(mcpCall('gatelight_gatelight', args)), expected, '没有 cwd 也要弹，不能当成不归 hook 管')
    assert.deepEqual(agy(mcpCall('gatelight_gatelight', JSON.stringify(args), { cwd: repo })), expected)
    // 真的入口脚本：照样输出
    const r = viaScript(mcpCall('gatelight_gatelight', args))
    assert.equal(r.code, 0)
    assert.deepEqual(JSON.parse(r.out), expected)
  })

  test('text 没填、全是空白（或 Arguments 读不出来）时拒绝，不弹空窗', () => {
    const repo = sampleRepo()
    for (const args of [{ repo, id: 'x' }, { repo, id: 'x', text: ' \n\t\n' }, { repo, id: 'x', text: 3 }, '{不是 JSON']) {
      const output = agy(mcpCall('gatelight_gatelight', args, { cwd: repo }))
      assert.deepEqual(output, { decision: 'deny', reason: 'confirm_with_user 的 text 没填：照要求确认的那条检查输出的原样填。' }, JSON.stringify(args))
    }
  })

  test('别的 MCP 服务不管；用户的话、命令里出现 "ServerName":"gatelight_gatelight" 字样不算确认调用（node 出错时也不拒）', () => {
    const repo = sampleRepo()
    const said = { lastUserInput: '说到 "ServerName":"gatelight_gatelight" 的话' }
    const layermap = mcpCall('layermap_layermap', { path: '.' }, { cwd: repo, ...said })
    assert.equal(agy(layermap), undefined)
    assert.deepEqual(viaScript(layermap), { code: 0, out: '', err: '' })
    const crashing = fakeNode('exit 3')
    const echoed = command(repo, `echo '"ServerName":"gatelight_gatelight"'`, 'u1')
    for (const input of [layermap, echoed]) {
      const r = viaScript(input, crashing)
      assert.equal(r.code, 0)
      assert.equal(r.out, '', JSON.stringify(input))
    }
  })

  test('入口脚本认出是确认调用时出了错一律拒绝（node 出错、找不到 node、没给结论）；别的调用出错照旧什么都不输出', () => {
    const repo = sampleRepo()
    const confirm = mcpCall('gatelight_gatelight', { repo, id: 'x', text: CONFIRM_TEXT }, { cwd: repo })
    const other = command(repo, 'ls', 'b1')
    const cases: Array<[string, NodeJS.ProcessEnv, string]> = [
      ['node 出错', fakeNode('echo 假的 node 出错 >&2\nexit 3'), PLUGIN],
      ['没给结论', fakeNode('exit 0'), PLUGIN],
      ['找不到 node', ENV, withoutNode()],
    ]
    for (const [label, env, dir] of cases) {
      const refused = viaScript(confirm, env, dir)
      assert.equal(refused.code, 0, label)
      const output = JSON.parse(refused.out) as { decision: string; reason: string }
      assert.equal(output.decision, 'deny', label)
      assert.match(output.reason, HOOK_BROKE, label)
      assert.notEqual(refused.err, '', `${label}：出了什么错写在标准错误里`)
      assert.equal(viaScript(other, env, dir).out, '', `${label}：不是确认调用的不输出`)
    }
  })

  test('照 mcp_config.json 的启动命令在插件目录里起得来确认工具的服务：服务名是插件名（agent 看到的是 gatelight_gatelight），工具是 confirm_with_user', () => {
    const { mcpServers } = JSON.parse(readFileSync(join(PLUGIN, 'mcp_config.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> }
    assert.deepEqual(Object.keys(mcpServers), ['gatelight'])
    const { command: program, args } = mcpServers.gatelight!
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]
      .map(line => JSON.stringify(line))
      .join('\n')
    const r = spawnSync(program, args, { cwd: PLUGIN, input: `${input}\n`, env: ENV, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const [initialized, listed] = r.stdout.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(initialized.result.serverInfo.name, 'gatelight')
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ['confirm_with_user'])
  })

  test('Antigravity 的会话说明里有一句怎么调确认工具（call_mcp_tool、ServerName gatelight_gatelight）和怎么申请到沙箱外；Claude Code、Codex 的没有', () => {
    const repo = sampleRepo()
    const context = brief(agy(start(repo, 'c1')))
    assert.ok(
      context.includes('在 Antigravity 里，gatelight 的 confirm_with_user 工具用 call_mcp_tool 调：ServerName 填 gatelight_gatelight，ToolName 填 confirm_with_user，Arguments 填 repo、id、text。'),
      context,
    )
    assert.ok(context.includes('每次在 run_command 里加上 BypassSandbox 申请在沙箱外跑。'), context)
    for (const agent of ['claude', 'codex'] as const) {
      const output = handle({ hook_event_name: 'SessionStart', session_id: `c-${agent}`, cwd: repo }, Date.now(), agent) as { hookSpecificOutput?: { additionalContext?: string } }
      assert.doesNotMatch(String(output?.hookSpecificOutput?.additionalContext), /call_mcp_tool|gatelight_gatelight|Antigravity/, agent)
    }
  })
})
