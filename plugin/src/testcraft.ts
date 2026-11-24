// testcraft 命令行入口：checklist、status（实现在 craft/commands.ts）。
// 这个文件的路径不能变：bin/testcraft 和整组里"测试写法"的那一段按它找。

import './modules.ts'
import { runCommandLine } from './base/commandline.ts'
import { main } from './craft/commands.ts'

// 没有在 agent 的沙箱里跑不了的子命令：只读项目里的文件和 git，不写记录、不用 LayerMap
process.exitCode = await runCommandLine({ name: 'testcraft', run: main }, process.argv.slice(2))
