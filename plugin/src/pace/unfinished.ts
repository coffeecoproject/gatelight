// 停止门里"跑测试"这一项（base/module.ts 的 onSession、unfinished；"该合了"那一项在 unmerged.ts）：这个会话改了代码（和会话起点比，只改了 ignore 路径的不算），
// 当前内容却没跑过 testpace focused，拦一次。同一份内容只拦一次（记号里带着内容的样子），小改动 agent 说一句就能收尾。
// 认"跑过"：当前内容有 fast 的记录（只有 focused 会跑 fast）、focused 跑的相关测试或整组的记录，过没过都算；相对那次只改了 ignore 路径的也算。
// 这道门只看跑没跑，不看过没过：开发中没过的测试照节奏只看不追。
//
// 来由（2026-11-27）：CrocWork 的 MCN 分支上，会话压缩的摘要把"没过的测试留到合并时改"一轮轮转述成了"e2e 都留到合并"，
// 后面 17 个提交、约 10 轮一次 focused 都没跑，每轮汇报都写"按约定留到合并时跑"。会话说明每次压缩后都重新带上了，
// 模型照更具体、更新的摘要做了。只靠说明管不住，所以和 modwall check 一样在收尾时查一次。

import { SessionBaselines } from '../base/baseline.ts'
import { changedPaths, treeOf, workTreeId } from '../base/git.ts'
import { ignoredBy, type Repo } from '../base/repo.ts'
import { loadConfig } from './config.ts'
import { paceRuns } from './record.ts'
import { noteHead, unmerged } from './unmerged.ts'

const MODULE = 'pace'
/** 会话起点记的是什么：workTreeId 算出的整个工作区的树。算法变了要改它（见 base/baseline.ts）。 */
const TREE_FORMAT = 'worktree-1'
/** 只和最近这么多份跑过的内容比 ignore 路径，避免记录很多时逐个 diff。 */
const CANDIDATES = 20

function baselines(repo: Repo): SessionBaselines<string> {
  return new SessionBaselines(repo, MODULE, TREE_FORMAT)
}

/** 会话碰到这个工作区时：记下这时整个工作区的样子（只记第一次）。没接入、配置写坏了的不记。 */
export function onSession(repo: Repo, sessionId: string): void {
  const onboarded = (): boolean => loadConfig(repo.root).config !== undefined
  baselines(repo).note(sessionId, () => (onboarded() ? workTreeId(repo.root) : undefined))
  noteHead(repo, sessionId, onboarded)
}

/** 两份内容之间只改了 ignore 路径（或没改）。树对象被清理了、比不了的当作改了代码。 */
function onlyIgnored(repo: Repo, from: string, to: string, isIgnored: (path: string) => boolean): boolean {
  if (from === to) return true
  try {
    return changedPaths(repo.root, from, to).every(isIgnored)
  } catch {
    return false
  }
}

/** 停止门：先看跑没跑 focused，跑过了（或已经拦过）再看该不该合（unmerged.ts）。 */
export function unfinished(repo: Repo, sessionId: string, seen: readonly string[], named: boolean): { keys: string[]; text: string; notice?: string } | undefined {
  const config = loadConfig(repo.root).config
  if (!config) return undefined
  const now = workTreeId(repo.root)
  const isIgnored = ignoredBy(config.ignore)
  const clean = (): boolean => {
    const head = treeOf(repo.root, 'HEAD')
    return head !== undefined && onlyIgnored(repo, head, now, isIgnored)
  }
  return notRun(repo, sessionId, seen, named, now, isIgnored) ?? unmerged(repo, sessionId, seen, named, clean, isIgnored)
}

/** 这个会话改了代码，当前内容没跑过 focused（也没跑过整组）。 */
function notRun(
  repo: Repo,
  sessionId: string,
  seen: readonly string[],
  named: boolean,
  now: string,
  isIgnored: (path: string) => boolean,
): { keys: string[]; text: string } | undefined {
  const key = `pace:focused:${now}`
  if (seen.includes(key)) return undefined
  if (onlyIgnored(repo, baselines(repo).since(sessionId, now), now, isIgnored)) return undefined
  // 跑过的内容：fast（focused 的第一步）和整组开始时的；跑完时的也算（测试自己写出没被 git 忽略的文件，内容会变）。
  // focused 的相关测试和它的 fast 记的是同一个开始时的内容，靠这个认出哪些 files 是 focused 跑的，取它们跑完时的
  const runs = paceRuns(repo.store).sort((a, b) => b.startedAt - a.startedAt)
  const focusedTrees = new Set(runs.filter(run => run.kind === 'fast').map(run => run.tree))
  const trees = [
    ...new Set(
      runs.flatMap(run => {
        if (run.kind === 'fast' || run.kind === 'full') return [run.tree, run.treeAtEnd]
        return run.kind === 'files' && focusedTrees.has(run.tree) ? [run.treeAtEnd] : []
      }),
    ),
  ]
  if (trees.includes(now) || trees.slice(0, CANDIDATES).some(tree => onlyIgnored(repo, tree, now, isIgnored))) return undefined
  return {
    keys: [key],
    text:
      `这个会话${named ? `在 ${repo.root} ` : ''}改了代码，当前内容还没跑过 testpace focused。向用户汇报之前跑一次。` +
      '没过的测试照节奏分清是哪一种：因为这次改了需求才不过的留到合并时改，focused 照样每轮跑；"留到合并"说的是改那些没过的测试，不是不跑测试。' +
      '只改了文字、样式、注释的小改动，或改动不是这个会话写的（拉取、合并进来的），说一句再收尾。',
  }
}
