// 整组（testpace full）的编排：底座跑、底座记录，跑什么由各模块交的各段决定（module.ts 的 fullPart）。
// 检查随插件一起装，没有在本机另外登记检查的入口：模块的顺序就是各段的顺序（src/modules.ts）。

import { appendFileSync, existsSync, statSync } from 'node:fs'
import { countedIgnore, loadContract } from './contract.ts'
import { type Execution, execute } from './execute.ts'
import { EXIT } from './exit.ts'
import { duration, short } from './format.ts'
import { changedPaths, currentBranch, headCommit, workTreeId } from './git.ts'
import { type FullPart, type FullStep, modules } from './module.ts'
import { busyText, coverageOf, describeCoverage, failureText, type Repo, runner, started } from './repo.ts'
import { newRunId, type RunMarker, type RunRecord, type RunStep } from './store.ts'

/**
 * testpace full：依次跑各模块交的各段，便宜的在前，一段没过就停；都过了、跑的过程中内容没变，
 * 才留下这份内容的整组通过记录。sessionId 是起这次整组的 agent 会话（停止门只拦起它的会话和等着用它结果的会话）。
 */
export async function full(ctx: Repo, sessionId: string | undefined): Promise<number> {
  // 约定有问题，或哪个模块现在跑不了（没接入、没有要跑的）：说明原因，不跑
  const contract = loadContract(ctx.root)
  const parts: FullPart[] = []
  const dispose = (): void => parts.forEach(part => part.dispose?.())
  let problem = contract?.problems.length ? contract.problems.join('；') : undefined
  for (const module of modules()) {
    if (problem !== undefined) break
    const part = module.fullPart?.(ctx)
    if (!part) continue
    if ('problem' in part) problem = part.problem
    else parts.push(part)
  }
  if (problem === undefined && parts.length === 0) problem = '没有哪个模块有要跑的'
  if (problem !== undefined) {
    dispose()
    console.error(`没法跑整组：${problem}`)
    return EXIT.usage
  }
  try {
    return await run(ctx, sessionId, countedIgnore(ctx.root, contract).rules, parts)
  } finally {
    dispose()
  }
}

async function run(ctx: Repo, sessionId: string | undefined, ignore: string[], parts: FullPart[]): Promise<number> {
  const tree = workTreeId(ctx.root)
  const coverage = coverageOf(ctx, ignore, tree)
  if (coverage.kind !== 'none') {
    console.log(`这份代码${describeCoverage(coverage)}，不重跑。`)
    return EXIT.ok
  }

  const elsewhere = ctx.store.running().find(marker => marker.kind === 'full' && marker.tree === tree && marker.worktree !== ctx.root)
  if (elsewhere) {
    console.log(`工作区 ${elsewhere.worktree} 正在跑同一份代码的整组（${started(elsewhere)}）。等它结束后用 testpace status 看结果。`)
    return EXIT.busy
  }

  const startedAt = Date.now()
  const id = newRunId(startedAt)
  const log = ctx.store.logPath(id)
  const session = sessionId ? { session: sessionId } : {}
  const busy = ctx.store.claim({ id, kind: 'full', pid: process.pid, worktree: ctx.root, tree, startedAt, ...session, log })
  if (busy?.kind === 'full') {
    if (sessionId) ctx.store.waitOn(busy, sessionId)
    console.log(`这个工作区已有整组在跑（${started(busy)}）。等它结束后用 testpace status 看结果。`)
    return EXIT.busy
  }
  if (busy) {
    console.log(busyText(busy, tree))
    return EXIT.busy
  }

  // 依次跑各模块交的各段，便宜的在前，一段没过就停。都过了才算整组通过。
  const steps: FullStep[] = parts.flatMap(part => part.steps)
  // 各模块给命令的环境变量（比如交每个测试结果的位置），每一段都带着
  const partsEnv: Record<string, string> = Object.assign({}, ...parts.map(part => part.env ?? {}))
  // 每段各用了多久：report 据此说整组的时间花在哪一段
  const timings: RunStep[] = []
  const onStart = (group: number) => ctx.store.update(ctx.root, id, { group })
  const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0)
  let failed: (typeof steps)[number] | undefined
  // 失败节选从没通过的那一段的输出开始
  let excerptFrom = 0
  let execution: Execution | undefined
  let waiting: string[]
  try {
    for (const step of steps) {
      excerptFrom = sizeOf(log)
      appendFileSync(log, `===== testpace ${step.header}\n`)
      const part = await execute(step.command, step.args, ctx.root, log, onStart, partsEnv)
      execution = execution ? { ...part, durationMs: execution.durationMs + part.durationMs } : part
      if (!part.interrupted) timings.push({ kind: step.kind, name: step.name, durationMs: part.durationMs })
      if (part.interrupted || part.exitCode !== 0) {
        failed = step
        break
      }
    }
  } finally {
    waiting = ctx.store.release(ctx.root, id)
  }
  if (!execution) throw new Error('整组没有运行')

  if (execution.interrupted) {
    console.log(`整组被中断，没有记录结果。日志：${log}`)
    return EXIT.interrupted
  }

  // 各模块往记录里加自己的字段，记录写下之后再说它们要说的话
  const finished = parts.map(part => part.finish?.(failed?.name) ?? {})
  // 各段都过了，再按交回来的东西核对：该跑到的没跑到，整组也算没过
  const problems = execution.exitCode === 0 ? finished.flatMap(done => done.problems ?? []) : []
  if (problems.length) appendFileSync(log, `===== testpace 跑完核对没通过\n${problems.join('\n')}\n`)
  const treeAtEnd = workTreeId(ctx.root)
  const result = execution.exitCode === 0 && problems.length === 0 ? 'pass' : 'fail'
  const before = ctx.store.readRuns()
  const record: RunRecord = {
    id,
    kind: 'full',
    worktree: ctx.root,
    branch: currentBranch(ctx.root),
    head: headCommit(ctx.root),
    tree,
    treeAtEnd,
    startedAt,
    durationMs: execution.durationMs,
    exitCode: execution.exitCode,
    result,
    ...session,
    ...(waiting.length ? { waiting } : {}),
    steps: timings,
    ...Object.assign({}, ...finished.map(done => done.fields ?? {})),
    ...runner(),
    log,
  }
  ctx.store.appendRun(record)
  const notes = finished.flatMap(done => done.notes?.(record, before) ?? [])
  const say = (text: string): void => console.log([text, ...notes].join('\n'))

  const took = duration(execution.durationMs)
  if (result === 'pass' && tree === treeAtEnd) {
    say(`${['整组通过', ...parts.flatMap(part => part.summary ?? []), `用时 ${took}`, `代码 ${short(tree)}`].join(' · ')}\n日志：${log}`)
    return EXIT.ok
  }
  if (result === 'pass') {
    const changed = changedPaths(ctx.root, tree, treeAtEnd)
    const more = changed.length > 5 ? ` 等 ${changed.length} 个` : ''
    say(
      [
        `整组通过，但跑的过程中代码改过，这次不算通过记录。变了的文件：${changed.slice(0, 5).join('、')}${more}`,
        '是整组自己生成的文件，就加进 .gitignore 或让它写到仓库外；是别处改的，代码不再改动时重跑 testpace full。',
        `用时 ${took} · 日志：${log}`,
      ].join('\n'),
    )
    return EXIT.fail
  }
  if (problems.length) {
    say([`整组失败：各段都过了，跑完核对没通过（该跑到的没跑到）`, ...problems.map(problem => `- ${problem}`), `用时 ${took} · 日志：${log}`].join('\n'))
    return EXIT.fail
  }
  const what = failed?.title ?? '整组'
  const gap = /[A-Za-z0-9]$/.test(what) ? ' ' : ''
  say(failureText(`整组失败：${what}${gap}没通过${failed === steps.at(-1) ? '' : '，后面的没有跑'}`, log, execution, excerptFrom))
  return EXIT.fail
}
