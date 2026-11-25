// node:test 的报告器：testpace 跑 files 时在环境变量 TESTPACE_RESULTS 里给一个文件，每个跑过或被跳过的测试往里追加一行
// {"file","name","status"}（文件用绝对路径）。整组跑完按它核对交给 files 的每个文件都跑到了。
import { appendFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type !== 'test:pass' && type !== 'test:fail') continue
    if (!data.file || data.details?.type === 'suite') continue
    // 一个测试都没有、或没加载起来的文件，node 把文件本身当成一个测试报上来：不算
    if (data.nesting === 0 && resolve(data.name) === data.file) continue
    const status = data.skip || data.todo ? 'skipped' : type === 'test:pass' ? 'passed' : 'failed'
    appendFileSync(process.env.TESTPACE_RESULTS, `${JSON.stringify({ file: realpathSync(data.file), name: data.name, status })}\n`)
  }
}
