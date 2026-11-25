// codekeep 的命令：check。命令入口（src/codekeep.ts）分发到这里。
// check 也是整组里的一段（见 full.ts）：接入了的仓库，testpace full 在测试之前跑它，不用另外登记。

import { EXIT } from '../base/exit.ts'
import { openRepo } from '../base/repo.ts'
import { check } from './check.ts'
import { CONFIG_PATH } from './config.ts'

const USAGE = `用法：
  codekeep check    规范检查：${CONFIG_PATH} 写得对不对；和分叉点比规范改松了哪些（改松的要用户确认）；
                    依次跑 checks 里的命令；secrets 开着时用 gitleaks 扫这次改动里的密钥。
                    接入了的仓库，testpace full 里自动跑它`

/** 退出码用底座的：0 通过；1 没通过；2 用法、配置或环境问题。 */

/**
 * 在 agent 的沙箱里跑不了的子命令和它要做的事（见 base/commandline.ts）。
 * check 要跑项目的检查命令、在系统临时目录建分叉点的临时 worktree、写 .git/testpace/ 的确认记录，沙箱里会被拒。
 */
export function outside(argv: string[]): string | undefined {
  return argv[0] === 'check' ? `跑 ${CONFIG_PATH} 里的检查命令和 gitleaks、在系统临时目录建分叉点的临时 worktree、写 .git/testpace/ 的记录` : undefined
}

export async function main(argv: string[]): Promise<number> {
  switch (argv[0]) {
    case 'check': {
      if (argv.length > 1) {
        console.error(`不认识的参数：${argv.slice(1).join(' ')}\n${USAGE}`)
        return EXIT.usage
      }
      const repo = openRepo(process.cwd())
      if (!repo) {
        console.error('codekeep 要在 git 仓库里运行。')
        return EXIT.usage
      }
      return check(repo)
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
