// modwall db check 在整组里交回的凭据。它由项目写进自己的 full 命令（迁移跑完才能查），脚本里删掉那一行，库的模块边界就不查了。
// 所以不读脚本，按凭据核对：整组给各段命令一个环境变量（DB_RECEIPTS_ENV），db check 查完往那个文件追加一行（查的是哪个应用、过没过）；
// 整组跑完，配置里每个写了 database 的应用都要有凭据、而且都过了。只防看错：凭据是 agent 写得到的文件，故意伪造拦不住。

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileNow } from '../base/git.ts'
import { CONFIG_PATH, readConfig, schemeOf } from './config.ts'

export const DB_RECEIPTS_ENV = 'MODWALL_DB_RECEIPTS'

/** 一次 db check 的凭据。app：查的是哪个应用的库（单应用的写法没有名字，为 null）。 */
export interface DbReceipt {
  app: string | null
  passed: boolean
}

/** 给一次整组准备收凭据的文件。用完调 dispose。 */
export function receiptsFile(): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'modwall-db-receipts-'))
  return { path: join(dir, 'receipts.jsonl'), dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** db check 查完时调：在整组里跑的（有那个环境变量），交一条凭据。 */
export function leaveReceipt(app: string | undefined, passed: boolean): void {
  const path = process.env[DB_RECEIPTS_ENV]
  if (path) appendFileSync(path, `${JSON.stringify({ app: app ?? null, passed } satisfies DbReceipt)}\n`)
}

function readReceipts(path: string): DbReceipt[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').flatMap(line => {
    try {
      const value = JSON.parse(line) as Partial<DbReceipt>
      return typeof value.passed === 'boolean' && (value.app === null || typeof value.app === 'string') ? [{ app: value.app, passed: value.passed }] : []
    } catch {
      return [] // 空行、写到一半的
    }
  })
}

/** 工作区的配置里写了 database 的应用（单应用的写法为 null）。配置有问题的不算：整组里的 modwall check 已经报了。 */
function databaseApps(root: string): Array<string | null> {
  const { config } = readConfig(fileNow(root, CONFIG_PATH))
  if (!config) return []
  return schemeOf(config).apps.filter(app => app.database).map(app => app.name ?? null)
}

/** 整组跑完：写了 database 的应用，哪个没交凭据、哪个没过却没让整组失败。一条一句、写明怎么改。 */
export function receiptProblems(root: string, path: string): string[] {
  const receipts = readReceipts(path)
  const problems: string[] = []
  const apps = databaseApps(root)
  for (const app of apps) {
    // 只有一个应用写了 database 时，db check 不用 --app 也查它
    const which = app === null ? '' : apps.length > 1 ? `（${app} 应用的库，用 --app ${app}）` : `（${app} 应用的库）`
    const mine = receipts.filter(receipt => receipt.app === app)
    if (mine.length === 0) {
      problems.push(
        `整组里没跑 modwall db check${which}：${CONFIG_PATH} 写了 database，项目的 full 命令要在迁移跑完后跑它，查库里的模块边界（写法见 gatelight:setup-modwall 技能）。`,
      )
    } else if (mine.some(receipt => !receipt.passed)) {
      problems.push(`modwall db check${which}没通过，整组却接着跑完了：项目的 full 命令里不要忽略它的退出码（比如 || true），没通过要让整组失败。`)
    }
  }
  return problems
}
