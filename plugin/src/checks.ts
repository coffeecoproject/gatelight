// 本机登记的附加检查：全局 git 配置 testpace.check（可以有多条），由别的插件装好时登记。
// 登记在本机、不在仓库里：agent 在改动里改不到它。
// testpace full 先在仓库根目录依次跑它们，再跑项目的整组命令：它们比整组便宜，没过就不用再等整组。
// 有一条没过就不跑整组，这次不算通过，合并门照常拦。

import { git } from './git.ts'

export const CHECK_KEY = 'testpace.check'

export function extraChecks(root: string): string[] {
  try {
    return git(root, ['config', '--global', '--get-all', CHECK_KEY])
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}
