// 评判用的配置：决定检查怎么判的文件（testpace.json、各模块自己的配置和清单）。
// 原则只有一条：这次改动改不了评判它的检查。模块读这类文件只走这里，拿到分叉点那一版和工作区现在这一版，
// 对每个配置项二选一，没有第三条路：
//   合并后才生效：按 before 判，分支上的放松这次不算；
//   用户同意后生效：和 before 比，放松的列成条目交给用户确认（confirm.ts）。
// 加严的（新加一条规则、多认一类文件）可以马上按 now 算。
// 分叉点由调用的地方给（git.ts 的 forkPoint）：算不出分叉点时没有 before 可比，模块要说"没做完"，不能当成没放松。

import { fileAt, fileNow, filesAt, filesNow } from './git.ts'

export interface Judging {
  /** 分叉点那一版的内容；那时没有这个文件为 undefined。 */
  before: string | undefined
  /** 工作区现在的内容（含没提交的改动）；没有这个文件为 undefined。 */
  now: string | undefined
}

/** 一个评判用的文件的两版。fork 是分叉点的提交，path 相对仓库根目录。 */
export function judgingFile(root: string, fork: string, path: string): Judging {
  return { before: fileAt(root, fork, path), now: fileNow(root, path) }
}

/** 一个评判用的目录（比如清单目录）里每个文件的两版，按路径排序：分叉点上有的和工作区里现有的都算。 */
export function judgingDir(root: string, fork: string, dir: string): Map<string, Judging> {
  const paths = [...new Set([...filesAt(root, fork, dir), ...filesNow(root, dir)])].sort()
  return new Map(paths.map(path => [path, judgingFile(root, fork, path)]))
}
