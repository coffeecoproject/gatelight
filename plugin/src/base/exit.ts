/**
 * 命令的退出码：0 通过；1 失败或没得到通过记录；2 用法或配置问题；
 * 3 这个工作区已有测试在跑或被借用着（hold：占不上），或别处在跑同一份代码的整组；4 在默认分支上，跑了的都通过，但选测靠不住，应当跑整组；130 被中断。
 * gate 拒绝时是 GATE_REJECT（见 gate.ts）。
 */
export const EXIT = { ok: 0, fail: 1, usage: 2, busy: 3, fullNeeded: 4, interrupted: 130 } as const
