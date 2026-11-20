// "模块边界"说给 agent 的话，经整个插件共用的那个钩子入口出去：会话说明、改文件之前。收尾时不拦。

import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { hook, sampleRepo, sh, write } from './helpers.ts'

const edit = (repo: string, path: string, tool = 'Write'): Record<string, any> | undefined =>
  hook(repo, 'PreToolUse', { tool_name: tool, tool_input: { file_path: join(repo, path) } })

/** 停止门：拦了返回给 agent 的话；没出声是 undefined；出了别的声原样返回（和 undefined 比就不相等）。 */
const stop = (repo: string, session: string): unknown => {
  const out = hook(repo, 'Stop', { session_id: session })
  return out?.decision === 'block' ? (out.reason as string) : out
}

/** 只看拦没拦：默认分支上没测过的提交另有给用户的提示（"跑测试"模块的），那不算拦。 */
const blocked = (repo: string, session: string): string | undefined => {
  const out = hook(repo, 'Stop', { session_id: session })
  return out?.decision === 'block' ? (out.reason as string) : undefined
}

describe('会话开始', () => {
  test('注入模块列表、各模块 MODULE.md 写的职责和写法约定；说明模块边界以 modwall 为准', () => {
    const repo = sampleRepo()
    const text = hook(repo, 'SessionStart')?.hookSpecificOutput.additionalContext as string
    assert.match(text, /模块边界以 modwall 为准/)
    assert.match(text, /新功能默认在模块根目录下新建一个模块目录/)
    assert.match(text, /只从它的入口（模块目录下第一层的 index\.ts、index\.tsx、index\.js、__init__\.py）引用/)
    assert.match(text, /- booking（src\/modules\/booking）：负责预订：创建预订、算预订价。不管收款，收款归 billing。/)
    // frontmatter（module-gates 的写法）不注入
    assert.match(text, /- billing（src\/modules\/billing）：负责收款。不管预订的规则。/)
    assert.doesNotMatch(text, /readonly/)
  })

  test('写了 database：加上数据库按模块分 schema 的约定；没写不提', () => {
    assert.doesNotMatch(hook(sampleRepo(), 'SessionStart')?.hookSpecificOutput.additionalContext as string, /schema/)
    const repo = sampleRepo(dir => {
      const file = join(dir, '.modwall/config.json')
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), database: { migrations: 'migrations', shared: 'src/shared/migrations', login: 'app', migrator: 'migrator' } }))
    })
    const text = hook(repo, 'SessionStart')?.hookSpecificOutput.additionalContext as string
    assert.match(text, /数据库（Postgres）也按模块分：.*入口 schema（<内部 schema>_api，不放表）.*模块之间不建外键（只存 id）.*迁移放在模块目录下的 migrations\/（共享层的在 src\/shared\/migrations\/）.*SET search_path = <本模块的内部 schema>, pg_temp.*SECURITY DEFINER.*不自己切身份/)
  })

  test('模块多时只列模块名和 MODULE.md 的头两句：中文、英文、中英混排都能断句', () => {
    const repo = sampleRepo(dir => {
      for (let i = 0; i < 12; i++) write(dir, `src/modules/m${String(i).padStart(2, '0')}/index.ts`, 'export const x = 1\n')
      write(dir, 'src/modules/booking/MODULE.md', '# booking\n\n负责预订。不管收款。第三句不该出现。\n')
      write(dir, 'src/modules/billing/MODULE.md', 'Handles billing (v1.5). Does not handle booking. Third sentence here.\n')
      write(dir, 'src/modules/m00/MODULE.md', '负责 search. 不管排序；第三句不该出现。\n')
    })
    const text = hook(repo, 'SessionStart')?.hookSpecificOutput.additionalContext as string
    assert.match(text, /模块（14 个）/)
    assert.match(text, /- booking（src\/modules\/booking）：负责预订。不管收款。\n/)
    assert.match(text, /- billing（src\/modules\/billing）：Handles billing \(v1\.5\)\. Does not handle booking\.\n/)
    assert.match(text, /- m00（src\/modules\/m00）：负责 search\. 不管排序；\n/)
    assert.match(text, /- m01（src\/modules\/m01）\n/)
    assert.doesNotMatch(text, /第三句|Third/)
  })

  test('没接入的仓库不说模块的事；没接入 testpace 的仓库钩子不管；配置有错时让 agent 先跑 modwall check', () => {
    const outside = sampleRepo(dir => rmSync(join(dir, '.modwall'), { recursive: true }))
    const told = hook(outside, 'SessionStart')?.hookSpecificOutput.additionalContext as string
    assert.match(told, /testpace focused/)
    assert.doesNotMatch(told, /modwall/)
    const noTestpace = sampleRepo(dir => rmSync(join(dir, 'testpace.json')))
    assert.doesNotMatch(String(hook(noTestpace, 'SessionStart')?.hookSpecificOutput.additionalContext), /modwall/)
    const broken = sampleRepo()
    write(broken, '.modwall/config.json', '{')
    assert.match(hook(broken, 'SessionStart')?.hookSpecificOutput.additionalContext, /现在有问题或不在：用 Bash 跑 modwall check/)
  })
})

describe('改文件之前（只看路径）', () => {
  test('没有归属的代码文件：新建和修改都拒绝，附上改法', () => {
    const repo = sampleRepo(dir => write(dir, 'src/old.ts', 'export const old = 1\n'))
    const created = edit(repo, 'src/new.ts')?.hookSpecificOutput
    assert.equal(created?.permissionDecision, 'deny')
    assert.match(created?.permissionDecisionReason, /src\/new\.ts 没有归属。代码文件要放进某个模块（src\/modules\/<模块名>\/）、共享层（src\/shared\/\*\*）、装配层（src\/main\.ts）/)
    assert.equal(edit(repo, 'src/old.ts', 'Edit')?.hookSpecificOutput.permissionDecision, 'deny')
    assert.equal(edit(repo, 'src/old.ts', 'MultiEdit')?.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(edit(repo, 'src/modules/helper.ts')?.hookSpecificOutput.permissionDecisionReason, /直接放在模块根目录 src\/modules 下.*在 app 里写到这个文件（"src\/modules\/helper\.ts"，不用通配）/)
    // 相对路径按会话目录算
    assert.equal(hook(repo, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: 'src/new2.py' } })?.hookSpecificOutput.permissionDecision, 'deny')
    // 目标不在会话所在的仓库里：按它自己所在的仓库算
    const elsewhere = sampleRepo()
    assert.equal(hook(elsewhere, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: join(repo, 'src/new3.ts') } })?.hookSpecificOutput.permissionDecision, 'deny')
  })

  test('新模块、共享层、装配层、outside、测试文件、不是代码的文件：放行', () => {
    const repo = sampleRepo()
    for (const path of ['src/modules/payments/index.ts', 'src/modules/booking/deep/a.ts', 'src/shared/date.ts', 'src/main.ts', 'scripts/x.ts', 'tests/a.test.ts', 'src/notes.md', '.modwall/config.json']) {
      assert.equal(edit(repo, path), undefined, path)
    }
  })

  test('直接放在模块根目录下的文件：app 里点名的放行，通配盖到的、没点名的照拦', () => {
    const repo = sampleRepo(dir => {
      const file = join(dir, '.modwall/config.json')
      const config = JSON.parse(readFileSync(file, 'utf8'))
      config.app.push('src/modules/__init__.py', 'src/modules/*.js')
      writeFileSync(file, JSON.stringify(config))
    })
    assert.equal(edit(repo, 'src/modules/__init__.py'), undefined)
    assert.equal(edit(repo, 'src/modules/barrel.js')?.hookSpecificOutput.permissionDecision, 'deny')
    assert.equal(edit(repo, 'src/modules/other.py')?.hookSpecificOutput.permissionDecision, 'deny')
  })

  test('LayerMap 不读的目录：模块里的新建要拒绝（大小写不同也一样）；别处的没写进 outside 拒绝、写了放行；被 git 忽略的放行', () => {
    const repo = sampleRepo(dir => {
      write(dir, '.gitignore', 'node_modules/\n')
      const file = join(dir, '.modwall/config.json')
      const config = JSON.parse(readFileSync(file, 'utf8'))
      config.outside.push('third/vendor/**')
      writeFileSync(file, JSON.stringify(config))
    })
    const inModule = edit(repo, 'src/modules/booking/vendor/util.ts')?.hookSpecificOutput
    assert.equal(inModule?.permissionDecision, 'deny')
    assert.match(inModule?.permissionDecisionReason, /在 LayerMap 不读的目录 src\/modules\/booking\/vendor 里，modwall 查不到它引用了谁.*换个目录名，把它搬出 src\/modules\/booking\/vendor\//)
    assert.equal(edit(repo, 'src/modules/booking/Vendor/util.ts')?.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(edit(repo, 'lib/vendor/x.go')?.hookSpecificOutput.permissionDecisionReason, /在 outside 里写上 "lib\/vendor\/\*\*"（放宽规则，要用户同意）/)
    assert.equal(edit(repo, 'third/vendor/x.go'), undefined)
    // 被 git 忽略的：装依赖生成的那种，不管放在哪里
    assert.equal(edit(repo, 'node_modules/pkg/index.js'), undefined)
    assert.equal(edit(repo, 'src/modules/booking/node_modules/pkg/index.js'), undefined)
  })

  test('没接入、配置有错、不在仓库里：不拦', () => {
    const outside = sampleRepo(dir => rmSync(join(dir, '.modwall'), { recursive: true }))
    assert.equal(edit(outside, 'src/new.ts'), undefined)
    const broken = sampleRepo()
    write(broken, '.modwall/config.json', '{')
    assert.equal(edit(broken, 'src/new.ts'), undefined)
    assert.equal(hook(broken, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/nowhere/at/all/x.ts' } }), undefined)
    // 没接入 testpace 的仓库钩子不管
    const noTestpace = sampleRepo(dir => rmSync(join(dir, 'testpace.json')))
    assert.equal(edit(noTestpace, 'src/new.ts'), undefined)
  })
})

describe('结束之前', () => {
  test('这个会话改了代码、越了界、没跑 modwall check：收尾时都不拦，越界留给合回默认分支时的整组', () => {
    const repo = sampleRepo()
    hook(repo, 'SessionStart', { session_id: 's1' })
    assert.equal(stop(repo, 's1'), undefined)

    appendFileSync(join(repo, 'src/modules/billing/index.ts'), '\nexport const fee = 1\n')
    assert.equal(blocked(repo, 's1'), undefined)
    // 直接引用别的模块的内部文件（越界）：收尾时照样不拦，modwall check 才查得出来
    write(repo, 'src/modules/billing/peek.ts', "import '../booking/internal.ts'\n")
    assert.equal(blocked(repo, 's1'), undefined)
  })

  test('没接入的仓库不出声', () => {
    const outside = sampleRepo(dir => rmSync(join(dir, '.modwall'), { recursive: true }))
    write(outside, 'src/new.ts', 'export const x = 1\n')
    assert.equal(stop(outside, 's3'), undefined)
  })
})
