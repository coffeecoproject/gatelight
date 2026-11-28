import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { describe, test } from 'node:test'
import { invocations, runsCommand, tokenize } from '../src/base/shell.ts'

describe('拆命令', () => {
  test('引号、转义、注释和操作符', () => {
    assert.deepEqual(tokenize(`git commit -m "fix: a \\"b\\"" && echo 'x y'; ls|wc # 注释 git push`), [
      'git', 'commit', '-m', 'fix: a "b"', '&&', 'echo', 'x y', ';', 'ls', '|', 'wc',
    ])
  })

  test('重定向不拆成命令，here-document 的正文跳过', () => {
    assert.deepEqual(invocations('git commit -m x 2>&1 | tail -3', '/r'), [
      { cwd: '/r', argv: ['git', 'commit', '-m', 'x'], writes: false },
      { cwd: '/r', argv: ['tail', '-3'], writes: false },
    ])
    assert.deepEqual(invocations("git commit -F - <<'EOF' && echo done\nit's a git push\nEOF\ngit push", '/r'), [
      { cwd: '/r', argv: ['git', 'commit', '-F', '-'], writes: false },
      { cwd: '/r', argv: ['echo', 'done'], writes: false },
      { cwd: '/r', argv: ['git', 'push'], writes: false },
    ])
    assert.deepEqual(invocations('cat << END > f\nx\nEND\nls &>/dev/null &', '/r'), [
      { cwd: '/r', argv: ['cat'], writes: true },
      { cwd: '/r', argv: ['ls'], writes: false },
    ])
  })

  test('输出重定向到了文件的调用记成往文件里写（> file、>> file、&> file、2> file）；写到 /dev/null、2>&1、>&2 不算', () => {
    const writes = (command: string): boolean[] => invocations(command, '/r').map(call => call.writes)
    assert.deepEqual(writes('echo x > a.txt; echo y >> a.txt; ls &> out.log; ls 2> err.txt; git log >log.txt'), [true, true, true, true, true])
    assert.deepEqual(writes('ls > /dev/null 2>&1; ls 2>/dev/null; echo x >&2; ls &>/dev/null; wc -l < a.txt'), [false, false, false, false, false])
  })

  test('跟着 cd 算出每条命令的目录，跳过环境变量前缀和包装', () => {
    const calls = invocations('cd sub && FOO=1 env BAR=2 git status\ncd .. ; command git push origin main', '/repo')
    assert.deepEqual(calls, [
      { cwd: '/repo/sub', argv: ['git', 'status'], writes: false },
      { cwd: '/repo', argv: ['git', 'push', 'origin', 'main'], writes: false },
    ])
  })

  test('cd 不带参数回到主目录，sh -c 里的命令也拆出来', () => {
    assert.deepEqual(invocations('cd && bash -c "cd /x && git commit -am wip"', '/repo'), [
      { cwd: '/x', argv: ['git', 'commit', '-am', 'wip'], writes: false },
    ])
    assert.equal(invocations('cd ~/p && ls', '/repo')[0]!.cwd, `${homedir()}/p`)
  })

  test('cd 的目录要展开才知道时当作没动，$(...) 里的命令也算命令', () => {
    assert.deepEqual(invocations('cd $(git rev-parse --show-toplevel) && testpace full', '/r/sub'), [
      { cwd: '/r/sub', argv: ['git', 'rev-parse', '--show-toplevel'], writes: false },
      { cwd: '/r/sub', argv: ['testpace', 'full'], writes: false },
    ])
    assert.equal(invocations('cd "$DIR" && ls', '/r')[0]!.cwd, '/r')
  })

  test('按顺序连着跑了目标命令（参数完全一样）才算', () => {
    assert.ok(runsCommand('CI=1 pnpm build && pnpm test 2>&1 | tail', 'pnpm build && pnpm test', '/r'))
    // 目标命令在最后、后面没有别的命令，也算
    assert.ok(runsCommand('pnpm build && pnpm test', 'pnpm build && pnpm test', '/r'))
    assert.ok(runsCommand('cd /r && pnpm test', 'pnpm test', '/r'))
    assert.ok(!runsCommand('pnpm build && pnpm lint && pnpm test', 'pnpm build && pnpm test', '/r'))
    assert.ok(!runsCommand('pnpm test --watch', 'pnpm test', '/r'))
  })
})
