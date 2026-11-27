// 停止门里"收记录"这一项：合并分支上收尾时，HEAD 里还有记录类的 .md（方案、设计、说明），拦一次。没提交的不算：落到默认分支的只有提交了的。
// 只看文件在不在、不看写了什么：程序分不出一段话是规则还是原因，按内容判就会判错、再加规矩。

import { changedPaths, currentBranch, defaultBranch, filesAt, headCommit, mergeBase, refTip } from '../base/git.ts'
import type { Repo } from '../base/repo.ts'
import { joined, TESTCRAFT_DIR } from './config.ts'

/** 指令（告诉 AI 怎么做，本身就是出处）放在这些目录下，或叫这些名字（MODULE.md 是 modwall 会话开始时给 agent 看的模块职责）。 */
const INSTRUCTION_DIRS = ['skills', TESTCRAFT_DIR, '.claude']
const INSTRUCTION_NAMES = ['CLAUDE.md', 'AGENTS.md', 'MODULE.md']
/** README 只在这次改了时才算：npm 页面要它，整份删不了，每次合并都拦就成了噪音。 */
const README = 'README.md'

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md')
}

function isInstruction(path: string): boolean {
  const parts = path.split('/')
  return INSTRUCTION_NAMES.includes(parts.at(-1)!) || parts.slice(0, -1).some(part => INSTRUCTION_DIRS.includes(part))
}

/** 相对默认分支的分叉点，这个分支改了（新加、修改）的路径；认不出默认分支时没有。 */
function changedOnBranch(root: string): Set<string> {
  const main = defaultBranch(root)
  const ref = [`refs/heads/${main}`, `refs/remotes/origin/${main}`].find(candidate => main && refTip(root, candidate))
  const base = ref ? mergeBase(root, ref, 'HEAD') : undefined
  return new Set(base ? changedPaths(root, base, 'HEAD') : [])
}

export function unfinished(repo: Repo, _sessionId: string, seen: readonly string[], named: boolean): { keys: string[]; text: string } | undefined {
  if (!joined(repo.root) || !currentBranch(repo.root)?.startsWith('merge/')) return undefined
  const head = headCommit(repo.root)
  if (!head) return undefined
  const key = `craft:records:${head}`
  if (seen.includes(key)) return undefined
  const markdown = filesAt(repo.root, head).filter(path => isMarkdown(path) && !isInstruction(path))
  const changed = markdown.some(path => path.split('/').at(-1) === README) ? changedOnBranch(repo.root) : new Set<string>()
  const records = markdown.filter(path => path.split('/').at(-1) !== README || changed.has(path))
  if (records.length === 0) return undefined
  const where = named ? `${repo.root} 里` : '仓库里'
  return {
    keys: [key],
    text:
      `落地前收记录：${where}还有记录类的 .md（${records.join('、')}）。` +
      '.md 和注释都只给 AI 看，过时的说法 AI 会照着做，所以不留记录：规则在测试里；为什么这样定、否掉的做法、用户拍板的、还没定的写进提交说明；' +
      'AI 很可能好心改掉、测试又守不住的地方，在那段代码旁边留一句为什么。写完删掉这些文件（README 只留怎么装），提交，重新合一次（.md 在 testpace.json 的 ignore 里的，不用重跑整组）。' +
      '要留的说一句为什么就能收尾。',
  }
}
