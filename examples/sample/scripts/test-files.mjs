// files：只跑给定的测试文件。文件不存在，或有文件一个测试都没有，返回非零。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('至少给一个测试文件')
  process.exit(2)
}
const missing = files.filter(file => !existsSync(file))
if (missing.length > 0) {
  console.error(`测试文件不存在：${missing.join(', ')}`)
  process.exit(2)
}
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8' })
process.stdout.write(run.stdout)
process.stderr.write(run.stderr)
// node 把一个测试都没有的文件当成以文件名命名的一个测试报告出来
const topLevel = [...run.stdout.matchAll(/^(?:not )?ok \d+ - (.*)$/gm)].map(match => match[1])
const empty = files.filter(file => topLevel.includes(file))
if (empty.length > 0) {
  console.error(`这些文件一个测试都没有：${empty.join(', ')}`)
  process.exit(1)
}
process.exit(run.status ?? 1)
