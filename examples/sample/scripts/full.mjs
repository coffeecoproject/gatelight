// full：落地前必须通过的、测试以外的检查。测试由 testpace 按 tests 规则找出来交给 files 跑。
import { execFileSync } from 'node:child_process'

try {
  execFileSync(process.execPath, ['scripts/check.mjs'], { stdio: 'inherit' })
} catch (error) {
  process.exit(error.status ?? 1)
}
