// testpace run node-test 的计数报告器：每跑完一个测试写一行 {file, skipped}，testpace 跑完按文件核对。
// 由项目的 node 加载，写成 .mjs，不靠 node 直接运行 TypeScript。
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const { file, name, nesting, details, skip, todo } = event.data
    if (!file || details?.type === 'suite') continue
    // 文件本身没加载起来、或里面一个测试都没有时，node:test 把文件当成一个测试报上来，名字就是交给它的路径。
    // testpace run 交的都是绝对路径，所以名字和 file 一样。它不是测试，不算
    if (nesting === 0 && name === file) continue
    yield `${JSON.stringify({ file, skipped: Boolean(skip || todo) })}\n`
  }
}
