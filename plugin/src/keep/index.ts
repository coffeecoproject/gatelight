// "代码规范"这个检查模块交给底座的入口（见 base/module.ts）：底座只通过这里知道它。
// 它在项目里的配置是 .codekeep/ 目录，没有这个目录的仓库里它不出声、不加检查。
// 第一期只有会话说明和整组里的一段：不在改文件时拦（lint 自己会报），不加停止门（整组兜底）。

import type { Module } from '../base/module.ts'
import { fullPart } from './full.ts'
import { brief } from './session.ts'

export const keep: Module = {
  name: 'keep',
  brief,
  fullPart,
}
