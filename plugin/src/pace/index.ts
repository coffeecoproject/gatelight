// "跑测试"这个检查模块交给底座的入口（见 base/module.ts）：底座只通过这里知道它。

import type { Module } from '../base/module.ts'
import { contractProblems, FIELDS } from './config.ts'
import { fullPart } from './full.ts'
import { alerts, fullCommandHint, rhythm } from './session.ts'

export const pace: Module = {
  name: 'pace',
  fields: FIELDS,
  contractProblems,
  brief: rhythm,
  alerts,
  beforeCommand: fullCommandHint,
  fullPart,
}
