// testcraft 的命令：prove、weaken、checklist、review、check、status。命令入口（src/testcraft.ts）分发到这里。
// 找仓库、存记录、让用户确认都用底座的；合并前的检查（check）是整组里的一段（见 full.ts），不用另外登记。

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { askUser } from '../base/confirm.ts'
import { EXIT } from '../base/exit.ts'
import { fileNow, trackedFiles } from '../base/git.ts'
import { openRepo, type Repo } from '../base/repo.ts'
import { open, type Snapshot } from './change.ts'
import { baseChecklist, changedChecklist, hitsOf, unanswered } from './checklist.ts'
import { CHANGES_DIR, CHECKLIST_DIR, RULES_DIR } from './config.ts'
import { Copy } from './copy.ts'
import { kindOf, testNames } from './files.ts'
import { cachedVerdicts, guardsFor, namedTargets, prove, proofKey, proofKeys, proveTargets, type Target, type Verdict } from './prove.ts'
import { readRecords } from './records.ts'
import { missingChecks, reviewKey, reviewing } from './review.ts'
import { openStore, type Store, type UserReview } from './store.ts'
import { behaviorCheck, behaviorUnits, describe, explain, FOR_USER, REVIEW_HEADING, reviewItem, settled, staticSignals, userReview, weakenKey } from './weaken.ts'

const USAGE = `用法：
  testcraft prove [测试文件...]
                      这次新增和改了的测试（或指定的测试文件），逐个证明能抓错：回旧代码跑要因断言失败，不行就在它守的代码上改坏一处，它要发现
  testcraft weaken    放水检查：删测试、跳过、改测试配置和数据、改依赖和测试约定、旧版测试在新代码上跑不过，都要在这次的改动记录里写理由；
                      其中要给用户过目的几种，还要写一行给用户看的白话
  testcraft checklist 清单（.testcraft/checklist/）里这次改动命中的条目：每条要在改动记录的"## 清单"写一行怎么查的、结论
  testcraft review start | done
                      检查员复查的开始和结束。开始前这份改动要先跑过 prove、weaken（检查员要看输出）；复查中改测试不用重跑，
                      收尾时也不催；问题都改完后 done，再各跑一次
  testcraft check     合并前的检查（testpace full 里的一段，接入了的仓库自动跑）：放水检查；放水里删测试、让测试不跑、程序的做法变了、
                      删了或放宽了清单条目这几种要用户过目同意（确认工具弹窗）；清单里命中的条目都写了怎么查的；这次新增、改了的测试都要证明能抓错
  testcraft status    这次改动的证明和放水检查情况、改动记录、清单命中的条目、暂定的规则`

/** 退出码用底座的：0 通过；1 没通过；2 用法、配置或环境问题。 */

interface Opened {
  snapshot: Snapshot
  store: Store
  repo: Repo
}

function snapshot(): Opened | number {
  const repo = openRepo(process.cwd())
  if (!repo) {
    console.error('testcraft 要在 git 仓库里运行。')
    return EXIT.usage
  }
  const { root } = repo
  const opened = open(root)
  if ('problem' in opened) {
    if (opened.code === 'notJoined') {
      console.log(`${opened.problem}，不检查。`)
      return EXIT.ok
    }
    console.error(`没法检查：${opened.problem}`)
    return EXIT.usage
  }
  if (opened.snapshot.problems.length) {
    console.error(`配置有问题：${opened.snapshot.problems.join('；')}`)
    return EXIT.usage
  }
  return { snapshot: opened.snapshot, store: openStore(repo), repo }
}

interface Weakened {
  code: number
  /** 这次检查按的 key：检查开始时改动的样子。 */
  key: string
  /** 通过时，要给用户过目的放水。 */
  review: UserReview[]
}

/** 现在这份改动的放水检查 key：重新看一遍改动。写记录之前核对用；看不了时为空（对不上任何 key）。 */
function currentWeakenKey(root: string): string {
  const opened = open(root)
  return 'problem' in opened ? '' : weakenKey(opened.snapshot)
}

/** 放水检查：打印结论，返回退出码、按的 key 和要给用户过目的放水。 */
async function weaken({ snapshot: s, store, repo }: Opened): Promise<Weakened> {
  const key = weakenKey(s)
  const done = store.weaken.get(key)
  if (done?.result === 'pass') {
    console.log('放水检查：这份改动已经检查过，没有问题。')
    return { code: EXIT.ok, key, review: done.review ?? [] }
  }
  const records = readRecords(s.root, s.changes)
  const signals = staticSignals(s)
  const units = behaviorUnits(s)
  let problem: string | undefined
  if (units.length) {
    if (!s.filesCommand) problem = 'testpace.json 里没有 files 命令，没法把旧版测试放到新代码上跑'
    else {
      const log = store.logPath('weaken')
      const copy = Copy.create(repo)
      try {
        const behavior = await behaviorCheck(s, copy, log, units)
        signals.push(...behavior.signals)
        problem = behavior.problem
      } finally {
        copy.dispose()
      }
    }
  }
  const explained = explain(signals, records)
  const missing = explained.filter(item => !settled(item))
  const items: string[] = []
  for (const item of [...explained.filter(settled), ...missing]) {
    const lines = [`  ${settled(item) ? '✓' : '✗'} ${describe(item.signal)}`]
    if (item.reason) lines.push(`    理由（${item.reason.file}）：${item.reason.text}`)
    if (item.plain) lines.push(`    给用户过目（${item.plain.file}）：${item.plain.text}`)
    else if (FOR_USER.has(item.signal.kind)) lines.push('    还没写"## 给用户过目"：合并前要给用户看')
    items.push(lines.join('\n'))
  }
  for (const text of records.problems) items.push(`  ✗ ${text}`)
  const pass = missing.length === 0 && records.problems.length === 0
  const lines: string[] = []
  if (problem) {
    // 没做完：不下"通过""没有发现"的结论，只列出已经认出的
    lines.push(`放水检查没做完：${problem}`)
    if (items.length) lines.push('', '已经认出的：', ...items)
  } else if (items.length === 0) {
    lines.push('放水检查：没有发现让测试变松的改动。')
  } else if (pass) {
    lines.push('放水检查通过：可能让测试变松的改动都写了理由。', ...items)
  } else {
    lines.push('放水检查没通过：下面标 ✗ 的改动没有写理由，或没写给用户过目的说明。', ...items)
  }
  if (!pass && (records.problems.length || missing.some(item => !item.reason))) {
    lines.push(
      '',
      `在这次改动新加的记录文件（${CHANGES_DIR}/<分支名>.md，分叉点上没有的）的"## 放水理由"一段，每处写一行：`,
      '  - `文件路径`：为什么这样改。规则变了的，引用用户确认的原话。删测试、改测试约定、清单只认写明的路径或以 / 结尾的目录。',
      '理由只是让改动看得见；改了已定的业务规则要先问用户。',
    )
  }
  if (missing.some(item => FOR_USER.has(item.signal.kind) && !item.plain)) {
    lines.push(
      '',
      '删测试、让测试不跑、程序的做法变了、删了或放宽了清单条目，合并前要用户过目。用户没有技术背景，看不懂放水理由，',
      `在同一个记录文件的"## 给用户过目"一段，每个这样的文件写一行白话（删测试、清单只认写明的路径或以 / 结尾的目录）：`,
      '  - `文件路径`：原来这些测试守的是什么，现在守的是什么，为什么改。不写实现细节，不把放松说轻。',
    )
  }
  console.log(lines.join('\n'))
  if (problem) return { code: EXIT.usage, key, review: [] }
  const review = pass ? userReview(explained) : []
  // 结论是按开始时的改动得出的：检查的过程中改动变了，这次的结论不记、不算
  const saved = store.weaken.saveChecked(key, () => currentWeakenKey(s.root), pass ? { result: 'pass', review, at: Date.now() } : { result: 'fail', at: Date.now() })
  if (!saved) {
    console.log('\n检查过程中改动变了（放水检查是按开始时的样子做的），这次的结论不算：重跑。')
    return { code: EXIT.fail, key, review: [] }
  }
  return { code: pass ? EXIT.ok : EXIT.fail, key, review }
}

/**
 * 清单：列出这次命中的条目和改动记录里写的怎么查，返回退出码。
 * 没写的、"## 清单"里写得不对的、这次加改的条目写坏了的，没通过。分叉点上原有、写坏了的条目只提醒：不是这次改动的事，不拦。
 */
function checklist(s: Snapshot): number {
  const base = baseChecklist(s)
  const changed = changedChecklist(s)
  const records = readRecords(s.root, s.changes)
  const hits = hitsOf(s, base.items)
  const missing = unanswered(hits, records)
  const lines: string[] = []
  if (base.items.length === 0) lines.push(base.problems.length ? '清单：分叉点上的条目都写得不对，这次没法按它们查。' : `清单：分叉点上没有条目（${CHECKLIST_DIR}/）。`)
  else if (hits.length === 0) lines.push(`清单：${base.items.length} 条，这次改动一条也没命中。`)
  else {
    lines.push(missing.length ? `清单：这次改动命中 ${hits.length} 条，下面标 ✗ 的还没写怎么查的。` : `清单：这次改动命中 ${hits.length} 条，都写了怎么查的。`)
    for (const hit of hits) {
      const answer = records.checks.find(item => item.id === hit.item.id)
      lines.push(`  ${answer ? '✓' : '✗'} ${hit.item.id}：${hit.item.title}`, `    改到了：${hit.paths.slice(0, 5).join('、')}${hit.paths.length > 5 ? ` 等 ${hit.paths.length} 个` : ''}`)
      if (answer) lines.push(`    查的（${answer.file}）：${answer.text}`)
      else lines.push(...hit.item.check.split('\n').map((line, index) => `    ${index === 0 ? '怎么查：' : '        '}${line}`), `    来由：${hit.item.origin.split('\n').join(' ')}`)
    }
  }
  if (base.problems.length) lines.push('', '分叉点上这几条写得不对，这次没按它们查（不拦这次改动，另找时间修好）：', ...base.problems.map(problem => `  · ${problem}`))
  if (changed.problems.length) lines.push('', '这次加、改的条目写得不对（合并后要用得上）：', ...changed.problems.map(problem => `  ✗ ${problem}`))
  if (records.checkProblems.length) lines.push('', '改动记录的"## 清单"写得不对：', ...records.checkProblems.map(problem => `  ✗ ${problem}`))
  if (missing.length) {
    lines.push(
      '',
      `按"怎么查"逐条查一遍，在这次改动新加的记录文件（${CHANGES_DIR}/<分支名>.md）的"## 清单"一段，每条写一行：`,
      '  - `编号`：怎么查的、结论。',
      '查出问题的先停下来告诉用户，不要为了让清单过而改条目；条目本身不对了，删改它要写理由、合并前给用户过目。',
    )
  }
  console.log(lines.join('\n'))
  return missing.length || changed.problems.length || records.checkProblems.length ? EXIT.fail : EXIT.ok
}

/** 复查的开始和结束（见 review.ts）：只记状态、查记录，不跑测试。 */
function review({ snapshot: s, store }: Opened, action: string | undefined): number {
  const key = reviewKey(s)
  const isOpen = reviewing(s, store)
  if (action === 'start') {
    if (isOpen) {
      console.log('复查已经开着。')
      return EXIT.ok
    }
    const missing = missingChecks(s, store)
    if (missing.length) {
      console.log(`复查前先跑一次，检查员要看输出。这份改动还缺：${missing.join('；')}。`)
      return EXIT.fail
    }
    store.reviews.put(key, { at: Date.now() })
    console.log('复查开始。复查中改测试不用重跑 testcraft prove、testcraft weaken，收尾时也不催；检查员提的问题都改完后，跑 testcraft review done。')
    return EXIT.ok
  }
  if (action === 'done') {
    if (!isOpen) {
      console.log('没有开着的复查。')
      return EXIT.ok
    }
    store.reviews.remove(key)
    const missing = missingChecks(s, store)
    console.log(missing.length ? `复查结束。复查中改过测试，现在补上：${missing.join('；')}。` : '复查结束。证明和放水检查的记录都还对得上，不用重跑。')
    return EXIT.ok
  }
  console.error(`testcraft review 后面要写 start 或 done。\n${USAGE}`)
  return EXIT.usage
}

async function proveCommand(paths: string[]): Promise<number> {
  const opened = snapshot()
  if (typeof opened === 'number') return opened
  const { snapshot: s } = opened
  let targets = proveTargets(s)
  if (paths.length) {
    const named = namedTargets(s, paths)
    if ('problem' in named) {
      console.error(named.problem)
      return EXIT.usage
    }
    targets = named.map(target => targets.find(item => item.change.path === target.change.path) ?? target)
  }
  return proveAll(opened, targets)
}

/** 证明这些测试（已有记录的直接给结论）：打印结论，返回退出码。 */
async function proveAll({ snapshot: s, store, repo }: Opened, targets: Target[]): Promise<number> {
  if (targets.length === 0) {
    console.log('这次没有新增的测试，不用证明。')
    return EXIT.ok
  }
  if (!s.filesCommand) {
    console.error('testpace.json 里没有 files 命令，没法跑测试。先接入 testpace。')
    return EXIT.usage
  }
  const records = readRecords(s.root, s.changes)
  // 记录的 key 在建副本之前算：证明是在副本上做的
  const keys = proofKeys(s, records, targets)
  const verdicts = cachedVerdicts(store, keys)
  const pending = targets.filter(target => !verdicts.has(target))
  const log = store.logPath('prove')
  if (pending.length) {
    const copy = Copy.create(repo)
    try {
      for (const [target, verdict] of await prove(s, store, copy, records, pending, log, keys)) verdicts.set(target, verdict)
    } finally {
      copy.dispose()
    }
  }
  const lines: string[] = []
  let failed = 0
  for (const target of targets) {
    const verdict = verdicts.get(target) as Verdict
    const name = `${target.change.path}（${target.why}）`
    if (verdict.kind === 'proven') {
      const parts = [`  ✓ ${name}`, `    ${verdict.record.method === 'revert' ? '证明一' : '证明二'}：${verdict.record.detail}${verdict.cached ? '（以前证明过）' : ''}`]
      if (verdict.record.missed?.length) {
        parts.push(`    在这之前改坏的 ${verdict.record.missed.length} 处它没发现（可能是没测到的情况，给检查员看）：`)
        for (const where of verdict.record.missed.slice(0, 5)) parts.push(`      - ${where}`)
      }
      lines.push(parts.join('\n'))
      continue
    }
    failed++
    if (verdict.kind === 'moved') {
      lines.push(`  ✗ ${name}\n    证明的过程中这个测试、它守的代码或改动记录改过，这次的证明不算：改完了再跑 testcraft prove。`)
      continue
    }
    if (verdict.kind === 'failsAfter') {
      lines.push(`  ✗ ${name}\n    在副本里的新代码上就没通过。先用 testpace files 确认它在工作区里能过；能过说明副本里的环境有问题。日志：${verdict.log}`)
      continue
    }
    const parts = [`  ✗ ${name}`, `    证明不了它能抓错：`]
    if (verdict.revert) parts.push(`    · ${verdict.revert}`)
    if (verdict.noCode) parts.push(`    · 改坏证明做不了：${verdict.noCode}`)
    else {
      const total = verdict.tried.length + verdict.shared.length + verdict.invalid
      parts.push(`    · 在它守的代码上改坏了 ${total} 处，没有一处是它新抓到的：`)
      if (verdict.tried.length) {
        parts.push(`      它没发现的 ${verdict.tried.length} 处：`)
        for (const where of verdict.tried.slice(0, 5)) parts.push(`      - ${where}`)
      }
      if (verdict.shared.length) parts.push(`      ${verdict.shared.length} 处文件里原有的测试也发现了（不是这次新加的部分抓到的）`)
      if (verdict.invalid) parts.push(`      ${verdict.invalid} 处改坏后测试没跑起来，不算`)
    }
    parts.push('    测试要检查结果对不对，而不是只检查有没有返回值；给已有代码补的测试，在改动记录的"## 守的代码"一段写明它守的代码。')
    lines.push(parts.join('\n'))
  }
  lines.unshift(failed ? `有 ${failed} 个测试证明不了能抓错：` : '测试都证明了能抓错：')
  if (pending.length) lines.push(`日志：${log}`)
  console.log(lines.join('\n'))
  return failed ? EXIT.fail : EXIT.ok
}

/**
 * 合并前的检查（整组里的一段），四项都过才算过：
 * 放水检查；放水里用户判断得了的几种（删测试、让测试不跑、程序的做法变了、删了或放宽了清单条目），用户在确认工具的弹窗里过目同意过；
 * 清单里命中的条目都写了怎么查的；这次新增的测试都证明能抓错（没证明过的现在证明）。技术调整的理由不给用户过目，检查员复查时顺带看。
 * 要过目的交给底座的用户确认（base/confirm.ts）：一个文件一项，同意按项记，工具只按编号核对文字。
 */
async function check(opened: Opened): Promise<number> {
  const { snapshot: s, repo } = opened
  if (s.deferred.length) console.log(['这次不算的配置改动：', ...s.deferred.map(text => `  · ${text}`), ''].join('\n'))
  const { code, review } = await weaken(opened)
  const codes = [code]
  if (review.length) {
    const asked = askUser(repo, 'craft', REVIEW_HEADING, review.map(item => reviewItem(s, item)))
    if (!asked.ask) console.log(`用户过目过这 ${review.length} 处放水。`)
    else {
      codes.push(EXIT.fail)
      console.log(['', ...asked.ask.lines].join('\n'))
    }
  }
  console.log('')
  codes.push(checklist(s))
  console.log('')
  codes.push(await proveAll(opened, proveTargets(s)))
  return Math.max(...codes)
}

function status(): number {
  const opened = snapshot()
  if (typeof opened === 'number') return opened
  const { snapshot: s, store } = opened
  const records = readRecords(s.root, s.changes)
  const lines: string[] = [`和 ${s.branch} 的分叉点 ${s.base.slice(0, 8)} 比，这次改了 ${s.changes.length} 个文件。`]
  const weakenState = store.weaken.get(weakenKey(s))
  lines.push(`放水检查：${weakenState ? (weakenState.result === 'pass' ? '这份改动检查过，通过' : '这份改动检查过，没通过') : '这份改动还没检查（testcraft weaken）'}`)
  const targets = proveTargets(s)
  if (targets.length === 0) lines.push('要证明的测试：没有')
  else {
    lines.push('要证明的测试：')
    for (const target of targets) {
      const proven = store.proofs.get(proofKey(s, target, guardsFor(records, target)))
      lines.push(`  ${proven ? '✓' : '·'} ${target.change.path}（${target.why}）${proven ? '' : '：还没证明（testcraft prove）'}`)
    }
  }
  if (reviewing(s, store)) lines.push('复查：开着，停止时不催证明和放水检查（问题都改完后 testcraft review done）')
  lines.push(`这次的改动记录：${records.files.length ? records.files.join('、') : `没有（${CHANGES_DIR}/<分支名>.md）`}`)
  const base = baseChecklist(s)
  if (base.items.length) {
    const hits = hitsOf(s, base.items)
    const missing = unanswered(hits, records)
    lines.push(`清单（${CHECKLIST_DIR}/）：${base.items.length} 条，这次命中 ${hits.length} 条${missing.length ? `，还没写怎么查的：${missing.map(hit => hit.item.id).join('、')}（testcraft checklist）` : ''}`)
  } else lines.push('清单：没有条目')
  lines.push(...settledRules(s))
  const rules = listRules(s.root)
  lines.push(rules.length ? `暂定的规则和记过的 bug（${RULES_DIR}/）：\n${rules.map(rule => `  - ${rule}`).join('\n')}` : '暂定的规则和记过的 bug：没有')
  if (s.deferred.length) lines.push('这次不算的配置改动：', ...s.deferred.map(text => `  · ${text}`))
  lines.push('合并前：testcraft check 是整组（testpace full）里的一段，没通过就不留整组通过记录。')
  console.log(lines.join('\n'))
  return EXIT.ok
}

/** 已定的规则以测试名为准：这次改到的测试文件里的测试名，加上整个仓库的数目。 */
function settledRules(s: Snapshot): string[] {
  const tests = trackedFiles(s.root).filter(path => kindOf(path, s.config) === 'test')
  const names = new Map(tests.map(path => [path, [...testNames(fileNow(s.root, path) ?? '')]]))
  const total = [...names.values()].reduce((sum, list) => sum + list.length, 0)
  const lines = [`已定的规则（以测试名为准）：仓库里 ${tests.length} 个测试文件、${total} 个测试`]
  const touched = s.changes.filter(change => change.kind === 'test' && names.has(change.path))
  for (const change of touched) {
    lines.push(`  ${change.path}${change.status === 'A' ? '（新增）' : ''}：`)
    for (const name of (names.get(change.path) ?? []).slice(0, 30)) lines.push(`    - ${name}`)
  }
  return lines
}

function listRules(root: string): string[] {
  try {
    return readdirSync(join(root, RULES_DIR))
      .filter(name => name.endsWith('.md'))
      .sort()
      .map(name => {
        const text = readFileSync(join(root, RULES_DIR, name), 'utf8')
        const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? name
        return `${name.replace(/\.md$/, '')}：${title}`
      })
  } catch {
    return []
  }
}

export async function main(argv: string[]): Promise<number> {
  switch (argv[0]) {
    case 'prove':
      return proveCommand(argv.slice(1))
    case 'weaken':
    case 'checklist':
    case 'review':
    case 'check': {
      const opened = snapshot()
      if (typeof opened === 'number') return opened
      if (argv[0] === 'weaken') return (await weaken(opened)).code
      if (argv[0] === 'checklist') return checklist(opened.snapshot)
      if (argv[0] === 'review') return review(opened, argv[1])
      return check(opened)
    }
    case 'status':
      return status()
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE)
      return argv[0] === undefined ? EXIT.usage : EXIT.ok
    default:
      console.error(`不认识的命令：${argv[0]}\n${USAGE}`)
      return EXIT.usage
  }
}
