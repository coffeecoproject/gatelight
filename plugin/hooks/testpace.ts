// agent hook 入口：node testpace.ts <agent>，agent 是 claude、codex 或 dsh，说明 hook 来自哪个 agent（各 agent 的 hook 配置里写明）。
// 从标准输入读事件，交给 src/base/hook.ts 判断，把结果写到标准输出。
// 出错时退出码 0、不挡 agent，但要让人看得到：输出一句 systemMessage。合并门自己把判断出错当作不放行。

import '../src/modules.ts'
import { isAgentKind } from '../src/base/agent.ts'
import { handle } from '../src/base/hook.ts'

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
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`)
}
