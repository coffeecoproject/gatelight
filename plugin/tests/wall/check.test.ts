import assert from 'node:assert/strict'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fakeLayermap, modwall, sampleRepo, sh, tempDir, withoutLayermap, write } from './helpers.ts'

/** 在示例项目上造出 R1、R2、R3、R5 各一处，R4 一处提示。 */
function breakSample(repo: string): void {
  // R1 + R4：billing 绕过 booking 的入口，新调用 booking 改了实现的 price
  write(
    repo,
    'src/modules/billing/index.ts',
    "import { price } from '../booking/internal/create.ts'\n\nexport function charge(amount: number): number {\n  return price(amount)\n}\n\nexport function refund(amount: number): number {\n  return -amount\n}\n",
  )
  // R2：booking 反过来引用 billing（新加的函数，不算改已有行为）
  write(
    repo,
    'src/modules/booking/internal/create.ts',
    "import { round } from '../../../shared/money.ts'\nimport { refund } from '../../billing/index.ts'\n\nexport function createBooking(amount: number): number {\n  return round(price(amount))\n}\n\nexport function price(amount: number): number {\n  return amount * 3\n}\n\nexport const undo = refund\n",
  )
  // R3：共享层引用模块
  write(repo, 'src/shared/money.ts', "import { createBooking } from '../modules/booking/index.ts'\n\nexport function round(amount: number): number {\n  return Math.round(amount * 100) / 100\n}\n\nexport const make = createBooking\n")
  // R5：没有归属的代码文件
  write(repo, 'src/loose.ts', 'export const loose = 1\n')
}

/** 最近一次 modwall check 的日志（和底座的日志放在一起：.git/testpace/logs/）。 */
function lastLog(repo: string): Record<string, any> {
  const logs = join(repo, sh(repo, 'git rev-parse --git-common-dir').trim(), 'testpace/logs')
  // 按记录里写的时间取最近一份，不按文件名：文件名里的时间只到秒，同一秒的两份靠进程号分先后，
  // 进程号位数变了（9999 → 10000）或转回小号时，按名字排就反了
  const entries = readdirSync(logs)
    .filter(file => file.endsWith('-modwall-check.log'))
    .map(file => JSON.parse(readFileSync(join(logs, file), 'utf8')) as Record<string, any>)
  return entries.sort((a, b) => a.at - b.at).at(-1) as Record<string, any>
}

describe('modwall check', () => {
  test('示例项目没有越界：通过，记下通过记录；没接入的仓库直接通过', () => {
    const repo = sampleRepo()
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /modwall check：通过。项目里没有越界/)
    assert.match(modwall(repo, ['status']).out, /当前内容 modwall check 通过过/)

    const outside = sampleRepo(dir => rmSync(join(dir, '.modwall'), { recursive: true }))
    const quiet = modwall(outside, ['check'])
    assert.equal(quiet.code, 0)
    assert.match(quiet.out, /没有接入 modwall/)
  })

  test('R1、R2、R3、R5 各报一处越界并给出改法，R4 给出提示；测试文件和 outside 里引用内部文件不算', () => {
    const repo = sampleRepo()
    breakSample(repo)
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /越界 4 处/)
    assert.match(r.out, /R1 绕过入口（1 处）\n {2}✗ src\/modules\/billing\/index\.ts:1（billing 模块）import 了 booking 模块的内部文件 src\/modules\/booking\/internal\/create\.ts\n {4}改法：改成从 booking 的入口 src\/modules\/booking\/index\.ts 引用/)
    assert.match(r.out, /R2 模块之间成环（1 处）\n {2}✗ billing → booking → billing/)
    assert.match(r.out, /R3 依赖方向反了（1 处）\n {2}✗ src\/shared\/money\.ts:1（共享层）import 了 booking 模块 src\/modules\/booking\/index\.ts/)
    assert.match(r.out, /R5 文件没有归属（1 处）\n {2}✗ src\/loose\.ts 没有归属\n {4}改法：放进某个模块/)
    assert.match(r.out, /R4 为新功能改了别人的已有行为（1 处，先只提示）\n {2}· booking 模块的 price（src\/modules\/booking\/internal\/create\.ts:8）这次改了实现，billing 模块在 src\/modules\/billing\/index\.ts:4 新增了对它的调用/)
    // 示例项目里 scripts/seed.ts（outside）和 tests/booking.test.ts 都直接引用了 booking 的内部文件
    assert.doesNotMatch(r.out, /seed\.ts|booking\.test\.ts/)
    assert.match(modwall(repo, ['status']).out, /越界：R1 1、R2 1、R3 1、R5 1、R6 0；R4 提示 1/)
  })

  test('入口新增导出列出来，不算违规；可能是项目自己的、没对上文件的 import 列为没检查到', () => {
    const repo = sampleRepo()
    write(repo, 'src/modules/booking/internal/cancel.ts', 'export function cancel(): boolean {\n  return true\n}\n')
    write(repo, 'src/modules/booking/index.ts', "export { createBooking, price } from './internal/create.ts'\nexport { cancel } from './internal/cancel.ts'\n")
    write(repo, 'src/modules/billing/index.ts', "import './style.css'\n\nexport function charge(amount: number): number {\n  return amount\n}\n")
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /booking 的入口 src\/modules\/booking\/index\.ts:2 新增引用 src\/modules\/booking\/internal\/cancel\.ts/)
    assert.match(r.out, /没检查到.*\n {2}· src\/modules\/billing\/index\.ts:1 的 import "\.\/style\.css"/)
  })

  test('import 非代码文件：相对路径指向存在的文件的按目标位置判（别的模块的样式报 R1，成环也算），不再列为没检查到', () => {
    const repo = sampleRepo(dir => {
      write(dir, 'src/modules/booking/theme.css', '.a {}\n')
      write(dir, 'src/shared/base.css', '.b {}\n')
      write(dir, 'src/modules/billing/logo.png', 'x')
    })
    write(repo, 'src/modules/billing/index.ts', "import '../booking/theme.css'\nimport '../../shared/base.css'\n\nexport function charge(amount: number): number {\n  return amount\n}\n")
    write(repo, 'src/modules/booking/index.ts', "import logo from '../billing/logo.png'\n\nexport { createBooking, price } from './internal/create.ts'\nexport const icon = logo\n")
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /R1 绕过入口（2 处）\n {2}✗ src\/modules\/billing\/index\.ts:1（billing 模块）import 了 booking 模块的内部文件 src\/modules\/booking\/theme\.css\n {4}改法：样式不能经入口导出：几个模块都用的样式，搬进共享层/)
    assert.match(r.out, /✗ src\/modules\/booking\/index\.ts:1（booking 模块）import 了 billing 模块的内部文件 src\/modules\/billing\/logo\.png\n {4}改法：改成从 billing 的入口 src\/modules\/billing\/index\.ts 引用/)
    assert.match(r.out, /R2 模块之间成环（1 处）\n {2}✗ billing → booking → billing/)
    assert.doesNotMatch(r.out, /没检查到|base\.css/)
  })

  test('只改了不是代码的文件（modwall 自己的配置、testpace.json）：不列为没检查到', () => {
    const repo = sampleRepo()
    const file = join(repo, '.modwall/config.json')
    const config = JSON.parse(readFileSync(file, 'utf8'))
    config.entry = ['index.ts', '__init__.py']
    writeFileSync(file, JSON.stringify(config, null, 2))
    write(repo, 'testpace.json', '{"fast":"true","files":"true","full":"true","tests":["tests/**"]}\n')
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /没检查到|\.modwall\/config\.json|testpace\.json/)
  })

  test('正式代码引用测试文件：报 R3', () => {
    const repo = sampleRepo()
    write(repo, 'tests/support.ts', 'export const fixture = 1\n')
    write(repo, 'src/modules/billing/index.ts', "import { fixture } from '../../../tests/support.ts'\n\nexport function charge(amount: number): number {\n  return amount + fixture\n}\n")
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /R3 依赖方向反了（1 处）\n {2}✗ src\/modules\/billing\/index\.ts:1（billing 模块）import 了 测试文件 tests\/support\.ts\n {4}改法：正式代码要用的东西不放在测试目录里/)
  })

  test('Java：模块之间成环（R2）、共享层引用模块（R3）、文件没有归属（R5）各报一处', () => {
    const repo = join(tempDir('modwall-java-'), 'repo')
    const base = 'src/main/java/com/acme'
    write(repo, '.modwall/config.json', JSON.stringify({ roots: [`${base}/modules`], shared: [`${base}/shared/**`], entry: [] }))
    write(repo, `${base}/modules/booking/Booking.java`, 'package com.acme.modules.booking;\n\nimport com.acme.modules.billing.Billing;\n\npublic class Booking {\n  public int make() { return new Billing().charge(); }\n}\n')
    write(repo, `${base}/modules/billing/Billing.java`, 'package com.acme.modules.billing;\n\nimport com.acme.modules.booking.Booking;\n\npublic class Billing {\n  public int charge() { return 1; }\n  public Booking back() { return null; }\n}\n')
    write(repo, `${base}/shared/Money.java`, 'package com.acme.shared;\n\nimport com.acme.modules.booking.Booking;\n\npublic class Money {\n  public Booking b() { return null; }\n}\n')
    write(repo, `${base}/Loose.java`, 'package com.acme;\n\npublic class Loose {}\n')
    sh(repo, 'git init -q -b main && git add -A && git commit -qm init && git checkout -qb feature')
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /越界 3 处/)
    assert.match(r.out, /R2 模块之间成环（1 处）\n {2}✗ billing → booking → billing/)
    assert.match(r.out, /R3 依赖方向反了（1 处）\n {2}✗ src\/main\/java\/com\/acme\/shared\/Money\.java:3（共享层）import 了 booking 模块 src\/main\/java\/com\/acme\/modules\/booking\/Booking\.java/)
    assert.match(r.out, /R5 文件没有归属（1 处）\n {2}✗ src\/main\/java\/com\/acme\/Loose\.java 没有归属/)
    // 第一版不管 Java 的入口（R1）
    assert.doesNotMatch(r.out, /R1/)
  })

  test('模块根目录在磁盘上不存在（git 不跟踪空目录）：不算配置错误，下面就是没有模块', () => {
    const repo = sampleRepo(dir => {
      const file = join(dir, '.modwall/config.json')
      const config = JSON.parse(readFileSync(file, 'utf8'))
      config.roots.push('src/features')
      writeFileSync(file, JSON.stringify(config, null, 2))
    })
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 0, r.out)
  })

  test('Python：模块根目录的 __init__.py 在 app 里点名后归装配层；从包名引模块的两种写法报 R3，另两种不报', () => {
    const repo = join(tempDir('modwall-py-'), 'repo')
    const config = { roots: ['app/modules'], app: ['app/__init__.py', 'app/modules/__init__.py'], entry: ['__init__.py'] }
    write(repo, '.modwall/config.json', JSON.stringify(config))
    write(repo, 'app/__init__.py', '')
    write(repo, 'app/modules/__init__.py', '')
    write(repo, 'app/modules/booking/__init__.py', 'def make(n):\n    return n\n')
    write(repo, 'app/modules/billing/__init__.py', '')
    write(repo, 'app/modules/billing/a.py', 'from app.modules import booking\n')
    write(repo, 'app/modules/billing/b.py', 'from .. import booking\n')
    write(repo, 'app/modules/billing/c.py', 'from app.modules.booking import make\n')
    write(repo, 'app/modules/billing/d.py', 'from ..booking import make\n')
    sh(repo, 'git init -q -b main && git add -A && git commit -qm init && git checkout -qb feature')
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /越界 2 处/)
    assert.match(r.out, /R3 依赖方向反了（2 处）\n {2}✗ app\/modules\/billing\/a\.py:1（billing 模块）import 了 装配层 app\/modules\/__init__\.py\n {2}✗ app\/modules\/billing\/b\.py:1（billing 模块）import 了 装配层 app\/modules\/__init__\.py/)
    assert.match(r.out, /写成 `from app\.modules\.模块名 import …` 或 `from \.\.模块名 import …`/)
    assert.doesNotMatch(r.out, /c\.py|d\.py|R5|路径重叠/)
  })

  test('LayerMap 不读的目录：写进 outside 的、被 git 忽略的不报；模块里 vendor/ 下的代码引用了别的模块，check 不通过', () => {
    const repo = sampleRepo(dir => {
      write(dir, '.gitignore', 'node_modules/\n')
      write(dir, 'src/modules/booking/node_modules/pkg/index.js', 'module.exports = 1\n')
      write(dir, 'third/vendor/lib.ts', 'export const lib = 1\n')
      const file = join(dir, '.modwall/config.json')
      const config = JSON.parse(readFileSync(file, 'utf8'))
      config.outside.push('third/vendor/**')
      writeFileSync(file, JSON.stringify(config, null, 2))
    })
    const clean = modwall(repo, ['check'])
    assert.equal(clean.code, 0, clean.out)

    write(repo, 'src/modules/booking/vendor/util.ts', "import { charge } from '../../billing/index.ts'\n\nexport const pay = charge\n")
    write(repo, 'tools/Vendor/gen.ts', 'export const gen = 1\n')
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /R5 文件没有归属（2 处）/)
    assert.match(r.out, /✗ src\/modules\/booking\/vendor\/util\.ts 在 LayerMap 不读的目录 src\/modules\/booking\/vendor 里，modwall 查不到它引用了谁（按路径它在booking 模块里），没有归属\n {4}改法：换个目录名/)
    assert.match(r.out, /✗ tools\/Vendor\/gen\.ts 在 LayerMap 不读的目录 tools\/Vendor 里.*\n {4}改法：第三方或工具的代码，在 outside 里写上 "tools\/Vendor\/\*\*"/)
    assert.doesNotMatch(r.out, /booking\/node_modules|third\/vendor/)
  })

  test('改正了越界，日志里记下上一次的哪些改正了', () => {
    const repo = sampleRepo()
    breakSample(repo)
    assert.equal(modwall(repo, ['check']).code, 1)
    rmSync(join(repo, 'src/loose.ts'))
    assert.equal(modwall(repo, ['check']).code, 1)
    const log = lastLog(repo)
    assert.deepEqual(log.fixed, ['R5 src/loose.ts'])
    assert.equal(log.violations.length, 3)
    assert.equal(log.result, 'fail')
    assert.equal(log.complete, true)
  })

  test('没查全的检查（LayerMap 用不了）不算改正了什么，也不作为下一次比较的基准', () => {
    const repo = sampleRepo()
    breakSample(repo)
    const last = (): Record<string, any> => lastLog(repo)
    assert.equal(modwall(repo, ['check']).code, 1)
    // 只查了 R5、R6：R1–R3 不在列表里，但不是改正了
    assert.equal(modwall(repo, ['check'], withoutLayermap()).code, 2)
    assert.deepEqual([last().complete, last().fixed], [false, []])
    // 再查全一次：和上一次查全的比，不和中间那次比
    rmSync(join(repo, 'src/loose.ts'))
    assert.equal(modwall(repo, ['check']).code, 1)
    assert.deepEqual([last().complete, last().fixed], [true, ['R5 src/loose.ts']])
  })

  test('配置有错：不往下查，退出码 2', () => {
    const repo = sampleRepo()
    writeFileSync(join(repo, '.modwall/config.json'), JSON.stringify({ roots: ['src/modules'], entry: ['index.ts'], shared: ['src/**'] }))
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /配置有问题.*\n {2}✗ 路径重叠：roots 的 "src\/modules" 和 shared 的 "src\/\*\*"/)
    assert.match(r.out, /各项的路径不能重叠/)
    // 别的配置错误后面不跟"路径不能重叠"那句
    writeFileSync(join(repo, '.modwall/config.json'), '{')
    const syntax = modwall(repo, ['check'])
    assert.equal(syntax.code, 2, syntax.out)
    assert.match(syntax.out, /不是合法的 JSON/)
    assert.doesNotMatch(syntax.out, /路径不能重叠/)
  })

  test('分叉点上的配置坏了、工作区又删掉了 .modwall/：照实说没有能用的配置', () => {
    const repo = sampleRepo(dir => writeFileSync(join(dir, '.modwall/config.json'), '{'))
    rmSync(join(repo, '.modwall'), { recursive: true })
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /工作区里删掉了 \.modwall\/，分叉点上的 \.modwall\/config\.json 又不在或校验不过/)
    assert.doesNotMatch(r.out, /有 \.modwall\/ 目录但没有/)
  })

  test('只有 layermap check 没跑成：R1–R3、R5 照常列出，说明 R4 和入口新增导出没查；仍然退出 2', () => {
    const repo = sampleRepo()
    write(repo, 'src/loose.ts', 'export const loose = 1\n')
    const env = fakeLayermap('case "$1" in\n  imports) echo \'{"imports":[],"unresolved":[]}\' ;;\n  --version) echo 0.1.48 ;;\n  *) echo "layermap: LAYERMAP_DIFF_TOO_LARGE" >&2; exit 1 ;;\nesac')
    const r = modwall(repo, ['check'], env)
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /没通过，这次改动增删的关系没读到，R4 和入口新增导出没查（R1、R2、R3、R5、R6 照常查了，结果在下面）/)
    assert.match(r.out, /LAYERMAP_DIFF_TOO_LARGE/)
    assert.match(r.out, /✗ src\/loose\.ts 没有归属/)
    assert.doesNotMatch(r.out, /R1、R2、R3 和 R4 没查|R1、R2、R3、R4 和入口新增导出都没查/)
    const status = modwall(repo, ['status'], env).out
    assert.match(status, /越界：R1 0、R2 0、R3 0、R5 1、R6 0；R4 和入口新增导出没查/)
    assert.match(status, /layermap check 没跑成/)
  })

  test('没装 LayerMap、或版本太旧：不通过并说明要装或升级；按路径判断的 R5 照查', () => {
    const repo = sampleRepo()
    write(repo, 'src/loose.ts', 'export const loose = 1\n')
    const missing = modwall(repo, ['check'], withoutLayermap())
    assert.equal(missing.code, 2, missing.out)
    assert.match(missing.out, /没找到 layermap 命令.*0\.1\.48 以上/)
    assert.match(missing.out, /✗ src\/loose\.ts 没有归属/)

    // 0.1.47 及以前没有 imports 命令：和真的一样，用法打在 stderr，stdout 是空的，退出码 1
    const old = modwall(repo, ['check'], fakeLayermap('printf "LayerMap — a layered map of a codebase for coding agents.\\n\\nUsage:\\n  layermap check\\n" >&2; exit 1'))
    assert.equal(old.code, 2, old.out)
    assert.match(old.out, /layermap 版本太旧，要 0\.1\.48 以上/)
    // 输出缺字段也当版本太旧，不当成没有违规
    const partial = modwall(repo, ['check'], fakeLayermap('echo \'{"imports":[]}\''))
    assert.equal(partial.code, 2, partial.out)
    assert.match(partial.out, /layermap 版本太旧/)
  })

  test('找不到分叉点：没法和改动前的配置比，退出码 2', () => {
    const repo = join(tempDir('modwall-nobase-'), 'repo')
    sh(tempDir('modwall-x-'), `git init -q -b trunk ${repo} && mkdir -p ${repo}/.modwall`)
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 2, r.out)
    assert.match(r.out, /没法检查：认不出默认分支/)
  })
})
