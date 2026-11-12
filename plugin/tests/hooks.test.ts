// 合并门、停止门和软提示：在示例项目的副本上调 hook 的判断。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { handle, RHYTHM } from '../src/hook.ts'
import { Store } from '../src/store.ts'
import { commit, ENV, sampleRepo, sh, tempDir, testpace } from './helpers.ts'

const ENTRY = fileURLToPath(new URL('../hooks/testpace.ts', import.meta.url))

type Output = { hookSpecificOutput?: Record<string, unknown>; decision?: string; reason?: string; systemMessage?: string } | undefined

function pre(cwd: string, command: string, session = 's1'): Output {
  return handle({ hook_event_name: 'PreToolUse', session_id: session, cwd, tool_name: 'Bash', tool_input: { command } }, Date.now()) as Output
}

function denied(output: Output): string | undefined {
  const specific = output?.hookSpecificOutput
  return specific?.permissionDecision === 'deny' ? String(specific.permissionDecisionReason) : undefined
}

function stop(cwd: string, session = 's1', active = false): Output {
  return handle({ hook_event_name: 'Stop', session_id: session, cwd, stop_hook_active: active }, Date.now()) as Output
}

function change(repo: string, text = '// 改过\n'): void {
  writeFileSync(join(repo, 'src', 'price.mjs'), `${sh(repo, 'cat src/price.mjs')}${text}`)
}

describe('合并门：提交', () => {
  test('提交到默认分支的内容没有整组通过记录时拒绝；跑过整组再提交就放行', () => {
    const repo = sampleRepo()
    change(repo)
    sh(repo, 'git add -A')
    assert.match(denied(pre(repo, 'git commit -m "改价格"')) ?? '', /^testpace 合并门：这次提交要落到 main 的代码（[0-9a-f]{10}）没有整组通过记录。先跑 testpace full/)
    assert.equal(testpace(repo, ['full']).code, 0)
    assert.equal(pre(repo, 'git commit -m "改价格"'), undefined)
  })

  test('工作区测过、但只把部分改动加进暂存区时拒绝，并说明差在哪', () => {
    const repo = sampleRepo()
    change(repo)
    writeFileSync(join(repo, 'src', 'extra.mjs'), 'export const x = 1\n')
    assert.equal(testpace(repo, ['full']).code, 0)
    sh(repo, 'git add src/price.mjs')
    assert.match(denied(pre(repo, 'git commit -m m')) ?? '', /工作区的整组通过了，但这次提交的内容和工作区不一样/)
    // -a 也带不上未跟踪的文件
    assert.match(denied(pre(repo, 'git commit -am m')) ?? '', /没有整组通过记录/)
    sh(repo, 'git add -A')
    assert.equal(pre(repo, 'git commit -m m'), undefined)
  })

  test('git commit -a 按暂存区加已跟踪文件的改动算', () => {
    const repo = sampleRepo()
    change(repo)
    assert.equal(testpace(repo, ['full']).code, 0)
    assert.equal(pre(repo, 'git commit -am "wip"'), undefined)
    assert.ok(denied(pre(repo, 'git commit -m "wip"')), '不带 -a 时暂存区里没有这个改动')
  })

  test('带路径或 -p 的提交没法确定内容，拒绝', () => {
    const repo = sampleRepo()
    change(repo)
    assert.equal(testpace(repo, ['full']).code, 0)
    assert.match(denied(pre(repo, 'git commit -m m src/price.mjs')) ?? '', /没法确定带路径或 -p 这类提交的内容/)
    assert.match(denied(pre(repo, 'git commit -p')) ?? '', /没法确定/)
  })

  test('工作分支上的提交、--dry-run、没接入约定的仓库都不管', () => {
    const repo = sampleRepo()
    change(repo)
    assert.ok(denied(pre(repo, 'git commit -am m')))
    assert.equal(pre(repo, 'git commit --dry-run -am m'), undefined)
    sh(repo, 'git checkout -qb feature')
    assert.equal(pre(repo, 'git commit -am m'), undefined)
    const plain = tempDir('testpace-plain-')
    sh(plain, 'git init -q -b main && echo a > a && git add -A && git -c user.name=t -c user.email=t@t commit -qm i && echo b > a')
    assert.equal(pre(plain, 'git commit -am m'), undefined)
  })

  test('重定向和 here-document 写的提交说明不影响判断', () => {
    const repo = sampleRepo()
    change(repo)
    sh(repo, 'git add -A')
    assert.equal(testpace(repo, ['full']).code, 0)
    assert.equal(pre(repo, 'git commit -m "x" 2>&1 | tail -3'), undefined, '2>&1 不是路径')
    assert.equal(pre(repo, 'git commit -q -m x >/dev/null 2>&1 &>/tmp/log'), undefined)
    // 说明里的撇号和像命令的行都在 here-document 里，不是命令；之后的推送照样认得出来
    const message = "git commit -q -F - <<'EOF'\nDon't push yet\ngit push origin main\nEOF\n"
    assert.equal(pre(repo, message), undefined)
    change(repo, '// 再改\n')
    assert.ok(denied(pre(repo, `${message}git commit -am again`)))
    assert.ok(denied(pre(repo, "cat <<-END\n\tgit status\n\tEND\ngit commit -am x")))
  })

  test('cd、git -C、sh -c 和 && 链里的提交都认得出来', () => {
    const repo = sampleRepo()
    change(repo)
    const outside = tempDir('testpace-outside-')
    assert.ok(denied(pre(outside, `cd ${repo} && git add -A && git commit -m m`)))
    assert.ok(denied(pre(outside, `git -C ${repo} commit -am m`)))
    assert.ok(denied(pre(outside, `bash -c "cd ${repo} && git commit -am m"`)))
    assert.ok(denied(pre(join(repo, 'src'), 'npm test; git commit -am m')))
  })

  test('同一条命令里先 git add 再提交：按预演 git add 之后的暂存区算，不动真实暂存区', () => {
    const repo = sampleRepo()
    change(repo)
    assert.equal(testpace(repo, ['full']).code, 0)
    assert.equal(pre(repo, 'git add -A && git commit -m m'), undefined)
    assert.equal(pre(join(repo, 'src'), 'git add price.mjs; git commit -m m'), undefined)
    assert.equal(pre(repo, 'git add . && git commit -m m && git push origin main'), undefined, '推送刚放行的提交')
    assert.equal(sh(repo, 'git diff --cached --name-only'), '')
    // 只预演写出来的 git add：少加了文件照样拦，并说明整条命令没有执行
    writeFileSync(join(repo, 'src', 'extra.mjs'), 'export const x = 1\n')
    assert.equal(testpace(repo, ['full']).code, 0)
    const partial = denied(pre(repo, 'git add src/extra.mjs && git commit -m m')) ?? ''
    assert.match(partial, /工作区的整组通过了，但这次提交的内容和工作区不一样/)
    assert.match(partial, /整条命令都没有执行。$/)
    assert.match(denied(pre(repo, 'git add -p && git commit -m m')) ?? '', /git add -p 这类要交互的写法没法预演/)
  })

  test('落到默认分支的命令前面连着 git add 之外的命令时，要求拆开执行', () => {
    const repo = sampleRepo()
    change(repo)
    assert.equal(testpace(repo, ['full']).code, 0)
    // 前面的命令可能改了要提交的内容
    assert.match(denied(pre(repo, 'echo x >> src/price.mjs && git commit -am m')) ?? '', /前面还连着别的命令（echo x）/)
    assert.match(denied(pre(repo, 'git commit -am m && git commit --amend -m n')) ?? '', /前面还连着别的命令（前面的提交或合并）/)
    // 工作分支上照常连写
    sh(repo, 'git checkout -qb feature')
    assert.equal(pre(repo, 'npm test && git commit -am wip && git push -u origin feature'), undefined)
    // 先切到默认分支再合并：执行前还在工作分支上，也要拦
    commit(repo, 'untested')
    change(repo, '// 没测过\n')
    commit(repo, 'untested 2')
    assert.match(denied(pre(repo, 'git checkout main && git merge feature')) ?? '', /这次合并要落到 main，但前面还连着别的命令（git checkout main）/)
    assert.ok(denied(pre(repo, 'git switch main && git commit -am m')))
    assert.ok(denied(pre(repo, 'git checkout main && git push')))
  })
})

describe('合并门：合并和推送', () => {
  /** main 上有一个工作分支 feature，比 main 多一次提交。 */
  function withFeature(): { repo: string; feature: string } {
    const repo = sampleRepo()
    sh(repo, 'git checkout -qb feature')
    change(repo)
    commit(repo, 'feature')
    return { repo, feature: sh(repo, 'git rev-parse HEAD').trim() }
  }

  test('合并工作分支：合并后的内容测过才放行（快进按分支的内容算）', () => {
    const { repo } = withFeature()
    sh(repo, 'git checkout -q main')
    assert.match(denied(pre(repo, 'git merge feature')) ?? '', /这次合并 feature 要落到 main 的代码/)
    sh(repo, 'git checkout -q feature')
    assert.equal(testpace(repo, ['full']).code, 0)
    sh(repo, 'git checkout -q main')
    assert.equal(pre(repo, 'git merge --no-ff -m "合并" feature'), undefined)
    assert.equal(pre(repo, 'git merge --abort'), undefined)
  })

  test('不是快进的合并按合并结果算', () => {
    const { repo } = withFeature()
    sh(repo, 'git checkout -q main')
    writeFileSync(join(repo, 'src', 'other.mjs'), 'export const y = 2\n')
    commit(repo, 'main moved')
    sh(repo, 'git checkout -q feature')
    assert.equal(testpace(repo, ['full']).code, 0)
    sh(repo, 'git checkout -q main')
    assert.ok(denied(pre(repo, 'git merge feature')), '只测过分支本身，没测过合并后的内容')
    sh(repo, 'git checkout -q feature && git merge -q main -m sync')
    assert.equal(testpace(repo, ['full']).code, 0)
    sh(repo, 'git checkout -q main')
    assert.equal(pre(repo, 'git merge feature'), undefined)
  })

  test('推送到默认分支：按推送的提交的内容算，推送别的分支不管', () => {
    const { repo } = withFeature()
    assert.equal(pre(repo, 'git push -u origin feature'), undefined)
    assert.match(denied(pre(repo, 'git push origin feature:main')) ?? '', /这次推送要落到 main 的代码/)
    assert.ok(denied(pre(repo, 'git push origin +HEAD:refs/heads/main')))
    assert.equal(pre(repo, 'git push --dry-run origin feature:main'), undefined)
    assert.equal(testpace(repo, ['full']).code, 0)
    assert.equal(pre(repo, 'git push origin feature:main'), undefined)

    sh(repo, 'git checkout -q main')
    change(repo, '// main 上直接改\n')
    commit(repo, 'direct')
    assert.ok(denied(pre(repo, 'git push')))
    assert.ok(denied(pre(repo, 'git push origin main')))
    assert.ok(denied(pre(repo, 'git push --all origin')))
  })

  test('同步远程默认分支已有的提交不算新落地', () => {
    const repo = sampleRepo()
    // 远程的 main 比本地多一个提交：用 refs/remotes/origin/main 模拟 fetch 之后的状态
    change(repo)
    commit(repo, 'remote work')
    sh(repo, 'git remote add origin https://example.invalid/sample.git && git update-ref refs/remotes/origin/main HEAD && git reset -q --hard HEAD~1')
    assert.equal(pre(repo, 'git merge origin/main'), undefined)
    assert.equal(pre(repo, 'git merge --ff-only'), undefined, '没写分支时合并上游')
    sh(repo, 'git branch -q --set-upstream-to=origin/main')
    assert.equal(pre(repo, 'git merge'), undefined)
    assert.equal(pre(repo, 'git push origin origin/main:main'), undefined)
    // 本地多了没推送过的提交，就要有记录
    sh(repo, 'git merge -q --ff-only origin/main')
    change(repo, '// 本地新提交\n')
    commit(repo, 'local')
    assert.ok(denied(pre(repo, 'git push origin main')))
  })

  test('gh pr merge：PR 要包含最新的默认分支，而且头提交的内容测过', () => {
    const { repo, feature } = withFeature()
    const bin = tempDir('testpace-gh-')
    const answer = join(bin, 'answer.json')
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\n[ -f '${answer}' ] || { echo 'gh: not logged in' >&2; exit 1; }\ncat '${answer}'\n`)
    chmodSync(join(bin, 'gh'), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      assert.match(denied(pre(repo, 'gh pr merge 7 --squash')) ?? '', /读不到 PR 的信息（gh: not logged in）/)
      writeFileSync(answer, JSON.stringify({ baseRefName: 'release', headRefOid: feature }))
      assert.equal(pre(repo, 'gh pr merge 7 --squash'), undefined, '合到别的分支不管')
      writeFileSync(answer, JSON.stringify({ baseRefName: 'main', headRefOid: 'f'.repeat(40) }))
      assert.match(denied(pre(repo, 'gh pr merge 7')) ?? '', /本地没有 PR 的最新提交 ffffffffff，先 git fetch/)
      writeFileSync(answer, JSON.stringify({ baseRefName: 'main', headRefOid: feature }))
      assert.match(denied(pre(repo, 'gh pr merge 7 --squash')) ?? '', /这次合并 PR 要落到 main 的代码/)
      assert.equal(testpace(repo, ['full']).code, 0)
      assert.equal(pre(repo, 'gh pr merge 7 --squash -b "说明"'), undefined)
      // 前面的推送可能给 PR 加了新提交，读到的 PR 头提交是执行前的
      assert.match(denied(pre(repo, 'git push origin feature && gh pr merge 7 --squash')) ?? '', /合并 PR 要落到 main，但前面还连着别的命令（git push origin）/)
      // main 往前走了，PR 没跟上
      sh(repo, 'git checkout -q main')
      writeFileSync(join(repo, 'src', 'other.mjs'), 'export const y = 2\n')
      commit(repo, 'main moved')
      assert.match(denied(pre(repo, 'gh pr merge 7')) ?? '', /PR 分支没有包含最新的 main/)
    } finally {
      process.env.PATH = path
    }
  })
})

describe('软提示', () => {
  test('会话开始时注入节奏说明，没接入约定的仓库不注入', () => {
    const repo = sampleRepo()
    const output = handle({ hook_event_name: 'SessionStart', session_id: 's', cwd: repo }, Date.now()) as Output
    assert.deepEqual(output, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: RHYTHM } })
    assert.equal(handle({ hook_event_name: 'SessionStart', session_id: 's', cwd: tempDir('testpace-none-') }, Date.now()), undefined)
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
    assert.equal(testpace(repo, ['full']).code, 0)
    assert.match(stop(repo, 'a')?.reason ?? '', /^这个会话跑的整组已经结束（通过），还没看结果。先跑 testpace status/)
    assert.equal(stop(repo, 'a')?.decision, 'block')
    assert.equal(stop(repo, 'a', true), undefined, '已经因为停止门继续过一次，不再拦')
    testpace(repo, ['status'])
    assert.equal(stop(repo, 'a'), undefined)
  })

  test('前台跑完 testpace full 算看过；放到后台的不算', () => {
    const repo = sampleRepo()
    handle({ hook_event_name: 'SessionStart', session_id: 'b', cwd: repo }, Date.now())
    assert.equal(testpace(repo, ['full']).code, 0)
    const post = (response: unknown): unknown =>
      handle({ hook_event_name: 'PostToolUse', session_id: 'b', cwd: repo, tool_name: 'Bash', tool_input: { command: 'testpace full' }, tool_response: response }, Date.now())
    post({ backgroundTaskId: 'task1' })
    assert.ok(stop(repo, 'b')?.reason)
    post({ stdout: '整组通过' })
    assert.equal(stop(repo, 'b'), undefined)
  })

  test('整组还在跑时拦下来', () => {
    const repo = sampleRepo()
    handle({ hook_event_name: 'SessionStart', session_id: 'c', cwd: repo }, Date.now())
    const store = new Store(join(repo, '.git'))
    // 和 testpace full 一样按 git 给的根目录登记（macOS 上临时目录的真实路径在 /private 下）
    const root = sh(repo, 'git rev-parse --show-toplevel').trim()
    store.markRunning({ id: 'r1', kind: 'full', pid: process.pid, worktree: root, tree: 't', startedAt: Date.now(), log: '/dev/null' })
    try {
      assert.match(stop(repo, 'c')?.reason ?? '', /^这个工作区的整组还在跑（开始于 .+，已 \d+秒）/)
    } finally {
      store.clearRunning('r1')
    }
  })

  test('会话开始前的整组不管', () => {
    const repo = sampleRepo()
    assert.equal(testpace(repo, ['full']).code, 0)
    handle({ hook_event_name: 'SessionStart', session_id: 'd', cwd: repo }, Date.now() + 60_000)
    assert.equal(stop(repo, 'd'), undefined)
  })

  test('默认分支在会话里有了没测过的提交，提示用户一次', () => {
    const repo = sampleRepo()
    handle({ hook_event_name: 'SessionStart', session_id: 'e', cwd: repo }, Date.now())
    change(repo)
    commit(repo, '绕过合并门')
    const head = sh(repo, 'git rev-parse --short=10 HEAD').trim()
    const first = stop(repo, 'e')
    assert.equal(first?.systemMessage, `testpace：main 的最新提交 ${head} 没有整组通过记录，可能绕过了合并门（比如在脚本里调用 git）。`)
    assert.equal(first?.decision, undefined, '只提示，不拦')
    assert.equal(stop(repo, 'e'), undefined, '同一个提交只提示一次')
  })
})

test('hook 入口：从标准输入读事件，把判断写到标准输出', () => {
  const repo = sampleRepo()
  change(repo)
  const run = (input: unknown): string =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY], { input: JSON.stringify(input), env: ENV, encoding: 'utf8' }).stdout
  const output = JSON.parse(run({ hook_event_name: 'PreToolUse', session_id: 'x', cwd: repo, tool_name: 'Bash', tool_input: { command: 'git commit -am m' } }))
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(run({ hook_event_name: 'PreToolUse', session_id: 'x', cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls' } }), '')
  // 输入坏了也不挡 agent
  const broken = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY], { input: '{', env: ENV, encoding: 'utf8' })
  assert.equal(broken.status, 0)
  assert.equal(broken.stdout, '')
})
