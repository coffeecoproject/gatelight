// 会话起点：会话第一次碰到一个工作区时，模块关心的那部分内容的样子。停止门只管这之后改的，靠它分清"这个会话改的"和"本来就这样"。
// 模块定记什么（value）、怎么算；怎么存、按什么认、没有起点时怎么办，都在这里，模块不各做各的。
//   按会话和工作区各记一份：记录文件是同一个仓库的所有工作区共用的，各工作区的内容却不一样，
//     拿一个工作区的起点去比另一个，那里别人早就改好的东西会被算成这个会话改的。
//   format 是算法的名字：算法换了，旧起点和新算出来的样子没法比，当作没有。
//   没有起点（模块是会话中途才装上的、当时看不了改动、算法换了）就没有参照：把现在的样子记成起点，不说是这个会话改的。
//     这之前这个会话真改过的，这一次不拦；合并前的整组照样查。
//   起点只说"这之后变了"，不说是谁变的：进去看过别人工作区的会话也有那里的起点，同一个工作区里别的会话、用户改的也算进变化。
//     停止门只为会话干活的工作区（所在目录的、用改文件的工具改过的）问模块，会话在那里动过手才问（store.ts 的 SessionState.worked、acted）。

import { hash, ModuleRecords } from './records.ts'
import type { Repo } from './repo.ts'

interface Baseline<T> {
  value: T
  at: number
}

export class SessionBaselines<T> {
  private readonly records: ModuleRecords<Baseline<T>>
  private readonly worktree: string
  private readonly format: string

  /** module 是模块的名字；format 变了，以前记的起点都不算。 */
  constructor(repo: Repo, module: string, format: string) {
    this.records = new ModuleRecords(repo.store, module, 'baselines')
    this.worktree = repo.root
    this.format = format
  }

  private key(sessionId: string): string {
    return hash(this.format, sessionId, this.worktree)
  }

  /**
   * 会话碰到这个工作区了：还没有起点就记下现在的样子（now 给不出来、比如没接入时，不记）。
   * 已经有的不动：同一个会话恢复、压缩后还会再来，每条命令之前也会来，所以先看有没有，再算。
   */
  note(sessionId: string, now: () => T | undefined): void {
    const key = this.key(sessionId)
    if (this.records.get(key)) return
    const value = now()
    if (value !== undefined) this.records.put(key, { value, at: Date.now() })
  }

  /** 这个会话在这个工作区的起点；没有就把 now（现在的样子）记成起点，返回它。 */
  since(sessionId: string, now: T): T {
    const key = this.key(sessionId)
    const found = this.records.get(key)
    if (found) return found.value
    this.records.put(key, { value: now, at: Date.now() })
    return now
  }
}
