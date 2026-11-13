// files：只跑给定的测试文件。文件不存在，或有文件一个测试都没有，返回非零。
// 参数也可以是 文件:行号（或 文件:行号:列号）；node --test 不能按行跑，去掉行号跑整个文件。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('至少给一个测试文件')
  process.exit(2)
}
const LOCATED = /:\d+(?::\d+)?$/
const located = targets.filter(target => LOCATED.test(target))
if (located.length > 0) console.log(`node --test 不能按行跑，这些跑整个文件：${located.join(', ')}`)
const files = [...new Set(targets.map(target => target.replace(LOCATED, '')))]
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
