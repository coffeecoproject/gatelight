# testpace

给 agent 开发用的测试节奏插件（Claude Code、Codex）：开发中只跑和改动相关的测试，代码落到默认分支前由程序确认整组通过，并记录测试时间花在哪。

把关只管 agent 执行的命令：合并门是配在全局 git 配置里的 git 钩子，只检查带着 agent 环境变量（Claude Code 的 `CLAUDECODE`、Codex 的 `CODEX_THREAD_ID` 等，见 `plugin/src/agent.ts`）的 git 命令；停止门是 agent 的 Stop hook。两边共用同一份记录：Claude 里测过的代码，Codex 合并时不用重跑。

## 安装

需要 Node 22.18 以上：插件直接运行 TypeScript。`testpace` 命令和 Codex 的 hook 会自己找够新的 node（`TESTPACE_NODE`、PATH、nvm、Homebrew），找不到时说一句、合并门不挡；Claude Code 的 hook 直接用 PATH 上的 `node`。

合并门要 git 2.54 以上：它用 git 在配置里声明钩子的功能（实测 2.54 支持，2.49 不支持）。git 太旧时 `testpace status` 和会话开始时的说明会讲出来。

```bash
claude plugin marketplace add coffeecoproject/testpace
claude plugin install testpace@testpace
```

建议同时装上 [layermap](https://github.com/coffeecoproject/layermap)，`testpace focused` 靠它按改动选测试：

```bash
claude plugin marketplace add coffeecoproject/layermap
claude plugin install layermap@layermap
```

### Codex

```bash
codex plugin marketplace add coffeecoproject/testpace
codex plugin add testpace@testpace
```

第一次用时 Codex 会要求信任插件的 hook。Codex 下的前提：

- **固定命令入口**：Codex 不把插件的 `bin/` 放进命令的 PATH，合并门的钩子也靠 PATH 找 `testpace`。`testpace install` 会放一个 `~/.local/bin/testpace`，它运行时转给这台机器上装着的、完整的最高版本的 testpace（Claude Code、Codex 装的都算；缓存只复制了一部分的那份不算），插件升级不用重放。没放之前，会话开始时会给出插件里 `testpace` 的完整路径，合并门在 Codex 里不检查。
- **在沙箱外跑**：testpace 要写 `.git/testpace/`，项目的测试常要开端口、用网络，Codex 的沙箱里都跑不了。testpace 发现自己在 Codex 沙箱里（`CODEX_SANDBOX`）就不跑测试、也不跑 `status`（它要记下看过结果），说明要提权。可以每次提权交给自动审查；也可以在 `~/.codex/rules/default.rules` 里放行 `testpace`，但那等于放行 `testpace.json` 里的任何命令。

### 之后

装好后开新会话。新建的项目（提交很少、还没有 `testpace.json` 的仓库），会话开始时 testpace 会提出接入，Claude 按接入说明配好，落地前跑全部检查和全部测试，不用你回答。老项目说"给这个项目接入 testpace"，Claude 先把它改造成新项目的样子再接入，只在有测试找不到办法跑、全部测试太久要取舍、要改业务代码时问你。合并门的钩子配在全局 git 配置里：会话开始时自动配上，只告诉你一声；你删掉后不会再自动配回去（要的话用 `testpace install`）。别的项目、新的 worktree 都不用再配，升级插件也不用重配。升级插件后，在已接入的项目里跑一次 `testpace verify <测试文件>...`，确认项目的命令还守着新的约定。

只装 testpace 也能把关：合并门、停止门和其余命令都不依赖 layermap。但开发中没法按改动选测试，`focused` 每次都会建议跑整组。装上 layermap 后只跑和改动相关的测试。在一个整组要跑约 11 分钟的项目里，相关测试每次在 1 分钟以内到 5 分钟之间（只是这一个项目的实测）。

`focused` 调的是 `layermap check --json`（layermap 0.1.41 起），PATH 里要有 `layermap` 命令，装上 layermap 插件并开新会话就有。

## 项目约定

仓库根目录放 `testpace.json`，进版本库。字段、三条命令要做到什么、默认加上的测试检查（不留 `.only`、每个测试有断言）、接入步骤见 [plugin/skills/setup/SKILL.md](plugin/skills/setup/SKILL.md)：它随插件安装，是 `testpace:setup` 技能；没有 `testpace.json` 时，命令的报错也指向这个文件。

`examples/sample` 是按约定建的最小示例项目。

## 开发节奏

- 每个任务在自己的分支上做，最好是自己的 worktree，不和别的会话挤在同一个目录里。
- 开发中只跑 `testpace focused`，失败了用 `testpace files 文件:行号` 只重跑失败的测试。分支上不跑整组。
- 整组在合回默认分支时跑：做完的几个分支一起合到一个临时的合并分支上，跑一次 `testpace full`，通过了再快进默认分支。步骤见 [plugin/skills/merge/SKILL.md](plugin/skills/merge/SKILL.md)（`testpace:merge` 技能）。
- 紧急修复可以单独合，只为它跑一次整组。
- 测试时好时坏，不靠重跑过关：testpace 认出来点名、记进名单，按 testcraft 写测试技能里"测试时好时坏"一节找原因修，修好后用 `testpace files --repeat 10` 连跑证明（见下面的时好时坏的测试）。

## 命令

| 命令 | 做什么 |
|---|---|
| `testpace focused [--base REF]` | 改完先跑：`fast`，再用 layermap 选出和改动相关的测试交给 `files` 跑，并把选出的测试交回 layermap，问它们跑不跑得到每处改动。只从 `tests` 规则找到的测试里选（和整组一致）：规则外的不选，但点出是哪几个（是测试的话整组跑不到它，该补进规则），这次改到的规则内测试文件都选。默认对比和默认分支的分叉点，分支上已提交的改动也算。只改了 `ignore` 路径、规则外的测试或删掉了整组的测试时不跑测试。改了地图跟不到的文件（配置、依赖、迁移、模板、脚本、样式等，`ignore` 里的不算），没有 layermap 或它出错，没找到相关测试，或者选出的测试有跑不到的改动时，在默认分支上建议跑整组；在别的分支上只说明一句，不建议现在跑，合回默认分支时的整组会覆盖 |
| `testpace files [--repeat N] PATH[:行号]...` | 只跑给定的测试文件；`文件:行号` 只跑那一行的测试，比如重跑失败的测试（测试框架不能按行跑的，跑整个文件）。`--repeat N` 连跑 N 次、没过就停：用来造出时好时坏的测试的失败，或修好后连跑证明；每次各记一条运行记录，`report` 不把它们算成反复跑 |
| `testpace full` | 依次跑本机登记的附加检查、`full`（测试以外的检查），再把 `tests` 规则在工作区里找到的全部测试文件交给 `files`，一段没过就停；按跑的那一刻工作区的完整内容（含未提交、未跟踪的文件）记录结果。同一份代码已经通过的不重跑；相对通过的代码只改了 `ignore` 路径也不重跑（`testpace.json` 自己不算忽略路径，改了它要重跑）。跑的过程中代码改过，通过也不算记录，输出里列出变了的文件 |
| `testpace status` | 当前代码有没有整组通过记录、有没有正在跑的整组、最近一次结果、时好时坏的测试名单（各自怎么认出来的、两次的日志）、配置检查（含 `tests` 规则找到多少个测试文件）、合并门和固定命令入口在不在、有没有 layermap |
| `testpace running` | 这个工作区有没有 testpace 的命令在跑（只看这个工作区，别的工作区在跑的不管；testpace 被强杀后测试进程组还在跑的也算）。给要复制或接着用工作区的工具问，比如 testcraft 建副本前：跑到一半的状态（锁文件、临时文件）会一起带进副本。有在跑的，说明跑的是哪种命令、什么时候哪个进程起的（testpace 已经退出的，给出停掉测试进程组的命令），退出码 3；没有的说"这个工作区没有测试在跑。"，退出码 0。`testpace full` 只给附加检查在环境变量 `TESTPACE_RUN` 里带上这一轮的运行 id：附加检查在测试之前跑，在里面问不算在跑。别的项目命令（`fast`、`files`、`full` 和整组跑测试的那一段）不带，testpace 起项目命令时去掉从外面继承来的 `TESTPACE_RUN`，`testpace run` 也不把它交给跑测试的进程：测试里问照样算在跑，同一轮别的测试可能正拿着锁 |
| `testpace report [--days N]` | 计时诊断：各命令次数和耗时、有几个 agent 跑过时按谁跑的分开的次数和耗时、平均每次落地的测试耗时和整组次数、失败后重跑轮数、同一份代码整组先失败后通过的（可能是测试不稳定，也可能是环境问题，列出失败用时和日志供分辨）、`fast` 是否过慢、按周的测试行数和整组耗时 |
| `testpace verify [测试文件...]` | 核对这个项目的接入守不守约定，由程序实际去跑，不靠 agent 说检查过了：`testpace.json` 没写坏、三条命令找得到、合并门在把关、`files` 给了不存在的文件要失败；给了测试文件时，逐个核对它在 `tests` 规则里（整组跑得到它这一类）、能通过、混进不存在的路径要失败、`文件:行号` 和 `文件:行号:列号` 能用，给了几个时再核对它们一起交给 `files` 能通过。项目里的测试交给不同工具或配置跑的（比如前端用 Vitest、接口用 node:test），每种各给一个文件。`tests` 规则一个都找不到算没通过。整组太长不在这里跑。这几次运行不记进报告。接入时和升级 testpace 后各跑一次 |
| `testpace run node-test [--cwd 目录] [--node-arg 参数]... 文件[:行号[:列号]]...`<br>`testpace run vitest [--cwd 目录] [--vitest-arg 参数]... 文件[:行号[:列号]]...`<br>`testpace run playwright [--cwd 目录] [--playwright-arg 参数]... 文件[:行号[:列号]]...` | 写在 `testpace.json` 的 `files` 里，或项目的 `files` 脚本里：用项目的测试框架跑测试文件，守 `files` 的约定，项目不用自己写这层包装。文件不存在、不是文件时退出码 2。逐个核对给的文件和 `文件:行号`：整个文件给的看这个文件的测试，按行给的看这一行选中的测试（测试自己，或它外层哪一级分组声明在这一行，三个框架按行跑都这么选）；一个测试都没跑到（文件没加载起来、里面没有测试、给的行上没有测试、文件被项目配置排除了，哪怕框架照样通过，比如 Playwright 只要别的行有测试就通过）时失败，这次已有测试没过的，另提醒框架可能提前停下了（bail、max-failures、依赖的准备项目没过）；选中的测试全被跳过时说一句，不算失败；框架在选测试之前就停了（参数不认、配置写错）时不核对，用它的退出码；框架还跑了没给的文件（Vitest、Playwright 把文件参数当名字片段，Playwright 先跑给的测试依赖的准备项目）时说一句，那些文件里的测试不算给的。`node-test` 用 PATH 上的 node，不加 `--test-only`，留着的 `.only` 不起作用；不能按行跑，按行给的整个文件跑，说一句，跑完照样核对那一行。`vitest`、`playwright` 用 `--cwd` 目录里装的 Vitest、`@playwright/test`，按行给的交给它们按行跑，项目配置里的报告器照常起作用：`vitest` 经插件的启动脚本调 Vitest 导出的 `startVitest`（命令行也是调它）照 `vitest run` 跑（不支持 `--watch`、`--ui` 这类另起分支的参数，Vitest 5 起不认的参数和命令行一样报错），跑完从它的状态里读结果；`playwright` 的计数报告器经 `PW_TEST_REPORTER` 加在项目配置的报告器后面，路径按正则转义后交给它。`--cwd` 换框架的工作目录（文件仍按当前目录算），`--node-arg`、`--vitest-arg`、`--playwright-arg` 原样交给框架，可以给几次。框架起在自己的进程组里，被中断时给整个组发 SIGINT（跑测试的子进程一起收到），8 秒还没退就强杀。由 `files`、`focused`、`full` 起的，把每个测试的结果（文件、行号、带外层分组的名字、过没过、是不是框架重试后才过）交回给 testpace，见下面的时好时坏的测试；交结果的位置（环境变量 `TESTPACE_RESULTS`）不传给跑测试的进程。testpace 跑项目命令时把自己的命令目录放在 PATH 最前面，命令和脚本里调的 `testpace` 就是正在跑的这一版 |
| `testpace install` | 在全局 git 配置（`git config --global`）里配上合并门的钩子：`hook.testpace.event = reference-transaction` 和 `hook.testpace.command`。这台机器配一次，所有仓库、所有工作区生效；不往仓库里写文件，也不影响项目自己的钩子（`core.hooksPath`、husky 这些照常跑）。钩子命令只把引用更新转交给 `testpace gate`，规则都在 testpace 里。git 太旧（不认配置里声明的钩子）时不配，说明要升级 git。同时放上固定命令入口 `~/.local/bin/testpace`（见安装的 Codex 一节）；那里已经有别的文件时不覆盖 |

同一个工作区一次只跑一轮测试：`focused`、`files`、`full` 发现这个工作区已经有 testpace 的命令在跑时直接退出，不抢端口、测试库这些资源。testpace 被强杀后测试进程还在跑的，照样算在跑，提示里给出停掉它的命令。`files` 的路径按当前目录算。

退出码：0 通过；1 失败或没得到通过记录（`verify`：有没通过的项）；2 用法或配置问题（`install` 时 git 太旧，或配好了但在这个仓库里没有生效；`verify` 时 `testpace.json` 有问题或给的文件不存在）；3 这个工作区已有测试在跑（`running`：有 testpace 的命令在跑），或别的工作区在跑同一份代码的整组；4 跑了的都通过，但选测靠不住、建议跑整组；130 被中断。

## 时好时坏的测试

经 `testpace run` 跑的测试，testpace 记得每次是哪几个没过（运行记录的 `failed`，按文件和带外层分组的名字认同一个测试，改了别处、行号变了也认得出；Vitest、Playwright 的 project 有名字时名字前带 `[project 名]`，各算一个）。一次运行里同一个名字既有过的又有没过的（同名测试、`repeatEach` 的拷贝），分不清是哪个，不算。项目没经 `testpace run` 跑的测试交不回结果，下面这些都不做。

- **认出时好时坏**：同一份代码（不管在哪个工作区；两次都要跑的过程中代码没改过）上，一个测试以前没过、这次过了；`--repeat` 连跑时前面过了、后面没过；框架重试之后才过（Vitest 的 `retry`、Playwright 的 `retries`）。记进名单（所有工作区共用），在那次运行的输出里点名：不要靠重跑过关，按 testcraft 的规矩找原因修，和手上的活无关的告诉用户。
- **哪里列出名单**：`testpace status`，会话开始时的说明。这个会话认出的、还在名单上的，停止门每个拦一次。不拦合并：时好时坏的测试常和手上的改动无关，拦住合并所有分支都得停下等它。
- **从名单上去掉**：连跑过程中代码一直没改，`testpace files --repeat 10` 连跑 10 次它每次都过（测试写了没被 `.gitignore` 忽略的文件、工作区变了的，不算，输出里说一句）；或者在认出它的工作区里（那个工作区删了的话在哪都行）整个跑了它的文件、全部通过，文件里却已经没有这个测试（删掉或改了名；所在的组整个被跳过的不算）。别的工作区的代码可能还没有这个测试，不算。去掉时输出里说一句。
- 不同工作区里被 `.gitignore` 忽略的东西（`node_modules`、构建产物、`.env`）可能不一样：新开的工作区缺了它们没过、在别处过了，也会被认成时好时坏。看日志能分出来。
- **几轮没过**：同一个工作区里，同一个测试改了代码再跑还没过算一轮，代码没改只是重跑不算，过了清零。到第 3 轮起，输出里让 agent 停下来，把失败原因和这几轮各改了什么告诉用户，等用户决定。只提醒，不拦。

## 把关

只对接入了约定（有 `testpace.json`）的仓库起作用，只作用于 agent 的命令，用户自己在终端里的操作不受影响。

接入与否分两处看：

- 合并门、停止门判断落到默认分支的代码时，看**提交里**的 `testpace.json`，不看工作区里的文件：默认分支现在的代码里有它，或要落地的代码里有它，就管；`ignore` 取要落地的那份代码自己带的。工作区里没提交的改动（删了、写坏了、改了 `ignore`）不影响判断。
- 会话说明、停止门拦不拦、各条命令，看**工作区根目录**有没有 `testpace.json`。写坏了也算接入：会话开始时照样说明节奏并讲出问题，`testpace status` 给出原因。

通过记录只在 `testpace.json` 相同的代码之间沿用，所以改约定（包括改 `ignore`）的提交要在改完的代码上跑过整组才能落地。提交里的 `testpace.json` 写坏了（`testpace full` 跑不了）的代码拿不到通过记录，合并门拦下时说出坏在哪。删掉 `testpace.json` 的代码也拿不到：退出接入由用户自己在终端里提交；接入之前分出去、本来就没有它的分支，把默认分支合进来再测。

- **合并门**（git 的 `reference-transaction` 钩子，会话开始时自动配在全局 git 配置里，也可以用 `testpace install`）：agent 的 git 命令要移动本地默认分支时，git 把分支要指向的提交交给 `testpace gate`；那份代码没有 `testpace full` 通过的记录，git 就取消这次更新，默认分支不动，并说明原因。
  - 按实际要落地的提交判断，不管命令怎么写：`commit`、`merge`、`cherry-pick`、`rebase`、`reset`、包了一层的写法、脚本里的 git 都一样。
  - 退回默认分支以前的提交、快进到远程默认分支已有的提交（同步远程）不算新落地。工作分支上的提交不管。
  - "远程已有"按远程跟踪分支（`refs/remotes/<远程>/<默认分支>`）认，包括同一次更新里它的新位置。同步远程用 `git pull`、`git fetch <远程> main:main`，或先 `git fetch <远程>` 再快进。`git fetch <路径或 URL> main:main` 不经过远程跟踪分支，照样拦。
  - 被拦下后，工作区和暂存区里可能留着这次操作带来的改动；停在半路的 `cherry-pick`、`rebase` 要先 `--abort`。
  - 不经过本地默认分支的落地不拦：推送别的分支到默认分支（`git push origin 分支:main`）、在 GitHub 上合并 PR。停止门事后提示。
  - 钩子在所有仓库里都跑：没有分支要动（只是远程跟踪分支、`HEAD`）时什么都不做；有分支要动时调用一次 `testpace gate`，没接入 testpace 的仓库直接放行。
  - 只有 `testpace gate` 明确拒绝才拦。没得到检查结论的都不挡：会话里找不到 `testpace` 命令（插件没启用、Codex 里没放固定命令入口）、插件没装全、找不到够新的 node、会话里是旧版本的 testpace，在接入了 testpace 的仓库里说一句，附上 testpace 的输出。插件更新后，开着的会话要重开才换成新版本。`gate` 已经在检查、却确认不了要落地的代码测过时照样拦。
  - 钩子命令里记着是哪一版 testpace 配的。Claude Code 和 Codex 装的版本不同时，会话开始的自动更新只升不降，不来回覆盖。
  - 合并门没配、配的命令是更旧版本的、被仓库自己的配置关掉（`hook.testpace.enabled = false`）、git 太旧，或找不到默认分支（没有 `origin/HEAD`，本地也没有 `main`、`master`）时，`testpace status` 和会话开始时的说明会讲出来。
- **整组跑全部测试**：测试由 testpace 按 `tests` 规则自己找，交给 `files` 跑，不靠谁记得把新测试加进整组。放松整组（改 `full`、`tests` 规则或它们调到的脚本）testpace 不另外拦：要防 agent 这样放水，装上做这类检查的插件（登记成附加检查）。
- **附加检查**（全局 git 配置 `testpace.check`，可以有多条）：`testpace full` 先在仓库根目录依次跑这台机器上登记的附加检查，再跑 `full` 和全部测试：附加检查便宜，有一条没过就不往下跑、不算整组通过，合并门照常拦。附加检查由别的插件装好时登记；登记在本机、不在仓库里，agent 在改动里删不掉。`testpace status` 列出登记了哪些。登记的命令找不到（插件停用了）时，`full` 不通过并说明怎么取消登记。
- **停止门**（agent 的 Stop hook）：这个会话认出了时好时坏的测试、还在名单上的，每个拦一次。这个会话起的整组（按 agent 给命令带的会话号认，别的会话和终端里起的不算）还在跑，或这个会话还没看过结果（`testpace status`，或在前台等到了 `testpace full` 的输出，通过、失败都算），拦一次。每次整组只拦一次（还在跑时一次、跑完没看结果时一次），拦过的记在会话状态里。本地默认分支或 `origin` 上的默认分支在会话里有了没有通过记录的提交时，提示用户。会话从仓库外开始的，也查它碰过的仓库。
- **软提示**（agent 的 hook）：会话开始时说明测试节奏（上一节），会话从仓库外开始的，第一次在仓库里执行命令时补说，压缩、恢复后再说一次；agent 直接跑 `full` 配置的命令时，提示它只是整组的一部分、不留记录，改用 `testpace full`。

记录放在仓库的 `.git/testpace/`（所有 worktree、Claude Code 和 Codex 共用）：`runs.jsonl` 每次运行一行（记着哪个 agent、哪一版 testpace 跑的），`logs/` 是完整输出，`running/` 是每个工作区正在跑的命令，`sessions/` 是各会话的状态，`flaky/` 是时好时坏的测试名单（一个测试一份），`rounds/` 是各工作区里测试连着几轮没过。

## 开发

需要 Node 22.18 以上（直接运行 TypeScript，不需要构建）和 git 2.54 以上（PATH 里排在前面的那个；合并门的测试要用）。测试用自己的全局 git 配置，不读也不改 `~/.gitconfig`。

这个仓库自己也接入了 testpace（`testpace.json`）：先 `npm install`，改完跑 `testpace focused`，合回 main 前跑 `testpace full`。`fast`、`full` 是类型检查加 lint（lint 只查每个测试都有断言），`files` 是 `testpace run node-test`：用的是跑整组的那个 testpace（本机装的），不是仓库里正在改的这一版，正在改的跑法要是坏了（比如吞掉失败），不会连整组的结论一起带坏。`testpace run` 自己的测试另外调仓库里这一版（`plugin/bin/testpace`）。

```bash
testpace focused
```
