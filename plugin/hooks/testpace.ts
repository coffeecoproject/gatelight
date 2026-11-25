// agent hook 入口：node testpace.ts <agent>，agent 是 claude、codex、antigravity 或 dsh，说明 hook 来自哪个 agent（各 agent 的 hook 配置里写明）。
// 从标准输入读事件，交给 src/base/hook.ts 判断，把结果写到标准输出。
// 出错时退出码 0、不挡 agent，但要让人看得到：按这个 agent 的格式输出一句（hookformat.ts 的 failure）。合并门自己把判断出错当作不放行。

import '../src/modules.ts'
import { AGENTS, isAgentKind } from '../src/base/agent.ts'
import { handle } from '../src/base/hook.ts'
import { CLAUDE_HOOKS } from '../src/base/hookformat.ts'

const agent = process.argv[2]
try {
  if (!isAgentKind(agent)) throw new Error(`不认识的 agent "${agent}"`)
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  const output = handle(JSON.parse(text), Date.now(), agent)
  if (output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`)
} catch (error) {
  const message = `testpace hook 出错，这次没有检查：${(error as Error).message.split('\n')[0]}`
  process.stderr.write(`${message}\n`)
  // 没说是哪个 agent（hook 配置写错了）时不知道它的格式，按 Claude Code 的说
  const format = isAgentKind(agent) ? AGENTS[agent].hooks : CLAUDE_HOOKS
  // 什么都不能输出的 agent（Antigravity：输出什么都会把工具调用拦掉）只说在标准错误里
  const output = format.failure(message)
  if (output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`)
}
