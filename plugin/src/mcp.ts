// 确认工具的 MCP 服务：只有一个工具 confirm_with_user，把检查要用户同意的改动给用户确认。
// 工具标了 anthropic/requiresUserInteraction：Claude Code 每次都弹窗，任何权限模式、允许规则都跳不过，
// 用户在弹窗里看到 text 的原文（检查写好的白话），同意了工具才会执行、记下确认。用标准输入输出收发一行一条的 JSON-RPC。
// 这个进程跟着会话开着，插件更新了也不换代码，所以工具只认检查存下的编号和文字（见 base/confirm.ts），不引用任何模块、不做判断。

import { createInterface } from 'node:readline'
import { confirm, CONFIRM_TOOL } from './base/confirm.ts'
import { PLUGIN_NAME, VERSION } from './base/version.ts'

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

interface Request {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

function reply(id: Request['id'], body: { result: unknown } | { error: { code: number; message: string } }): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`)
}

function handle(request: Request): void {
  // 通知（没有 id）不用回
  if (request.id === undefined) return
  const params = request.params ?? {}
  switch (request.method) {
    case 'initialize':
      return reply(request.id, {
        result: {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: PLUGIN_NAME, version: VERSION },
        },
      })
    case 'ping':
      return reply(request.id, { result: {} })
    case 'tools/list':
      return reply(request.id, { result: { tools: [TOOL] } })
    case 'tools/call': {
      const args = (params.arguments ?? {}) as Record<string, unknown>
      if (params.name !== TOOL.name) return reply(request.id, { error: { code: -32602, message: `没有这个工具：${String(params.name)}` } })
      if (typeof args.repo !== 'string' || typeof args.id !== 'string' || typeof args.text !== 'string') {
        return reply(request.id, { result: { content: [{ type: 'text', text: 'repo、id、text 都要填文字' }], isError: true } })
      }
      const confirmed = confirm(args.repo, args.id, args.text)
      return reply(request.id, { result: { content: [{ type: 'text', text: confirmed.text }], isError: !confirmed.ok } })
    }
    default:
      return reply(request.id, { error: { code: -32601, message: `不支持 ${request.method}` } })
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return
  let request: Request
  try {
    request = JSON.parse(line) as Request
  } catch {
    return reply(undefined, { error: { code: -32700, message: '不是合法的 JSON' } })
  }
  handle(request)
})
