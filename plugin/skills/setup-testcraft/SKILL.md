---
name: setup-testcraft
description: 给项目接入 testcraft：确认已接入 testpace，建 .testcraft/ 目录（清单和暂定的规则），放进 gatelight 自带的默认清单条目。用户要给项目接入 testcraft，或已接入的项目要补上新的默认清单条目时使用。
---

# 接入 testcraft

testcraft 和 testpace 在同一个插件里。它只做两件事：会话开始时把写测试的约定说给 agent（照 `gatelight:write-tests` 写）；改动命中清单（`.testcraft/checklist/`）里的条目时提醒 agent 按条目查一遍。它不检查测试写得好不好，不要求证明、复查或写改动记录，也没有配置文件。

仓库里有 `.testcraft/` 目录就算接入：`testpace full` 会在测试之前跑一次 `testcraft checklist`（只读文件，不跑测试），不用另外登记。

## 步骤

1. **确认接入了 testpace**：仓库根目录有 `testpace.json`，`testpace verify` 能过。没有就先用 `gatelight:setup` 接入。
2. **建 `.testcraft/rules/` 和 `.testcraft/checklist/`**（各放一个 `.gitkeep`）。`rules/` 记还在试的规则修过的 bug；`checklist/` 记写不成测试、又能从改动看出来的坑，除了下一步放进的默认条目，其余第一次遇到时再加。写法见 `gatelight:write-tests`。
3. **放进默认的清单条目**：把本技能目录下 `checklist/` 里的每个 `.md` 原样复制进 `.testcraft/checklist/`，文件名不变。这几条是很多项目都会碰到、出了事代价大的坑，触发条件按增删的行里的文字认，项目里没有这块就永远不会命中。现在有：
   - `dev-login.md`：开发登录和开发账号只在开发环境有，后端开关挡住、默认关。
   - `same-number.md`：改了一个数（金额、计提、税这类）怎么算时，查它在后台别处、前端预览有没有另算一份，有就改成同一处算，测试在每个读到它的地方各断言一次。

   再把 gatelight 现在的版本号（`testcraft status` 第一行写着）写进 `.testcraft/defaults`，一行：记下补到了哪一版的默认条目，以后只提醒比它新的。
4. **收掉记录类的 `.md`**：`.md` 和注释都只给 AI 看，仓库里不留记录（方案、设计、说明）。逐份读一遍认是不是记录：给 agent 的指令（`CLAUDE.md`、`AGENTS.md`、技能、各家 agent 的规则文件）和项目的内容（文档站、博客的正文，CHANGELOG、许可证、`.github` 下的模板）不是记录，不动。是记录的：AI 很可能好心改掉、测试又守不住的地方，在那段代码旁边补一句为什么；怎么开发这个仓库（跑哪些命令、环境怎么准备）写进 `CLAUDE.md`；README 只留怎么装。其余删掉，原文在 git 里，删的那次提交说明里写清每份最后在哪个提交、各管什么。
5. **核对**：`testcraft status` 能列出清单条数和暂定的规则。
6. 把 `.testcraft/` 和上一步的改动提交（提交前问用户）。

## 已接入的项目补默认条目

gatelight 加了新的默认条目，已接入的项目不会自己拿到：会话说明、`testcraft checklist` 和 `testcraft status` 会点名比 `.testcraft/defaults` 记的版本新、项目里又没有的条目。在那个项目自己的分支上，把点名的文件从本技能 `checklist/` 原样复制进 `.testcraft/checklist/`，已有同名文件的不动；项目的写法和条目里举的名字不一样的（开关、接口叫别的），在条目的"## 触发"里加一行（只加触发条件不算放宽）。然后把提醒里说的版本号写进 `.testcraft/defaults`。

项目用不上的条目（这块代码根本没有、触发条件在这个项目里只会误报）可以不复制，照样把版本号写进去，以后就不再提醒；用户说过不要的也这样。照常提交、合并：清单按分叉点那一版提醒，合进默认分支后才生效。
