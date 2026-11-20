// testcraft 命令行入口：prove、weaken、checklist、review、check、status（实现在 craft/commands.ts）。
// 这个文件的路径不能变：bin/testcraft 和整组里"测试写法"的那一段按它找。

import './modules.ts'
import { EXIT } from './base/exit.ts'
import { main } from './craft/commands.ts'
import { CopyRefused } from './craft/copy.ts'

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  // 副本建不了（工作区被占着、有指向别的工作目录的链接）：说明原因，算环境问题
  if (!(error instanceof CopyRefused)) throw error
  console.error(error.message)
  process.exitCode = EXIT.usage
}
