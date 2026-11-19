// testpace run vitest 起 Vitest 用的启动脚本：用项目的 node、在 --cwd 下运行，经 Vitest 的 Node 接口照 `vitest run` 的做法跑，
// 跑完把每个跑过或被跳过的测试写进报告（见 targets.ts 的 Ran），testpace 按给的文件和行核对。
// 不用命令行，是因为命令行加报告器（--reporter）会把项目配置里的报告器整个换掉；这里不加报告器，项目的报告器、
// 屏幕输出都和直接跑 `vitest run` 一样，结果跑完从它的状态（vitest.state）里读。
//
// 用法：node vitest-launcher.mjs <报告文件> <vitest 的 bin> -- <交给 vitest run 的参数>...
// 照 Vitest 命令行（vitest run → start）做：解析参数，再交给它导出的 startVitest（命令行也是调它：准备环境、查要装的包、跑、
// 报启动错误、收尾），只在它返回之后、退出之前写报告。4.1 到 5.x 都一样；不同的地方注明。
// 选测试之前就停了（参数不认、不支持、配置写错）不写报告，testpace 见没有报告就不核对。
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [report, bin, separator, ...args] = process.argv.slice(2)
if (separator !== '--') throw new Error('用法：node vitest-launcher.mjs <报告文件> <vitest 的 bin> -- <参数>...')

/** testpace 只跑一次就结束：这些会另起分支（看着改动重跑、开界面、合并报告、只列测试、清缓存）或不跑测试，不交给它。 */
const UNSUPPORTED = ['watch', 'ui', 'standalone', 'mergeReports', 'listTags', 'clearCache', 'help', 'version']

await main()

async function main() {
  const node = await import(pathToFileURL(createRequire(join(process.cwd(), 'package.json')).resolve('vitest/node')).href)

  // 配置文件里看 process.argv 的，看到的和直接跑 vitest run 一样
  process.argv = [process.argv[0], bin, 'run', ...args]
  const argv = ['vitest', 'run', ...args]

  // 不认识的参数：命令行会报错退出，parseCLI 却照收不误。5.0 起 Vitest 导出 createCLI，照命令行那样查；4.1 没导出，查不了
  if (node.createCLI) {
    const cli = node.createCLI()
    try {
      cli.parse(['node', bin, ...argv.slice(1)], { run: false })
      cli.matchedCommand?.checkUnknownOptions()
      cli.matchedCommand?.checkOptionValue()
      cli.matchedCommand?.checkRequiredArgs()
    } catch (error) {
      console.error(`[testpace] Vitest 不认这些参数：${error.message}`)
      process.exitCode = 2
      return
    }
  }

  const { filter, options } = node.parseCLI(argv)
  const unsupported = UNSUPPORTED.filter(name => options[name] !== undefined && options[name] !== false)
  if (unsupported.length > 0) {
    console.error(`[testpace] testpace run vitest 不支持这些参数：${unsupported.map(name => `--${name}`).join('、')}`)
    process.exitCode = 2
    return
  }

  // 命令行的 normalizeCliOptions（Vitest 没导出）。命令行还把过滤参数的路径统一成 / 分隔，testpace 只在类 Unix 系统上跑，本来就是
  if (options.exclude) {
    options.cliExclude = [options.exclude].flat()
    delete options.exclude
  }
  if (filter.some(arg => arg.includes(':'))) options.includeTaskLocation ??= true
  if (typeof options.typecheck?.only === 'boolean') options.typecheck.enabled ??= true

  // 命令行的 start。startVitest 5.x 把第一个参数（mode）去掉了，但还认 4.1 的写法
  try {
    const vitest = await node.startVitest('test', filter, options)
    // 它返回时已经收尾（close），跑的结果还在 vitest.state 里
    writeFileSync(report, collect(vitest))
    await vitest.exit()
  } catch (error) {
    console.error('\n Startup Error \n')
    console.error(error)
    console.error('\n\n')
    process.exitCode ??= 1
    process.exit()
  }
}

/**
 * 每个跑过或被跳过的测试一行。文件出错、又一个测试都没真跑的（没加载起来、给的行上没有测试），它报上来的测试只是没被选中，不算；
 * 还是 pending 的（bail 之后没跑到）也不算。按行跑时没被选中的测试也报成跳过，靠行号由 testpace 筛掉。
 */
function collect(vitest) {
  const lines = []
  for (const module of vitest.state.getTestModules()) {
    const tests = [...module.children.allTests()].map(test => ({ test, state: test.result().state }))
    const ran = tests.some(({ state }) => state === 'passed' || state === 'failed')
    if (module.errors().length > 0 && !ran) continue
    for (const { test, state } of tests) {
      if (state === 'pending') continue
      const ancestors = []
      for (let parent = test.parent; parent?.type === 'suite'; parent = parent.parent) {
        if (parent.location) ancestors.push(parent.location.line)
      }
      // 重试后才过的记 retried（diagnostic 只在跑过的测试上有）
      const retried = state === 'passed' && test.diagnostic()?.flaky === true
      // 同一个文件跑在几个 project 里时各算一个测试：名字前面带上 project 名（和 Playwright 一样）
      const project = test.project.name
      const name = `${project ? `[${project}] ` : ''}${test.fullName}`
      lines.push(`${JSON.stringify({ file: module.moduleId, line: test.location?.line, ancestors, name, status: state, ...(retried ? { retried } : {}) })}\n`)
    }
  }
  return lines.join('')
}
