// modwall 命令行入口：init、check、db check、status（实现在 wall/commands.ts）。
// 这个文件的路径不能变：bin/modwall 和整组里"模块边界"的那一段按它找。

import './modules.ts'
import { runCommandLine } from './base/commandline.ts'
import { main, outside } from './wall/commands.ts'

process.exitCode = await runCommandLine({ name: 'modwall', outside, run: main }, process.argv.slice(2))
