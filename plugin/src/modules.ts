// 装配：把这个插件里的检查模块登记给底座。命令行入口（cli.ts）、钩子入口（hooks/testpace.ts）和测试都先引用这个文件。
// 底座（base/）不引用模块，模块之间也不互相引用；知道有哪些模块的只有这里。

import { registerModules } from './base/module.ts'
import { pace } from './pace/index.ts'

registerModules([pace])
