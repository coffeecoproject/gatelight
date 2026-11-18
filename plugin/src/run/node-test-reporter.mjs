// testpace run node-test 的计数报告器：每个跑过或被跳过的测试写一行 {file, line, ancestors, status}（见 targets.ts 的 Ran），
// testpace 跑完按给的文件和行核对。由项目的 node 加载，写成 .mjs，不靠 node 直接运行 TypeScript。
//
// 外层各级的行：node:test 的 test:start、test:pass、test:fail 都按声明的顺序发，nesting 是层级。
// 按文件记下每一层最近开始的那一个，一个测试的结果到的时候，比它浅的那几层就是它的外层。
// 整组被跳过（describe 带 skip）时 node:test 只报这一组，不报组里的测试：把这一组记成一条被跳过的。
export default async function* reporter(source) {
  /** 每个文件当前各层开始的那一个的行号。 */
  const open = new Map()
  for await (const event of source) {
    const data = event.data
    if (event.type === 'test:start') {
      if (!data.file) continue
      const stack = open.get(data.file) ?? []
      stack.length = data.nesting
      stack.push(data.line)
      open.set(data.file, stack)
      continue
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const { file, name, nesting, line, details, skip, todo } = data
    if (!file) continue
    // 文件本身没加载起来、或里面一个测试都没有时，node:test 把文件当成一个测试报上来，名字就是交给它的路径。
    // testpace run 交的都是绝对路径，所以名字和 file 一样。它不是测试，不算
    if (nesting === 0 && name === file) continue
    // skip、todo 可以是一段说明，按真假算
    const skipped = Boolean(skip || todo)
    if (details?.type === 'suite' && !skipped) continue
    const status = skipped ? 'skipped' : event.type === 'test:pass' ? 'passed' : 'failed'
    yield `${JSON.stringify({ file, line, ancestors: (open.get(file) ?? []).slice(0, nesting), status })}\n`
  }
}
