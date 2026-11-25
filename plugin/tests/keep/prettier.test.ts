// 格式检查查哪些文件（prettier: true）：原来查、现在不查了的文件算放松。
// gatelight 仓库里没装 prettier（测试不另外装），这里用一个替身 prettier 包：只认 .prettierignore 里逐行写的路径和目录，
// 按扩展名给出能不能格式化。它守的是 codekeep 这一侧（在分叉点的临时 worktree 里算、只比两边都有的文件、合成一项）；
// 真 prettier 自己怎么读忽略文件、写法选项改了算不算放松，这里不测。

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { codekeep, keepConfig, keepRepo, pendingOf, tempDir, write } from './helpers.ts'

/** 一个只有替身 prettier 的 node_modules。 */
function fakePrettier(): string {
  const modules = tempDir('codekeep-prettier-')
  write(modules, 'prettier/package.json', JSON.stringify({ name: 'prettier', version: '0.0.0-fake', main: 'index.cjs' }))
  write(
    modules,
    'prettier/index.cjs',
    `const { existsSync, readFileSync } = require('node:fs')
const { dirname, relative } = require('node:path')
exports.getFileInfo = async (path, { ignorePath }) => {
  const ignored = ignorePath.filter(file => existsSync(file)).some(file => {
    const rel = relative(dirname(file), path)
    return readFileSync(file, 'utf8').split('\\n').map(line => line.trim().replace(/\\/$/, '')).filter(line => line && !line.startsWith('#'))
      .some(line => rel === line || rel.startsWith(line + '/'))
  })
  return { ignored, inferredParser: /\\.(js|json|md)$/.test(path) ? 'babel' : null }
}
`,
  )
  return modules
}

describe('格式检查查哪些文件', () => {
  test('往 .prettierignore 里加路径：原来查、现在不查的文件合成一项；这次新加的文件不算', () => {
    const repo = keepRepo(
      {
        '.codekeep/config.json': keepConfig({ checks: [{ name: 'format', command: 'true' }], prettier: true }),
        '.prettierignore': 'dist\n',
        'src/a.js': 'a\n',
        'src/legacy/old.js': 'old\n',
        'src/legacy/older.js': 'older\n',
        'notes.txt': '认不出写法的文件本来就不查\n',
      },
      { modules: fakePrettier() },
    )
    write(repo, 'src/legacy/new.js', 'new\n')
    write(repo, '.prettierignore', 'dist\nsrc/legacy/\nnotes.txt\n')
    const r = codekeep(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const asked = pendingOf(r.out)
    assert.deepEqual(asked.items, ['2 个文件不再做格式检查（被 .prettierignore 之类的忽略了）：以后这些文件格式乱了也照样通过'])
    assert.match(asked.text, /\n {3}src\/legacy\/old\.js\n {3}src\/legacy\/older\.js\n\n同意/)
  })
})
