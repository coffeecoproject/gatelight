// "模块边界"说给 agent 的话，经整个插件共用的那个钩子入口出去：会话说明、改文件之前、停止门。

import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { ENV, hook, modwall, sampleRepo, sh, tempDir, write } from './helpers.ts'

const edit = (repo: string, path: string, tool = 'Write'): Record<string, any> | undefined =>
  hook(repo, 'PreToolUse', { tool_name: tool, tool_input: { file_path: join(repo, path) } })

/** 会话用改文件的工具改 path：先发改文件的事件（停止门只为会话动过手的工作区问），再真的写。 */
const editBy = (repo: string, session: string, path: string, change: (file: string) => void): void => {
  hook(repo, 'PreToolUse', { session_id: session, tool_name: 'Edit', tool_input: { file_path: join(repo, path) } })
  change(join(repo, path))
}
const append = (text: string) => (file: string) => appendFileSync(file, text)

/**
 * 停止门里"跑测试"那一项（testpace 的：改了代码、当前内容没跑过 testpace focused）不归 modwall 管，认出来不算拦。
 * modwall 排在它前面，modwall 自己拦的照样看得到。
 */
const focusedOnly = (out: Record<string, any> | undefined): boolean => out?.decision === 'block' && /当前内容还没跑过 testpace focused/.test(out.reason)

/** 停止门：拦了返回给 agent 的话；没出声是 undefined；出了别的声原样返回（和 undefined 比就不相等）。 */
const stop = (repo: string, session: string): unknown => {
  const out = hook(repo, 'Stop', { session_id: session })
  if (focusedOnly(out)) return out?.systemMessage === undefined ? undefined : { systemMessage: out?.systemMessage }
  return out?.decision === 'block' ? (out.reason as string) : out
}

/** 只看拦没拦：默认分支上没测过的提交另有给用户的提示（"跑测试"模块的），那不算拦。 */
const blocked = (repo: string, session: string): string | undefined => {
  const out = hook(repo, 'Stop', { session_id: session })
  return out?.decision === 'block' && !focusedOnly(out) ? (out.reason as string) : undefined
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

  test('说明不在别的模块的名单、类型、常量、映射表、数据库约束里写上新功能的名字，改成对方收一个值或由装配层接进来', () => {
    const text = hook(sampleRepo(), 'SessionStart')?.hookSpecificOutput.additionalContext as string
    assert.match(text, /不给别的模块的已有函数加分支：为新功能在对方新增一个函数。不在别的模块的名单、类型、常量、映射表、数据库约束里写上新功能的名字：改成对方收一个值，或由装配层接进来。模块之间不能成环。/)
  })

  test('写了 database：加上数据库按模块分 schema 的约定；没写不提', () => {
    assert.doesNotMatch(hook(sampleRepo(), 'SessionStart')?.hookSpecificOutput.additionalContext as string, /schema/)
    const withDb = (extra: Record<string, unknown> = {}): string =>
      sampleRepo(dir => {
        const file = join(dir, '.modwall/config.json')
        const database = { migrations: 'migrations', shared: 'src/shared/migrations', login: '<module>_app', migrator: 'migrator', ...extra }
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), database }))
      })
    const text = hook(withDb(), 'SessionStart')?.hookSpecificOutput.additionalContext as string
    assert.match(text, /数据库（Postgres）也按模块分：.*入口 schema（<内部 schema>_api，不放表）.*模块之间不建外键（只存 id）.*迁移放在模块目录下的 migrations\/（共享层的在 src\/shared\/migrations\/）.*SET search_path = <本模块的内部 schema>, pg_temp.*SECURITY DEFINER.*每个模块一个同名的数据库角色（拥有对象，迁移切成它跑）和一个运行账号（<module>_app，只有本模块的读写授权，不拥有对象、不建对象），每个模块的代码用自己的运行账号连库/)
    assert.doesNotMatch(text, /切成模块的角色|切身份只在/)
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

describe('改文件之前（看路径，和要写进去的新文字）', () => {
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

  test('写文件时就拦绕过入口：新文字里用相对路径直接引用别的模块的内部文件，拒绝并说改法；走入口、同模块内部、共享层放行', () => {
    const repo = sampleRepo()
    const writing = (path: string, content: string, tool = 'Write'): Record<string, any> | undefined =>
      hook(repo, 'PreToolUse', {
        tool_name: tool,
        tool_input: tool === 'Write' ? { file_path: join(repo, path), content } : tool === 'Edit' ? { file_path: join(repo, path), old_string: 'x', new_string: content } : { file_path: join(repo, path), edits: [{ old_string: 'x', new_string: content }] },
      })
    const denied = (out: Record<string, any> | undefined): string | undefined => (out?.hookSpecificOutput.permissionDecision === 'deny' ? out.hookSpecificOutput.permissionDecisionReason : undefined)

    const reason = denied(writing('src/modules/billing/fee.ts', "import { slot } from '../booking/internal/slot.ts'\nexport const fee = slot\n"))
    assert.match(reason ?? '', /modwall（R1 绕过入口）：src\/modules\/billing\/fee\.ts（billing 模块）要 import booking 模块的内部文件（\.\.\/booking\/internal\/slot\.ts）。改成从 booking 的入口引用（src\/modules\/booking\/ 下的 index\.ts、index\.tsx、index\.js）；入口里没有，就先在对方入口新增导出/)
    // Edit、MultiEdit 替换进去的那几段也看；没写扩展名、写成 .js、export … from、require、import() 都认；装配层也只能走入口
    assert.ok(denied(writing('src/modules/billing/fee.ts', "import { slot } from '../booking/internal/slot'", 'Edit')))
    assert.ok(denied(writing('src/modules/billing/fee.ts', "export * from '../booking/internal/slot.js'", 'MultiEdit')))
    assert.ok(denied(writing('src/modules/billing/fee.ts', "const slot = require('../booking/rules')")))
    assert.ok(denied(writing('src/modules/billing/deep/fee.ts', "const m = await import('../../booking/internal/slot.ts')")))
    assert.ok(denied(writing('src/main.ts', "import { slot } from './modules/booking/internal/slot.ts'")))

    // 走入口：入口文件（.js 的写法对应 .ts 的入口）、直接引模块目录
    for (const ok of ["import { book } from '../booking/index.ts'", "import { book } from '../booking/index.js'", "import { book } from '../booking/index'", "import { book } from '../booking'"]) {
      assert.equal(writing('src/modules/billing/fee.ts', ok), undefined, ok)
    }
    // 同一个模块里互相引用、引共享层、整行注释里提到的、引样式和数据文件（留给 modwall check）：不拦
    assert.equal(writing('src/modules/booking/a.ts', "import { slot } from './internal/slot.ts'"), undefined)
    assert.equal(writing('src/modules/billing/fee.ts', "import { today } from '../../shared/date.ts'"), undefined)
    assert.equal(writing('src/modules/billing/fee.ts', "// import { slot } from '../booking/internal/slot.ts'\nexport const fee = 1\n"), undefined)
    assert.equal(writing('src/modules/billing/fee.ts', "import '../booking/internal/slot.css'\nimport data from '../booking/internal/data.json'"), undefined)
    // 没有新文字可看（只给了路径）：照旧只看路径
    assert.equal(edit(repo, 'src/modules/billing/fee.ts'), undefined)
  })

  test('配置里给这个文件写了绕过入口的例外：写文件时不拦，留给 modwall check 按例外判', () => {
    const repo = sampleRepo(dir => {
      const file = join(dir, '.modwall/config.json')
      const config = JSON.parse(readFileSync(file, 'utf8'))
      config.allow = [{ rule: 'R1', from: 'src/modules/billing/fee.ts', to: 'src/modules/booking/internal/slot.ts', reason: '历史原因' }]
      writeFileSync(file, JSON.stringify(config))
    })
    const out = hook(repo, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: join(repo, 'src/modules/billing/fee.ts'), content: "import { slot } from '../booking/internal/slot.ts'" } })
    assert.equal(out, undefined)
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
  test('这个会话没改东西：不拦；改了代码没跑 modwall check：拦一次；check 通过后放行；改了内容要重跑', () => {
    const repo = sampleRepo()
    hook(repo, 'SessionStart', { session_id: 's1' })
    assert.equal(stop(repo, 's1'), undefined)

    editBy(repo, 's1', 'src/modules/billing/index.ts', append('\nexport const fee = 1\n'))
    assert.match(stop(repo, 's1') as string, /改了代码或 modwall 的配置.*用 Bash 跑 modwall check.*confirm_with_user/)
    // 同一份内容只拦一次
    assert.equal(stop(repo, 's1'), undefined)
    // 会话又改了内容、还没有通过记录：再拦
    editBy(repo, 's1', 'src/modules/billing/index.ts', append('\nexport const fee2 = 1\n'))
    assert.match(stop(repo, 's1') as string, /modwall check/)

    assert.equal(modwall(repo, ['check']).code, 0)
    assert.equal(stop(repo, 's1'), undefined)
    // 只改文档不算
    editBy(repo, 's1', 'src/modules/billing/MODULE.md', file => writeFileSync(file, '负责收款和退款。\n'))
    assert.equal(stop(repo, 's1'), undefined)

    editBy(repo, 's1', 'src/modules/billing/index.ts', append('\nexport const tax = 1\n'))
    assert.match(stop(repo, 's1') as string, /modwall check/)
  })

  test('没有这个会话在这里的起点（比如这个模块是会话中途才装上的）：不说是这个会话改的，从这时算起；之后再改照常拦', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/modules/billing/index.ts'), '\nexport const fee = 1\n')
    // 这个会话没有过会话开始，也没在这里跑过命令：没有起点可比
    assert.equal(stop(repo, 'late'), undefined)
    editBy(repo, 'late', 'src/modules/billing/index.ts', append('\nexport const fee2 = 1\n'))
    assert.match(stop(repo, 'late') as string, /modwall check/)
  })

  test('改了配置也要重跑；压缩后再来一次会话开始，不覆盖会话开始时的样子', () => {
    const repo = sampleRepo()
    hook(repo, 'SessionStart', { session_id: 's2' })
    editBy(repo, 's2', '.modwall/config.json', file =>
      writeFileSync(file, '{"roots":["src/modules"],"entry":["index.ts"],"shared":["src/shared/**"],"app":["src/main.ts"],"outside":["scripts/**"]}'),
    )
    hook(repo, 'SessionStart', { session_id: 's2' })
    assert.match(stop(repo, 's2') as string, /modwall check/)
  })

  test('在默认分支上：检查通过后提交、默认分支往前走，通过记录照样有效；分叉点上的配置变了才要重跑', () => {
    const repo = sampleRepo()
    sh(repo, 'git checkout -q main')
    hook(repo, 'SessionStart', { session_id: 'main1' })
    editBy(repo, 'main1', 'src/modules/billing/index.ts', append('\nexport const fee = 1\n'))
    assert.match(blocked(repo, 'main1') as string, /modwall check/)
    assert.equal(modwall(repo, ['check']).code, 0)
    sh(repo, 'git add -A && git commit -qm fee')
    assert.equal(blocked(repo, 'main1'), undefined)
    assert.match(modwall(repo, ['status']).out, /当前内容 modwall check 通过过/)
    // 默认分支上又提交了别的东西（不是代码）：照样有效
    write(repo, 'notes.md', '说明\n')
    sh(repo, 'git add -A && git commit -qm notes')
    assert.equal(blocked(repo, 'main1'), undefined)
    // 提交了配置的改动：分叉点上的配置变了，要重跑
    editBy(repo, 'main1', '.modwall/config.json', file => {
      const config = JSON.parse(readFileSync(file, 'utf8'))
      config.entry = ['index.ts']
      writeFileSync(file, JSON.stringify(config, null, 2))
    })
    assert.equal(modwall(repo, ['check']).code, 0)
    sh(repo, 'git add -A && git commit -qm entry')
    assert.match(blocked(repo, 'main1') as string, /modwall check/)
  })

  test('同一个仓库两个工作区、两个会话：只进去看过别人工作区的会话不为那边的改动被拦；自己也动手改了那边，照常拦', () => {
    const env = { ...ENV, CLAUDE_PLUGIN_DATA: tempDir('modwall-data-') }
    const at = (cwd: string, event: string, extra: Record<string, unknown>): Record<string, any> | undefined => hook(cwd, event, extra, env)
    const stopIn = (cwd: string, session: string): string | undefined => {
      const out = at(cwd, 'Stop', { session_id: session })
      return out?.decision === 'block' ? (out.reason as string) : undefined
    }
    const mine = sampleRepo()
    const theirs = join(mine, '..', 'theirs')
    sh(mine, `git worktree add -q '${theirs}' -b theirs feature`)
    at(mine, 'SessionStart', { session_id: 'reader' })
    at(theirs, 'SessionStart', { session_id: 'writer' })

    // reader 在自己的目录里，用一条 cd 进去的命令只看了一眼别人的工作区
    at(mine, 'PreToolUse', { session_id: 'reader', tool_name: 'Bash', tool_input: { command: `cd '${theirs}' && modwall check` } })
    // writer 在自己的工作区里改代码（用改文件的工具，和命令里直接写）
    const file = join(theirs, 'src/modules/billing/index.ts')
    at(theirs, 'PreToolUse', { session_id: 'writer', tool_name: 'Edit', tool_input: { file_path: file } })
    appendFileSync(file, '\nexport const fee = 1\n')

    assert.equal(stopIn(mine, 'reader'), undefined)
    assert.match(stopIn(theirs, 'writer') as string, /改了代码或 modwall 的配置/)

    // reader 后来也用改文件的工具改了那边：它要为那边的内容负责（从它第一次碰到那里算起）
    at(mine, 'PreToolUse', { session_id: 'reader', tool_name: 'Edit', tool_input: { file_path: file } })
    appendFileSync(file, '\nexport const fee2 = 1\n')
    const reason = stopIn(mine, 'reader') ?? ''
    assert.ok(reason.includes(`这个会话在 ${realpathSync(theirs)} 改了代码或 modwall 的配置`), reason)
  })

  test('Codex 的 apply_patch 也算改文件：会话在自己的目录里，用补丁改了别的工作区，收尾时为那边拦', () => {
    const env = { ...ENV, CLAUDE_PLUGIN_DATA: tempDir('modwall-data-') }
    const mine = sampleRepo()
    const theirs = join(mine, '..', 'theirs')
    sh(mine, `git worktree add -q '${theirs}' -b theirs feature`)
    hook(mine, 'SessionStart', { session_id: 'cx' }, env, 'codex')
    // 补丁里的路径相对会话所在目录，也可以写绝对路径；一段补丁里可以有几个文件
    const patch = [
      '*** Begin Patch',
      '*** Add File: notes.md',
      '+说明',
      `*** Update File: ${join(theirs, 'src/modules/billing/index.ts')}`,
      '@@',
      '+export const fee = 1',
      '*** End Patch',
      '',
    ].join('\n')
    assert.equal(hook(mine, 'PreToolUse', { session_id: 'cx', tool_name: 'apply_patch', tool_input: { command: patch } }, env, 'codex'), undefined)
    appendFileSync(join(theirs, 'src/modules/billing/index.ts'), '\nexport const fee = 1\n')
    const out = hook(mine, 'Stop', { session_id: 'cx' }, env, 'codex')
    assert.equal(out?.decision, 'block')
    assert.ok(String(out?.reason).includes(`这个会话在 ${realpathSync(theirs)} 改了代码或 modwall 的配置`), String(out?.reason))
  })

  test('没接入的仓库不出声', () => {
    const outside = sampleRepo(dir => rmSync(join(dir, '.modwall'), { recursive: true }))
    write(outside, 'src/new.ts', 'export const x = 1\n')
    assert.equal(stop(outside, 's3'), undefined)
  })
})
