// "测试写法"这个模块交给底座的入口（见 base/module.ts）：底座只通过这里知道它。
// 它在项目里的配置是 .testcraft/ 目录，没有这个目录的仓库里它不出声、不加检查。

import type { Module } from '../base/module.ts'
import { fullPart } from './full.ts'
import { unfinished } from './records.ts'
import { brief } from './session.ts'

export const craft: Module = {
  name: 'craft',
  brief,
  fullPart,
  unfinished,
}
