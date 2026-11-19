// 合并门（git 钩子，真实执行 git 命令）、停止门和软提示（调 hook 的判断）：都在示例项目的副本上。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { handle, RHYTHM, rhythm } from '../src/hook.ts'
import { GATE_REJECT, HOOK_COMMAND } from '../src/gate.ts'
import { Store } from '../src/store.ts'
import { agent, commit, ENV, gatedRepo, globalGitConfig, sampleRepo, setConfig, sh, tempDir, testpace } from './helpers.ts'

/** PATH 上没有 testpace、但有测试用的 git（合并门要 git 2.54 以上，不一定是 /usr/bin 里那个）。 */
const NO_TESTPACE_PATH = `${dirname(sh(tempDir('testpace-git-'), 'command -v git').trim())}:/usr/bin:/bin`

const ENTRY = fileURLToPath(new URL('../hooks/testpace.ts', import.meta.url))
// Claude Code 给 hook 的插件数据目录：会话碰过哪些仓库记在这里。
process.env.CLAUDE_PLUGIN_DATA = tempDir('testpace-data-')

type Output = { hookSpecificOutput?: Record<string, unknown>; decision?: string; reason?: string; systemMessage?: string } | undefined

// 会话在 cwd 里开始：SessionStart 已经说过节奏（cwd 是接入的仓库时），PreToolUse 不再补说。
function pre(cwd: string, command: string, session = 's1'): Output {
  handle({ hook_event_name: 'SessionStart', session_id: session, cwd }, Date.now(), 'claude')
  return handle({ hook_event_name: 'PreToolUse', session_id: session, cwd, tool_name: 'Bash', tool_input: { command } }, Date.now(), 'claude') as Output
}

function stop(cwd: string, session = 's1'): Output {
  return handle({ hook_event_name: 'Stop', session_id: session, cwd }, Date.now(), 'claude') as Output
}

// 停止门每次整组只拦一次。要看"现在还算不算没看结果"时，先清掉这个会话拦过的记录再问。
function stopAgain(repo: string, session: string): Output {
  const store = new Store(join(repo, '.git'))
  store.saveSession(session, { ...store.session(session, Date.now()), blocked: [] })
  return stop(repo, session)
}

// 在这个会话里起整组：Claude Code 给 agent 的命令带着会话号。
function fullIn(repo: string, session: string): number | null {
  return testpace(repo, ['full'], { ...ENV, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session }).code
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
    const r = agent(repo, 'git commit -qam m', { PATH: NO_TESTPACE_PATH })
    assert.equal(r.code, 0)
    assert.match(r.out, /^testpace 合并门：testpace 没有给出检查结论（退出码 127），这次没有检查。/)
    // 钩子配在全局、所有仓库都跑：没接入 testpace 的仓库里不说
    const plain = tempDir('testpace-plain-')
    sh(plain, 'git init -q -b main && git config hook.testpace.event reference-transaction')
    spawnSync('git', ['config', 'hook.testpace.command', HOOK_COMMAND], { cwd: plain, env: ENV })
    const quiet = agent(plain, 'git commit -q --allow-empty -m m', { PATH: NO_TESTPACE_PATH })
    assert.deepEqual(quiet, { code: 0, out: '' })
    // 对照：同一个仓库有了 testpace.json 就说，钩子确实在这里跑
    writeFileSync(join(plain, 'testpace.json'), '{}')
    assert.match(agent(plain, 'git commit -q --allow-empty -m m', { PATH: NO_TESTPACE_PATH }).out, /testpace 没有给出检查结论/)
  })

  test('没有分支要动（只是远程跟踪分支）时钩子不调用 testpace', () => {
    const repo = gatedRepo()
    const fake = tempDir('testpace-fake-')
    const calls = join(fake, 'calls')
    writeFileSync(join(fake, 'testpace'), `#!/bin/sh\ncat >> '${calls}'\n`, { mode: 0o755 })
    const env = { PATH: `${fake}:${NO_TESTPACE_PATH}` }
    assert.equal(agent(repo, 'git update-ref refs/remotes/origin/main HEAD', env).code, 0)
    assert.equal(sh(repo, `cat '${calls}' 2>/dev/null || true`), '')
    assert.equal(agent(repo, 'git branch x', env).code, 0)
    assert.match(sh(repo, `cat '${calls}'`), / refs\/heads\/x$/m, '有分支要动时调用，引用更新原样交给它')
  })

  test('testpace 没给出检查结论（插件没装全、旧版本、崩了）时说一句、附上它的输出，不挡；只有明确拒绝才拦', () => {
    const repo = gatedRepo()
    const fake = tempDir('testpace-broken-')
    const env = { PATH: `${fake}:${NO_TESTPACE_PATH}` }
    // 插件缓存缺 src/ 时 node 报找不到模块、退出码 1；还没有 gate 命令的旧版本是用法错误、退出码 2
    for (const [code, said] of [[1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find module /x/src/cli.ts"], [2, '不认识的命令 "gate"']] as const) {
      writeFileSync(join(fake, 'testpace'), `#!/bin/sh\necho '${said}' >&2\nexit ${code}\n`, { mode: 0o755 })
      change(repo, `// ${code}\n`)
      const r = agent(repo, 'git commit -qam m', env)
      assert.equal(r.code, 0, r.out)
      assert.equal(
        r.out.trim(),
        `testpace 合并门：testpace 没有给出检查结论（退出码 ${code}），这次没有检查。可能是找不到 testpace 命令、插件没装全、找不到能运行它的 node，或会话里的 testpace 是旧版本（插件更新后，开着的会话要重开才换成新版本）。\n${said}`,
      )
    }
    // 对照：同一个假 testpace 明确拒绝（GATE_REJECT），提交被拦，原样转达它的理由
    writeFileSync(join(fake, 'testpace'), `#!/bin/sh\necho '不放' >&2\nexit ${GATE_REJECT}\n`, { mode: 0o755 })
    const before = head(repo)
    change(repo, '// 拒绝\n')
    const refused = agent(repo, 'git commit -qam m', env)
    assert.notEqual(refused.code, 0)
    assert.match(refused.out, /^不放$/m)
    assert.equal(head(repo), before)
  })

  test('gate 检查时出错（读不到要落地的提交）照样拒绝，用钩子认的退出码', () => {
    const repo = gatedRepo()
    const missing = '1'.repeat(40)
    const r = agent(repo, `printf '%s\\n' "$(git rev-parse main) ${missing} refs/heads/main" | testpace gate`)
    assert.equal(r.code, GATE_REJECT, r.out)
    assert.match(r.out, new RegExp(`^testpace 合并门：没能确认要落地的代码测过（读不到提交 ${missing}.*），这次不更新。$`, 'm'))
  })

  test('install 把合并门配进全局 git 配置：所有仓库、所有工作区都把关，不碰项目自己的钩子；status 和会话开始时说出没在把关的原因', () => {
    // 固定命令入口放在 ~/.local/bin：换成测试自己的 HOME，不碰用户真实的
    const env = { ...ENV, GIT_CONFIG_GLOBAL: globalGitConfig(), HOME: tempDir('testpace-home-') }
    // agent() 只给要改的变量：整份 ENV 会连 PATH 一起换掉，用到机器上别处装的 testpace
    const agentEnv = { GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, HOME: env.HOME }
    const repo = sampleRepo()
    const missing = /合并门：合并门没配（用户自己删掉了，或还没配过），提交、合并到默认分支时不会检查。用户要的话，跑 testpace install 在全局 git 配置里配上。/
    assert.match(testpace(repo, ['status'], env).out, missing)

    // 项目自己的钩子：git 自己的钩子目录里有一个，core.hooksPath 指向一个还不存在的目录（husky 装依赖前的 .husky/_）
    const seen = join(tempDir('testpace-seen-'), 'refs')
    writeFileSync(join(repo, '.git', 'hooks', 'reference-transaction'), `#!/bin/sh\n[ "$1" = prepared ] && cat >> '${seen}'\nexit 0\n`, { mode: 0o755 })
    const installed = testpace(repo, ['install'], env)
    assert.equal(installed.code, 0, installed.out)
    assert.equal(
      installed.out,
      '合并门已配好：全局 git 配置里的 hook.testpace，这台机器上 agent 在所有仓库里移动默认分支时都检查（只管接入了 testpace 的仓库）。\n' +
        `固定命令入口已放好：${join(env.HOME, '.local', 'bin', 'testpace')}，运行时转给这台机器上装着的最高版本的 testpace。\n`,
    )
    assert.equal(sh(repo, `git config --file '${env.GIT_CONFIG_GLOBAL}' --get hook.testpace.command`).trim(), HOOK_COMMAND)
    assert.equal(sh(repo, 'git status --porcelain --untracked-files=all'), '', '仓库里什么都没写')
    assert.match(testpace(repo, ['status'], env).out, /合并门：已装上/)
    change(repo)
    assert.match(agent(repo, 'git commit -qam m', agentEnv).out, /testpace 合并门：这次要把 main 更新到/)
    assert.equal(agent(repo, 'git checkout -qb fix && git commit -qam m', agentEnv).code, 0, '分支上的提交照常放行')
    assert.match(sh(repo, `cat '${seen}'`), /^[0-9a-f]+ [0-9a-f]+ refs\/heads\/fix$/m, '项目自己的钩子照常跑，读得到引用更新')
    sh(repo, 'git config core.hooksPath .husky/_')
    assert.match(agent(repo, 'git update-ref refs/heads/main fix', agentEnv).out, /testpace 合并门：这次要把 main 更新到/, 'core.hooksPath 不影响')

    // 别的仓库、别的工作区不用再装
    const other = sampleRepo()
    const wt = join(tempDir('testpace-wt-'), 'wt')
    sh(other, `git branch old && git worktree add -q '${wt}' old`)
    change(wt)
    commit(wt, 'old 上没测过的提交')
    assert.match(testpace(wt, ['status'], env).out, /合并门：已装上/)
    assert.match(agent(wt, 'git update-ref refs/heads/main old', agentEnv).out, /testpace 合并门：这次要把 main 更新到/)

    // 命令不是这一版的：提示更新，install 改回来
    sh(repo, `git config --file '${env.GIT_CONFIG_GLOBAL}' hook.testpace.command 'testpace gate'`)
    assert.match(testpace(repo, ['status'], env).out, /合并门：git 配置里合并门的钩子命令（hook\.testpace\.command）不是这一版的，跑 testpace install 更新。/)
    assert.equal(testpace(repo, ['install'], env).code, 0)
    assert.match(testpace(repo, ['status'], env).out, /合并门：已装上/)
    // 仓库自己的配置把它关了：说出来，install 也说配好了但没生效
    sh(other, 'git config hook.testpace.enabled false')
    assert.match(testpace(other, ['status'], env).out, /合并门：git 配置把合并门的钩子关掉了（hook\.testpace\.enabled = false），合并门没有生效。/)
    const off = testpace(other, ['install'], env)
    assert.equal(off.code, 2)
    assert.match(off.out, /^没有配好：全局 git 配置里配好了，但在这个仓库里没有生效：git 配置把合并门的钩子关掉了/)

    // git 太旧，不认配置里的钩子：说清楚，不配
    const oldGit = tempDir('testpace-oldgit-')
    const realGit = sh(repo, 'command -v git').trim()
    writeFileSync(join(oldGit, 'git'), `#!/bin/sh\n[ "$1" = hook ] && { echo "error: unknown subcommand: \\\`list'" >&2; exit 129; }\n[ "$1" = --version ] && { echo 'git version 2.49.0'; exit 0; }\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
    const oldEnv = { ...ENV, GIT_CONFIG_GLOBAL: globalGitConfig(), PATH: `${oldGit}:${ENV.PATH}` }
    assert.match(testpace(repo, ['status'], oldEnv).out, /合并门：这台机器的 git（2\.49\.0）不认配置里声明的钩子，合并门没有生效。要 git 2\.54 以上：告诉用户升级 git（比如 brew upgrade git），不要自己装。/)
    const refused = testpace(repo, ['install'], oldEnv)
    assert.equal(refused.code, 2)
    assert.match(refused.out, /^没有配好：这台机器的 git（2\.49\.0）/)
    assert.equal(sh(repo, `cat '${oldEnv.GIT_CONFIG_GLOBAL}'`).includes('hook'), false)

    const trunk = tempDir('testpace-trunk-')
    sh(trunk, `cp -R ${join(repo, 'src')} ${join(repo, 'testpace.json')} . && git init -q -b trunk && git add -A && git -c user.name=t -c user.email=t@t commit -qm i`)
    assert.match(testpace(trunk, ['status'], env).out, /合并门：找不到默认分支（没有 origin\/HEAD，本地和 origin 上也没有 main、master），合并门没有生效。/)
  })

  test('origin/HEAD 指着不存在的分支时不信它：照样守 main，status 说明；指着的分支在 origin 上有才按它算', () => {
    // 远程把默认分支从 master 改名成 main 之后，本地的 origin/HEAD 还指着 origin/master，本地的旧分支 master 也还在
    const repo = gatedRepo()
    sh(repo, 'git branch master && git update-ref refs/remotes/origin/main HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master')
    const before = head(repo)
    change(repo)
    const r = agent(repo, 'git commit -qam 改价格')
    assert.notEqual(r.code, 0)
    assert.match(r.out, /testpace 合并门：这次要把 main 更新到/)
    assert.equal(head(repo), before)
    assert.match(
      testpace(repo, ['status']).out,
      /合并门：已装上，agent 移动默认分支时检查\n  origin\/HEAD 指着不存在的分支 master（远程可能改了默认分支的名字），默认分支按 main 算。用 git remote set-head origin --auto 更新。/,
    )

    // origin 上真有 trunk、origin/HEAD 指着它：默认分支是 trunk，main 上的提交不归合并门管
    const other = gatedRepo()
    sh(other, 'git update-ref refs/remotes/origin/trunk HEAD && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/trunk')
    assert.doesNotMatch(testpace(other, ['status']).out, /origin\/HEAD 指着/)
    change(other)
    assert.equal(agent(other, 'git commit -qam 改价格').code, 0)
    sh(other, 'git checkout -qb trunk HEAD~1')
    change(other, '// 另一处\n')
    assert.match(agent(other, 'git commit -qam 改价格').out, /testpace 合并门：这次要把 trunk 更新到/)

    // 哪儿都认不出来：说清原因，不当成在把关
    const lost = gatedRepo()
    sh(lost, 'git branch -m main work && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/gone')
    assert.match(testpace(lost, ['status']).out, /合并门：找不到默认分支（origin\/HEAD 指着不存在的分支 gone，本地和 origin 上也没有 main、master），合并门没有生效。/)
  })
})

describe('会话开始', () => {
  test('自动配上合并门，只告诉用户一声；用户删掉后不再配回去', () => {
    const saved = process.env.GIT_CONFIG_GLOBAL
    const global = globalGitConfig()
    process.env.GIT_CONFIG_GLOBAL = global
    try {
      const repo = sampleRepo()
      const first = handle({ hook_event_name: 'SessionStart', session_id: 'auto-1', cwd: repo }, Date.now(), 'claude') as Output
      assert.match(String(first?.systemMessage), /^testpace：在全局 git 配置里配上了合并门/)
      assert.equal(sh(repo, `git config --file '${global}' --get hook.testpace.command`).trim(), HOOK_COMMAND)
      assert.doesNotMatch(String(first?.hookSpecificOutput?.additionalContext), /合并门没配/)
      const second = handle({ hook_event_name: 'SessionStart', session_id: 'auto-2', cwd: repo }, Date.now(), 'claude') as Output
      assert.equal(second?.systemMessage, undefined, '配好了不再说')

      // 照说明删掉
      const remove = String(first?.systemMessage).match(/git config --global --remove-section (\S+)，/)![1]
      sh(repo, `git config --file '${global}' --remove-section ${remove}`)
      const removed = handle({ hook_event_name: 'SessionStart', session_id: 'auto-3', cwd: repo }, Date.now(), 'claude') as Output
      assert.equal(removed?.systemMessage, undefined)
      assert.equal(sh(repo, `git config --file '${global}' --get-all hook.testpace.command || true`), '', '用户删掉的不配回去')
      assert.match(String(removed?.hookSpecificOutput?.additionalContext), /合并门没配（用户自己删掉了，或还没配过）/)
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved
    }
  })

  test('新仓库还没接入：提出照接入说明配好；提交多的老仓库、不是仓库的目录不提', () => {
    const saved = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalGitConfig()
    try {
      const fresh = tempDir('testpace-new-')
      sh(fresh, 'git init -qb main')
      const start = handle({ hook_event_name: 'SessionStart', session_id: 'new-1', cwd: fresh }, Date.now(), 'claude') as Output
      assert.match(String(start?.hookSpecificOutput?.additionalContext), /^这是个新仓库，还没接入 testpace[\s\S]*不用问用户/)

      const old = tempDir('testpace-old-')
      sh(old, 'git init -qb main && for i in $(seq 21); do git -c user.name=t -c user.email=t@t commit --allow-empty -qm "$i"; done')
      assert.equal(handle({ hook_event_name: 'SessionStart', session_id: 'old-1', cwd: old }, Date.now(), 'claude'), undefined)
      assert.equal(handle({ hook_event_name: 'SessionStart', session_id: 'none-1', cwd: tempDir('testpace-plain-') }, Date.now(), 'claude'), undefined)
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved
    }
  })
})

describe('软提示', () => {
  test('会话开始时注入节奏说明，没接入约定的仓库不注入', () => {
    const repo = gatedRepo()
    const output = handle({ hook_event_name: 'SessionStart', session_id: 's', cwd: repo }, Date.now(), 'claude') as Output
    assert.deepEqual(output, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: RHYTHM } })
    assert.equal(handle({ hook_event_name: 'SessionStart', session_id: 's-none', cwd: tempDir('testpace-none-') }, Date.now(), 'claude'), undefined)
  })

  test('会话不在接入的仓库里开始时，第一条碰到那个仓库的命令补说一次节奏，写上是哪个仓库', () => {
    const repo = gatedRepo()
    const root = sh(repo, 'git rev-parse --show-toplevel').trim()
    const parent = tempDir('testpace-parent-')
    const run = (cwd: string, command: string): Output =>
      handle({ hook_event_name: 'PreToolUse', session_id: 'p', cwd, tool_name: 'Bash', tool_input: { command } }, Date.now(), 'claude') as Output
    assert.equal(handle({ hook_event_name: 'SessionStart', session_id: 'p', cwd: parent }, Date.now(), 'claude'), undefined)
    assert.equal(run(parent, 'ls'), undefined, '没碰到接入的仓库不说')
    const told = run(parent, `cd ${repo} && git status`)?.hookSpecificOutput?.additionalContext
    assert.equal(told, rhythm(`${root} 这个仓库`))
    assert.equal(run(parent, `cd ${repo} && git status`), undefined, '同一会话只说一次')
    assert.equal(run(repo, 'git status'), undefined, '会话后来在仓库里也不再说')
    assert.match(String(run(repo, 'node scripts/full.mjs')?.hookSpecificOutput?.additionalContext), /^这是 testpace.json 里 full 的检查/)
    // 压缩、恢复后会话重新开始：碰过的仓库再说一次，之后的命令不再说
    const again = handle({ hook_event_name: 'SessionStart', session_id: 'p', cwd: parent }, Date.now(), 'claude') as Output
    assert.equal(again?.hookSpecificOutput?.additionalContext, rhythm(`${root} 这个仓库`))
    assert.equal(run(parent, `cd ${repo} && git status`), undefined)
    // 换一个会话，补说和别的提示一起出
    const both = handle({ hook_event_name: 'PreToolUse', session_id: 'q', cwd: repo, tool_name: 'Bash', tool_input: { command: 'node scripts/full.mjs' } }, Date.now(), 'claude') as Output
    assert.match(String(both?.hookSpecificOutput?.additionalContext), /用 testpace 管测试节奏[\s\S]*\n\n这是 testpace.json 里 full 的检查/)
  })

  test('testpace.json 写坏了照样说明节奏并讲出问题，停止门和合并门的状态照常', () => {
    const repo = gatedRepo()
    assert.equal(fullIn(repo, 'k'), 0)
    writeFileSync(join(repo, 'testpace.json'), '{')
    const start = handle({ hook_event_name: 'SessionStart', session_id: 'k', cwd: repo }, Date.now(), 'claude') as Output
    assert.match(
      String(start?.hookSpecificOutput?.additionalContext),
      /用 testpace 管测试节奏[\s\S]*\ntestpace\.json 有问题：testpace\.json 不是合法的 JSON：.+。$/,
    )
    assert.match(stop(repo, 'k')?.reason ?? '', /^这个会话跑的整组已经结束（通过），还没看结果/)
    const status = testpace(repo, ['status'])
    assert.equal(status.code, 2)
    assert.match(status.out, /配置（testpace\.json）：testpace\.json 不是合法的 JSON[\s\S]*合并门：已装上/)
  })

  test('直接跑配置里的 full 时提示改用 testpace full', () => {
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
    handle({ hook_event_name: 'SessionStart', session_id: 'a', cwd: repo }, Date.now(), 'claude')
    assert.equal(stop(repo, 'a'), undefined)
    assert.equal(fullIn(repo, 'a'), 0)
    const first = stop(repo, 'a')
    assert.match(first?.reason ?? '', /^这个会话跑的整组已经结束（通过），还没看结果。先跑 testpace status/)
    assert.equal(first?.decision, 'block')
    assert.equal(stop(repo, 'a'), undefined, '同一次整组只拦一次：停止门自己记着，不靠 agent 给的 stop_hook_active')
    testpace(repo, ['status'], { ...ENV, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'z' })
    assert.ok(stopAgain(repo, 'a')?.reason, '别的会话看了结果不算')
    testpace(repo, ['status'])
    assert.ok(stopAgain(repo, 'a')?.reason, '用户在终端里看了也不算')
    testpace(repo, ['status'], { ...ENV, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'a' })
    assert.equal(stopAgain(repo, 'a'), undefined)
    change(repo)
    assert.equal(fullIn(repo, 'a'), 0)
    assert.ok(stop(repo, 'a')?.reason, '新的一次整组又拦一次')
  })

  test('会话从仓库外开始时，也查它碰过的仓库，话里写上是哪个仓库', () => {
    const repo = sampleRepo()
    const root = sh(repo, 'git rev-parse --show-toplevel').trim()
    const parent = tempDir('testpace-parent-')
    handle({ hook_event_name: 'SessionStart', session_id: 'o', cwd: parent }, Date.now(), 'claude')
    handle({ hook_event_name: 'PreToolUse', session_id: 'o', cwd: parent, tool_name: 'Bash', tool_input: { command: `cd ${repo} && testpace full` } }, Date.now(), 'claude')
    assert.equal(fullIn(repo, 'o'), 0)
    assert.equal(stop(parent, 'o')?.reason, `这个会话在 ${root} 跑的整组已经结束（通过），还没看结果。先跑 testpace status 看结果，再收尾。`)
    testpace(repo, ['status'], { ...ENV, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'o' })
    assert.equal(stop(parent, 'o'), undefined)
    // 没有插件数据目录（不在 Claude Code 里跑）时只认会话所在目录
    const data = process.env.CLAUDE_PLUGIN_DATA
    delete process.env.CLAUDE_PLUGIN_DATA
    try {
      handle({ hook_event_name: 'PreToolUse', session_id: 'o2', cwd: parent, tool_name: 'Bash', tool_input: { command: `cd ${repo} && ls` } }, Date.now(), 'claude')
      assert.equal(fullIn(repo, 'o2'), 0)
      assert.equal(stop(parent, 'o2'), undefined)
    } finally {
      process.env.CLAUDE_PLUGIN_DATA = data
    }
  })

  test('前台跑完 testpace full 算看过，失败的（Claude Code 发 PostToolUseFailure）也算；放到后台的不算', () => {
    const repo = sampleRepo()
    handle({ hook_event_name: 'SessionStart', session_id: 'b', cwd: repo }, Date.now(), 'claude')
    assert.equal(fullIn(repo, 'b'), 0)
    const post = (event: string, input: Record<string, unknown>, response?: unknown): unknown =>
      handle({ hook_event_name: event, session_id: 'b', cwd: repo, tool_name: 'Bash', tool_input: { command: 'testpace full', ...input }, tool_response: response }, Date.now(), 'claude')
    post('PostToolUse', {}, { backgroundTaskId: 'task1' })
    assert.ok(stopAgain(repo, 'b')?.reason)
    post('PostToolUse', { run_in_background: true }, {})
    assert.ok(stopAgain(repo, 'b')?.reason)
    post('PostToolUse', {}, { stdout: '整组通过' })
    assert.equal(stopAgain(repo, 'b'), undefined)

    setConfig(repo, { full: 'false' })
    assert.equal(fullIn(repo, 'b'), 1)
    assert.match(stopAgain(repo, 'b')?.reason ?? '', /^这个会话跑的整组已经结束（失败），还没看结果/)
    post('PostToolUseFailure', {})
    assert.equal(stopAgain(repo, 'b'), undefined)
  })

  test('整组还在跑时拦下来', () => {
    const repo = sampleRepo()
    handle({ hook_event_name: 'SessionStart', session_id: 'c', cwd: repo }, Date.now(), 'claude')
    const store = new Store(join(repo, '.git'))
    // 和 testpace full 一样按 git 给的根目录登记（macOS 上临时目录的真实路径在 /private 下）
    const root = sh(repo, 'git rev-parse --show-toplevel').trim()
    assert.equal(store.claim({ id: 'r1', kind: 'full', pid: process.pid, worktree: root, tree: 't', startedAt: Date.now(), session: 'c', log: '/dev/null' }), undefined)
    try {
      assert.match(stop(repo, 'c')?.reason ?? '', /^这个工作区的整组还在跑（开始于 .+，已 \d+秒）/)
      assert.equal(stop(repo, 'c'), undefined, '还在跑时只拦一次')
      // 别的会话想跑整组，发现已经在跑：它等着用这次的结果，也要拦
      handle({ hook_event_name: 'SessionStart', session_id: 'c2', cwd: repo }, Date.now(), 'claude')
      assert.equal(testpace(repo, ['full'], { ...ENV, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'c2' }).code, 3)
      assert.match(stop(repo, 'c2')?.reason ?? '', /^这个工作区的整组还在跑/)
      handle({ hook_event_name: 'SessionStart', session_id: 'c3', cwd: repo }, Date.now(), 'claude')
      assert.equal(stop(repo, 'c3'), undefined, '没起也没等的会话不管')
    } finally {
      store.release(root, 'r1')
    }
  })

  test('等着用别人整组结果的会话：跑完还没看结果时也拦', () => {
    const repo = sampleRepo()
    const root = sh(repo, 'git rev-parse --show-toplevel').trim()
    handle({ hook_event_name: 'SessionStart', session_id: 'w', cwd: repo }, Date.now(), 'claude')
    new Store(join(repo, '.git')).appendRun({
      id: 'r2', kind: 'full', worktree: root, tree: 't', treeAtEnd: 't', startedAt: Date.now() - 2000, durationMs: 1000,
      exitCode: 0, result: 'pass', session: 'a', waiting: ['w'], log: '/dev/null',
    })
    assert.match(stop(repo, 'w')?.reason ?? '', /^这个会话等的整组已经结束（通过），还没看结果/)
    testpace(repo, ['status'], { ...ENV, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'w' })
    assert.equal(stop(repo, 'w'), undefined)
  })

  test('别的会话、或不在 Claude Code 里起的整组不管', () => {
    const repo = sampleRepo()
    handle({ hook_event_name: 'SessionStart', session_id: 'd', cwd: repo }, Date.now(), 'claude')
    assert.equal(fullIn(repo, 'other'), 0)
    assert.equal(stop(repo, 'd'), undefined)
    change(repo)
    assert.equal(testpace(repo, ['full']).code, 0)
    assert.equal(stop(repo, 'd'), undefined)
    assert.match(stop(repo, 'other')?.reason ?? '', /^这个会话跑的整组已经结束/)
  })

  test('本地或远程默认分支在会话里有了没测过的提交，提示用户一次', () => {
    const repo = sampleRepo()
    handle({ hook_event_name: 'SessionStart', session_id: 'e', cwd: repo }, Date.now(), 'claude')
    change(repo)
    commit(repo, '用户在终端里提交')
    const head = sh(repo, 'git rev-parse --short=10 HEAD').trim()
    const first = stop(repo, 'e')
    assert.equal(first?.systemMessage, `testpace：main 的最新提交 ${head} 没有整组通过记录（可能不是 agent 提交的（合并门只管 agent 的命令），或者合并门没装上）。`)
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
    handle({ hook_event_name: 'SessionStart', session_id: 'f', cwd: repo }, Date.now(), 'claude')
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
    handle({ hook_event_name: 'SessionStart', session_id: 'g', cwd: fresh }, Date.now(), 'claude')
    change(fresh)
    sh(fresh, `git add src && git -c user.name=t -c user.email=t@t commit -qm '只提交代码'`)
    assert.equal(stop(fresh, 'g'), undefined)
  })
})

test('hook 入口：从标准输入读事件，把判断写到标准输出', () => {
  const repo = gatedRepo()
  const run = (input: unknown): string =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'claude'], { input: JSON.stringify(input), env: ENV, encoding: 'utf8' }).stdout
  const pre = (command: string): string => run({ hook_event_name: 'PreToolUse', session_id: 'x', cwd: repo, tool_name: 'Bash', tool_input: { command } })
  const output = JSON.parse(pre('node scripts/full.mjs'))
  assert.match(output.hookSpecificOutput.additionalContext, /用 testpace 管测试节奏[\s\S]*改用 testpace full/)
  assert.equal(pre('ls'), '', '节奏只说一次')
  // 输入坏了也不挡 agent，但要让人看到出了错
  const broken = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'claude'], { input: '{', env: ENV, encoding: 'utf8' })
  assert.equal(broken.status, 0)
  assert.match(JSON.parse(broken.stdout).systemMessage, /^testpace hook 出错，这次没有检查：/)
  // 没说是哪个 agent：hook 配置写错了，同样不挡但说出来
  const unnamed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY], { input: '{}', env: ENV, encoding: 'utf8' })
  assert.equal(unnamed.status, 0)
  assert.equal(JSON.parse(unnamed.stdout).systemMessage, 'testpace hook 出错，这次没有检查：不认识的 agent "undefined"')
})

test('hooks.json 把用到的事件都交给入口：Bash 的三个工具事件只看 Bash', () => {
  const { hooks } = JSON.parse(readFileSync(fileURLToPath(new URL('../hooks/hooks.json', import.meta.url)), 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
  }
  const registered = Object.fromEntries(Object.entries(hooks).map(([event, entries]) => [event, entries.map(entry => entry.matcher ?? '')]))
  assert.deepEqual(registered, { SessionStart: [''], PreToolUse: ['Bash'], PostToolUse: ['Bash'], PostToolUseFailure: ['Bash'], Stop: [''] })
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) assert.match(entry.hooks[0]!.command, /"\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/testpace\.ts" claude$/, '说明是 Claude Code')
  }
})
