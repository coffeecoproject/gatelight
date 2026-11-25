// codekeep 命令行入口：check（实现在 keep/commands.ts）。
// 这个文件的路径不能变：bin/codekeep 和整组里"代码规范"的那一段按它找。

import './modules.ts'
import { runCommandLine } from './base/commandline.ts'
import { main, outside } from './keep/commands.ts'

process.exitCode = await runCommandLine({ name: 'codekeep', outside, run: main }, process.argv.slice(2))
