// "模块边界"接在底座上的部分：整组里有它的一段、通过记录按开始时的内容记、status 说合并前谁来拦。
// 放宽项的确认见 confirm.test.ts，钩子见 hooks.test.ts。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runs } from '../helpers.ts'
import { ENV, fakeLayermap, modwall, sampleRepo, sh, TESTPACE, write } from './helpers.ts'

const testpace = (repo: string, args: string[], env: NodeJS.ProcessEnv = ENV): { code: number | null; out: string } => {
  const r = spawnSync(TESTPACE, args, { cwd: repo, env, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

describe('整组里的"模块边界"', () => {
  test('接入了的仓库：modwall check 是整组最前面的一段，随插件一起装，不用另外登记；没越界时整组通过', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/modules/billing/index.ts'), '\nexport const fee = 1\n')
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 0, r.out)
    const record = runs(repo).at(-1)!
    assert.deepEqual(
      (record.steps as Array<{ kind: string; name: string }>).map(step => [step.kind, step.name]),
      [
        ['wall', '模块边界的检查（modwall check）'],
        ['full', '整组的检查（full）'],
        ['tests', '全部测试'],
      ],
    )
    assert.match(readFileSync(record.log as string, 'utf8'), /===== testpace 模块边界的检查：modwall check\nmodwall check：通过。项目里没有越界。/)
    // 整组里那一次检查留下了通过记录
    assert.match(modwall(repo, ['status']).out, /当前内容 modwall check 通过过/)
  })

  test('有越界：整组在这一段停下，后面的不跑，不留通过记录；改好后通过', () => {
    const repo = sampleRepo()
    write(repo, 'src/loose.ts', 'export const loose = 1\n')
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^整组失败：模块边界的检查（modwall check）没通过，后面的没有跑/)
    assert.match(r.out, /✗ src\/loose\.ts 没有归属/)
    assert.deepEqual((runs(repo).at(-1)!.steps as Array<{ kind: string }>).map(step => step.kind), ['wall'])
    assert.match(testpace(repo, ['status']).out, /没有整组通过记录/)

    rmSync(join(repo, 'src/loose.ts'))
    assert.equal(testpace(repo, ['full']).code, 0)
  })

  test('删掉 .modwall/ 躲不过这一段（按分叉点也算接入）；没接入的仓库没有这一段', () => {
    const repo = sampleRepo()
    rmSync(join(repo, '.modwall'), { recursive: true })
    const r = testpace(repo, ['full'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /模块边界的检查（modwall check）没通过/)
    assert.match(r.out, /删掉了整个 \.modwall\/ 目录/)

    const outside = sampleRepo(dir => rmSync(join(dir, '.modwall'), { recursive: true }))
    assert.equal(testpace(outside, ['full']).code, 0)
    assert.deepEqual((runs(outside).at(-1)!.steps as Array<{ kind: string }>).map(step => step.kind), ['full', 'tests'])
  })
})

describe('通过记录按开始检查时的内容记', () => {
  test('检查的过程中内容改过：这次不记、不算通过；内容不再变时重跑才记', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/modules/billing/index.ts'), '\nexport const fee = 1\n')
    // 一个假的 layermap：回答"没有越界"，回答的同时改了一个代码文件
    const answers = `case "$1" in
  imports) echo 'export const late = 1' >> src/modules/billing/index.ts; echo '{"imports":[],"unresolved":[]}' ;;
  check) echo '{"edges":{"imports":[],"calls":[],"declarations":[],"truncated":false}}' ;;
esac`
    const r = modwall(repo, ['check'], fakeLayermap(answers))
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /modwall check：通过。项目里没有越界。/)
    assert.match(r.out, /检查过程中内容改过（检查是按开始时的样子做的），这次的结论不算/)
    assert.match(modwall(repo, ['status']).out, /当前内容还没有通过记录/)

    assert.equal(modwall(repo, ['check']).code, 0)
    assert.match(modwall(repo, ['status']).out, /当前内容 modwall check 通过过/)
  })

  test('通过记录所有 worktree 共用：别的 worktree 里同样的内容不用再查', () => {
    const repo = sampleRepo()
    appendFileSync(join(repo, 'src/modules/billing/index.ts'), '\nexport const fee = 1\n')
    sh(repo, 'git add -A && git commit -qm fee')
    assert.equal(modwall(repo, ['check']).code, 0)
    const other = join(repo, '..', 'other')
    sh(repo, `git worktree add -q '${other}' -b same feature`)
    assert.match(modwall(other, ['status']).out, /当前内容 modwall check 通过过/)
  })
})

describe('modwall status：合并前谁来拦', () => {
  test('接入了 testpace：说明它是整组里的一段；testpace 的 ignore 盖住了配置要指出来', () => {
    const repo = sampleRepo()
    assert.match(modwall(repo, ['status']).out, /testpace：接入了。modwall check 是整组（testpace full）里的一段/)
    write(repo, 'testpace.json', '{"fast":"true","files":"true","full":"true","tests":["tests/**"],"ignore":[".modwall/"]}\n')
    assert.match(modwall(repo, ['status']).out, /ignore 盖住了 \.modwall\/config\.json/)
  })

  test('没接入 testpace：说明钩子和合并门都不管它；install、uninstall 不再是命令', () => {
    const repo = sampleRepo(dir => rmSync(join(dir, 'testpace.json')))
    assert.match(modwall(repo, ['status']).out, /testpace：这个仓库没接入（没有 testpace\.json）：会话说明、停止门、合并门都不管它/)
    // 没接入 testpace 也能手动检查
    assert.equal(modwall(repo, ['check']).code, 0)
    for (const command of ['install', 'uninstall']) {
      const gone = modwall(repo, [command])
      assert.equal(gone.code, 2, gone.out)
      assert.match(gone.out, new RegExp(`不认识的命令：${command}`))
    }
  })
})
