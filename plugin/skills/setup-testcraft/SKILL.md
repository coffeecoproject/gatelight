---
name: setup-testcraft
description: 给项目接入 testcraft：确认已接入 testpace，建 .testcraft/ 目录（清单和暂定的规则）。用户要给项目接入 testcraft 时使用。
---

# 接入 testcraft

testcraft 和 testpace 在同一个插件里。它只做两件事：会话开始时把写测试的约定说给 agent（照 `gatelight:write-tests` 写）；改动命中清单（`.testcraft/checklist/`）里的条目时提醒 agent 按条目查一遍。它不检查测试写得好不好，不要求证明、复查或写改动记录，也没有配置文件。

仓库里有 `.testcraft/` 目录就算接入：`testpace full` 会在测试之前跑一次 `testcraft checklist`（只读文件，不跑测试），不用另外登记。

## 步骤

1. **确认接入了 testpace**：仓库根目录有 `testpace.json`，`testpace verify` 能过。没有就先用 `gatelight:setup` 接入。
2. **建 `.testcraft/rules/` 和 `.testcraft/checklist/`**（各放一个 `.gitkeep`）。`rules/` 记还在试的规则修过的 bug；`checklist/` 记写不成测试、又能从改动看出来的坑，第一次遇到时再加条目。写法见 `gatelight:write-tests`。
3. **核对**：`testcraft status` 能列出清单条数和暂定的规则。
4. 把 `.testcraft/` 提交（提交前问用户）。
