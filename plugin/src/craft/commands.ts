// testcraft 的命令：checklist、status。命令入口（src/testcraft.ts）分发到这里。
// checklist 也是整组里的一段（见 full.ts）：落地前把这次命中的条目再说一遍，这次加、改的条目写坏了的不让过。

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT } from '../base/exit.ts'
import { openRepo } from '../base/repo.ts'
import { open, type Snapshot } from './change.ts'
import { baseChecklist, changedChecklist, hitsOf } from './checklist.ts'
import { CHECKLIST_DIR, RULES_DIR } from './config.ts'

const USAGE = `用法：
  testcraft checklist 清单（.testcraft/checklist/）里这次改动命中的条目和各条怎么查：按条目查一遍。
                      这次加、改的条目写得不对的会指出来，没改对不算通过（testpace full 里的一段，接入了的仓库自动跑）
  testcraft status    这次改动命中的清单条目、暂定的规则`

/** 退出码用底座的：0 通过；1 没通过；2 用法、配置或环境问题。 */

function snapshot(): Snapshot | number {
  const repo = openRepo(process.cwd())
  if (!repo) {
    console.error('testcraft 要在 git 仓库里运行。')
    return EXIT.usage
  }
  const opened = open(repo.root)
  if ('problem' in opened) {
    if (opened.code === 'notJoined') {
      console.log(`${opened.problem}，不检查。`)
      return EXIT.ok
    }
    console.error(`没法检查：${opened.problem}`)
    return EXIT.usage
  }
  return opened.snapshot
}

/**
 * 清单：列出这次命中的条目和各条怎么查，返回退出码。只是提醒，命中了不算没通过。
 * 这次加、改的条目写坏了的，没通过（合并后要用得上）。分叉点上原有、写坏了的条目只提醒：不是这次改动的事，不拦。
 */
function checklist(s: Snapshot): number {
  const base = baseChecklist(s)
  const changed = changedChecklist(s)
  const hits = hitsOf(s, base.items)
  const lines: string[] = []
  if (base.items.length === 0) lines.push(base.problems.length ? '清单：分叉点上的条目都写得不对，这次没法按它们提醒。' : `清单：分叉点上没有条目（${CHECKLIST_DIR}/）。`)
  else if (hits.length === 0) lines.push(`清单：${base.items.length} 条，这次改动一条也没命中。`)
  else {
    lines.push(`清单：这次改动命中 ${hits.length} 条，按"怎么查"逐条查一遍，查出问题就改好：`)
    for (const hit of hits) {
      lines.push(
        `  · ${hit.item.id}：${hit.item.title}`,
        `    改到了：${hit.paths.slice(0, 5).join('、')}${hit.paths.length > 5 ? ` 等 ${hit.paths.length} 个` : ''}`,
        ...hit.item.check.split('\n').map((line, index) => `    ${index === 0 ? '怎么查：' : '        '}${line}`),
        `    来由：${hit.item.origin.split('\n').join(' ')}`,
      )
    }
  }
  if (base.problems.length) lines.push('', '分叉点上这几条写得不对，这次没按它们提醒（不拦这次改动，另找时间修好）：', ...base.problems.map(problem => `  · ${problem}`))
  if (changed.problems.length) lines.push('', '这次加、改的条目写得不对（合并后要用得上）：', ...changed.problems.map(problem => `  ✗ ${problem}`))
  console.log(lines.join('\n'))
  return changed.problems.length ? EXIT.fail : EXIT.ok
}

function status(s: Snapshot): number {
  const lines: string[] = [`和 ${s.branch} 的分叉点 ${s.base.slice(0, 8)} 比，这次改了 ${s.changes.length} 个文件。`]
  const base = baseChecklist(s)
  if (base.items.length) {
    const hits = hitsOf(s, base.items)
    lines.push(`清单（${CHECKLIST_DIR}/）：${base.items.length} 条，这次命中 ${hits.length} 条${hits.length ? `：${hits.map(hit => hit.item.id).join('、')}（testcraft checklist 列出怎么查）` : ''}`)
  } else lines.push('清单：没有条目')
  const rules = listRules(s.root)
  lines.push(rules.length ? `暂定的规则和记过的 bug（${RULES_DIR}/）：\n${rules.map(rule => `  - ${rule}`).join('\n')}` : '暂定的规则和记过的 bug：没有')
  console.log(lines.join('\n'))
  return EXIT.ok
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

export function main(argv: string[]): number {
  switch (argv[0]) {
    case 'checklist':
    case 'status': {
      const s = snapshot()
      if (typeof s === 'number') return s
      return argv[0] === 'checklist' ? checklist(s) : status(s)
    }
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
