// 确认工具的 MCP 服务：只有一个工具 confirm_with_user，把检查要用户同意的改动给用户确认。用标准输入输出收发一行一条的 JSON-RPC。
// 三个 agent 怎么保证每次都是用户本人在弹窗里同意（用户看到的都是检查存下的原文，同意了工具才记下）：
// - Claude Code：工具标了 anthropic/requiresUserInteraction，每次都弹窗，任何权限模式、允许规则都跳不过。
// - Antigravity：不认这个标记。它从插件根上的 mcp_config.json 起这个服务，每次调用前由插件的 hook 输出 force_ask 弹窗（hookformat.ts），
//   "总是允许"在那个弹窗里选不了；hook 出错时拒绝这次调用（hooks/antigravity.sh）。
// - Codex：也不认这个标记，hook 也要不了弹窗，工具审批还可能交给自动审查（AI）。它从 .codex-plugin/mcp.json 起这个服务、
//   参数带 codex：服务核对编号和文字后，自己向 Codex 发一张表单（MCP 的 elicitation），表单到用户面前、用户点同意才记下；
//   拒绝、取消（不能交互的 codex exec 直接取消）都不记。不支持表单的客户端不记，说明原因。
// 这个进程跟着会话开着，插件更新了也不换代码，所以工具只认检查存下的编号和文字（见 base/confirm.ts），不引用任何模块、不做判断。

import { createInterface } from 'node:readline'
import { check, CONFIRM_TOOL, type Confirmed } from './base/confirm.ts'
import { PLUGIN_NAME, VERSION } from './base/version.ts'

/** 服务自己向客户端发表单问用户（Codex）：启动参数里带 codex。 */
const ASK_BY_FORM = process.argv.slice(2).includes('codex')

const TOOL = {
  name: CONFIRM_TOOL,
  description:
    '把检查要求用户同意的改动（放松了测试、放宽了规则这类）给用户确认：弹窗里用户看到每一项，同意后才记下。只在 testpace 的检查要求时调用；repo、id、text 都照检查输出的原样填，text 一字不改。调用前先在对话里用白话向用户讲清每一项原来是什么样、现在是什么样、为什么。',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: '仓库路径，照检查输出的填' },
      id: { type: 'string', description: '编号，照检查输出的填' },
      text: { type: 'string', description: '给用户确认的文字，照检查输出的原样填，一字不改' },
    },
    required: ['repo', 'id', 'text'],
  },
  _meta: { 'anthropic/requiresUserInteraction': true },
}

type Id = number | string

interface Message {
  jsonrpc: '2.0'
  id?: Id
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function reply(id: Message['id'], body: { result: unknown } | { error: { code: number; message: string } }): void {
  send({ id, ...body })
}

/** 客户端在 initialize 里说了支持表单（elicitation 的 form；只写了 elicitation 的按老版本，也是表单）。 */
let formSupported = false

/** 服务发给客户端、还在等回答的请求。 */
const waiting = new Map<Id, (answer: Message) => void>()
let nextAsk = 0

/** 向客户端发表单问用户，返回用户的选择（accept、decline、cancel），客户端出错时是 undefined。 */
function askByForm(message: string): Promise<string | undefined> {
  const id = `${PLUGIN_NAME}-ask-${++nextAsk}`
  return new Promise(resolve => {
    waiting.set(id, answer => resolve(typeof answer.result?.action === 'string' ? answer.result.action : undefined))
    send({ id, method: 'elicitation/create', params: { message, requestedSchema: { type: 'object', properties: {} } } })
  })
}

const text = (body: string, isError: boolean) => ({ result: { content: [{ type: 'text', text: body }], isError } })

async function callTool(id: Id, args: Record<string, unknown>): Promise<void> {
  if (typeof args.repo !== 'string' || typeof args.id !== 'string' || typeof args.text !== 'string') {
    return reply(id, text('repo、id、text 都要填文字', true))
  }
  const checked = check(args.repo, args.id, args.text)
  if (!checked.ok) return reply(id, text(checked.text, true))
  let done: Confirmed
  if (!ASK_BY_FORM) done = checked.record()
  else if (!formSupported) {
    done = { ok: false, text: '这个客户端不支持向用户弹表单（MCP elicitation），没法让用户本人确认，没有记下。升级客户端，或在 Claude Code 里确认。' }
  } else {
    const action = await askByForm(`${PLUGIN_NAME} 要你确认：\n\n${checked.popup}`)
    done =
      action === 'accept'
        ? checked.record()
        : { ok: false, text: action === 'decline' ? '用户拒绝了，没有记下：照用户的意思改回去或换个做法。' : '用户没有确认（表单取消了或弹不出来，比如不能交互的 codex exec），没有记下。' }
  }
  return reply(id, text(done.text, !done.ok))
}

function handle(message: Message): void {
  // 客户端对服务发出的请求（表单）的回答
  if (message.method === undefined) {
    if (message.id !== undefined) {
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
    }
    return
  }
  // 通知（没有 id）不用回
  if (message.id === undefined) return
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize': {
      const elicitation = (params.capabilities as { elicitation?: { form?: unknown; url?: unknown } } | undefined)?.elicitation
      formSupported = elicitation !== undefined && (elicitation.form !== undefined || elicitation.url === undefined)
      return reply(message.id, {
        result: {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: PLUGIN_NAME, version: VERSION },
        },
      })
    }
    case 'ping':
      return reply(message.id, { result: {} })
    case 'tools/list':
      return reply(message.id, { result: { tools: [TOOL] } })
    case 'tools/call': {
      if (params.name !== TOOL.name) return reply(message.id, { error: { code: -32602, message: `没有这个工具：${String(params.name)}` } })
      void callTool(message.id, (params.arguments ?? {}) as Record<string, unknown>)
      return
    }
    default:
      return reply(message.id, { error: { code: -32601, message: `不支持 ${message.method}` } })
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return
  let message: Message
  try {
    message = JSON.parse(line) as Message
  } catch {
    return reply(undefined, { error: { code: -32700, message: '不是合法的 JSON' } })
  }
  handle(message)
})
