# testpace

给 agent 开发用的测试节奏插件（Claude Code）：开发中只跑和改动相关的测试，代码落到默认分支前由程序确认整组通过，并记录测试时间花在哪。

把关只管 Claude Code 里 agent 执行的命令：合并门是装进仓库的 git 钩子，只检查带着 Claude Code 环境变量（`CLAUDECODE`）的 git 命令；停止门是 Claude Code 的 hook。Codex 等其他 agent 也能用 testpace 的命令，但它们落到默认分支的提交不会被拦。

## 安装

需要 Node 22.18 以上：插件直接用 `node` 运行 TypeScript。Node 太旧时 testpace 的命令和 hook 都会报错，合并门会把 agent 对默认分支的更新都拦下。

```bash
claude plugin marketplace add coffeecoproject/testpace
claude plugin install testpace@testpace
```

建议同时装上 [layermap](https://github.com/coffeecoproject/layermap)，`testpace focused` 靠它按改动选测试：

```bash
claude plugin marketplace add coffeecoproject/layermap
claude plugin install layermap@layermap
```

装好后开新会话，在项目里说"给这个项目接入 testpace"，Claude 会按接入说明配好，包括用 `testpace install` 装上合并门的 git 钩子。已经接入的项目升级到这一版后，会话开始时和 `testpace status` 会提示装上钩子。

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
| `testpace install` | 装上合并门的 git 钩子（`reference-transaction`），装进 git 实际用的钩子目录（设了 `core.hooksPath` 的装进那里，这时它是项目文件，要提交）。那里已有别的同名钩子时不覆盖 |

同一个工作区一次只跑一轮测试：`focused`、`files`、`full` 发现这个工作区已经有 testpace 的命令在跑时直接退出，不抢端口、测试库这些资源。testpace 被强杀后测试进程还在跑的，照样算在跑，提示里给出停掉它的命令。`files` 的路径按当前目录算。

退出码：0 通过；1 失败或没得到通过记录；2 用法或配置问题（`install` 时已有别的钩子）；3 这个工作区已有测试在跑，或别的工作区在跑同一份代码的整组；4 跑了的都通过，但选测靠不住、建议跑整组；130 被中断。

## 把关

只对接入了约定（有 `testpace.json`）的仓库起作用，只作用于 agent 的命令，用户自己在终端里的操作不受影响。

- **合并门**（git 的 `reference-transaction` 钩子，`testpace install` 装上）：agent 的 git 命令要移动本地默认分支时，git 把分支要指向的提交交给 `testpace gate`；那份代码没有 `testpace full` 通过的记录，git 就取消这次更新，默认分支不动，并说明原因。
  - 按实际要落地的提交判断，不管命令怎么写：`commit`、`merge`、`cherry-pick`、`rebase`、`reset`、包了一层的写法、脚本里的 git 都一样。
  - 退回默认分支以前的提交、快进到远程默认分支已有的提交（同步远程）不算新落地。工作分支上的提交不管。
  - 被拦下后，工作区和暂存区里可能留着这次操作带来的改动；停在半路的 `cherry-pick`、`rebase` 要先 `--abort`。
  - 不经过本地默认分支的落地不拦：推送别的分支到默认分支（`git push origin 分支:main`）、在 GitHub 上合并 PR。停止门事后提示。
  - 钩子没装、是旧版本、被别的钩子占着，或找不到默认分支（没有 `origin/HEAD`，本地也没有 `main`、`master`）时，`testpace status` 和会话开始时的说明会讲出来。
- **停止门**（Claude Code 的 Stop hook）：这个会话起的整组（按 Claude Code 给命令带的会话号认，别的会话和终端里起的不算）还在跑，或这个会话还没看过结果（`testpace status`，或在前台等到了 `testpace full` 的输出），拦一次。本地默认分支或 `origin` 上的默认分支在会话里有了没有通过记录的提交时，提示用户。会话从仓库外开始的，也查它碰过的仓库。
- **软提示**（Claude Code 的 hook）：会话开始时说明测试节奏（上一节），会话从仓库外开始的，第一次在仓库里执行命令时补说，压缩、恢复后再说一次；agent 直接跑 `full` 配置的命令时，提示改用 `testpace full`。

记录放在仓库的 `.git/testpace/`（所有 worktree 共用）：`runs.jsonl` 每次运行一行，`logs/` 是完整输出，`running/` 是每个工作区正在跑的命令，`sessions/` 是各会话的状态。

## 开发

需要 Node 22.18 以上（直接运行 TypeScript，不需要构建）。

```bash
npm test
```
