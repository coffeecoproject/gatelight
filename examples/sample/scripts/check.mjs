// fast：语法检查 src 和 tests 下的文件。真实项目里是增量类型检查加 lint。
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

for (const dir of ['src', 'tests']) {
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', join(dir, name)], { stdio: 'inherit' })
  }
}
