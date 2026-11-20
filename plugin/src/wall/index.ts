// "模块边界"这个检查模块交给底座的入口（见 base/module.ts）：底座只通过这里知道它。
// 它在项目里的配置是 .modwall/ 目录，没有这个目录的仓库里它不出声、不加检查。

import type { Module } from '../base/module.ts'
import { fullPart } from './full.ts'
import { beforeEdit, brief, onSession, unfinished } from './session.ts'

export const wall: Module = {
  name: 'wall',
  brief,
  onSession,
  beforeEdit,
  unfinished,
  fullPart,
}
