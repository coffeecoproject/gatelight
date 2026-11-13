// 合并门（git 钩子，真实执行 git 命令）、停止门和软提示（调 hook 的判断）：都在示例项目的副本上。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { handle, RHYTHM, rhythm } from '../src/hook.ts'
import { GATE_SNIPPET } from '../src/gate.ts'
import { Store } from '../src/store.ts'
import { agent, commit, ENV, gatedRepo, sampleRepo, setConfig, sh, tempDir, testpace } from './helpers.ts'

const ENTRY = fileURLToPath(new URL('../hooks/testpace.ts', import.meta.url))
// Claude Code 给 hook 的插件数据目录：会话碰过哪些仓库记在这里。
process.env.CLAUDE_PLUGIN_DATA = tempDir('testpace-data-')

type Output = { hookSpecificOutput?: Record<string, unknown>; decision?: string; reason?: string; systemMessage?: string } | undefined

// 会话在 cwd 里开始：SessionStart 已经说过节奏（cwd 是接入的仓库时），PreToolUse 不再补说。
function pre(cwd: string, command: string, session = 's1'): Output {
  handle({ hook_event_name: 'SessionStart', session_id: session, cwd }, Date.now())
  return handle({ hook_event_name: 'PreToolUse', session_id: session, cwd, tool_name: 'Bash', tool_input: { command } }, Date.now()) as Output
}

function stop(cwd: string, session = 's1', active = false): Output {
  return handle({ hook_event_name: 'Stop', session_id: session, cwd, stop_hook_active: active }, Date.now()) as Output
}

// 在这个会话里起整组：Claude Code 给 agent 的命令带着会话号。
function fullIn(repo: string, session: string): number | null {
  return testpace(repo, ['full'], { ...ENV, CLAUDE_CODE_SESSION_ID: session }).code
}

function change(repo: string, text = '// 改过\n'): void {
  writeFileSync(join(repo, 'src', 'price.mjs'), `${sh(repo, 'cat src/price.mjs')}${text}`)
}

describe('合并门（git 钩子）', () => {
  const head = (repo: string, ref = 'main'): string => sh(repo, `git rev-parse ${ref}`).trim()

  /** 装好钩子的仓库，另有一个比 main 多一次（没测过的）提交的分支 feature。 */
  function withFeature(): string {
    const repo = gatedRepo()
    sh(repo, 'git checkout -qb feature')
    change(repo)
    commit(repo, 'feature')
    sh(repo, 'git checkout -q main')
    return repo
  }

  test('没测过的提交被取消，main 不动；跑过整组再提交就落地', () => {
    const repo = gatedRepo()
    const before = head(repo)
    change(repo)
    const r = agent(repo, 'git commit -qam 改价格')
    assert.notEqual(r.code, 0)
    assert.match(r.out, /testpace 合并门：这次要把 main 更新到 [0-9a-f]{10}，那份代码（[0-9a-f]{10}）没有整组通过记录，main 没有更新。\n先在要落地的这份代码上跑 testpace full/)
    assert.equal(head(repo), before)
    assert.equal(testpace(repo, ['full']).code, 0)
    assert.equal(agent(repo, 'git commit -qam 改价格').code, 0)
    assert.notEqual(head(repo), before)
  })

  test('工作区测过、但提交的内容和工作区不一样时说明差在哪', () => {
    const repo = gatedRepo()
    change(repo)
    writeFileSync(join(repo, 'src', 'extra.mjs'), 'export const x = 1\n')
    assert.equal(testpace(repo, ['full']).code, 0)
    assert.match(agent(repo, 'git commit -qam m').out, /工作区的整组通过了，但要落地的内容和工作区不一样/)
    assert.equal(agent(repo, 'git add -A && git commit -qm m').code, 0)
  })

  test('不管命令怎么写，按要落地的提交判断', () => {
    const repo = withFeature()
    const before = head(repo)
    writeFileSync(join(repo, 'land.sh'), 'git merge -q feature\n')
    const ways = [
      'git merge -q feature',
      '{ git merge -q feature; }',
      'if true; then git merge -q feature; fi',
      'sh land.sh',
      'git cherry-pick feature',
      'git reset -q --hard feature',
      'git update-ref refs/heads/main feature',
    ]
    for (const way of ways) {
      const r = agent(repo, way)
      assert.notEqual(r.code, 0, way)
      assert.match(r.out, /testpace 合并门：这次要把 main 更新到/, way)
      assert.equal(head(repo), before, way)
      sh(repo, 'git cherry-pick --abort 2>/dev/null; git reset -q --hard main')
    }
    // 在别的 worktree 里移动 main 也一样（钩子所有 worktree 共用）
    const other = join(tempDir('testpace-wt-'), 'wt')
    sh(repo, `git worktree add -q --detach '${other}' feature`)
    assert.notEqual(agent(other, 'git update-ref refs/heads/main feature').code, 0)
    assert.equal(head(repo), before)
  })

  test('有冲突时 -X theirs 自动合出来的结果、在 main 上 rebase 出来的结果，没测过都不落地', () => {
    const repo = withFeature()
    change(repo, '// main 上也改了这一行\n')
    commit(repo, 'main side')
    const before = head(repo)
    assert.match(agent(repo, 'git merge -q -X theirs --no-edit feature').out, /testpace 合并门：这次要把 main 更新到/)
    assert.equal(head(repo), before)
    sh(repo, 'git merge --abort 2>/dev/null; git reset -q --hard main')
    assert.match(agent(repo, 'git rebase -q -X theirs feature').out, /testpace 合并门：这次要把 main 更新到/)
    sh(repo, 'git rebase --abort 2>/dev/null; git checkout -q main')
    assert.equal(head(repo), before)
  })

  test('快进到测过的合并分支放行；同步远程已有的提交、退回以前的提交都不算新落地', () => {
    const repo = withFeature()
    sh(repo, 'git checkout -q feature')
    assert.equal(testpace(repo, ['full']).code, 0)
    sh(repo, 'git checkout -q main')
    assert.equal(agent(repo, 'git merge -q --ff-only feature').code, 0)
    assert.equal(agent(repo, 'git reset -q --hard HEAD~1').code, 0, '退回以前的提交')
    // 远程的 main 多一个提交：用 refs/remotes/origin/main 模拟 fetch 之后的状态
    change(repo, '// 远程的提交\n')
    commit(repo, 'remote work')
    sh(repo, 'git update-ref refs/remotes/origin/main HEAD && git reset -q --hard HEAD~1')
    assert.equal(agent(repo, 'git merge -q --ff-only origin/main').code, 0)
  })

  test('分支上的提交、用户在终端里的操作、没接入的仓库都不管', () => {
    const repo = gatedRepo()
    change(repo)
    assert.equal(agent(repo, 'git checkout -qb fix && git commit -qam m').code, 0, '先开分支再提交')
    sh(repo, 'git checkout -q main')
    change(repo, '// 用户自己改\n')
    assert.doesNotThrow(() => commit(repo, '用户在终端里提交'))
    sh(repo, 'git rm -q testpace.json')
    commit(repo, '不接入了')
    change(repo, '// 没接入\n')
    assert.equal(agent(repo, 'git commit -qam m').code, 0)
  })

  test('管不管、按哪些 ignore 判断都看提交里的 testpace.json，工作区里的文件不影响', () => {
    const repo = gatedRepo()
    assert.equal(testpace(repo, ['full']).code, 0)
    const before = head(repo)
    const blocked = (script: string, why: string): string => {
      const r = agent(repo, script)
      assert.match(r.out, /testpace 合并门：这次要把 main 更新到/, why)
      assert.equal(head(repo), before, why)
      sh(repo, 'git reset -q --hard main')
      return r.out
    }
    change(repo)
    writeFileSync(join(repo, 'testpace.json'), '{')
    blocked('git add src && git commit -qm m', '工作区里的 testpace.json 写坏了')
    change(repo)
    rmSync(join(repo, 'testpace.json'))
    blocked('git add src && git commit -qm m', '工作区里删了 testpace.json，没提交这个删除')
    change(repo)
    setConfig(repo, { ignore: ['**'] })
    blocked('git add src && git commit -qm m', '工作区里把 ignore 改成了全部，没提交')
    // 改 ignore 的提交本身也要测过：testpace.json 自己不算忽略路径，通过记录不沿用到约定不一样的代码
    change(repo)
    setConfig(repo, { ignore: ['**'] })
    blocked('git commit -qam m', '把 ignore 改成全部，和没测过的改动一起提交')
    change(repo)
    assert.match(
      blocked('git rm -q testpace.json && git commit -qam m', '删掉 testpace.json 的提交'),
      /要落地的提交删掉了 testpace\.json，拿不到整组通过记录。要退出接入，由用户自己在终端里提交；不是要退出，就把它恢复回来。/,
    )
    change(repo)
    writeFileSync(join(repo, 'testpace.json'), '{')
    assert.match(
      blocked('git commit -qam m', '提交了写坏的 testpace.json'),
      /要落地的代码里的 testpace\.json 有问题：testpace\.json 不是合法的 JSON：.*。testpace full 跑不了，拿不到整组通过记录：先修好它/,
    )
    // 接入之前分出去的老分支（和 main 后来的提交不在一条线上，也没有 testpace.json）：在它的工作区里移动 main 也一样
    sh(repo, 'git checkout -q --orphan old && git rm -qf testpace.json')
    change(repo)
    commit(repo, 'old')
    sh(repo, 'git checkout -q main')
    const other = join(tempDir('testpace-wt-'), 'wt')
    sh(repo, `git worktree add -q '${other}' old`)
    assert.match(
      agent(other, 'git update-ref refs/heads/main old').out,
      /要落地的代码里没有 testpace\.json（main 上有），拿不到整组通过记录：这个分支是接入之前分出去的。把 main 合进这个分支再测。/,
    )
    assert.equal(head(repo), before)
  })

  test('只改了提交里的 ignore 路径的提交放行；分支上给 ignore 加了路径并测过，之后只改那些路径也放行', () => {
    const repo = gatedRepo()
    assert.equal(testpace(repo, ['full']).code, 0)
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'note.md'), '说明\n')
    assert.equal(agent(repo, 'git add -A && git commit -qm docs').code, 0, '示例约定里 ignore 是 docs/**')
    // main 上的约定还没有 notes/**：按要落地的那份约定判断
    sh(repo, 'git checkout -qb feature')
    setConfig(repo, { ignore: ['docs/**', 'notes/**'] })
    mkdirSync(join(repo, 'notes'))
    writeFileSync(join(repo, 'notes', 'a.md'), '一\n')
    assert.equal(testpace(repo, ['full']).code, 0)
    commit(repo, '加 notes，记进 ignore')
    writeFileSync(join(repo, 'notes', 'a.md'), '一\n二\n')
    commit(repo, '只改 notes')
    sh(repo, 'git checkout -q main')
    const r = agent(repo, 'git merge -q --ff-only feature')
    assert.equal(r.code, 0, r.out)
    assert.equal(head(repo), head(repo, 'feature'))
  })

  test('同步远程：远程跟踪分支和本地默认分支在同一次更新里一起动时放行；不经过远程跟踪分支的照样拦，说明同步的写法', () => {
    const repo = gatedRepo()
    const up = join(tempDir('testpace-up-'), 'up')
    sh(repo, `git clone -q . '${up}' && git remote add origin '${up}' && git fetch -q origin`)
    change(up)
    commit(up, '远程的新提交')
    const tip = head(up)
    sh(repo, 'git checkout -q --detach')
    const direct = agent(repo, `git fetch -q '${up}' main:main`)
    assert.match(direct.out, /只是同步远程的 main 的话：先 git fetch <远程>，再把 main 快进到 <远程>\/main。/)
    assert.notEqual(head(repo), tip)
    const synced = agent(repo, 'git fetch -q --atomic origin main:main')
    assert.equal(synced.code, 0, synced.out)
    assert.equal(head(repo), tip)
  })

  test('钩子找不到 testpace 命令（插件没启用）时说一句，不挡', () => {
    const repo = gatedRepo()
    change(repo)
    const r = agent(repo, 'git commit -qam m', { PATH: '/usr/bin:/bin' })
    assert.equal(r.code, 0)
    assert.match(r.out, /找不到 testpace 命令/)
  })

  test('install 装进 core.hooksPath 指的目录，不覆盖别人的钩子；status 和会话开始时说出合并门没在把关的原因', () => {
    const repo = sampleRepo()
    assert.match(testpace(repo, ['status']).out, /合并门：合并门的 git 钩子还没装，提交、合并到默认分支时不会检查。跑 testpace install 装上。/)
    const start = handle({ hook_event_name: 'SessionStart', session_id: 'i', cwd: repo }, Date.now()) as Output
    assert.match(String(start?.hookSpecificOutput?.additionalContext), /^.*用 testpace 管测试节奏[\s\S]*跑 testpace install 装上。$/)

    sh(repo, 'git config core.hooksPath .githooks')
    // core.hooksPath 指的目录还不存在：看不出它进不进版本库，不装
    const noDir = /钩子目录 \.githooks（core\.hooksPath）在这个工作区里还不存在，git 不会跑那里的任何钩子，合并门没有生效。/
    assert.match(testpace(repo, ['status']).out, noDir)
    const refused = testpace(repo, ['install'])
    assert.equal(refused.code, 2)
    assert.match(refused.out, /^没有装：钩子目录 \.githooks/)
    assert.equal(sh(repo, 'ls -a').includes('.githooks'), false)
    mkdirSync(join(repo, '.githooks'))
    const installed = testpace(repo, ['install'])
    assert.equal(installed.code, 0)
    assert.match(installed.out, /合并门已装上：.*\/\.githooks\/reference-transaction\n这个钩子在项目目录里（core.hooksPath），和 testpace.json 一样要提交进仓库。/)
    assert.match(testpace(repo, ['status']).out, /合并门：已装上/)

    const hook = join(repo, '.githooks', 'reference-transaction')
    writeFileSync(hook, '#!/bin/sh\n# testpace 合并门\nexit 0\n')
    assert.match(testpace(repo, ['status']).out, /合并门的 git 钩子是旧版本/)
    assert.equal(testpace(repo, ['install']).code, 0, '旧版本直接更新')
    writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    const foreign = testpace(repo, ['install'])
    assert.equal(foreign.code, 2)
    assert.match(foreign.out, /已经有别的 reference-transaction 钩子，没有覆盖。要用合并门，在那个钩子开头/)
    assert.ok(foreign.out.includes(GATE_SNIPPET.replace(/^/gm, '  ')), '说明里给出完整的检查片段')
    assert.equal(sh(repo, 'cat .githooks/reference-transaction'), '#!/bin/sh\nexit 0\n')
    // 照说明把检查加进项目自己的钩子：算装上了，不动它，真的在把关，钩子原来的内容也照样读得到 git 给的引用更新
    const seen = join(tempDir('testpace-seen-'), 'refs')
    const merged = `#!/bin/sh\n${GATE_SNIPPET}\n# 项目自己的钩子：记下要更新的引用\n[ "$1" = prepared ] && cat >> '${seen}'\nexit 0\n`
    writeFileSync(hook, merged)
    const kept = testpace(repo, ['install'])
    assert.equal(kept.code, 0)
    assert.match(kept.out, /是项目自己的钩子，里面已经调用了 testpace gate，没有改动它。/)
    assert.equal(sh(repo, 'cat .githooks/reference-transaction'), merged)
    assert.match(testpace(repo, ['status']).out, /合并门：已装上/)
    commit(repo, '提交钩子')
    change(repo)
    assert.match(agent(repo, 'git commit -qam m').out, /testpace 合并门：这次要把 main 更新到/)
    assert.equal(agent(repo, 'git checkout -qb fix && git commit -qam m').code, 0, '分支上的提交照常放行')
    assert.match(sh(repo, `cat '${seen}'`), /^[0-9a-f]+ [0-9a-f]+ refs\/heads\/fix$/m, '钩子原来的内容读到了 testpace gate 读过的引用更新')

    // 钩子目录被 .gitignore 忽略（husky 的 .husky/_ 这类）：不说要提交，说每个工作区各装一次
    const husky = sampleRepo()
    mkdirSync(join(husky, '.husky', '_'), { recursive: true })
    writeFileSync(join(husky, '.husky', '_', '.gitignore'), '*\n')
    sh(husky, 'git config core.hooksPath .husky/_')
    assert.match(
      testpace(husky, ['status']).out,
      /合并门：合并门的 git 钩子还没装，提交、合并到默认分支时不会检查。这个项目的钩子目录（\.husky\/_）不进版本库，每个工作区要各装一次。跑 testpace install 装上。/,
    )
    const ignored = testpace(husky, ['install'])
    assert.match(ignored.out, /合并门已装上：.*\/\.husky\/_\/reference-transaction\n这个钩子目录不进版本库（被 \.gitignore 忽略）：每个工作区、每次重新克隆后都要再跑一次 testpace install。/)
    assert.match(testpace(husky, ['status']).out, /合并门：已装上/)
    // 新的工作区里还没装依赖、.husky/_ 还没生成：不装，免得写出一个没被忽略、会被当成项目文件提交的钩子
    const fresh = join(tempDir('testpace-wt-'), 'wt')
    sh(husky, `git worktree add -q '${fresh}' -b fresh`)
    assert.match(testpace(fresh, ['status']).out, /合并门：钩子目录 \.husky\/_（core\.hooksPath）在这个工作区里还不存在[\s\S]*先装依赖再跑 testpace install/)
    assert.equal(testpace(fresh, ['install']).code, 2)
    assert.equal(sh(fresh, 'git status --porcelain --untracked-files=all'), '')

    const trunk = tempDir('testpace-trunk-')
    sh(trunk, `cp -R ${join(repo, 'src')} ${join(repo, 'testpace.json')} . && git init -q -b trunk && git add -A && git -c user.name=t -c user.email=t@t commit -qm i`)
    assert.match(testpace(trunk, ['status']).out, /合并门：找不到默认分支（没有 origin\/HEAD，本地也没有 main、master），合并门没有生效。/)
  })

  test('项目的钩子目录跟着分支走：分支上还没有钩子的工作区里不检查，说清楚合进默认分支就有', () => {
    const repo = sampleRepo()
    sh(repo, 'git branch old && git config core.hooksPath .githooks && mkdir .githooks')
    assert.equal(testpace(repo, ['install']).code, 0)
    commit(repo, '提交合并门钩子')
    // 检出的提交里有钩子、只是工作区里删了：照常提示安装，装回去和提交的一样
    rmSync(join(repo, '.githooks', 'reference-transaction'))
    assert.match(testpace(repo, ['status']).out, /合并门：合并门的 git 钩子还没装/)
    assert.equal(testpace(repo, ['install']).code, 0)
    assert.equal(sh(repo, 'git status --porcelain'), '')
    const other = join(tempDir('testpace-wt-'), 'wt')
    sh(repo, `git worktree add -q '${other}' old`)
    assert.match(
      testpace(other, ['status']).out,
      /合并门：这个工作区检出的代码里还没有合并门的钩子（\.githooks\/reference-transaction）：项目的钩子目录跟着分支走，main 上已经有了，把 main 合进这个分支就有，不用在这里装。/,
    )
    // 在这里装会写出未跟踪的钩子文件，之后把 main 合进来时 git 会因为它拒绝合并：不装
    const refused = testpace(other, ['install'])
    assert.equal(refused.code, 2)
    assert.match(refused.out, /^没有装：这个工作区检出的代码里还没有合并门的钩子/)
    assert.equal(sh(other, 'git status --porcelain --untracked-files=all'), '')
    // 说明里讲的缺口是真的：这个工作区里移动 main 不经过钩子
    change(other)
    commit(other, 'old 上没测过的提交')
    assert.equal(agent(other, 'git update-ref refs/heads/main old').code, 0)
    sh(repo, 'git reset -q --hard main@{1}')
    sh(other, 'git merge -q --no-edit main')
    assert.match(testpace(other, ['status']).out, /合并门：已装上/)
    const after = agent(other, 'git update-ref refs/heads/main old')
    assert.match(after.out, /testpace 合并门：这次要把 main 更新到/, '合进默认分支后就检查')
  })
})

describe('软提示', () => {
  test('会话开始时注入节奏说明，没接入约定的仓库不注入', () => {
    const repo = gatedRepo()
    const output = handle({ hook_event_name: 'SessionStart', session_id: 's', cwd: repo }, Date.now()) as Output
    assert.deepEqual(output, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: RHYTHM } })
    assert.equal(handle({ hook_event_name: 'SessionStart', session_id: 's-none', cwd: tempDir('testpace-none-') }, Date.now()), undefined)
  })

  test('会话不在接入的仓库里开始时，第一条碰到那个仓库的命令补说一次节奏，写上是哪个仓库', () => {
    const repo = gatedRepo()
    const root = sh(repo, 'git rev-parse --show-toplevel').trim()
    const parent = tempDir('testpace-parent-')
    const run = (cwd: string, command: string): Output =>
      handle({ hook_event_name: 'PreToolUse', session_id: 'p', cwd, tool_name: 'Bash', tool_input: { command } }, Date.now()) as Output
    assert.equal(handle({ hook_event_name: 'SessionStart', session_id: 'p', cwd: parent }, Date.now()), undefined)
    assert.equal(run(parent, 'ls'), undefined, '没碰到接入的仓库不说')
    const told = run(parent, `cd ${repo} && git status`)?.hookSpecificOutput?.additionalContext
    assert.equal(told, rhythm(`${root} 这个仓库`))
    assert.equal(run(parent, `cd ${repo} && git status`), undefined, '同一会话只说一次')
    assert.equal(run(repo, 'git status'), undefined, '会话后来在仓库里也不再说')
    assert.match(String(run(repo, 'node scripts/full.mjs')?.hookSpecificOutput?.additionalContext), /^这是 testpace.json 里的整组命令/)
    // 压缩、恢复后会话重新开始：碰过的仓库再说一次，之后的命令不再说
    const again = handle({ hook_event_name: 'SessionStart', session_id: 'p', cwd: parent }, Date.now()) as Output
    assert.equal(again?.hookSpecificOutput?.additionalContext, rhythm(`${root} 这个仓库`))
    assert.equal(run(parent, `cd ${repo} && git status`), undefined)
    // 换一个会话，补说和别的提示一起出
    const both = handle({ hook_event_name: 'PreToolUse', session_id: 'q', cwd: repo, tool_name: 'Bash', tool_input: { command: 'node scripts/full.mjs' } }, Date.now()) as Output
    assert.match(String(both?.hookSpecificOutput?.additionalContext), /用 testpace 管测试节奏[\s\S]*\n\n这是 testpace.json 里的整组命令/)
  })

  test('testpace.json 写坏了照样说明节奏并讲出问题，停止门和合并门的状态照常', () => {
    const repo = gatedRepo()
    assert.equal(fullIn(repo, 'k'), 0)
    writeFileSync(join(repo, 'testpace.json'), '{')
    const start = handle({ hook_event_name: 'SessionStart', session_id: 'k', cwd: repo }, Date.now()) as Output
    assert.match(
      String(start?.hookSpecificOutput?.additionalContext),
      /用 testpace 管测试节奏[\s\S]*\ntestpace\.json 有问题：testpace\.json 不是合法的 JSON：.+。$/,
    )
    assert.match(stop(repo, 'k')?.reason ?? '', /^这个会话跑的整组已经结束（通过），还没看结果/)
    const status = testpace(repo, ['status'])
    assert.equal(status.code, 2)
    assert.match(status.out, /配置（testpace\.json）：testpace\.json 不是合法的 JSON[\s\S]*合并门：已装上/)
  })

  test('直接跑配置里的整组命令时提示改用 testpace full', () => {
    const repo = sampleRepo()
    assert.match(String(pre(repo, 'node scripts/full.mjs 2>&1 | tail')?.hookSpecificOutput?.additionalContext), /改用 testpace full/)
    assert.equal(pre(repo, 'testpace full'), undefined)
    assert.equal(pre(repo, 'node scripts/check.mjs'), undefined)
    assert.ok(pre(repo, 'CI=1 node scripts/full.mjs > out.log')?.hookSpecificOutput, '环境变量前缀和重定向不影响')
    assert.equal(pre(repo, 'node scripts/full.mjs --watch'), undefined, '参数不一样就不是那条命令')
  })
})

describe('停止门', () => {
  test('这个会话起的整组跑完还没看结果时拦一次；看过（testpace status）就放行', () => {
    const repo = sampleRepo()
    handle({ hook_event_name: 'SessionStart', session_id: 'a', cwd: repo }, Date.now())
    assert.equal(stop(repo, 'a'), undefined)
    assert.equal(fullIn(repo, 'a'), 0)
    assert.match(stop(repo, 'a')?.reason ?? '', /^这个会话跑的整组已经结束（通过），还没看结果。先跑 testpace status/)
    assert.equal(stop(repo, 'a')?.decision, 'block')
    assert.equal(stop(repo, 'a', true), undefined, '已经因为停止门继续过一次，不再拦')
    testpace(repo, ['status'], { ...ENV, CLAUDE_CODE_SESSION_ID: 'z' })
    assert.ok(stop(repo, 'a')?.reason, '别的会话看了结果不算')
    testpace(repo, ['status'])
    assert.ok(stop(repo, 'a')?.reason, '用户在终端里看了也不算')
    testpace(repo, ['status'], { ...ENV, CLAUDE_CODE_SESSION_ID: 'a' })
    assert.equal(stop(repo, 'a'), undefined)
  })

  test('会话从仓库外开始时，也查它碰过的仓库，话里写上是哪个仓库', () => {
    const repo = sampleRepo()
    const root = sh(repo, 'git rev-parse --show-toplevel').trim()
    const parent = tempDir('testpace-parent-')
    handle({ hook_event_name: 'SessionStart', session_id: 'o', cwd: parent }, Date.now())
    handle({ hook_event_name: 'PreToolUse', session_id: 'o', cwd: parent, tool_name: 'Bash', tool_input: { command: `cd ${repo} && testpace full` } }, Date.now())
    assert.equal(fullIn(repo, 'o'), 0)
    assert.equal(stop(parent, 'o')?.reason, `这个会话在 ${root} 跑的整组已经结束（通过），还没看结果。先跑 testpace status 看结果，再收尾。`)
    testpace(repo, ['status'], { ...ENV, CLAUDE_CODE_SESSION_ID: 'o' })
    assert.equal(stop(parent, 'o'), undefined)
    // 没有插件数据目录（不在 Claude Code 里跑）时只认会话所在目录
    const data = process.env.CLAUDE_PLUGIN_DATA
    delete process.env.CLAUDE_PLUGIN_DATA
    try {
      handle({ hook_event_name: 'PreToolUse', session_id: 'o2', cwd: parent, tool_name: 'Bash', tool_input: { command: `cd ${repo} && ls` } }, Date.now())
      assert.equal(fullIn(repo, 'o2'), 0)
      assert.equal(stop(parent, 'o2'), undefined)
    } finally {
      process.env.CLAUDE_PLUGIN_DATA = data
    }
  })

  test('前台跑完 testpace full 算看过，失败的（Claude Code 发 PostToolUseFailure）也算；放到后台的不算', () => {
    const repo = sampleRepo()
    handle({ hook_event_name: 'SessionStart', session_id: 'b', cwd: repo }, Date.now())
    assert.equal(fullIn(repo, 'b'), 0)
    const post = (event: string, input: Record<string, unknown>, response?: unknown): unknown =>
      handle({ hook_event_name: event, session_id: 'b', cwd: repo, tool_name: 'Bash', tool_input: { command: 'testpace full', ...input }, tool_response: response }, Date.now())
    post('PostToolUse', {}, { backgroundTaskId: 'task1' })
    assert.ok(stop(repo, 'b')?.reason)
    post('PostToolUse', { run_in_background: true }, {})
    assert.ok(stop(repo, 'b')?.reason)
    post('PostToolUse', {}, { stdout: '整组通过' })
    assert.equal(stop(repo, 'b'), undefined)

    setConfig(repo, { full: 'false' })
    assert.equal(fullIn(repo, 'b'), 1)
    assert.match(stop(repo, 'b')?.reason ?? '', /^这个会话跑的整组已经结束（失败），还没看结果/)
    post('PostToolUseFailure', {})
    assert.equal(stop(repo, 'b'), undefined)
  })

  test('整组还在跑时拦下来', () => {
    const repo = sampleRepo()
    handle({ hook_event_name: 'SessionStart', session_id: 'c', cwd: repo }, Date.now())
    const store = new Store(join(repo, '.git'))
    // 和 testpace full 一样按 git 给的根目录登记（macOS 上临时目录的真实路径在 /private 下）
    const root = sh(repo, 'git rev-parse --show-toplevel').trim()
    assert.equal(store.claim({ id: 'r1', kind: 'full', pid: process.pid, worktree: root, tree: 't', startedAt: Date.now(), session: 'c', log: '/dev/null' }), undefined)
    try {
      assert.match(stop(repo, 'c')?.reason ?? '', /^这个工作区的整组还在跑（开始于 .+，已 \d+秒）/)
      // 别的会话想跑整组，发现已经在跑：它等着用这次的结果，也要拦
      handle({ hook_event_name: 'SessionStart', session_id: 'c2', cwd: repo }, Date.now())
      assert.equal(testpace(repo, ['full'], { ...ENV, CLAUDE_CODE_SESSION_ID: 'c2' }).code, 3)
      assert.match(stop(repo, 'c2')?.reason ?? '', /^这个工作区的整组还在跑/)
      handle({ hook_event_name: 'SessionStart', session_id: 'c3', cwd: repo }, Date.now())
      assert.equal(stop(repo, 'c3'), undefined, '没起也没等的会话不管')
    } finally {
      store.release(root, 'r1')
    }
  })

  test('等着用别人整组结果的会话：跑完还没看结果时也拦', () => {
    const repo = sampleRepo()
    const root = sh(repo, 'git rev-parse --show-toplevel').trim()
    handle({ hook_event_name: 'SessionStart', session_id: 'w', cwd: repo }, Date.now())
    new Store(join(repo, '.git')).appendRun({
      id: 'r2', kind: 'full', worktree: root, tree: 't', treeAtEnd: 't', startedAt: Date.now() - 2000, durationMs: 1000,
      exitCode: 0, result: 'pass', session: 'a', waiting: ['w'], log: '/dev/null',
    })
    assert.match(stop(repo, 'w')?.reason ?? '', /^这个会话等的整组已经结束（通过），还没看结果/)
    testpace(repo, ['status'], { ...ENV, CLAUDE_CODE_SESSION_ID: 'w' })
    assert.equal(stop(repo, 'w'), undefined)
  })

  test('别的会话、或不在 Claude Code 里起的整组不管', () => {
    const repo = sampleRepo()
    handle({ hook_event_name: 'SessionStart', session_id: 'd', cwd: repo }, Date.now())
    assert.equal(fullIn(repo, 'other'), 0)
    assert.equal(stop(repo, 'd'), undefined)
    change(repo)
    assert.equal(testpace(repo, ['full']).code, 0)
    assert.equal(stop(repo, 'd'), undefined)
    assert.match(stop(repo, 'other')?.reason ?? '', /^这个会话跑的整组已经结束/)
  })

  test('本地或远程默认分支在会话里有了没测过的提交，提示用户一次', () => {
    const repo = sampleRepo()
    handle({ hook_event_name: 'SessionStart', session_id: 'e', cwd: repo }, Date.now())
    change(repo)
    commit(repo, '用户在终端里提交')
    const head = sh(repo, 'git rev-parse --short=10 HEAD').trim()
    const first = stop(repo, 'e')
    assert.equal(first?.systemMessage, `testpace：main 的最新提交 ${head} 没有整组通过记录（可能是在 Claude Code 之外提交的，或者合并门没装上）。`)
    assert.equal(first?.decision, undefined, '只提示，不拦')
    assert.equal(stop(repo, 'e'), undefined, '同一个提交只提示一次')
    // 推送别的分支到默认分支、在 GitHub 上合并 PR：本地 main 没动，fetch 之后 origin/main 有了没测过的提交
    sh(repo, 'git checkout -qb feature')
    change(repo, '// 推到远程\n')
    commit(repo, 'pushed')
    sh(repo, 'git update-ref refs/remotes/origin/main HEAD')
    const pushed = sh(repo, 'git rev-parse --short=10 HEAD').trim()
    assert.equal(stop(repo, 'e')?.systemMessage, `testpace：origin/main 的最新提交 ${pushed} 没有整组通过记录（可能是推送了别的分支到默认分支，或者在 GitHub 上合并了 PR）。`)
    assert.equal(testpace(repo, ['full']).code, 0)
    change(repo, '// 测过再推\n')
    commit(repo, 'tested')
    assert.equal(testpace(repo, ['full']).code, 0)
    sh(repo, 'git update-ref refs/remotes/origin/main HEAD')
    assert.equal(stop(repo, 'e'), undefined, '测过的不提示')
  })

  test('默认分支的新提交和合并门一样按提交里的 testpace.json 判断，工作区里的文件不影响', () => {
    const repo = sampleRepo()
    assert.equal(testpace(repo, ['full']).code, 0)
    handle({ hook_event_name: 'SessionStart', session_id: 'f', cwd: repo }, Date.now())
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'note.md'), '说明\n')
    commit(repo, '只改了提交里 ignore 的路径')
    writeFileSync(join(repo, 'testpace.json'), '{')
    assert.equal(stop(repo, 'f'), undefined, '工作区里的 testpace.json 写坏了，照样按提交里的 ignore 算')
    // 提交里去掉、工作区里留着（记进 .git/info/exclude，git add -A 不再带上它）
    sh(repo, 'git checkout -q testpace.json && git rm -q --cached testpace.json && echo testpace.json >> .git/info/exclude')
    commit(repo, '提交里去掉了 testpace.json')
    assert.match(stop(repo, 'f')?.systemMessage ?? '', /^testpace：main 的最新提交 [0-9a-f]{10} 没有整组通过记录/, '会话开始时提交里还有')

    // 提交里从来没有 testpace.json（工作区里刚写好还没提交）：合并门不管，这里也不提示
    const fresh = sampleRepo()
    sh(fresh, 'git rm -q --cached testpace.json && echo testpace.json >> .git/info/exclude')
    commit(fresh, '还没接入')
    handle({ hook_event_name: 'SessionStart', session_id: 'g', cwd: fresh }, Date.now())
    change(fresh)
    sh(fresh, `git add src && git -c user.name=t -c user.email=t@t commit -qm '只提交代码'`)
    assert.equal(stop(fresh, 'g'), undefined)
  })
})

test('hook 入口：从标准输入读事件，把判断写到标准输出', () => {
  const repo = gatedRepo()
  const run = (input: unknown): string =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY], { input: JSON.stringify(input), env: ENV, encoding: 'utf8' }).stdout
  const pre = (command: string): string => run({ hook_event_name: 'PreToolUse', session_id: 'x', cwd: repo, tool_name: 'Bash', tool_input: { command } })
  const output = JSON.parse(pre('node scripts/full.mjs'))
  assert.match(output.hookSpecificOutput.additionalContext, /用 testpace 管测试节奏[\s\S]*改用 testpace full/)
  assert.equal(pre('ls'), '', '节奏只说一次')
  // 输入坏了也不挡 agent
  const broken = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY], { input: '{', env: ENV, encoding: 'utf8' })
  assert.equal(broken.status, 0)
  assert.equal(broken.stdout, '')
})

test('hooks.json 把用到的事件都交给入口：Bash 的三个工具事件只看 Bash', () => {
  const { hooks } = JSON.parse(readFileSync(fileURLToPath(new URL('../hooks/hooks.json', import.meta.url)), 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
  }
  const registered = Object.fromEntries(Object.entries(hooks).map(([event, entries]) => [event, entries.map(entry => entry.matcher ?? '')]))
  assert.deepEqual(registered, { SessionStart: [''], PreToolUse: ['Bash'], PostToolUse: ['Bash'], PostToolUseFailure: ['Bash'], Stop: [''] })
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) assert.match(entry.hooks[0]!.command, /"\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/testpace\.ts"$/)
  }
})
