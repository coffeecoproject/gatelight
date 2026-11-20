// "测试写法"说给 agent 的话，经底座的钩子送出去（base/module.ts 的 brief）：会话开始时说几句写测试的约定。
// 没有停止门：加测试、删测试、改到清单条目，收尾时都不拦。清单在落地前的整组里提醒（见 full.ts），平时用 testcraft checklist 看。
// 这里没有"证明测试管用""复查测试"这类检查：测试写得好不好靠写测试的约定，不靠再起一轮核对。

import type { Repo } from '../base/repo.ts'
import { joined } from './config.ts'

export function guide(label = '这个仓库'): string[] {
  return [
    `${label}用 testcraft 管测试的写法（.testcraft/）：`,
    '1. 写测试照 gatelight:write-tests 技能。小改动（文字、样式、注释、显示用的配置）不写。必跑层：钱、权限、状态与数据（什么状态下能做、数据会不会错）写在接口层、测透，每个功能留主流程的页面测试。细节层：界面细节、样式、提示文字这类人容易漏看的，也值得写。修过的 bug 留一条能重现它的测试。在页面上重复验证接口层守着的规则不写。还在试的规则不写正式测试。',
    '2. 已定的业务规则以测试名为准。要改已定的业务规则（包括为此删测试、让测试不跑、改期望值），先用白话问用户，用户同意了再改；用户这次自己提出要改的不用再问。测试上别的调整（跟着代码改接法、换写法、挪位置、删重复的）自己定，不问用户，也不用写说明。',
    '3. 改动命中 .testcraft/checklist/ 里条目的触发条件时（testcraft checklist 列出，落地前的整组里也会说一遍），按条目查一遍，查出问题就改好。修 bug 时，写不成测试、又能从改动看出来的坑，加一条清单。',
  ]
}

/** 会话说明：接入了"测试写法"的仓库才说。 */
export function brief(label: string, repo?: Repo): string[] {
  return repo && joined(repo.root) ? guide(label) : []
}
