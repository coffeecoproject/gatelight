import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { describe, test } from 'node:test'
import { gitSubcommand, invocations, splitArgs, tokenize } from '../src/shell.ts'

describe('拆命令', () => {
  test('引号、转义、注释和操作符', () => {
    assert.deepEqual(tokenize(`git commit -m "fix: a \\"b\\"" && echo 'x y'; ls|wc # 注释 git push`), [
      'git', 'commit', '-m', 'fix: a "b"', '&&', 'echo', 'x y', ';', 'ls', '|', 'wc',
    ])
  })

  test('重定向不拆成命令，here-document 的正文跳过', () => {
    assert.deepEqual(invocations('git commit -m x 2>&1 | tail -3', '/r'), [
      { cwd: '/r', argv: ['git', 'commit', '-m', 'x'] },
      { cwd: '/r', argv: ['tail', '-3'] },
    ])
    assert.deepEqual(invocations("git commit -F - <<'EOF' && echo done\nit's a git push\nEOF\ngit push", '/r'), [
      { cwd: '/r', argv: ['git', 'commit', '-F', '-'] },
      { cwd: '/r', argv: ['echo', 'done'] },
      { cwd: '/r', argv: ['git', 'push'] },
    ])
    assert.deepEqual(invocations('cat << END > f\nx\nEND\nls &>/dev/null &', '/r'), [
      { cwd: '/r', argv: ['cat'] },
      { cwd: '/r', argv: ['ls'] },
    ])
  })

  test('跟着 cd 算出每条命令的目录，跳过环境变量前缀和包装', () => {
    const calls = invocations('cd sub && FOO=1 env BAR=2 git status\ncd .. ; command git push origin main', '/repo')
    assert.deepEqual(calls, [
      { cwd: '/repo/sub', argv: ['git', 'status'] },
      { cwd: '/repo', argv: ['git', 'push', 'origin', 'main'] },
    ])
  })

  test('cd 不带参数回到主目录，sh -c 里的命令也拆出来', () => {
    assert.deepEqual(invocations('cd && bash -c "cd /x && git commit -am wip"', '/repo'), [
      { cwd: '/x', argv: ['git', 'commit', '-am', 'wip'] },
    ])
    assert.equal(invocations('cd ~/p && ls', '/repo')[0]!.cwd, `${homedir()}/p`)
  })

  test('git 的 -C 改目录，-c 和其他全局选项跳过', () => {
    const [call] = invocations('git -C ../other -c user.name=x --no-pager commit -m m', '/repo/a')
    assert.deepEqual(gitSubcommand(call!), { cwd: '/repo/other', sub: 'commit', args: ['-m', 'm'] })
    assert.equal(gitSubcommand({ cwd: '/', argv: ['gitx', 'commit'] }), undefined)
  })
})

describe('分开选项和参数', () => {
  const values = new Set(['-m', '--message'])

  test('带值的选项吃掉下一个参数，--x=y 和 -mmsg 不吃', () => {
    assert.deepEqual(splitArgs(['-m', 'msg', '--message=x', '-mmsg', 'path'], values), {
      options: ['-m', '--message', '-m'],
      positionals: ['path'],
    })
  })

  test('合在一起的短选项拆开，最后一个带值时吃掉下一个参数', () => {
    assert.deepEqual(splitArgs(['-am', 'wip'], values), { options: ['-a', '-m'], positionals: [] })
    assert.deepEqual(splitArgs(['-av', 'file'], values), { options: ['-a', '-v'], positionals: ['file'] })
  })

  test('-- 之后都是位置参数', () => {
    assert.deepEqual(splitArgs(['-a', '--', '-m'], values), { options: ['-a'], positionals: ['-m'] })
  })
})
