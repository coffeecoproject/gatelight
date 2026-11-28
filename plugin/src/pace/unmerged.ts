// 停止门里"该合了"这一项：这个会话在功能分支上提交了，分支上还有没合进默认分支的提交，拦一次，同时直接给用户看一行。
// 不按攒了多少设门槛：多少算多没有依据，一件事分几次提交的，中间被提一次，agent 说一句还没做完就行。

import { SessionBaselines } from '../base/baseline.ts'
import { day } from '../base/format.ts'
import { commitsSince, currentBranch, findDefaultBranch, headCommit, refsUnder, refTip } from '../base/git.ts'
import type { Repo } from '../base/repo.ts'

const MODULE = 'pace'
/** 会话起点记的是什么：那时 HEAD 指的提交和记下的时间（毫秒）。 */
const HEAD_FORMAT = 'head-1'
/** 列出来的提交最多几个，再多的只说一共几个。 */
const LISTED = 8
/** 每个提交取说明开头一段，最多这么多个字。 */
const TITLE = 24

interface HeadStart {
  head: string
  at: number
}

function heads(repo: Repo): SessionBaselines<HeadStart> {
  return new SessionBaselines(repo, MODULE, HEAD_FORMAT)
}

/** 会话碰到这个工作区时：记下这时 HEAD 指的提交（只记第一次）。onboarded 答接入了没有，还没记过才问。 */
export function noteHead(repo: Repo, sessionId: string, onboarded: () => boolean): void {
  heads(repo).note(sessionId, () => {
    const head = onboarded() ? headCommit(repo.root) : undefined
    return head ? { head, at: Date.now() } : undefined
  })
}

/** 提交说明开头一段：到第一个冒号、逗号、句号、分号为止，太长的截断。 */
function title(subject: string): string {
  const head = subject.split(/[：:，,。；;]/)[0]!.trim() || subject
  const chars = [...head]
  return chars.length > TITLE ? `${chars.slice(0, TITLE).join('')}…` : head
}

/**
 * 停止门：这个会话提交了，分支上还有没合进默认分支、改了代码的提交。
 * clean 答工作区相对 HEAD 是不是只改了 ignore 路径（或没改），用到时才算；isIgnored 按 testpace.json 的 ignore 认路径。
 */
export function unmerged(
  repo: Repo,
  sessionId: string,
  seen: (key: string) => boolean,
  named: boolean,
  clean: () => boolean,
  isIgnored: (path: string) => boolean,
): { keys: string[]; text: string; notice: string } | undefined {
  const branch = currentBranch(repo.root)
  if (!branch || branch.startsWith('merge/')) return undefined
  const found = findDefaultBranch(repo.root)
  if (!found.branch || branch === found.branch) return undefined
  const head = headCommit(repo.root)
  if (!head) return undefined
  const key = `pace:unmerged:${head}`
  if (seen(key)) return undefined
  // 会话起点以来 HEAD 没动：这个会话没提交过
  const start = heads(repo).since(sessionId, { head, at: Date.now() })
  if (start.head === head || !clean()) return undefined
  // 本地或 origin 上的默认分支有了的都算合了（推送到 origin 默认分支的，本地还没拉）
  const landed = [`refs/heads/${found.branch}`, `refs/remotes/origin/${found.branch}`].filter(ref => refTip(repo.root, ref))
  if (landed.length === 0) return undefined
  const commits = commitsSince(repo.root, [...landed, ...refsUnder(repo.root, 'refs/heads/merge/')], head)
    .filter(commit => commit.paths.some(path => !isIgnored(path)))
    .reverse()
  // 提交时间按秒记，起点按毫秒：同一秒里的算会话开始以后
  if (!commits.some(commit => commit.time >= Math.floor(start.at / 1000) * 1000)) return undefined

  const files = new Set(commits.flatMap(commit => commit.paths.filter(path => !isIgnored(path)))).size
  const titles = commits.map(commit => title(commit.subject))
  const list = titles.length > LISTED ? `${titles.slice(0, LISTED).join('、')} 等 ${titles.length} 个` : titles.join('、')
  const where = named ? `${repo.root} 的` : ''
  const facts = `${where}分支 ${branch} 攒了 ${commits.length} 个提交没合进 ${found.branch}（从 ${day(commits[0]!.time)} 起，改了 ${files} 个文件）：${list}`
  const tested = '这些改动都还没经过合并时的整组，接入了 testcraft 的，测试也要合并时才写'
  return {
    keys: [key],
    notice: `gatelight：${facts}。${tested}。每件事做完就合。`,
    text:
      `这个会话提交了。${facts}。${tested}。` +
      '向用户汇报时，第一行单独写这件事：攒了几个提交、从哪天起、还没有测试、建议现在先合（用户说合就照 gatelight:merge 合），下一件事在新分支上做；' +
      '不要夹在段落里，也不要只说一句"可以合了"。这次的事还没做完的照样说，再说还差什么。用户说接着在这个分支上做的，照做，下次提交还会再提。',
  }
}
