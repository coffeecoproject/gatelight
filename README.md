# testpace

给 agent 开发用的测试节奏插件（Claude Code）。完整方案见 [测试提速方案.md](测试提速方案.md)。

已完成第 1、3 期：项目约定，`focused`、`files`、`full`、`status`、`report` 五条命令，结果记录和精简输出，合并门、停止门和软提示。`focused` 用 `layermap check --json` 选测试，需要 PATH 里有支持 `--json` 的 `layermap` 命令（见方案 5.7）；没有时提示跑整组，并说装上 layermap 插件就能按改动选测试。

## 项目约定

仓库根目录放 `testpace.json`，进版本库。字段、三条命令要做到什么、接入步骤见 [plugin/skills/setup/SKILL.md](plugin/skills/setup/SKILL.md)：它随插件安装，是 Claude Code 里的 `testpace:setup` 技能；没有 `testpace.json` 时，命令的报错也指向这个文件。

`examples/sample` 是按约定建的最小示例项目。

## 命令

| 命令 | 做什么 |
|---|---|
| `testpace focused [--base REF]` | 改完先跑：`fast`，再用 layermap 选出和改动相关的测试交给 `files` 跑，并把选出的测试交回 layermap，问它们跑不跑得到每处改动。默认对比和默认分支的分叉点，分支上已提交的改动也算。改了地图跟不到的文件（配置、依赖、迁移、模板、脚本、样式等，`ignore` 里的不算），没有 layermap 或它出错，没找到相关测试，或者选出的测试有跑不到的改动时，建议跑整组 |
| `testpace files PATH...` | 只跑给定的测试文件，比如重跑失败的文件 |
| `testpace full` | 跑 `full`，按跑的那一刻工作区的完整内容（含未提交、未跟踪的文件）记录结果。同一份代码已经通过的不重跑；相对通过的代码只改了 `ignore` 路径也不重跑。跑的过程中代码改过，通过也不算记录 |
| `testpace status` | 当前代码有没有整组通过记录、有没有正在跑的整组、最近一次结果、配置检查、有没有 layermap |
| `testpace report [--days N]` | 计时诊断：各命令次数和耗时、失败后重跑轮数、不稳定的测试、`fast` 是否过慢、按周的测试行数和整组耗时 |

退出码：0 通过；1 失败或没得到通过记录；2 用法或配置问题；3 已有整组在跑；4 跑了的都通过，但选测靠不住、建议跑整组；130 被中断。

## Hook（Claude Code）

只对接入了约定（有 `testpace.json`）的仓库起作用，只作用于 agent 的命令，用户自己在终端里的操作不受影响。

- **合并门**（PreToolUse）：agent 的 `git commit`、`git merge`、`git push`、`gh pr merge` 要落到默认分支时，算出落地后的代码内容，必须有一次 `testpace full` 通过的记录，否则拒绝并说明原因。同一条命令里，落地的操作前面只能连 `cd` 和 `git add`（会预演），连着别的命令时要求拆开执行。
  - 提交按暂存区算（`-a` 加上已跟踪文件的改动）；带路径或 `-p` 的提交没法确定内容，拒绝。
  - 合并按合并后的结果算；推送按推送的那个提交算。
  - `gh pr merge` 要求 PR 分支包含最新的默认分支，并按 PR 的头提交算。
  - 工作分支上的提交不管。快进到远程默认分支已有的提交（同步远程）、推送远程已有的提交不算新落地。`pull`、`cherry-pick`、`rebase`、`reset` 这类写法和脚本里的 git 不拦，hook 超时也会放行，这些由停止门事后提示。
- **停止门**（Stop）：这个会话起的整组还在跑，或跑完了还没看结果（`testpace status`，或在前台等到了 `testpace full` 的输出），拦一次。默认分支在会话里有了没有通过记录的提交时，提示用户。会话从仓库外开始的，也查它碰过的仓库。
- **软提示**：会话开始时说明测试节奏，会话从仓库外开始的，第一次在仓库里执行命令时补说，压缩、恢复后再说一次；agent 直接跑 `full` 配置的命令时，提示改用 `testpace full`。

记录放在仓库的 `.git/testpace/`（所有 worktree 共用）：`runs.jsonl` 每次运行一行，`logs/` 是完整输出，`running/` 是正在跑的命令。

## 开发

需要 Node 22.18 以上（直接运行 TypeScript，不需要构建）。

```bash
npm test
```
