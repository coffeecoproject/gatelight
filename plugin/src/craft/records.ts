// 这次改动的记录：.testcraft/changes/ 下这次改动新加的文件（分叉点上没有的）。以前改动写的不算数。
// 程序只读这几段：
//   "## 放水理由"：每条一行，行首写明是哪个文件（反引号括起来，几个用、隔开；可以用路径规则，但要从具体目录写起；删测试、改约定只认写明的路径或目录），后面写理由。
//     - `tests/price.test.ts`：规则变了，用户确认"会员价不再叠加优惠券"
//   "## 给用户过目"：放水里删测试、让测试不跑、程序的做法变了、删了或放宽了清单条目这几种（weaken 的 FOR_USER），合并前要用户在弹窗里同意。
//     用户没有技术背景，"放水理由"是写给检查员的，用户看不懂，所以每个这样的文件另写一行白话：原来这些测试守的是什么、现在守的是什么、为什么改。
//     行首写文件，写法同"放水理由"（删测试、清单只认写明的路径或 / 结尾的目录）。
//     - `tests/price.test.ts`：原来满减券满 100 减 20，现在改成减一半；用户说新活动按减一半算
//   "## 守的代码"：给已有代码补测试（这次没有对应的代码改动）时，行首写明测试守的是哪段代码。
//     - `tests/price.test.ts` → `src/price.ts#discount`（# 后面是函数名，不写就是整个文件）
//   "## 清单"：这次命中的清单条目（.testcraft/checklist/），每条一行，行首写编号，后面写怎么查的、结论。
//     - `resume-old-fields`：新字段读老记录时给了默认值，拿改动前的会话记录恢复过，能打开
// 只认行首的反引号；理由、说明里的反引号是正文，原样留着，不算文件。
// 其他段落（证明方式、要用户看的事项）给人和检查员看。

import { CHANGES_DIR } from './config.ts'
import type { Change } from '../base/git.ts'
import { fileNow } from '../base/git.ts'
import { globToRegExp } from '../base/glob.ts'

/** 行首的文件：一个或几个反引号括起来的路径，用、或逗号隔开。只隔空格的下一个反引号算理由的正文。 */
export const LEADING_FILES = /^`[^`]+`(?:\s*[、，,]\s*`[^`]+`)*/
/** 守的代码：`测试` → `代码位置`，或只写 `代码位置`。 */
const GUARD_LINE = /^`([^`]+)`(?:\s*(?:→|->)\s*`([^`]+)`)?/

export interface Reason {
  patterns: string[]
  text: string
  file: string
}

export interface Guard {
  /** 这条只管这个测试文件；不写就管这次所有要证明的测试。 */
  test?: string
  path: string
  name?: string
  file: string
}

/** 清单里一条命中的条目怎么查的。 */
export interface Answer {
  id: string
  text: string
  file: string
}

export interface Records {
  files: string[]
  reasons: Reason[]
  /** "## 给用户过目"每行：写法和放水理由一样，给用户看的白话。 */
  forUser: Reason[]
  guards: Guard[]
  checks: Answer[]
  /** 放水理由、给用户过目、守的代码三段里写得不对的行：放水检查报。 */
  problems: string[]
  /** "## 清单"一段里写得不对的行：testcraft checklist 报。 */
  checkProblems: string[]
}

export function recordFiles(changes: Change[]): string[] {
  return changes.filter(change => change.status === 'A' && change.path.startsWith(`${CHANGES_DIR}/`) && change.path.endsWith('.md')).map(change => change.path)
}

export function readRecords(root: string, changes: Change[]): Records {
  const records: Records = { files: recordFiles(changes), reasons: [], forUser: [], guards: [], checks: [], problems: [], checkProblems: [] }
  for (const file of records.files) {
    let section = ''
    const text = fileNow(root, file) ?? ''
    text.split('\n').forEach((line, index) => {
      const heading = /^#{2,}\s*(.+?)\s*$/.exec(line)
      if (heading) {
        section = heading[1] as string
        return
      }
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
      if (!bullet) return
      const body = bullet[1] as string
      if (section.includes('守的代码')) {
        const guard = GUARD_LINE.exec(body)
        if (!guard) {
          records.problems.push(`${file} 第 ${index + 1} 行没写代码位置（行首用反引号括起来）`)
          return
        }
        const target = (guard[2] ?? guard[1]) as string
        const [path, name] = target.split('#') as [string, string | undefined]
        const test = guard[2] === undefined ? undefined : guard[1]
        records.guards.push({ path, ...(name ? { name } : {}), ...(test ? { test } : {}), file })
      } else if (section === '清单') {
        const leading = LEADING_FILES.exec(body)
        if (!leading) {
          records.checkProblems.push(`${file} 第 ${index + 1} 行没写是清单的哪一条（行首用反引号括起编号）`)
          return
        }
        const text = body.slice(leading[0].length).replace(/^[\s:：，,、]+/, '').trim()
        if (text.length < 4) {
          records.checkProblems.push(`${file} 第 ${index + 1} 行只写了编号，没写怎么查的、结论`)
          return
        }
        for (const match of leading[0].matchAll(/`([^`]+)`/g)) records.checks.push({ id: match[1] as string, text, file })
      } else if (section.includes('给用户过目')) {
        const line = leadingLine(body, `${file} 第 ${index + 1} 行`, '说明')
        if ('problem' in line) records.problems.push(line.problem)
        else records.forUser.push({ ...line, file })
      } else if (section.includes('理由')) {
        const line = leadingLine(body, `${file} 第 ${index + 1} 行`, '理由')
        if ('problem' in line) records.problems.push(line.problem)
        else records.reasons.push({ ...line, file })
      }
    })
  }
  return records
}

/** 行首写文件、后面写正文的一行（放水理由、给用户过目）：拆出文件和正文，写得不对的说明哪里不对。 */
function leadingLine(body: string, where: string, what: string): { patterns: string[]; text: string } | { problem: string } {
  const leading = LEADING_FILES.exec(body)
  if (!leading) return { problem: `${where}没写是哪个文件（行首用反引号括起来）` }
  const patterns = [...leading[0].matchAll(/`([^`]+)`/g)].map(match => match[1] as string)
  const text = body.slice(leading[0].length).replace(/^[\s:：，,、]+/, '').trim()
  if (text.length < 4) return { problem: `${where}只写了文件，没写${what}` }
  const broad = patterns.find(pattern => /^[*?]/.test(pattern) || /^\/?$/.test(pattern))
  if (broad) return { problem: `${where}的 \`${broad}\` 太宽：从具体的目录或文件写起` }
  return { patterns, text }
}

/** 盖住这个文件的那一行。strict 时只认写明的路径或以 / 结尾的目录，不认通配。 */
function covering(lines: Reason[], paths: Array<string | undefined>, strict: boolean): Reason | undefined {
  const covers = (pattern: string, path: string): boolean =>
    pattern === path || (strict ? pattern.endsWith('/') && path.startsWith(pattern) : globToRegExp(pattern).test(path))
  return lines.find(line => line.patterns.some(pattern => paths.some(path => path !== undefined && covers(pattern, path))))
}

/** 这个文件的放水理由。 */
export function reasonFor(records: Records, paths: Array<string | undefined>, strict: boolean): Reason | undefined {
  return covering(records.reasons, paths, strict)
}

/** 这个文件给用户过目的那一行。 */
export function forUserLine(records: Records, paths: Array<string | undefined>, strict: boolean): Reason | undefined {
  return covering(records.forUser, paths, strict)
}
