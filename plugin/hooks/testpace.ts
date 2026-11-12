// Claude Code hook 入口：从标准输入读事件，交给 src/hook.ts 判断，把结果写到标准输出。
// 出错时什么都不输出、退出码 0：插件出问题不挡 agent。合并门自己把判断出错当作不放行。

import { handle } from '../src/hook.ts'

try {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  const output = handle(JSON.parse(text), Date.now())
  if (output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`)
} catch (error) {
  process.stderr.write(`testpace hook: ${(error as Error).message}\n`)
}
