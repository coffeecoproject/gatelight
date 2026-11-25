// 底座给检查模块的能力：分叉点、评判用的配置的两版、ignore 认哪些、用户确认（和确认工具）、模块的记录、调 LayerMap。

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SessionBaselines } from '../src/base/baseline.ts'
import { askUser, check, CONFIRM_TOOL, type ConfirmItem } from '../src/base/confirm.ts'
import { effectiveIgnore, parseContract } from '../src/base/contract.ts'
import { forkPoint } from '../src/base/git.ts'
import { judgingDir, judgingFile } from '../src/base/judging.ts'
import { layermap, LAYERMAP_MINIMUM } from '../src/base/layermap.ts'
import { ModuleRecords } from '../src/base/records.ts'
import { openRepo, type Repo } from '../src/base/repo.ts'
import { PLUGIN_NAME } from '../src/base/version.ts'
import { commit, ENV, sampleRepo, sh, tempDir, userAgrees } from './helpers.ts'

const head = (repo: string): string => sh(repo, 'git rev-parse HEAD').trim()

describe('分叉点', () => {
  test('在默认分支上是当前提交；在别的分支上是和默认分支分开的那个提交', () => {
    const repo = sampleRepo()
    const start = head(repo)
    assert.deepEqual(forkPoint(repo), { commit: start, branch: 'main' })

    sh(repo, 'git checkout -q -b feature')
    writeFileSync(join(repo, 'src', 'new.mjs'), 'export const a = 1\n')
    commit(repo, 'feature')
    assert.notEqual(head(repo), start)
    assert.deepEqual(forkPoint(repo), { commit: start, branch: 'main' })

    // 默认分支又往前走了：分叉点不跟着走
    sh(repo, 'git checkout -q main')
    writeFileSync(join(repo, 'src', 'main.mjs'), 'export const b = 1\n')
    commit(repo, 'main moves')
    sh(repo, 'git checkout -q feature')
    assert.deepEqual(forkPoint(repo), { commit: start, branch: 'main' })
  })

  test('本地没有默认分支时和 origin 上的比', () => {
    const repo = sampleRepo()
    const start = head(repo)
    sh(repo, 'git checkout -q -b feature && git update-ref refs/remotes/origin/main HEAD && git branch -q -D main')
    writeFileSync(join(repo, 'src', 'new.mjs'), 'export const a = 1\n')
    commit(repo, 'feature')
    assert.deepEqual(forkPoint(repo), { commit: start, branch: 'main' })
  })

  test('算不出时说明原因', () => {
    const repo = sampleRepo()
    sh(repo, 'git branch -q -m main dev')
    assert.deepEqual(forkPoint(repo), { problem: '认不出默认分支：没有 origin/HEAD，本地和 origin 上也没有 main、master' })

    // 和默认分支没有共同的祖先
    sh(repo, 'git branch -q -m dev main && git checkout -q --orphan lone')
    commit(repo, 'lone')
    assert.deepEqual(forkPoint(repo), { problem: '当前提交和 main 没有共同的祖先' })

    // 还没有提交，默认分支只在 origin 上有
    const empty = tempDir('testpace-empty-')
    sh(empty, `git init -q -b main && git fetch -q '${repo}' main:refs/remotes/origin/main`)
    assert.deepEqual(forkPoint(empty), { problem: '仓库还没有提交' })
  })
})

describe('评判用的配置', () => {
  /** 示例项目加一份模块配置和清单目录，提交后切到分支上。返回分叉点。 */
  function withConfig(): { repo: string; fork: string } {
    const repo = sampleRepo()
    mkdirSync(join(repo, '.rules', 'checklist'), { recursive: true })
    writeFileSync(join(repo, '.rules', 'config.json'), '{"strict":true}\n')
    writeFileSync(join(repo, '.rules', 'checklist', '金额.md'), '金额要查两位小数\n')
    writeFileSync(join(repo, '.rules', 'checklist', 'old.md'), '旧的一条\n')
    commit(repo, 'config')
    sh(repo, 'git checkout -q -b feature')
    return { repo, fork: head(repo) }
  }

  test('一个文件给分叉点那一版和工作区现在这一版，没提交的改动也算现在', () => {
    const { repo, fork } = withConfig()
    // 没改：两版一字不差（末尾的换行也一样）
    assert.deepEqual(judgingFile(repo, fork, '.rules/config.json'), { before: '{"strict":true}\n', now: '{"strict":true}\n' })

    writeFileSync(join(repo, '.rules', 'config.json'), '{"strict":false}\n')
    assert.deepEqual(judgingFile(repo, fork, '.rules/config.json'), { before: '{"strict":true}\n', now: '{"strict":false}\n' })
    // 提交了也一样：分叉点那一版不变
    commit(repo, 'loosen')
    assert.deepEqual(judgingFile(repo, fork, '.rules/config.json'), { before: '{"strict":true}\n', now: '{"strict":false}\n' })

    // 删掉了：现在没有，分叉点那一版还在，删配置躲不过
    rmSync(join(repo, '.rules', 'config.json'))
    assert.deepEqual(judgingFile(repo, fork, '.rules/config.json'), { before: '{"strict":true}\n', now: undefined })
    // 分支上新加的：分叉点上没有
    writeFileSync(join(repo, '.rules', 'extra.json'), '{}\n')
    assert.deepEqual(judgingFile(repo, fork, '.rules/extra.json'), { before: undefined, now: '{}\n' })
  })

  test('一个目录：分叉点上有的和工作区里现有的文件都给', () => {
    const { repo, fork } = withConfig()
    rmSync(join(repo, '.rules', 'checklist', 'old.md'))
    writeFileSync(join(repo, '.rules', 'checklist', '金额.md'), '金额不查了\n')
    // 没跟踪的新文件也算现在有的
    writeFileSync(join(repo, '.rules', 'checklist', 'new.md'), '新的一条\n')
    assert.deepEqual([...judgingDir(repo, fork, '.rules/checklist')], [
      ['.rules/checklist/new.md', { before: undefined, now: '新的一条\n' }],
      ['.rules/checklist/old.md', { before: '旧的一条\n', now: undefined }],
      ['.rules/checklist/金额.md', { before: '金额要查两位小数\n', now: '金额不查了\n' }],
    ])
    // 目录外的不给
    assert.deepEqual([...judgingDir(repo, fork, '.rules/none')], [])
  })
})

describe('用户确认', () => {
  const HEADING = '这次改动里放松测试的地方'
  const skip: ConfirmItem = { before: 'test("a") 在跑', after: 'test.skip("a")', text: 'tests/a.test.ts\n  跳过了测试 a：接口下线了' }
  const removed: ConfirmItem = { before: '有 3 个测试', after: '有 2 个测试', text: 'tests/b.test.ts 删了一个测试：和 c 重复' }

  function repoOf(dir: string): Repo {
    const repo = openRepo(dir)
    assert.ok(repo)
    return repo
  }

  test('没同意的条目存好编号和弹窗文字；工具核对文字后记下，再检查就算同意过', () => {
    const repo = repoOf(sampleRepo())
    const first = askUser(repo, 'craft', HEADING, [skip, removed])
    assert.deepEqual(first.confirmed, [])
    assert.deepEqual(first.pending, [skip, removed])
    assert.ok(first.ask)
    assert.match(first.ask.id, /^[0-9a-f]{32}$/)
    assert.equal(
      first.ask.text,
      [
        '这次改动里放松测试的地方，要你确认的有 2 项：',
        '',
        '1. tests/a.test.ts',
        '   跳过了测试 a：接口下线了',
        '',
        '2. tests/b.test.ts 删了一个测试：和 c 重复',
        '',
        '同意：按这样改。不同意：告诉 agent 改回去或换个做法。',
      ].join('\n'),
    )
    // 说给 agent 的话里有调工具要填的三样
    assert.deepEqual(first.ask.lines.slice(2, 4), [`repo：${repo.root}`, `id：${first.ask.id}`])
    assert.ok(first.ask.lines[0]?.includes(`${PLUGIN_NAME} 的 ${CONFIRM_TOOL} 工具`))
    assert.deepEqual(first.ask.lines.slice(5), ['-----', first.ask.text, '-----'])

    // 没调工具，再检查一次还是没同意，编号不变
    assert.equal(askUser(repo, 'craft', HEADING, [skip, removed]).ask?.id, first.ask.id)

    const checked = check(repo.root, first.ask.id, first.ask.text)
    assert.ok(checked.ok)
    assert.equal(checked.popup, first.ask.text)
    assert.deepEqual(checked.record(), { ok: true, text: '已记下：用户确认并同意了这 2 项。再跑一次要求确认的那条检查。' })
    assert.deepEqual(askUser(repo, 'craft', HEADING, [skip, removed]), { confirmed: [skip, removed], pending: [] })
  })

  test('传来的文字和存下的不一致就不记；只差缩进和空行的算一样', () => {
    const repo = repoOf(sampleRepo())
    const { ask } = askUser(repo, 'craft', HEADING, [skip, removed])
    assert.ok(ask)
    // agent 把一项删掉、改了说法，都不算
    for (const text of [ask.text.replace(/\n2\. .*\n/, '\n'), ask.text.replace('接口下线了', '不重要'), '']) {
      assert.deepEqual(check(repo.root, ask.id, text), { ok: false, text: '传来的文字和检查给这个编号的不一致：照它输出的原样填，不要改写、增删。' })
    }
    assert.equal(askUser(repo, 'craft', HEADING, [skip, removed]).pending.length, 2)
    const reflowed = ask.text.split('\n').map(line => `  ${line.trim()}  `).join('\n\n')
    const checked = check(repo.root, ask.id, reflowed)
    assert.ok(checked.ok)
    // 给用户看的是存下的原文，不是传来的那份
    assert.equal(checked.popup, ask.text)
  })

  test('核对通过只是核对：用户同意了记下（record）才算同意过', () => {
    const repo = repoOf(sampleRepo())
    const { ask } = askUser(repo, 'craft', HEADING, [skip, removed])
    assert.ok(ask)
    const checked = check(repo.root, ask.id, ask.text)
    assert.ok(checked.ok)
    assert.equal(askUser(repo, 'craft', HEADING, [skip, removed]).pending.length, 2)
    checked.record()
    assert.deepEqual(askUser(repo, 'craft', HEADING, [skip, removed]), { confirmed: [skip, removed], pending: [] })
  })

  test('按项记：同意过的那一项，别的条目增减不用重新确认', () => {
    const repo = repoOf(sampleRepo())
    const first = askUser(repo, 'craft', HEADING, [skip])
    assert.ok(first.ask)
    userAgrees(repo.root, first.ask.id, first.ask.text)

    // 几个分支合到一起，多了一项：只问新的那一项
    const merged = askUser(repo, 'craft', HEADING, [skip, removed])
    assert.deepEqual(merged.confirmed, [skip])
    assert.deepEqual(merged.pending, [removed])
    assert.ok(merged.ask)
    assert.notEqual(merged.ask.id, first.ask.id)
    assert.match(merged.ask.text, /要你确认的有 1 项：\n\n1\. tests\/b\.test\.ts 删了一个测试/)
    assert.doesNotMatch(merged.ask.text, /tests\/a\.test\.ts/)

    // 同一项重复交两次只算一项
    assert.equal(askUser(repo, 'craft', HEADING, [removed, removed]).pending.length, 1)
  })

  test('改之前、改成什么、给用户看的文字、模块，有一样不同就是另一项', () => {
    const repo = repoOf(sampleRepo())
    const first = askUser(repo, 'craft', HEADING, [skip])
    assert.ok(first.ask)
    userAgrees(repo.root, first.ask.id, first.ask.text)
    assert.equal(askUser(repo, 'craft', HEADING, [skip]).pending.length, 0)

    // 文字一样，改之前的内容不同：不能沿用那次同意
    assert.equal(askUser(repo, 'craft', HEADING, [{ ...skip, before: 'test("a") 在跑，还查了金额' }]).pending.length, 1)
    assert.equal(askUser(repo, 'craft', HEADING, [{ ...skip, after: 'test("a") 删掉了' }]).pending.length, 1)
    assert.equal(askUser(repo, 'craft', HEADING, [{ ...skip, text: 'tests/a.test.ts\n  跳过了测试 a：太慢' }]).pending.length, 1)
    assert.equal(askUser(repo, 'wall', HEADING, [skip]).pending.length, 1)
    // 弹窗开头那半句不是这一项的内容，换了说法不用重新确认
    assert.equal(askUser(repo, 'craft', '这次放松的地方', [skip]).pending.length, 0)
  })

  test('条目变了以后，旧编号的同意对新条目不算', () => {
    const repo = repoOf(sampleRepo())
    const old = askUser(repo, 'craft', HEADING, [skip])
    const changed: ConfirmItem = { ...skip, after: 'test("a") 删掉了', text: 'tests/a.test.ts 删掉了测试 a' }
    const next = askUser(repo, 'craft', HEADING, [changed])
    assert.ok(old.ask && next.ask)
    assert.notEqual(next.ask.id, old.ask.id)
    // 旧编号配新文字：对不上
    assert.equal(check(repo.root, old.ask.id, next.ask.text).ok, false)
    // 旧编号配旧文字：记下的是旧的那一项
    userAgrees(repo.root, old.ask.id, old.ask.text)
    assert.deepEqual(askUser(repo, 'craft', HEADING, [changed]).pending, [changed])
  })

  test('没有的编号、不在仓库里的路径都不记', () => {
    const repo = repoOf(sampleRepo())
    const { ask } = askUser(repo, 'craft', HEADING, [skip])
    assert.ok(ask)
    const missing = { ok: false, text: '没有这个编号要确认的内容：重跑要求确认的那条检查，照它输出的编号和文字填。' }
    assert.deepEqual(check(repo.root, '0'.repeat(32), ask.text), missing)
    // 对象原型上的名字不能当编号
    for (const id of ['constructor', '__proto__', 'toString', '']) assert.deepEqual(check(repo.root, id, ask.text), missing)
    const outside = tempDir('testpace-norepo-')
    assert.deepEqual(check(outside, ask.id, ask.text), { ok: false, text: `${outside} 不在 git 仓库里` })
    assert.deepEqual(check(join(outside, 'none'), ask.id, ask.text), { ok: false, text: `${join(outside, 'none')} 不在 git 仓库里` })
    assert.equal(askUser(repo, 'craft', HEADING, [skip]).pending.length, 1)
  })

  test('存下的内容坏了说明白，不当成同意', () => {
    const repo = repoOf(sampleRepo())
    const { ask } = askUser(repo, 'craft', HEADING, [skip])
    assert.ok(ask)
    const file = join(repo.root, '.git', 'testpace', 'confirm', 'pending.json')
    writeFileSync(file, JSON.stringify({ [ask.id]: { module: 'craft', text: ask.text, items: 'all', at: Date.now() } }))
    assert.deepEqual(check(repo.root, ask.id, ask.text), { ok: false, text: '这个编号存下的内容坏了：重跑要求确认的那条检查，照它输出的编号和文字填。' })
    writeFileSync(file, 'not json')
    assert.equal(check(repo.root, ask.id, ask.text).ok, false)
    assert.equal(askUser(repo, 'craft', HEADING, [skip]).pending.length, 1)
  })

  test('记录所有 worktree 共用：在一个工作区同意的，别的工作区也算', () => {
    const main = sampleRepo()
    const other = join(tempDir('testpace-wt-'), 'wt')
    sh(main, `git worktree add -q --detach '${other}'`)
    const { ask } = askUser(repoOf(other), 'craft', HEADING, [skip])
    assert.ok(ask)
    // repo 给的是工作区里的子目录也认
    userAgrees(join(other, 'src'), ask.id, ask.text)
    assert.deepEqual(askUser(repoOf(main), 'craft', HEADING, [skip]), { confirmed: [skip], pending: [] })
  })

  test('太久以前的同意不再算', () => {
    const repo = repoOf(sampleRepo())
    const { ask } = askUser(repo, 'craft', HEADING, [skip, removed])
    assert.ok(ask)
    userAgrees(repo.root, ask.id, ask.text)
    const file = join(repo.root, '.git', 'testpace', 'confirm', 'confirmed.json')
    const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { text: string; at: number }>
    assert.deepEqual(Object.values(all).map(record => record.text).sort(), [removed.text, skip.text].sort())
    // skip 那一项的同意改成 91 天前的
    for (const record of Object.values(all)) if (record.text === skip.text) record.at -= 91 * 24 * 3600 * 1000
    writeFileSync(file, JSON.stringify(all))
    const again = askUser(repo, 'craft', HEADING, [skip, removed])
    assert.deepEqual(again.confirmed, [removed])
    assert.deepEqual(again.pending, [skip])
  })
})

describe('确认工具（MCP 服务）', () => {
  const SERVER = fileURLToPath(new URL('../src/mcp.ts', import.meta.url))
  const HEADING = '这次放松的地方'
  const DONE = '已记下：用户确认并同意了这 1 项。再跑一次要求确认的那条检查。'
  const NO_FORM = '这个客户端不支持向用户弹表单（MCP elicitation），没法让用户本人确认，没有记下。升级客户端，或在 Claude Code 里确认。'
  const DECLINED = '用户拒绝了，没有记下：照用户的意思改回去或换个做法。'
  const NOT_CONFIRMED = '用户没有确认（表单取消了或弹不出来，比如不能交互的 codex exec），没有记下。'

  /** 起一次服务，一行发一条，读回各条消息。args 是启动参数（Codex 起的带 codex）。 */
  function serve(lines: Array<Record<string, unknown> | string>, args: string[] = []): Array<Record<string, any>> {
    const input = lines.map(line => (typeof line === 'string' ? line : JSON.stringify({ jsonrpc: '2.0', ...line }))).join('\n')
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER, ...args], { input: `${input}\n`, encoding: 'utf8', env: ENV })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }

  /** 一个仓库里存好一项待确认的，返回仓库、这一项和检查给的编号、文字。 */
  function pendingAsk(): { repo: Repo; item: ConfirmItem; id: string; text: string } {
    const repo = openRepo(sampleRepo())
    assert.ok(repo)
    const item: ConfirmItem = { before: 'a', after: 'b', text: '把 a 改成了 b' }
    const { ask } = askUser(repo, 'craft', HEADING, [item])
    assert.ok(ask)
    return { repo, item, id: ask.id, text: ask.text }
  }

  const call = (id: number, args: Record<string, unknown>): Record<string, unknown> => ({ id, method: 'tools/call', params: { name: 'confirm_with_user', arguments: args } })
  const initialize = (capabilities?: Record<string, unknown>): Record<string, unknown> => ({
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', ...(capabilities === undefined ? {} : { capabilities }) },
  })
  const toolText = (body: string, isError: boolean): Record<string, unknown> => ({ content: [{ type: 'text', text: body }], isError })

  /**
   * 带 codex 起服务，边发边读：next() 等服务发来的下一条消息（回复，或它向客户端发的表单请求），不靠等固定时间。
   * end() 关掉输入，等服务退出，确认没有没读到的消息。
   */
  function codexServer(): { send: (message: Record<string, unknown>) => void; next: () => Promise<Record<string, any>>; end: () => Promise<void> } {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER, 'codex'], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => (stderr += chunk))
    const unread: Array<Record<string, any>> = []
    const readers: Array<{ resolve: (message: Record<string, any>) => void; reject: (error: Error) => void }> = []
    createInterface({ input: child.stdout }).on('line', line => {
      if (line.trim() === '') return
      const message = JSON.parse(line) as Record<string, any>
      const reader = readers.shift()
      if (reader) reader.resolve(message)
      else unread.push(message)
    })
    const exited = new Promise<number | null>(resolve =>
      child.on('close', code => {
        for (const reader of readers.splice(0)) reader.reject(new Error(`服务退出了（${code}），没等到消息：${stderr}`))
        resolve(code)
      }),
    )
    return {
      send: message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`),
      next: () => {
        const message = unread.shift()
        if (message) return Promise.resolve(message)
        return new Promise((resolve, reject) => readers.push({ resolve, reject }))
      },
      end: async () => {
        child.stdin.end()
        assert.equal(await exited, 0, stderr)
        assert.deepEqual(unread, [])
      },
    }
  }

  /** 带 codex 起服务、说支持表单，调一次工具，读到服务发来的表单请求。 */
  async function formAsked(
    args: Record<string, unknown>,
    capabilities: Record<string, unknown> = { elicitation: {} },
  ): Promise<{ server: ReturnType<typeof codexServer>; form: Record<string, any> }> {
    const server = codexServer()
    server.send(initialize(capabilities))
    assert.equal((await server.next()).id, 1)
    server.send({ method: 'notifications/initialized' })
    server.send(call(2, args))
    return { server, form: await server.next() }
  }

  test('只有一个工具，标了每次都要用户在弹窗里同意', () => {
    const [initialized, listed] = serve([
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
    ])
    assert.equal(initialized?.result.serverInfo.name, PLUGIN_NAME)
    assert.deepEqual(initialized?.result.capabilities, { tools: {} })
    const tools = listed?.result.tools as Array<Record<string, any>>
    assert.equal(tools.length, 1)
    assert.equal(tools[0]?.name, 'confirm_with_user')
    assert.deepEqual(tools[0]?._meta, { 'anthropic/requiresUserInteraction': true })
    assert.deepEqual(tools[0]?.inputSchema.required, ['repo', 'id', 'text'])
  })

  test('不带 codex 起（Claude Code、Antigravity）：调用时照编号核对文字、直接记下同意，客户端支持表单也不发；文字不对回错误', () => {
    const { repo, item, id, text } = pendingAsk()
    const [initialized, wrong, missing, done, unknown, notJson, ...rest] = serve([
      initialize({ elicitation: {} }),
      call(1, { repo: repo.root, id, text: '改写过的文字' }),
      call(2, { repo: repo.root, id }),
      call(3, { repo: repo.root, id, text }),
      { id: 4, method: 'tools/call', params: { name: 'other', arguments: {} } },
      'not json',
    ])
    assert.equal(initialized?.id, 1)
    assert.equal(wrong?.result.isError, true)
    assert.match(wrong?.result.content[0].text, /不一致/)
    assert.deepEqual(missing?.result, toolText('repo、id、text 都要填文字', true))
    assert.deepEqual(done?.result, toolText(DONE, false))
    assert.equal(unknown?.error.code, -32602)
    assert.equal(notJson?.error.code, -32700)
    assert.deepEqual(rest, [], '服务没向客户端发别的（表单）')
    assert.deepEqual(askUser(repo, 'craft', HEADING, [item]), { confirmed: [item], pending: [] })
  })

  describe('带 codex 起（Codex）：核对通过后向客户端发表单，用户点同意才记下', () => {
    test('客户端没说支持表单（没声明 elicitation，或只声明了 url 方式）：不发表单、不记，说明原因', () => {
      for (const capabilities of [undefined, {}, { elicitation: { url: {} } }]) {
        const { repo, item, id, text } = pendingAsk()
        const messages = serve([initialize(capabilities), call(2, { repo: repo.root, id, text })], ['codex'])
        assert.deepEqual(
          messages.map(message => message.method),
          [undefined, undefined],
          `${JSON.stringify(capabilities)}：服务没发请求`,
        )
        assert.deepEqual(messages[1], { jsonrpc: '2.0', id: 2, result: toolText(NO_FORM, true) }, JSON.stringify(capabilities))
        assert.deepEqual(askUser(repo, 'craft', HEADING, [item]).pending, [item], JSON.stringify(capabilities))
      }
    })

    test('核对不过（文字不对、编号不存在、参数缺）：直接回错误，不发表单、不记', () => {
      const { repo, item, id, text } = pendingAsk()
      const messages = serve(
        [
          initialize({ elicitation: { form: {} } }),
          call(2, { repo: repo.root, id, text: '改写过的文字' }),
          call(3, { repo: repo.root, id: '0'.repeat(32), text }),
          call(4, { repo: repo.root, id }),
        ],
        ['codex'],
      )
      assert.deepEqual(messages.map(message => [message.id, message.method]), [[1, undefined], [2, undefined], [3, undefined], [4, undefined]])
      assert.deepEqual(messages[1]?.result, toolText('传来的文字和检查给这个编号的不一致：照它输出的原样填，不要改写、增删。', true))
      assert.deepEqual(messages[2]?.result, toolText('没有这个编号要确认的内容：重跑要求确认的那条检查，照它输出的编号和文字填。', true))
      assert.deepEqual(messages[3]?.result, toolText('repo、id、text 都要填文字', true))
      assert.deepEqual(askUser(repo, 'craft', HEADING, [item]).pending, [item])
    })

    test('支持表单时（elicitation 写 {} 或带 form）：表单里是检查存下的原文，等用户回答后才回工具调用；同意了记下', async () => {
      for (const capabilities of [{ elicitation: {} }, { elicitation: { form: {} } }, { elicitation: { form: {}, url: {} } }]) {
        const { repo, item, id, text } = pendingAsk()
        // 调用方传的文字排版不同（缩进、空行），核对算一样；表单里给用户看的是存下的那份
        const reflowed = text.split('\n').map(line => `  ${line.trim()}  `).join('\n\n')
        const { server, form } = await formAsked({ repo: repo.root, id, text: reflowed }, capabilities)
        assert.equal(form.method, 'elicitation/create', JSON.stringify(capabilities))
        assert.deepEqual(form.params, { message: `gatelight 要你确认：\n\n${text}`, requestedSchema: { type: 'object', properties: {} } })
        assert.notEqual(form.id, undefined)

        // 用户还没回答：工具调用没回，别的请求照常回
        server.send({ id: 3, method: 'ping' })
        assert.deepEqual(await server.next(), { jsonrpc: '2.0', id: 3, result: {} })
        assert.deepEqual(askUser(repo, 'craft', HEADING, [item]).pending, [item], '还没回答时不记')

        server.send({ id: form.id, result: { action: 'accept' } })
        assert.deepEqual(await server.next(), { jsonrpc: '2.0', id: 2, result: toolText(DONE, false) })
        await server.end()
        assert.deepEqual(askUser(repo, 'craft', HEADING, [item]), { confirmed: [item], pending: [] }, JSON.stringify(capabilities))
      }
    })

    test('用户拒绝、取消，或客户端回的是错误（弹不出表单）：不记，说明是哪种', async () => {
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ['拒绝', { result: { action: 'decline' } }, DECLINED],
        ['取消', { result: { action: 'cancel' } }, NOT_CONFIRMED],
        ['客户端出错', { error: { code: -32600, message: '不能交互' } }, NOT_CONFIRMED],
      ]
      for (const [label, answer, expected] of cases) {
        const { repo, item, id, text } = pendingAsk()
        const { server, form } = await formAsked({ repo: repo.root, id, text })
        assert.equal(form.method, 'elicitation/create', label)
        server.send({ id: form.id, ...answer })
        assert.deepEqual(await server.next(), { jsonrpc: '2.0', id: 2, result: toolText(expected, true) }, label)
        await server.end()
        assert.deepEqual(askUser(repo, 'craft', HEADING, [item]).pending, [item], label)
      }
    })

    test('同一个服务里调几次，每次各发一张表单，按各自的回答记', async () => {
      const first = pendingAsk()
      const second = pendingAsk()
      const { server, form } = await formAsked({ repo: first.repo.root, id: first.id, text: first.text })
      server.send({ id: form.id, result: { action: 'decline' } })
      assert.equal((await server.next()).id, 2)
      server.send(call(3, { repo: second.repo.root, id: second.id, text: second.text }))
      const again = await server.next()
      assert.equal(again.method, 'elicitation/create')
      assert.notEqual(again.id, form.id)
      server.send({ id: again.id, result: { action: 'accept' } })
      assert.deepEqual(await server.next(), { jsonrpc: '2.0', id: 3, result: toolText(DONE, false) })
      await server.end()
      assert.deepEqual(askUser(first.repo, 'craft', HEADING, [first.item]).pending, [first.item])
      assert.deepEqual(askUser(second.repo, 'craft', HEADING, [second.item]).pending, [])
    })
  })
})

describe('调 LayerMap', () => {
  /** 假的 layermap 命令：照脚本输出、退出。返回只有它和 node 的 PATH。 */
  function fake(script: string): string {
    const dir = tempDir('testpace-fake-layermap-')
    writeFileSync(join(dir, 'layermap'), `#!/usr/bin/env node\n${script}\n`)
    chmodSync(join(dir, 'layermap'), 0o755)
    return dir
  }

  /** 调的时候把 PATH 换成只有这个目录（加上 node 和系统命令）。 */
  function ask(dir: string | undefined, args: string[]): ReturnType<typeof layermap> {
    const repo = sampleRepo()
    const node = sh(repo, 'dirname "$(command -v node)"').trim()
    const saved = process.env.PATH
    process.env.PATH = [...(dir ? [dir] : []), node, '/usr/bin', '/bin'].join(':')
    try {
      return layermap(repo, args)
    } finally {
      process.env.PATH = saved
    }
  }

  test('跑成了给出它输出的 JSON；在仓库根目录跑，参数原样带上', () => {
    const dir = fake('process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: require("node:fs").existsSync("testpace.json") }))')
    assert.deepEqual(ask(dir, ['check', '--json', '--base', 'HEAD']), { ok: true, value: { args: ['check', '--json', '--base', 'HEAD'], cwd: true } })
  })

  test('找不到命令、它出错、版本太旧，都是说明了原因的失败', () => {
    assert.deepEqual(ask(undefined, ['check', '--json']), { ok: false, kind: 'missing', problem: '找不到 layermap 命令' })

    const failing = fake('console.error("building map"); console.error("layermap: map build failed"); process.exit(1)')
    assert.deepEqual(ask(failing, ['check', '--json']), { ok: false, kind: 'failed', problem: 'layermap 出错了：layermap: map build failed' })
    const silent = fake('process.exit(3)')
    assert.deepEqual(ask(silent, ['check', '--json']), { ok: false, kind: 'failed', problem: 'layermap 出错了（退出码 3）' })

    const old = { ok: false, kind: 'old', problem: `layermap 版本太旧，要 ${LAYERMAP_MINIMUM} 以上：升级 layermap 插件（Claude Code 里是 claude plugin update layermap@layermap），开新会话后再跑` }
    // 旧版不认识的命令只打印用法
    assert.deepEqual(ask(fake('console.error("Usage: layermap <command>"); process.exit(2)'), ['imports', '--json']), old)
    // 输出不是 JSON
    assert.deepEqual(ask(fake('console.log("3 files changed")'), ['check', '--json']), old)
  })
})

describe('ignore 合并后才生效', () => {
  const contractWith = (ignore: string[]) => parseContract({ ignore })

  test('这份约定里有、默认分支上原来那份里也有的才认：新加的这次不算，删掉的马上生效', () => {
    const landed = contractWith(['docs/**', 'notes/**'])
    assert.deepEqual(effectiveIgnore(contractWith(['docs/**', 'notes/**']), landed), ['docs/**', 'notes/**'])
    assert.deepEqual(effectiveIgnore(contractWith(['docs/**', 'src/**']), landed), ['docs/**'])
    assert.deepEqual(effectiveIgnore(contractWith(['**']), landed), [])
    assert.deepEqual(effectiveIgnore(contractWith([]), landed), [])
    // 默认分支上还没有约定（首次接入）、要落地的代码里没有约定：一条也不认
    assert.deepEqual(effectiveIgnore(contractWith(['docs/**']), undefined), [])
    assert.deepEqual(effectiveIgnore(undefined, landed), [])
  })
})

describe('模块的记录', () => {
  interface Note {
    text: string
    at: number
  }
  const notesOf = (dir: string, name = 'notes'): ModuleRecords<Note> => {
    const repo = openRepo(dir)
    assert.ok(repo)
    return new ModuleRecords<Note>(repo.store, 'craft', name)
  }

  test('按键存取，放在 .git/testpace/<模块>/ 下，所有 worktree 共用；键不认对象原型上的名字', () => {
    const main = sampleRepo()
    const notes = notesOf(main)
    assert.equal(notes.get('a'), undefined)
    notes.put('a', { text: '一', at: Date.now() })
    notes.put('b', { text: '二', at: Date.now() })
    assert.equal(notes.get('a')?.text, '一')
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(main, '.git', 'testpace', 'craft', 'notes.json'), 'utf8'))), ['a', 'b'])
    for (const key of ['constructor', '__proto__', 'toString']) assert.equal(notes.get(key), undefined)
    // 不同名字的记录互不相干
    assert.equal(notesOf(main, 'other').get('a'), undefined)

    const other = join(tempDir('testpace-wt-'), 'wt')
    sh(main, `git worktree add -q --detach '${other}'`)
    assert.equal(notesOf(other).get('b')?.text, '二')
  })

  test('按内容记的结论：写之前内容的标识变了就不记', () => {
    const notes = notesOf(sampleRepo())
    assert.equal(notes.saveChecked('k1', () => 'k1', { text: '通过', at: Date.now() }), true)
    assert.equal(notes.get('k1')?.text, '通过')
    // 跑的过程中内容改过：现在算出来的是 k9，按 k2 得出的结论不记，k9 下也不记
    assert.equal(notes.saveChecked('k2', () => 'k9', { text: '通过', at: Date.now() }), false)
    assert.equal(notes.get('k2'), undefined)
    assert.equal(notes.get('k9'), undefined)
  })

  test('太久以前的记录读不到；文件写坏了当成没有', () => {
    const repo = sampleRepo()
    const notes = notesOf(repo)
    const day = 24 * 3600 * 1000
    notes.put('old', { text: '旧', at: Date.now() - 91 * day })
    notes.put('recent', { text: '新', at: Date.now() - 89 * day })
    assert.equal(notes.get('old'), undefined)
    assert.equal(notes.get('recent')?.text, '新')
    writeFileSync(join(repo, '.git', 'testpace', 'craft', 'notes.json'), 'not json')
    assert.equal(notes.get('recent'), undefined)
    notes.put('again', { text: '再来', at: Date.now() })
    assert.equal(notes.get('again')?.text, '再来')
  })
})

describe('会话起点', () => {
  test('算法的名字换了，以前记的起点不算：当作没有，把现在的样子记成起点', () => {
    const repo = openRepo(sampleRepo())
    assert.ok(repo)
    const old = new SessionBaselines<string>(repo, 'craft', 'look-1')
    old.note('s1', () => 'before')
    assert.equal(old.since('s1', 'now'), 'before')
    // 换了算法：旧起点和新算出来的样子没法比
    const next = new SessionBaselines<string>(repo, 'craft', 'look-2')
    assert.equal(next.since('s1', 'now'), 'now')
    assert.equal(next.since('s1', 'later'), 'now')
  })
})
