// testcraft 命令行入口：checklist、status（实现在 craft/commands.ts）。
// 这个文件的路径不能变：bin/testcraft 和整组里"测试写法"的那一段按它找。

import './modules.ts'
import { main } from './craft/commands.ts'

process.exitCode = main(process.argv.slice(2))
