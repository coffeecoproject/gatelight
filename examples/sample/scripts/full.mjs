// full：落地前必须通过的全部检查和测试。
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

try {
  execFileSync(process.execPath, ['scripts/check.mjs'], { stdio: 'inherit' })
  const tests = readdirSync('tests').filter(name => name.endsWith('.test.mjs')).map(name => join('tests', name))
  execFileSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' })
} catch (error) {
  process.exit(error.status ?? 1)
}
