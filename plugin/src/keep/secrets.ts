// 扫密钥：secrets 开着时，用 gitleaks 扫这次改动——分叉点之后的提交（gitleaks git --log-opts "<分叉点>..HEAD"），
// 加上没提交的改动（--pre-commit：已暂存、没暂存的，没跟踪的新文件也算）。只扫这次的，旧提交里的不管。
// 没提交的那一份用一份临时的索引：从 HEAD 读出来，把没跟踪的新文件登记成"要加的"（git add -N），
// gitleaks 跑的 git diff 就是工作区相对 HEAD 的全部改动。真实的索引不动。
// gitleaks 用仓库根目录的 .gitleaks.toml、.gitleaksignore（改松要用户同意，见 loosen.ts）；外面环境变量指的配置不认。
// 找不到 gitleaks 不自己装，说怎么装。输出里的密钥打码（--redact）。
// 代码里的 gitleaks:allow 注释不认（--ignore-gitleaks-allow）：它是不写理由、不用确认的"这里不查"；确实不是密钥的进 .gitleaksignore，要用户同意。

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type SecretsResult = { ok: true } | { missing: true } | { leaks: true } | { problem: string }

/** gitleaks 的可执行文件：PATH 上的，没有再看 Homebrew 的位置。 */
function findGitleaks(): string | undefined {
  const found = spawnSync('/bin/sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).stdout.trim()
  if (found) return found
  return ['/opt/homebrew/bin/gitleaks', '/usr/local/bin/gitleaks'].find(path => spawnSync(path, ['version']).status === 0)
}

const { GITLEAKS_CONFIG: _config, GITLEAKS_CONFIG_TOML: _toml, ...env } = process.env

/** 跑一次 gitleaks，输出照原样给出来。返回退出码：0 没扫出、1 扫出了，别的是没跑成。 */
function gitleaks(bin: string, root: string, args: string[], extraEnv: Record<string, string> = {}): number | null {
  const r = spawnSync(bin, ['git', ...args, '--ignore-gitleaks-allow', '--redact', '--no-banner', '--no-color', '--verbose', '--exit-code', '1', root], {
    cwd: root,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  return r.status
}

export function scanSecrets(root: string, fork: string): SecretsResult {
  const bin = findGitleaks()
  if (!bin) return { missing: true }
  console.log(`== 扫密钥：分叉点 ${fork.slice(0, 10)} 之后的提交`)
  const committed = gitleaks(bin, root, ['--log-opts', `${fork}..HEAD`])
  if (committed !== 0 && committed !== 1) return { problem: `gitleaks 扫提交时没跑成（退出码 ${committed}）` }

  console.log('== 扫密钥：没提交的改动')
  const dir = mkdtempSync(join(tmpdir(), 'codekeep-index-'))
  let pending: number | null
  try {
    const indexEnv = { GIT_INDEX_FILE: join(dir, 'index') }
    const git = (args: string[], input?: string): void => {
      execFileSync('git', args, { cwd: root, env: { ...process.env, ...indexEnv }, input, stdio: ['pipe', 'ignore', 'pipe'] })
    }
    git(['read-tree', 'HEAD'])
    git(['update-index', '-q', '--refresh'])
    // 对着临时索引列：已暂存、还没提交的新文件不在 HEAD 里，也要登记进来
    const untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...indexEnv } })
    if (untracked) git(['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], untracked)
    pending = gitleaks(bin, root, ['--pre-commit'], indexEnv)
  } catch (error) {
    return { problem: `准备扫没提交的改动时出错：${(error as Error).message.split('\n')[0]}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  if (pending !== 0 && pending !== 1) return { problem: `gitleaks 扫没提交的改动时没跑成（退出码 ${pending}）` }
  return committed === 1 || pending === 1 ? { leaks: true } : { ok: true }
}
