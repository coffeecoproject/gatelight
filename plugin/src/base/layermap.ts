// 调 LayerMap：只在这里碰它的命令。找命令、跑、读 JSON、出了问题怎么说都在这一处；
// 输出里要哪些事实由用的模块自己读（各模块要的不一样），读不到要的字段就按版本太旧说（tooOld）。
// 不看版本号，按能力判断：没有要的命令、输出不是 JSON 或缺字段，就是版本太旧。版本下限只有这里的一个。
//
// 出问题时的规则只有一条：命令找不到、没跑成、版本太旧，都拿不到事实，用的模块要退回更严的一边
// （选测试退回跑整组，别的检查算没做完），不能当成"没有问题"。所以这里的结果要么是事实，要么是说明了原因的失败，没有空值。
//
// 底座不自己做代码分析：要 LayerMap 新出的事实，向它提需求、等它发版。

import { spawnSync } from 'node:child_process'

export const LAYERMAP_MINIMUM = '0.1.48'

export type LayermapFailure = {
  ok: false
  /** missing：PATH 里没有 layermap 命令；old：版本太旧；failed：它跑了但没跑成。 */
  kind: 'missing' | 'old' | 'failed'
  problem: string
}

export type LayermapAnswer = { ok: true; value: unknown } | LayermapFailure

/** 版本太旧的说法：模块在输出里读不到要的字段时也用它。 */
export function tooOld(): LayermapFailure {
  return {
    ok: false,
    kind: 'old',
    problem: `layermap 版本太旧，要 ${LAYERMAP_MINIMUM} 以上：升级 layermap 插件（claude plugin update layermap@layermap），开新会话后再跑`,
  }
}

/** 最多等多久：大仓库第一次建地图要几分钟。 */
const TIMEOUT_MS = 600_000

/** 在仓库根目录跑一条 layermap 命令（args 里要带 --json），读回它输出的 JSON。 */
export function layermap(root: string, args: string[]): LayermapAnswer {
  const r = spawnSync('layermap', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, kind: 'missing', problem: '找不到 layermap 命令' }
    if (code === 'ETIMEDOUT') return { ok: false, kind: 'failed', problem: `layermap 出错了：等了 ${TIMEOUT_MS / 60_000} 分钟没跑完` }
    return { ok: false, kind: 'failed', problem: `layermap 出错了：${r.error.message}` }
  }
  if (r.status !== 0) {
    // 旧版不认识的命令只打印用法（打在 stderr，stdout 不是 JSON）
    if (/^Usage:/m.test(`${r.stdout}\n${r.stderr}`) && !r.stdout.trimStart().startsWith('{')) return tooOld()
    const said = (r.stderr.trim() || r.stdout.trim()).split('\n').at(-1) ?? ''
    const how = r.status === null ? `被信号 ${r.signal} 终止` : `退出码 ${r.status}`
    return { ok: false, kind: 'failed', problem: `layermap 出错了${said ? `：${said}` : `（${how}）`}` }
  }
  try {
    return { ok: true, value: JSON.parse(r.stdout) }
  } catch {
    return tooOld()
  }
}
