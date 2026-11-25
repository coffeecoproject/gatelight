// tsconfig 生效的选项：用项目自己装的 typescript 跑 tsc --showConfig（extends 合并好、strict 展开好），分叉点那一版和现在比。
// 算放松的：严格类的选项从开变成关，开了 skipLibCheck，include 少了、exclude 多了。别的选项不比。

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { ConfirmItem } from '../base/confirm.ts'
import { stable } from './eslint.ts'

/** 严格类的选项和它查的是什么（白话）。strict 开着时没写的前几项跟着开。 */
const STRICT: Record<string, string> = {
  strict: '严格类型检查的总开关',
  noImplicitAny: '推断不出类型的地方不许悄悄当成 any',
  strictNullChecks: '可能是空值（null、undefined）的地方要先判断',
  strictFunctionTypes: '函数参数的类型要对得上',
  strictBindCallApply: 'bind、call、apply 的参数要对得上',
  strictPropertyInitialization: '类的属性要在构造时赋值',
  strictBuiltinIteratorReturn: '内置迭代器的返回值按严格的类型算',
  noImplicitThis: 'this 的类型要明确',
  alwaysStrict: '按 JavaScript 严格模式解析',
  useUnknownInCatchVariables: 'catch 到的错误当成 unknown，用之前要先判断',
  noUncheckedIndexedAccess: '按下标、键取值可能取不到，要先判断',
  noImplicitReturns: '函数的每个分支都要 return',
  noFallthroughCasesInSwitch: 'switch 的分支不许漏写 break',
  noUnusedLocals: '不许有没用的变量',
  noUnusedParameters: '不许有没用的参数',
  noImplicitOverride: '覆盖父类的方法要写 override',
  exactOptionalPropertyTypes: '可选属性不许随手赋 undefined',
}
/** strict 开着时跟着开的（没单独写时）。 */
const STRICT_FAMILY = [
  'noImplicitAny',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'strictBuiltinIteratorReturn',
  'noImplicitThis',
  'alwaysStrict',
  'useUnknownInCatchVariables',
]

/** 拿来比的那几样。 */
export interface TsSettings {
  /** 开着的严格类选项。 */
  strict: string[]
  skipLibCheck: boolean
  include: string[]
  exclude: string[]
}

/**
 * 项目自己装的 tsc：从工作区里这个 tsconfig 所在的目录往上找 typescript，按它 package.json 的 bin 找到 tsc。
 * 不直接找 typescript/bin/tsc：TypeScript 7 的 package.json 写了 exports，没导出 bin/ 下的文件。找不到时抛错。
 */
export function findTsc(root: string, tsconfig: string): string {
  let manifest: string
  try {
    manifest = createRequire(join(root, dirname(tsconfig), 'noop.js')).resolve('typescript/package.json')
  } catch {
    throw new Error('项目里没装 typescript（从 tsconfig 所在的目录往上找不到），先装好依赖')
  }
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> }
  const tsc = typeof bin === 'string' ? bin : bin?.tsc
  if (!tsc) throw new Error(`${manifest} 里没写 tsc 命令（bin）`)
  return join(dirname(manifest), tsc)
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

/** 在 tree（仓库或分叉点的临时 worktree）里算一个 tsconfig 生效的选项。算不出来时抛错。 */
export function tsSettings(tsc: string, tree: string, tsconfig: string): TsSettings {
  let out: string
  try {
    out = execFileSync(process.execPath, [tsc, '--showConfig', '-p', join(tree, tsconfig)], { cwd: tree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 256 * 1024 * 1024 })
  } catch (error) {
    const output = `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}`.trim()
    throw new Error(`tsc --showConfig 没跑成：${output.split('\n')[0] || (error as Error).message}`)
  }
  const shown = JSON.parse(out) as { compilerOptions?: Record<string, unknown>; include?: unknown; exclude?: unknown }
  const options = shown.compilerOptions ?? {}
  const on = (name: string): boolean => {
    const value = options[name]
    if (typeof value === 'boolean') return value
    return STRICT_FAMILY.includes(name) && options.strict === true
  }
  return {
    strict: Object.keys(STRICT).filter(on),
    skipLibCheck: options.skipLibCheck === true,
    include: strings(shown.include),
    exclude: strings(shown.exclude),
  }
}

/** 一个 tsconfig 的放松合成一项，一行一处。 */
export function tsconfigItem(tsconfig: string, before: TsSettings, now: TsSettings): ConfirmItem | undefined {
  const lines: string[] = []
  const off = before.strict.filter(name => !now.strict.includes(name))
  // 关掉 strict 时跟着关掉的几项并成一行说
  const along = off.includes('strict') ? off.filter(name => STRICT_FAMILY.includes(name)) : []
  if (off.includes('strict')) lines.push(`关掉了 strict（${STRICT.strict}）${along.length ? `，跟着关掉了 ${along.join('、')}` : ''}：以后这些类型问题都不再报`)
  for (const name of off.filter(name => name !== 'strict' && !along.includes(name))) lines.push(`关掉了 ${name}（${STRICT[name]}）：以后这类问题类型检查不再报`)
  if (now.skipLibCheck && !before.skipLibCheck) lines.push('开了 skipLibCheck：以后不检查依赖库和 .d.ts 文件里的类型声明')
  const dropped = before.include.filter(rule => !now.include.includes(rule))
  if (dropped.length) lines.push(`include 去掉了 ${dropped.map(rule => `"${rule}"`).join('、')}：这些文件可能不再做类型检查`)
  const excluded = now.exclude.filter(rule => !before.exclude.includes(rule))
  if (excluded.length) lines.push(`exclude 新加了 ${excluded.map(rule => `"${rule}"`).join('、')}：这些文件可能不再做类型检查`)
  if (lines.length === 0) return undefined
  return {
    before: stable(['tsconfig', tsconfig, before]),
    after: stable(['tsconfig', tsconfig, now]),
    text: [`类型检查的配置 ${tsconfig} 改松了：`, ...lines].join('\n'),
  }
}
