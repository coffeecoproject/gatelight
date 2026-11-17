// scripts/testpace-files.mjs 用的 node:test 报告器：每个跑完的测试（不含 describe）记一行它在哪个文件、是不是被跳过。
// 文件里一个测试都没有、或者没加载起来时，node:test 把文件本身当成一个测试报上来（名字就是文件路径），这个不算。
import { resolve } from 'node:path'

export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const { file, name, nesting, details, skip, todo } = event.data
    if (!file || details?.type === 'suite') continue
    if (nesting === 0 && resolve(name) === file) continue
    yield `${JSON.stringify({ file, skipped: Boolean(skip || todo) })}\n`
  }
}
