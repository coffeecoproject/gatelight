// "代码规范"说给 agent 的话，经底座的钩子送出去（base/module.ts 的 brief）：会话开始时说几句规范的约定。
// 没有改文件前的拦截和停止门：lint 自己会报，规范检查在落地前的整组里跑（见 full.ts）。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo } from '../base/repo.ts'
import { CONFIG_PATH, KEEP_DIR } from './config.ts'

export function guide(label = '这个仓库'): string[] {
  return [
    `${label}用 codekeep 管代码规范（${KEEP_DIR}/）：`,
    `1. 类型检查、lint、格式检查由 codekeep 在整组（testpace full）里跑，命令和要比的配置写在 ${CONFIG_PATH}。`,
    '2. 不改松规范：不关规则、不把 error 降成 warn、不调高长度和复杂度上限、不加忽略的路径、不关严格类型选项、不往批量豁免文件里加条目。确实要改，整组会要用户确认：先在对话里用白话讲清改了哪条、为什么只能这样。',
    '3. 代码里"这里不查"的注释（eslint-disable、@ts-expect-error 这类）必须写理由，比如 // eslint-disable-next-line 规则名 -- 理由；能改代码就改代码，不加这种注释。',
    '4. 提交里不放密钥、密码；测试用的假值写得一眼能看出是假的（比如 test-password-not-real）。',
  ]
}

/** 会话说明：接入了"代码规范"的仓库（工作区里有 .codekeep/）才说。 */
export function brief(label: string, repo?: Repo): string[] {
  return repo && existsSync(join(repo.root, KEEP_DIR)) ? guide(label) : []
}
