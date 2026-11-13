# testpace

给 agent 开发用的测试节奏插件（Claude Code）：开发中只跑和改动相关的测试，提交、合并、推送到默认分支前由程序确认整组通过，并记录测试时间花在哪。

把关（合并门、停止门）靠 Claude Code 的 hook，只管 Claude Code 里 agent 执行的命令。Codex 等其他 agent 也能用 testpace 的命令，但它们的提交、合并、推送不会被拦。

## 安装

需要 Node 22.18 以上：插件直接用 `node` 运行 TypeScript。Node 太旧时 hook 会报错，Claude Code 不会因此拦命令，合并门也就不起作用。

```bash
claude plugin marketplace add coffeecoproject/testpace
claude plugin install testpace@testpace
```

建议同时装上 [layermap](https://github.com/coffeecoproject/layermap)，`testpace focused` 靠它按改动选测试：

```bash
claude plugin marketplace add coffeecoproject/layermap
claude plugin install layermap@layermap
```

装好后开新会话，在项目里说"给这个项目接入 testpace"，Claude 会按接入说明配好。

只装 testpace 也能把关：合并门、停止门和其余命令都不依赖 layermap。但开发中没法按改动选测试，`focused` 每次都会建议跑整组。装上 layermap 后只跑和改动相关的测试。在一个整组要跑约 11 分钟的项目里，相关测试每次在 1 分钟以内到 5 分钟之间（只是这一个项目的实测）。

`focused` 调的是 `layermap check --json`（layermap 0.1.40 起），PATH 里要有 `layermap` 命令，装上 layermap 插件并开新会话就有。

## 项目约定

仓库根目录放 `testpace.json`，进版本库。字段、三条命令要做到什么、默认加上的测试检查（不留 `.only`、每个测试有断言）、接入步骤见 [plugin/skills/setup/SKILL.md](plugin/skills/setup/SKILL.md)：它随插件安装，是 Claude Code 里的 `testpace:setup` 技能；没有 `testpace.json` 时，命令的报错也指向这个文件。

`examples/sample` 是按约定建的最小示例项目。

## 开发节奏

- 每个任务在自己的分支上做，最好是自己的 worktree，不和别的会话挤在同一个目录里。
- 开发中只跑 `testpace focused`，失败了用 `testpace files 文件:行号` 只重跑失败的测试。分支上不跑整组。
- 整组在合回默认分支时跑：做完的几个分支一起合到一个临时的合并分支上，跑一次 `testpace full`，通过了再快进默认分支。步骤见 [plugin/skills/merge/SKILL.md](plugin/skills/merge/SKILL.md)（Claude Code 里的 `testpace:merge` 技能）。
- 紧急修复可以单独合，只为它跑一次整组。

## 命令

| 命令 | 做什么 |
|---|---|
| `testpace focused [--base REF]` | 改完先跑：`fast`，再用 layermap 选出和改动相关的测试交给 `files` 跑，并把选出的测试交回 layermap，问它们跑不跑得到每处改动。默认对比和默认分支的分叉点，分支上已提交的改动也算。改了地图跟不到的文件（配置、依赖、迁移、模板、脚本、样式等，`ignore` 里的不算），没有 layermap 或它出错，没找到相关测试，或者选出的测试有跑不到的改动时，在默认分支上建议跑整组；在别的分支上只说明一句，不建议现在跑，合回默认分支时的整组会覆盖 |
| `testpace files PATH[:行号]...` | 只跑给定的测试文件；`文件:行号` 只跑那一行的测试，比如重跑失败的测试（测试框架不能按行跑的，跑整个文件） |
| `testpace full` | 跑 `full`，按跑的那一刻工作区的完整内容（含未提交、未跟踪的文件）记录结果。同一份代码已经通过的不重跑；相对通过的代码只改了 `ignore` 路径也不重跑。跑的过程中代码改过，通过也不算记录 |
| `testpace status` | 当前代码有没有整组通过记录、有没有正在跑的整组、最近一次结果、配置检查、有没有 layermap |
| `testpace report [--days N]` | 计时诊断：各命令次数和耗时、平均每次落地的测试耗时和整组次数、失败后重跑轮数、同一份代码整组先失败后通过的次数（可能不稳定）、`fast` 是否过慢、按周的测试行数和整组耗时 |

同一个工作区一次只跑一轮测试：`focused`、`files`、`full` 发现这个工作区已经有 testpace 的命令在跑时直接退出，不抢端口、测试库这些资源。

退出码：0 通过；1 失败或没得到通过记录；2 用法或配置问题；3 这个工作区已有测试在跑，或别的工作区在跑同一份代码的整组；4 跑了的都通过，但选测靠不住、建议跑整组；130 被中断。

## Hook（Claude Code）

只对接入了约定（有 `testpace.json`）的仓库起作用，只作用于 agent 的命令，用户自己在终端里的操作不受影响。

- **合并门**（PreToolUse）：agent 的 `git commit`、`git merge`、`git push`、`gh pr merge` 要落到默认分支时，算出落地后的代码内容，必须有一次 `testpace full` 通过的记录，否则拒绝并说明原因。同一条命令里，落地的操作前面只能连 `cd` 和 `git add`（会预演），连着别的命令时要求拆开执行。
  - 提交按暂存区算（`-a` 加上已跟踪文件的改动）；带路径或 `-p` 的提交没法确定内容，拒绝。
  - 合并按合并后的结果算；推送按推送的那个提交算。
  - `gh pr merge` 要求 PR 分支包含最新的默认分支，并按 PR 的头提交算。
  - 工作分支上的提交不管。快进到远程默认分支已有的提交（同步远程）、推送远程已有的提交不算新落地。`pull`、`cherry-pick`、`rebase`、`reset` 这类写法和脚本里的 git 不拦，hook 超时也会放行，这些由停止门事后提示。
- **停止门**（Stop）：这个会话起的整组（按 Claude Code 给命令带的会话号认，别的会话和终端里起的不算）还在跑，或跑完了还没看结果（`testpace status`，或在前台等到了 `testpace full` 的输出），拦一次。默认分支在会话里有了没有通过记录的提交时，提示用户。会话从仓库外开始的，也查它碰过的仓库。
- **软提示**：会话开始时说明测试节奏（上一节），会话从仓库外开始的，第一次在仓库里执行命令时补说，压缩、恢复后再说一次；agent 直接跑 `full` 配置的命令时，提示改用 `testpace full`。

记录放在仓库的 `.git/testpace/`（所有 worktree 共用）：`runs.jsonl` 每次运行一行，`logs/` 是完整输出，`running/` 是正在跑的命令。

## 开发

需要 Node 22.18 以上（直接运行 TypeScript，不需要构建）。

```bash
npm test
```
