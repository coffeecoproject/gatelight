// testpace 的 files 命令：参数是测试文件（相对仓库根目录），可以带 :行号 或 :行号:列号。
// node:test 不能按行跑：带行号的去掉行号，整个文件跑，输出里说一句。不加 --test-only，留着的 .only 不起作用。
// node --test 给的路径找不到时会悄悄跳过，这里先查文件都在；跑完再查每个文件都跑到了测试（scripts/testpace-reporter.mjs 记下），
// 文件没加载起来、里面一个测试都没有算失败；测试全被跳过的说一句（整组里同样被跳过，不算失败）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('没有给测试文件')
  process.exit(2)
}
const files = [...new Set(args.map(arg => arg.replace(/(:\d+){1,2}$/, '')))]
const missing = files.filter(file => !existsSync(file))
if (missing.length > 0) {
  console.error(`找不到测试文件：${missing.join('、')}`)
  process.exit(2)
}
const byLine = args.filter(arg => /:\d+(:\d+)?$/.test(arg))
if (byLine.length > 0) console.log(`[testpace] node:test 不能按行跑，这些整个文件跑：${byLine.join('、')}`)

const dir = mkdtempSync(join(tmpdir(), 'testpace-files-'))
const ran = join(dir, 'ran.jsonl')
let status
try {
  status = check()
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(status)

// 跑给定的文件，返回退出码：测试没过照 node --test 的，测试都过了再查每个文件都跑到了测试。
function check() {
  const run = spawnSync(process.execPath, [
    '--test',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${join(import.meta.dirname, 'testpace-reporter.mjs')}`, `--test-reporter-destination=${ran}`,
    ...files,
  ], { stdio: 'inherit' })
  if (run.status !== 0) return run.status ?? 1

  const counts = new Map(files.map(file => [resolve(file), { ran: 0, skipped: 0 }]))
  const lines = existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').filter(Boolean) : []
  for (const line of lines) {
    const { file, skipped } = JSON.parse(line)
    const count = counts.get(file)
    if (count) count[skipped ? 'skipped' : 'ran'] += 1
  }
  const empty = files.filter(file => { const c = counts.get(resolve(file)); return c.ran + c.skipped === 0 })
  const allSkipped = files.filter(file => { const c = counts.get(resolve(file)); return c.ran === 0 && c.skipped > 0 })
  if (allSkipped.length > 0) console.log(`[testpace] 这些文件的测试这次全被跳过，什么都没验证：${allSkipped.join('、')}`)
  if (empty.length > 0) {
    console.error(`[testpace] 这些文件一个测试都没跑到：${empty.join('、')}`)
    return 1
  }
  return 0
}
