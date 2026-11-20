// 放宽规则要用户同意：条目交给底座的确认（base/confirm.ts），同意按"哪一项改动加当时看到的文字"记。

import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { confirm } from '../../src/base/confirm.ts'
import { editConfig, modwall, pendingOf, sampleRepo, sh, write } from './helpers.ts'

describe('放宽规则要用户在弹窗里同意', () => {
  test('首次接入：整份配置确认一次才通过；对不上的不算；配置再改要重新确认', () => {
    const config = readFileSync(join(sampleRepo(), '.modwall/config.json'), 'utf8')
    // 分叉点上还没有配置，这次加上
    const repo = sampleRepo(dir => rmSync(join(dir, '.modwall'), { recursive: true }))
    write(repo, '.modwall/config.json', config)

    let r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /放宽规则 1 项（和分叉点上的配置比），要用户同意/)
    assert.match(r.out, /这 1 项还没经用户确认。用户不会看命令输出，要调用 testpace 的 confirm_with_user 工具/)
    const asked = pendingOf(r.out)
    assert.match(asked.text, /^这次改动里放宽模块边界规则的地方，要你确认的有 1 项：\n/)
    assert.equal(asked.items.length, 1)
    assert.match(asked.items[0] as string, /^首次接入 modwall（分叉点上还没有配置），整份配置：\{"roots":\["src\/modules"\]/)

    assert.equal(confirm(repo, asked.id, asked.text.replace('src/modules', 'src')).ok, false)
    assert.match(modwall(repo, ['check']).out, /还没经用户确认/)

    assert.equal(confirm(repo, asked.id, asked.text).ok, true)
    r = modwall(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /放宽规则 1 项，用户都同意过/)

    // 整份配置变了：之前的确认对不上
    editConfig(repo, c => c.outside.push('tools/**'))
    r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.match(pendingOf(r.out).items[0] as string, /"outside":\["scripts\/\*\*","tools\/\*\*"\]/)
  })

  test('按项记：同意过的项不用再同意，新加的只问新的；收紧不用确认', () => {
    const repo = sampleRepo()
    editConfig(repo, c => {
      c.shared.push('src/common/**')
      c.allow.push({ rule: 'R3', from: 'src/shared/money.ts', to: 'src/main.ts', reason: '启动参数待拆' })
    })
    let r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const asked = pendingOf(r.out)
    assert.deepEqual(asked.items, ['shared 扩大：新增 "src/common/**"', 'allow 新增例外：R3 src/shared/money.ts → src/main.ts，理由：启动参数待拆'])
    assert.equal(confirm(repo, asked.id, asked.text).ok, true)
    assert.equal(modwall(repo, ['check']).code, 0)

    // 收紧（删掉例外）：不用再确认
    editConfig(repo, c => {
      c.allow = []
    })
    assert.equal(modwall(repo, ['check']).code, 0)
    // 再加一条：只要同意新的这条
    editConfig(repo, c => c.entry.push('main.ts'))
    r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(pendingOf(r.out).items, ['entry 新增入口文件名 "main.ts"'])
    const status = modwall(repo, ['status']).out
    assert.match(status, /✓ 用户同意过：shared 扩大：新增 "src\/common\/\*\*"/)
    assert.match(status, /· 还没同意：entry 新增入口文件名 "main\.ts"/)
  })

  test('删掉整个 .modwall/ 躲不过检查：要用户同意，同意后这份改动退出 modwall', () => {
    const repo = sampleRepo()
    rmSync(join(repo, '.modwall'), { recursive: true })
    // 退出之后规则不再查
    write(repo, 'src/loose.ts', 'export const loose = 1\n')
    let r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const asked = pendingOf(r.out)
    assert.deepEqual(asked.items, ['删掉了整个 .modwall/ 目录'])
    assert.equal(confirm(repo, asked.id, asked.text).ok, true)
    r = modwall(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /退出 modwall/)
  })

  test('文字一样、删掉的是另一份配置：是另一项，要重新同意（同意不只按文字记）', () => {
    const repo = sampleRepo()
    rmSync(join(repo, '.modwall'), { recursive: true })
    const first = pendingOf(modwall(repo, ['check']).out)
    assert.equal(confirm(repo, first.id, first.text).ok, true)
    assert.equal(modwall(repo, ['check']).code, 0)

    // 这次删除没落地；默认分支上的配置后来变了（多了一条例外），在新的分支上再删
    sh(repo, 'git checkout -q -- .modwall && git checkout -q main')
    editConfig(repo, c => c.allow.push({ rule: 'R3', from: 'src/shared/money.ts', to: 'src/main.ts', reason: '启动参数待拆' }))
    sh(repo, 'git add -A && git commit -qm allow && git checkout -qb later')
    rmSync(join(repo, '.modwall'), { recursive: true })
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 1, r.out)
    const again = pendingOf(r.out)
    assert.deepEqual(again.items, ['删掉了整个 .modwall/ 目录'])
    assert.notEqual(again.id, first.id)
  })

  test('两个分支在同一份配置上做同一项放宽：是同一个决定，共用一次同意', () => {
    const repo = sampleRepo()
    const loosen = (): void => editConfig(repo, c => c.shared.push('src/common/**'))
    loosen()
    const asked = pendingOf(modwall(repo, ['check']).out)
    assert.equal(confirm(repo, asked.id, asked.text).ok, true)

    sh(repo, 'git checkout -q -- .modwall && git checkout -qb other main')
    loosen()
    // 这个分支上另外还动了别的地方（收紧）：那一项照样不用再问
    editConfig(repo, c => {
      c.entry = c.entry.filter((name: string) => name !== 'index.tsx')
    })
    const r = modwall(repo, ['check'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /放宽规则 1 项，用户都同意过/)
  })
})
