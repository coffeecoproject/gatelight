// "测试写法"说给 agent 的话，经底座的钩子送出去（base/module.ts 的 brief）：会话开始时说几句写测试的约定。
// 没有停止门：加测试、删测试、改到清单条目，收尾时都不拦。清单在落地前的整组里提醒（见 full.ts），平时用 testcraft checklist 看。
// 这里没有"证明测试管用""复查测试"这类检查：测试写得好不好靠写测试的约定，不靠再起一轮核对。

import type { Repo } from '../base/repo.ts'
import { joined } from './config.ts'
import { missingText } from './defaults.ts'

export function guide(label = '这个仓库'): string[] {
  return [
    `${label}用 testcraft 管测试的写法（.testcraft/）：`,
    '1. 什么时候写：分支上开发时不写新测试、不改已有的测试（需求还在试），做完告诉用户做完了、测试还没写。用户说要合并这个分支时才写：把这次定下来的规则用白话一条条列出来，交给一个子代理照 gatelight:write-tests 技能写新测试、改掉因为需求变了而不过的旧测试（没有起子代理的工具就自己写），跑通、提交，再合。例外，当场做：修已合进默认分支的规则的 bug，先写能重现它的测试再修。',
    '2. 写哪些：小改动（文字、样式、注释、显示用的配置）不写。必跑层：钱、权限、状态与数据（什么状态下能做、数据会不会错）写在接口层、测透，每个功能留主流程的页面测试。细节层：界面细节、样式、提示文字这类人容易漏看的，也值得写。修过的 bug 留一条能重现它的测试。在页面上重复验证接口层守着的规则不写。',
    '3. 已定的业务规则（合进默认分支的）以测试名为准。要改已定的业务规则（包括为此删测试、让测试不跑、改期望值），先用白话问用户，用户同意了再改；用户这次自己提出要改的不用再问。测试上别的调整（跟着代码改接法、换写法、挪位置、删重复的）自己定，不问用户，也不用写说明。文档里不另写已定的规则：设计文档只写代码和测试装不下的（为什么这样定、否掉的做法、还没定的、怎么跑），和测试名说法不一样时以测试为准；合并时规则写进了测试，文档里写着这几条规则的段落就删掉。',
    '4. 改动命中 .testcraft/checklist/ 里条目的触发条件时（testcraft checklist 列出，落地前的整组里也会说一遍），按条目查一遍，查出问题就改好。修 bug 时，写不成测试、又能从改动看出来的坑，加一条清单。',
  ]
}

/** 会话说明：接入了"测试写法"的仓库才说。 */
export function brief(label: string, repo?: Repo): string[] {
  if (!repo || !joined(repo.root)) return []
  const missing = missingText(repo.root)
  return missing ? [...guide(label), missing] : guide(label)
}
