// "测试写法"说给 agent 的话，经底座的钩子送出去（base/module.ts 的 brief、onSession、unfinished）。
// 会话开始：说几句写测试的约定，记下这时测试这一侧的样子。
// 停止门：这个会话改了测试这一侧的文件、测试的配置、依赖或约定（和会话开始时比），而这份改动有要写理由的地方却没有放水检查通过的记录、
// 或有要证明的测试还没证明，就拦一次，说明要跑什么。不跑测试，只查记录，所以很快（weaken 可能要跑测试，放不进 hook 的时限）。
// 没动测试、或这个会话没动过测试时不出声。
// 清单：这个会话改到了清单（.testcraft/checklist/）条目的触发条件，改动记录"## 清单"里还没写怎么查的，也拦一次。
// 同一份改动只拦一次（记号里带着改动的样子）：改了以后还缺，再拦。
// 复查中（testcraft review start 之后，见 review.ts）不催证明和放水检查，只提醒一次复查还开着：复查完再一起跑。

import { CONFIRM_TOOL } from '../base/confirm.ts'
import type { Repo } from '../base/repo.ts'
import { open, type Snapshot } from './change.ts'
import { baseChecklist, checklistFingerprint, hitsOf, unanswered } from './checklist.ts'
import { joined } from './config.ts'
import { readRecords } from './records.ts'
import { missingChecks, reviewing } from './review.ts'
import { openStore, type SessionRecord, type Store } from './store.ts'
import { testFingerprint } from './weaken.ts'

export function guide(label = '这个仓库'): string[] {
  return [
    `${label}用 testcraft 管测试的写法（.testcraft/）：`,
    '1. 小改动（文字、样式、注释、显示用的配置）不写测试。改到规则（钱、权限、数据、业务判断）时照 gatelight:write-tests 技能写：每个测试守一条规则，测试名用白话写这条规则；钱、权限、数据测透，别的点到为止；修 bug 先写能重现它的测试。还在试的规则不写正式测试。',
    '2. 新增的测试，跑 testcraft prove 证明它能抓错。',
    `3. 删测试、跳过测试、改期望值或断言、改测试配置或测试约定，在 .testcraft/changes/<分支名>.md 的"## 放水理由"写明理由，跑 testcraft weaken。改已定的业务规则先用白话问用户；其中删测试、让测试不跑、程序的做法变了、删改清单条目这几处，还要在"## 给用户过目"按文件写一行白话（原来守什么、现在守什么、为什么改），合并前用户在 ${CONFIRM_TOOL} 工具的弹窗里过目同意（编号和文字照 testcraft check 输出的填）。`,
    '4. 测试改完，用 gatelight:review-tests 技能请检查员复查，只挑糊弄的、多余的测试和对不上改动的放水理由。复查前跑 testcraft review start，复查中改测试不重跑 testcraft prove、testcraft weaken；问题都改完后跑 testcraft review done，再把这两条各跑一次。',
    '5. 改动命中 .testcraft/checklist/ 里条目的触发条件时（testcraft checklist 列出），按条目查一遍，在改动记录的"## 清单"写一行怎么查的、结论。修 bug 时，写不成测试、又能从改动看出来的坑，加一条清单。',
  ]
}

/** 这个仓库接入了、现在看得了改动时的全貌；没接入、算不出分叉点时没有。 */
function snapshotOf(repo: Repo): Snapshot | undefined {
  const opened = open(repo.root)
  return 'problem' in opened ? undefined : opened.snapshot
}

/** 会话说明：接入了"测试写法"的仓库才说。 */
export function brief(label: string, repo?: Repo): string[] {
  return repo && joined(repo.root) ? guide(label) : []
}

/** 会话开始（或第一次碰到这个仓库）时测试这一侧的样子。同一个会话恢复、压缩后还会再来，只记第一次。 */
export function onSession(repo: Repo, sessionId: string): void {
  const s = snapshotOf(repo)
  if (!s) return
  const store = openStore(repo)
  if (store.sessions.get(sessionId)) return
  store.sessions.put(sessionId, { fingerprint: testFingerprint(s), checklist: checklistState(s).fingerprint, at: Date.now() })
}

/** 停止门：这个会话在这个仓库里改了测试却还缺检查，或改到了清单条目还没写怎么查的。 */
export function unfinished(repo: Repo, sessionId: string, seen: readonly string[], named: boolean): { keys: string[]; text: string } | undefined {
  const s = snapshotOf(repo)
  if (!s) return undefined
  const store = openStore(repo)
  const started = store.sessions.get(sessionId)
  // 要现在补的，和只提醒的
  const todos: string[] = []
  const notes: string[] = []
  const keys: string[] = []
  const where = named ? `在 ${repo.root} ` : ''
  const todo = testTodo(s, store, started)
  // 记号带着测试这一侧现在的样子：同一份改动只拦一次，改了以后还缺再拦。复查中的提醒另用一个记号：复查结束后还缺的照常拦
  const fingerprint = testFingerprint(s)
  const inReview = todo.length > 0 && reviewing(s, store)
  const todoKey = `craft:${inReview ? 'review' : 'tests'}:${fingerprint}`
  if (todo.length && !seen.includes(todoKey)) {
    keys.push(todoKey)
    if (inReview) {
      notes.push(
        `这个会话${where}改的测试正在请检查员复查（testcraft review start 开的），testcraft prove、testcraft weaken 先不用跑：复查中每改一次测试，之前的结果就对不上。检查员提的问题都改完后，跑 testcraft review done，再把这两条各跑一次；还在等检查员的，接着等。`,
      )
    } else todos.push(`这个会话${where}改了测试、测试的配置或约定，当前这份改动还缺：${todo.join('；')}。`)
  }
  const checklist = checklistState(s)
  const checklistKey = `craft:checklist:${checklist.fingerprint}`
  if (checklist.missing.length && started?.checklist !== checklist.fingerprint && !seen.includes(checklistKey)) {
    keys.push(checklistKey)
    todos.push(`这个会话${where}改到了清单条目的触发条件，改动记录的"## 清单"还没写怎么查的：${checklist.missing.join('、')}（testcraft checklist 列出要查什么）。`)
  }
  if (keys.length === 0) return undefined
  const act = todos.length ? `${todos.join('')}跑完、按结果补好再收尾；没通过的，用白话告诉用户卡在哪。` : ''
  return { keys, text: `${act}${notes.join('')}` }
}

/** 测试这一侧还缺的：这个会话改了测试（和会话开始时比），却没有放水检查或证明的通过记录。 */
function testTodo(s: Snapshot, store: Store, started: SessionRecord | undefined): string[] {
  if (started && started.fingerprint === testFingerprint(s)) return []
  return missingChecks(s, store)
}

/** 清单命中了、还没写怎么查的条目，和命中的文件、改动记录现在的样子（会话开始时就这样、这个会话没动的，不拦）。 */
function checklistState(s: Snapshot): { missing: string[]; fingerprint: string } {
  const hits = hitsOf(s, baseChecklist(s).items)
  const records = readRecords(s.root, s.changes)
  return { missing: unanswered(hits, records).map(hit => hit.item.id), fingerprint: checklistFingerprint(s, hits, records) }
}
