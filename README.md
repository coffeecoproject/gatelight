# gatelight

给 agent 写代码把关的插件（Claude Code、Codex、Antigravity）。门口的一盏灯：几件事都过了才变绿，代码才能落到默认分支。

| 查什么 | 怎么查 | 命令 |
|---|---|---|
| 测试跑了没有 | 开发中只跑和改动相关的测试；代码落到默认分支前，由程序确认全部测试通过，并记录测试时间花在哪 | `testpace` |
| 测试怎么写 | 把写测试的约定说给 agent；写不成测试的坑记成清单，改动碰到了提醒它查一遍 | `testcraft` |
| 代码有没有越界 | 项目分成模块，要别的模块的能力只能走它的入口；放宽规则要你同意 | `modwall` |
| 代码守不守规范 | 类型检查、lint、格式检查在落地前跑；规范改松了要你同意；提交里不能有密钥 | `codekeep` |

第一项是底子，接入了它（仓库根目录有 `testpace.json`）另外几项才起作用；后三项各自按仓库启用（见下面"测试写法""模块边界""代码规范"几节）。

它原来叫 testpace（另两项原来是单独的 testcraft、modwall 插件）。改的是插件的名字和技能的前缀（`gatelight:`）；三条命令、`testpace.json`、`.testcraft/`、`.modwall/`、`.git/` 下的记录都没改，已接入的项目不用动。从 testpace 换过来要做的见"换成这一版要做的"。

把关只管 agent 执行的命令：合并门是配在全局 git 配置里的 git 钩子，只检查带着 agent 环境变量（Claude Code 的 `CLAUDECODE`，桌面版里它往终端面板打的命令带 `CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS`；Codex 的 `CODEX_THREAD_ID` 等，见 `plugin/src/base/agent.ts`）的 git 命令；停止门是 agent 的 Stop hook。两边共用同一份记录：Claude 里测过的代码，Codex 合并时不用重跑。

## 安装

需要 Node 22.18 以上：插件直接运行 TypeScript。`testpace` 命令和 Codex 的 hook 会自己找够新的 node（`TESTPACE_NODE`、PATH、nvm、Homebrew），找不到时说一句、合并门不挡；Claude Code 的 hook 直接用 PATH 上的 `node`。

合并门要 git 2.54 以上：它用 git 在配置里声明钩子的功能（实测 2.54 支持，2.49 不支持）。git 太旧时 `testpace status` 和会话开始时的说明会讲出来。

插件发在 npm 上（包名 `gatelight`）。Claude Code、Codex 从插件市场 [gatelight-marketplace](https://github.com/coffeecoproject/gatelight-marketplace) 装，市场里写的是从 npm 拿；Antigravity 没有第三方插件市场，用 `npx` 装。这个仓库根上的市场目录是开发用的（插件从仓库里的 `plugin/` 拿），装来用的话加 gatelight-marketplace，两个市场都叫 `gatelight`，不要同时加。

```bash
claude plugin marketplace add coffeecoproject/gatelight-marketplace
claude plugin install gatelight@gatelight
```

建议同时装上 [layermap](https://github.com/coffeecoproject/layermap)，`testpace focused` 靠它按改动选测试：

```bash
claude plugin marketplace add coffeecoproject/layermap
claude plugin install layermap@layermap
```

### Codex

```bash
codex plugin marketplace add coffeecoproject/gatelight-marketplace
codex plugin add gatelight@gatelight
```

Codex 用本机的 `npm` 从 npm 拿插件，要装着它。第一次用时 Codex 会要求信任插件的 hook。Codex 下的前提：

- **固定命令入口**：Codex 不把插件的 `bin/` 放进命令的 PATH，合并门的钩子也靠 PATH 找 `testpace`。`testpace install` 会在 `~/.local/bin` 给插件的每条命令放一个入口（`testpace`、`modwall`、`testcraft`、`codekeep`，内容一样，按被叫的名字转），运行时转给这台机器上装着的、完整的最高版本的插件里同名的命令（Claude Code、Codex 装的都算；缓存只复制了一部分的那份不算），插件升级不用重放；入口文件本身变了的那几版（比如插件改名），会话开始时自动把放过的旧入口换成新的，没放过的那几条不自动放（0.17.4 起多了 `modwall`、`testcraft`，之后又多了 `codekeep`，升级后再跑一次 `testpace install`）。没放之前，会话开始时会说是哪几条没放、给出插件里放命令的目录，`testpace` 没放时合并门在 Codex 里不检查。`~/.local/bin` 在 PATH 里排在插件的 `bin/` 前面时，Claude Code 里这几条命令也走入口（用装着的最高版本）。
- **LayerMap 的命令**：`testpace focused` 按改动选测试、`modwall check` 都靠 PATH 上的 `layermap` 命令。LayerMap 的 Codex 插件只带 MCP 服务、不带命令，所以装好 LayerMap 的插件、开过一次会话后，还要跑一次 `npx layermap setup command`（LayerMap 0.1.55 起）：它在 `~/.local/bin` 放一个 `layermap` 命令，运行这台机器上各 agent 的 LayerMap 插件装着的最高版本，插件升级不用重放。这个入口是 LayerMap 放的、归它管，gatelight 不替它放；没放时 `focused` 没法选测试，`modwall check` 不通过，输出里会说这一句。
- **在沙箱外跑**：testpace 要写 `.git/testpace/`，项目的测试常要开端口、用网络，Codex 的沙箱里都跑不了。testpace 发现自己在 Codex 沙箱里（`CODEX_SANDBOX`）就不跑测试、也不跑 `status`（它要记下看过结果），说明要提权。modwall 也一样：`modwall check`、`modwall status` 要 LayerMap 更新存在项目外面的地图，`modwall db check` 要连数据库，在沙箱里得出的是假的“没通过”，所以也不跑、说明要提权。`codekeep check` 要跑项目的检查命令和 gitleaks、在系统临时目录建临时 worktree，也一样。testcraft 只读项目里的文件，沙箱里照常跑。可以每次提权交给自动审查；也可以在 `~/.codex/rules/default.rules` 里放行 `testpace`，但那等于放行 `testpace.json` 里的任何命令。
- **确认工具**：要你同意的改动，确认服务自己向 Codex 发一张表单（MCP 的 elicitation）问你，内容是检查存下的原文，你点同意才记下；工具调用本身不用审批（插件里设成直接放行），开着自动审查（`approvals_reviewer = "auto_review"`）时表单也是到你面前、不交给审查。不能交互的 `codex exec` 弹不出表单，确认不了。

### Antigravity

只接了桌面 App。装、换成新版、卸载：

```bash
npx gatelight setup antigravity
npx gatelight remove antigravity
```

`setup` 把插件复制到 `~/.gemini/config/plugins/gatelight/`，已经装着的换成这一版；那里是开发用的链接、或者是别的东西时不动。装好后新开一个对话生效。它不跑 `testpace install`，和另外两边一样，会话开始时说哪几条入口没放，你同意后再放。`remove` 只删插件目录，`~/.local/bin` 的入口留着（别的 agent 装着的 gatelight 还用它们）。

Antigravity 下的前提和不一样的地方（细节见 [Antigravity适配方案.md](Antigravity适配方案.md)）：

- **固定命令入口**：和 Codex 一样，命令都走 `~/.local/bin` 的入口，要跑一次 `testpace install`。
- **在沙箱外跑**：Antigravity 的终端沙箱里看不见各 agent 的插件目录，入口找不到插件，会说"多半是在沙箱里"，让 agent 申请在沙箱外跑。
- **确认工具**：要你同意的改动在 Antigravity 自己的确认弹窗里给你看（"总是允许"选不了，每次都问），弹窗里换行会压成一段。
- **跑整组配置的命令之前**：Antigravity 的钩子只能拒绝、不能只提示，所以同一段提示一个对话只拦一次，第二次照样放行。
- 改文件之前的拦截、会话开始的说明照常有；停止门只在 agent 正常说完话时管（用户取消、出错的不拦）；命令跑完之后的检查没有（它的钩子拿不到命令的输出）。

### 之后

装好后开新会话。新建的项目（提交很少、还没有 `testpace.json` 的仓库），会话开始时 testpace 会提出接入，Claude 按接入说明配好，落地前跑全部检查和全部测试，不用你回答。老项目说"给这个项目接入 testpace"，Claude 先把它改造成新项目的样子再接入，只在有测试找不到办法跑、全部测试太久要取舍、要改业务代码时问你。合并门的钩子配在全局 git 配置里：会话开始时自动配上，只告诉你一声；你删掉后不会再自动配回去（要的话用 `testpace install`）。别的项目、新的 worktree 都不用再配，升级插件也不用重配。升级插件后，在已接入的项目里跑一次 `testpace verify <测试文件>...`，确认项目的命令还守着新的约定。

只装 gatelight 也能把关：合并门、停止门和其余命令都不依赖 layermap。但开发中没法按改动选测试，`focused` 每次都会建议跑整组。装上 layermap 后只跑和改动相关的测试。在一个整组要跑约 11 分钟的项目里，相关测试每次在 1 分钟以内到 5 分钟之间（只是这一个项目的实测）。

`focused` 调的是 `layermap check --json`（layermap 0.1.48 起），PATH 里要有 `layermap` 命令：Claude Code 里装上 layermap 插件并开新会话就有；Codex 和终端里还要跑一次 `npx layermap setup command`（见上面 Codex 的前提）。

## 项目约定

仓库根目录放 `testpace.json`，进版本库。字段、三条命令要做到什么、默认加上的测试检查（不留 `.only`、每个测试有断言）、接入步骤见 [plugin/skills/setup/SKILL.md](plugin/skills/setup/SKILL.md)：它随插件安装，是 `gatelight:setup` 技能；没有 `testpace.json` 时，命令的报错也指向这个文件。

`examples/sample` 是按约定建的最小示例项目。

## 测试写法（testcraft）

同一个插件里的另一部分，管 agent 怎么写测试。它不检查、不拦路，只做两件事：会话开始时把写测试的约定说给 agent（分支上开发时不写新测试、不改已有的测试，你说要合并时才写、交给一个子代理写；改到规则才写，修已定规则的 bug 先复现；要改已定的业务规则先问你，别的不问；已定的规则只留在测试里，合并时从设计文档里删掉，文档只写为什么这样定、否掉的做法、还没定的）；写不成测试的坑记成清单（`.testcraft/checklist/`），改动碰到了提醒 agent 按条目查一遍（`testcraft checklist`）。它没有"证明测试能抓错"、放水检查、改动记录、另一个 agent 复查这些环节：2026-11-20 全部删了，原因见 [测试写法方案.md](测试写法方案.md) 开头。

仓库里有 `.testcraft/` 目录才启用，没有的仓库里它不出声、不加检查。启用后 `testpace full` 在测试之前跑一次 `testcraft checklist`（只读文件，不跑测试），不用另外登记。接入步骤见 [plugin/skills/setup-testcraft/SKILL.md](plugin/skills/setup-testcraft/SKILL.md)（`gatelight:setup-testcraft` 技能），写测试的约定见 `gatelight:write-tests`。`examples/craft-sample` 是它的示例项目。

它原来是单独的 testcraft 插件，换成这一版时把旧插件卸掉（`claude plugin uninstall testcraft@testcraft`）。项目里以前留下的 `.testcraft/config.json` 和 `.testcraft/changes/` 现在没有东西读，可以删。

## 模块边界（modwall）

同一个插件里的第三项检查，管代码有没有越界：项目分成模块、共享层和装配层，要别的模块的能力只能走它的入口，模块之间不能成环，依赖方向不能反，代码文件要有归属；用 Postgres 的项目，数据库也按模块分 schema。代码里的 import 和调用来自 [layermap](https://github.com/coffeecoproject/layermap)（0.1.48 以上），没有它检查算没做完、不算通过。

仓库里有 `.modwall/` 目录才启用。启用后会话开始时说明模块列表和写法约定，agent 改没有归属的代码文件、或者要写进绕过入口的引用之前就被拦下，`testpace full` 在最前面跑一次 `modwall check`，不用另外登记。放宽规则（加例外、扩大共享层、删模块根目录、删配置等）要你在弹窗里同意，同意按项记。库里的现状由项目在整组里跑完迁移后用 `modwall db check --psql "<执行 SQL 的命令>"` 查；它查完交一条凭据，整组里没跑到、或没通过却被忽略了，整组算没过。接入步骤见 [plugin/skills/setup-modwall/SKILL.md](plugin/skills/setup-modwall/SKILL.md)（`gatelight:setup-modwall` 技能），写法约定见 `gatelight:modular`。`examples/wall-sample` 是它的示例项目。

它原来是单独的 modwall 插件，换成这一版时把旧插件卸掉：

```bash
claude plugin uninstall modwall@modwall
```

旧插件记在 `.git/modwall/` 下的通过记录、用户同意的记录不带过来：同意过的放宽项要重新同意一次。只接了 modwall、没接 testpace 的仓库，钩子不再管，只剩自己跑 `modwall check`。

## 代码规范（codekeep）

同一个插件里的第四项检查，管代码本身的规范：类型查得严不严、lint 和格式检查有没有跑、规范有没有被悄悄改松、提交里有没有密钥。只做程序判断得了的事，不让 AI 判断代码写得好不好。第一期只管 TypeScript、JavaScript，lint 只比 eslint。方案见 [代码规范方案.md](代码规范方案.md)。

仓库里有 `.codekeep/` 目录才启用。启用后会话开始时说明规范的约定（不改松规范，"这里不查"的注释要写理由，提交里不放密钥），`testpace full` 在测试之前跑一次 `codekeep check`，不用另外登记。它依次做：

- **配置**：`.codekeep/config.json` 写得对不对：`checks` 是规范检查的命令（直接写工具命令，不经过项目的脚本），`eslint` 写配置文件，`tsconfig` 写要比的 tsconfig，`prettier` 开着时比格式检查查哪些文件，`secrets` 开着时扫密钥，`styles` 写前端的主题文件和组件层目录。
- **改松要你同意**：和分叉点那一版比，规范改松了的（关规则、调高上限、文件不再被 lint、关严格类型选项、加忽略、改了检查命令，配了前端规则的还有改主题和组件层的样式等）要你在弹窗里同意，同意按项记；加规则、调严不问，首次接入不问。分叉点那一版算不出来的不当成没改松，也问。不用批量豁免，旧代码超标的改代码。
- **跑检查**：依次跑 `checks` 里的命令，一条没过就停。
- **扫密钥**：用 gitleaks 扫分叉点之后的提交和没提交的改动，输出里打码。没装 gitleaks 算没通过，说怎么装，不替你装。

- **前端规则**：有前端代码的项目，接入时照技能里的模板（`plugin/skills/setup-codekeep/frontend.eslint.mjs`，先做 React 加 antd）加 lint 规则：页面上不加无必要的说明文字；用了组件不在页面里写样式、写具体的值去补，具体的值只写在主题和组件层；这些文件里不能用注释就地关规则。方案见 [前端规范方案.md](前端规范方案.md)。

不在改文件时拦（lint 自己会报），也没有停止门（整组兜底）。接入步骤见 [plugin/skills/setup-codekeep/SKILL.md](plugin/skills/setup-codekeep/SKILL.md)（`gatelight:setup-codekeep` 技能）。

## 换成这一版要做的

**从这个仓库的市场换到 gatelight-marketplace**（0.18.0 起）。以前加的是 `coffeecoproject/gatelight`，插件从这个仓库的代码拿；以后从 npm 拿，发新版不再推送这个仓库。换一次市场（插件名还是 `gatelight@gatelight`，各仓库 `.git/testpace/` 下的记录都还在）：

```bash
claude plugin marketplace remove gatelight
claude plugin marketplace add coffeecoproject/gatelight-marketplace
claude plugin install gatelight@gatelight
```

Codex：

```bash
codex plugin marketplace remove gatelight
codex plugin marketplace add coffeecoproject/gatelight-marketplace
codex plugin add gatelight@gatelight
```

**从 testpace 插件换成 gatelight**（0.10.0 起）。插件换了名字，要卸掉旧的、装上新的：

```bash
claude plugin uninstall testpace@testpace
claude plugin marketplace remove testpace
claude plugin marketplace add coffeecoproject/gatelight
claude plugin install gatelight@gatelight
```

装好后开新会话。要知道的几处：

- 放过固定命令入口（`~/.local/bin/testpace`）的机器：旧入口按旧名字找插件，找不到。新会话一开始会自动换成新的；在那之前命令行的 `testpace` 用不了，合并门不检查。
- 技能的前缀从 `testpace:` 变成 `gatelight:`（`gatelight:merge`、`gatelight:setup` 等）。自己的说明文件（`CLAUDE.md`、`AGENTS.md`）里写了旧名字的，改一下。
- 确认工具还叫 `confirm_with_user`，但带插件名的完整名字变了（`mcp__plugin_gatelight_gatelight__confirm_with_user`）。权限设置里放行过旧名字的，换成新的。
- 各仓库 `.git/testpace/` 下的记录（整组通过记录、证明、同意过的项）都还在，不用重来。会话碰过哪些仓库的记录在插件自己的数据目录里，不带过来，新会话重新记。

整组里的检查现在随插件一起装，不再靠在本机登记（全局 git 配置 `testpace.check`）。这一版不读那项配置，留着也不起作用；旧的 testcraft、modwall 插件登记过的，可以清掉：

```bash
git config --global --unset-all testpace.check
```

## 开发节奏

- 每个任务在自己的分支上做，最好是自己的 worktree，不和别的会话挤在同一个目录里。
- 开发中每做完一轮跑一次 `testpace focused`，只看不追：因为你这次改了需求才不过的测试留到合并时改；和这次需求无关的（这次的改动弄坏了别的功能）当场改这次写的代码，用 `testpace files 文件:行号` 只重跑那几个。分支上不跑整组。
- 整组在合回默认分支时跑：你说合，agent 先把这次的测试写上（接入了 testcraft 的），再把分支合到一个临时的合并分支上，跑一次 `testpace full`，通过了再快进默认分支。一个分支合一次，不攒。步骤见 [plugin/skills/merge/SKILL.md](plugin/skills/merge/SKILL.md)（`gatelight:merge` 技能）。
- 测试时好时坏，不靠重跑过关：testpace 认出来点名、记进名单，按 testcraft 写测试技能里"测试时好时坏"一节找原因修，修好后用 `testpace files --repeat 3` 连跑证明（见下面的时好时坏的测试）。

## 命令

| 命令 | 做什么 |
|---|---|
| `testpace focused [--base REF]` | 改完先跑：`fast`，再用 layermap 选出和改动相关的测试交给 `files` 跑（在分支上只跑这次改到的测试，加上最相关的几个，最多再跑 8 个文件：一样近的测试里，先取相关理由少有别的测试共用的，很多测试共用同一条理由的只留一个，凑不满 8 个就不凑；其余留给合并时的整组），并把选出的测试交回 layermap，问它们跑不跑得到每处改动。只从 `tests` 规则找到的测试里选（和整组一致）：规则外的不选，但点出是哪几个（是测试的话整组跑不到它，该补进规则），这次改到的规则内测试文件都选。默认对比和默认分支的分叉点，分支上已提交的改动也算。只改了 `ignore` 路径、规则外的测试或删掉了整组的测试时不跑测试。改了地图跟不到的文件（配置、依赖、迁移、模板、脚本、样式等，`ignore` 里的不算），没有 layermap 或它出错，没找到相关测试，或者选出的测试有跑不到的改动时，在默认分支上建议跑整组；在别的分支上只说明一句，不建议现在跑，合回默认分支时的整组会覆盖 |
| `testpace files [--repeat N] PATH[:行号]...` | 只跑给定的测试文件；`文件:行号` 只跑那一行的测试，比如重跑失败的测试（测试框架不能按行跑的，跑整个文件）。`--repeat N` 连跑 N 次、没过就停：用来造出时好时坏的测试的失败，或修好后连跑证明；每次各记一条运行记录，`report` 不把它们算成反复跑 |
| `testpace full` | 依次跑这个仓库接入了的检查（`modwall check`、`testcraft checklist`、`codekeep check`）、`full`（测试以外的检查），再把 `tests` 规则在工作区里找到的全部测试文件交给 `files`，一段没过就停。各段都过了，再按交回来的东西核对该跑到的跑到没有：交给 `files` 的每个测试文件都要交回至少一条结果（见 `testpace run`；不经它跑的自己往 `TESTPACE_RESULTS` 写），接入了 modwall、写了 `database` 的要交回 `modwall db check` 的凭据，缺了算整组没过、点名缺的是什么（项目的脚本里删掉一步，testpace 看不到脚本，靠这个查出来）；按跑的那一刻工作区的完整内容（含未提交、未跟踪的文件）记录结果。同一份代码已经通过的不重跑；相对通过的代码只改了 `ignore` 路径也不重跑（`testpace.json` 自己不算忽略路径，改了它要重跑）。跑的过程中代码改过，通过也不算记录，输出里列出变了的文件 |
| `testpace status` | 当前代码有没有整组通过记录、有没有正在跑的整组、最近一次结果、时好时坏的测试名单（各自怎么认出来的、两次的日志）、配置检查（含 `tests` 规则找到多少个测试文件）、合并门和固定命令入口在不在、有没有 layermap |
| `testpace hold PID 说明`<br>`testpace release ID` | 借用这个工作区（只占这个工作区，别的工作区不管），给要复制或接着用工作区的工具用，比如要建一份副本的工具：跑到一半的状态（锁文件、临时文件）会一起带进副本。查有没有在跑的和占上是同一步，问完到用完之间不会有新起的命令插进来。占着时别的 testpace 命令（`fast`、`files`、`full`、`verify`）不跑，说明是谁占着（`说明` 里写的）、等它放开再跑。`PID` 是借用的那个进程（一般是调用者自己，要是还在的进程，不在的报用法错）：它不在了（被杀、崩了），占用跟着作废，不会把工作区永远锁住。占上时输出这次的 id，退出码 0，用完用 `testpace release ID` 放开（只放借用的，跑着的命令放不开）；有在跑的、已经被借用着的，不占，说明是谁（testpace 被强杀后测试进程组还在跑的，给出停掉它的命令），退出码 3。`testpace full` 只给要建副本的检查（`testcraft check`）在环境变量 `TESTPACE_RUN` 里带上这一轮的运行 id：它在测试之前跑，工作区已经是这一轮的，在里面借用不另占、什么也不输出，退出码 0。别的项目命令（`fast`、`files`、`full` 和整组跑测试的那一段）不带，testpace 起项目命令时去掉从外面继承来的 `TESTPACE_RUN`，`testpace run` 也不把它交给跑测试的进程：测试里借用照样被挡，同一轮别的测试可能正拿着锁 |
| `testpace report [--days N]` | 计时诊断：各命令次数和耗时、有几个 agent 跑过时按谁跑的分开的次数和耗时、整组的时间花在哪一段（各项检查、`full`、全部测试各跑到几次、平均、合计、占比）、平均每次落地的测试耗时和整组次数、失败后重跑轮数、同一份代码整组先失败后通过的（可能是测试不稳定，也可能是环境问题，列出失败用时和日志供分辨）、`fast` 是否过慢、按周的测试行数和整组耗时 |
| `testpace verify [测试文件...]` | 核对这个项目的接入守不守约定，由程序实际去跑，不靠 agent 说检查过了：`testpace.json` 没写坏、三条命令找得到、合并门在把关、`files` 给了不存在的文件要失败；给了测试文件时，逐个核对它在 `tests` 规则里（整组跑得到它这一类）、能通过、混进不存在的路径要失败、`文件:行号` 和 `文件:行号:列号` 能用，给了几个时再核对它们一起交给 `files` 能通过。项目里的测试交给不同工具或配置跑的（比如前端用 Vitest、接口用 node:test），每种各给一个文件。`tests` 规则一个都找不到算没通过。整组太长不在这里跑。这几次运行不记进报告。接入时和升级 testpace 后各跑一次 |
| `testpace run node-test [--cwd 目录] [--node-arg 参数]... 文件[:行号[:列号]]...`<br>`testpace run vitest [--cwd 目录] [--vitest-arg 参数]... 文件[:行号[:列号]]...`<br>`testpace run playwright [--cwd 目录] [--playwright-arg 参数]... 文件[:行号[:列号]]...` | 写在 `testpace.json` 的 `files` 里，或项目的 `files` 脚本里：用项目的测试框架跑测试文件，守 `files` 的约定，项目不用自己写这层包装。文件不存在、不是文件时退出码 2。逐个核对给的文件和 `文件:行号`：整个文件给的看这个文件的测试，按行给的看这一行选中的测试（测试自己，或它外层哪一级分组声明在这一行，三个框架按行跑都这么选）；一个测试都没跑到（文件没加载起来、里面没有测试、给的行上没有测试、文件被项目配置排除了，哪怕框架照样通过，比如 Playwright 只要别的行有测试就通过）时失败，这次已有测试没过的，另提醒框架可能提前停下了（bail、max-failures、依赖的准备项目没过）；选中的测试全被跳过时说一句，不算失败；框架在选测试之前就停了（参数不认、配置写错）时不核对，用它的退出码；框架还跑了没给的文件（Vitest、Playwright 把文件参数当名字片段，Playwright 先跑给的测试依赖的准备项目）时说一句，那些文件里的测试不算给的。`node-test` 用 PATH 上的 node，不加 `--test-only`，留着的 `.only` 不起作用；不能按行跑，按行给的整个文件跑，说一句，跑完照样核对那一行。`vitest`、`playwright` 用 `--cwd` 目录里装的 Vitest、`@playwright/test`，按行给的交给它们按行跑，项目配置里的报告器照常起作用：`vitest` 经插件的启动脚本调 Vitest 导出的 `startVitest`（命令行也是调它）照 `vitest run` 跑（不支持 `--watch`、`--ui` 这类另起分支的参数，Vitest 5 起不认的参数和命令行一样报错），跑完从它的状态里读结果；`playwright` 的计数报告器经 `PW_TEST_REPORTER` 加在项目配置的报告器后面，路径按正则转义后交给它。`--cwd` 换框架的工作目录（文件仍按当前目录算），`--node-arg`、`--vitest-arg`、`--playwright-arg` 原样交给框架，可以给几次。框架起在自己的进程组里，被中断时给整个组发 SIGINT（跑测试的子进程一起收到），8 秒还没退就强杀。由 `files`、`focused`、`full` 起的，把每个测试的结果（文件、行号、带外层分组的名字、过没过、是不是框架重试后才过）交回给 testpace，见下面的时好时坏的测试；交结果的位置（环境变量 `TESTPACE_RESULTS`）不传给跑测试的进程。testpace 跑项目命令时把自己的命令目录放在 PATH 最前面，命令和脚本里调的 `testpace` 就是正在跑的这一版 |
| `testpace install` | 在全局 git 配置（`git config --global`）里配上合并门的钩子：`hook.testpace.event = reference-transaction` 和 `hook.testpace.command`。这台机器配一次，所有仓库、所有工作区生效；不往仓库里写文件，也不影响项目自己的钩子（`core.hooksPath`、husky 这些照常跑）。钩子命令只把引用更新转交给 `testpace gate`，规则都在 testpace 里。git 太旧（不认配置里声明的钩子）时不配，说明要升级 git。同时在 `~/.local/bin` 放上 `testpace`、`modwall`、`testcraft`、`codekeep` 的固定命令入口（见安装的 Codex 一节）；哪个名字那里已经有别的文件就不覆盖它，其余的照放 |

同一个工作区一次只跑一轮测试：`focused`、`files`、`full` 发现这个工作区已经有 testpace 的命令在跑时直接退出，不抢端口、测试库这些资源。testpace 被强杀后测试进程还在跑的，照样算在跑，提示里给出停掉它的命令。`files` 的路径按当前目录算。

退出码：0 通过；1 失败或没得到通过记录（`verify`：有没通过的项）；2 用法或配置问题（`install` 时 git 太旧，或配好了但在这个仓库里没有生效；`verify` 时 `testpace.json` 有问题或给的文件不存在）；3 这个工作区已有测试在跑或被借用着（`hold`：占不上），或别的工作区在跑同一份代码的整组；4 跑了的都通过，但选测靠不住、建议跑整组；130 被中断。

## 时好时坏的测试

经 `testpace run` 跑的测试，testpace 记得每次是哪几个没过（运行记录的 `failed`，按文件和带外层分组的名字认同一个测试，改了别处、行号变了也认得出；Vitest、Playwright 的 project 有名字时名字前带 `[project 名]`，各算一个）。一次运行里同一个名字既有过的又有没过的（同名测试、`repeatEach` 的拷贝），分不清是哪个，不算。项目没经 `testpace run` 跑的测试交不回结果，下面这些都不做。

- **认出时好时坏**：同一份代码（不管在哪个工作区；两次都要跑的过程中代码没改过）上，一个测试以前没过、这次过了；`--repeat` 连跑时前面过了、后面没过；框架重试之后才过（Vitest 的 `retry`、Playwright 的 `retries`）。记进名单（所有工作区共用），在那次运行的输出里点名：不要靠重跑过关，按 testcraft 的规矩找原因修，和手上的活无关的告诉用户。
- **哪里列出名单**：`testpace status`，会话开始时的说明。不拦合并：时好时坏的测试常和手上的改动无关，拦住合并所有分支都得停下等它。
- **从名单上去掉**：连跑过程中代码一直没改，`testpace files --repeat 3` 连跑 3 次它每次都过（测试写了没被 `.gitignore` 忽略的文件、工作区变了的，不算，输出里说一句）；或者在认出它的工作区里（那个工作区删了的话在哪都行）整个跑了它的文件、全部通过，文件里却已经没有这个测试（删掉或改了名；所在的组整个被跳过的不算）。别的工作区的代码可能还没有这个测试，不算。去掉时输出里说一句。
- 不同工作区里被 `.gitignore` 忽略的东西（`node_modules`、构建产物、`.env`）可能不一样：新开的工作区缺了它们没过、在别处过了，也会被认成时好时坏。看日志能分出来。
- **几轮没过**：同一个工作区里，同一个测试改了代码再跑还没过算一轮，代码没改只是重跑不算，过了清零。到第 3 轮起，输出里让 agent 停下来，把失败原因和这几轮各改了什么告诉用户，等用户决定。只提醒，不拦。

## 把关

只对接入了约定（有 `testpace.json`）的仓库起作用，只作用于 agent 的命令，用户自己在终端里的操作不受影响。

接入与否分两处看：

- 合并门、停止门判断落到默认分支的代码时，看**提交里**的 `testpace.json`，不看工作区里的文件：默认分支现在的代码里有它，或要落地的代码里有它，就管；`ignore` 只认要落地的那份代码和默认分支上原来那份里都有的规则。工作区里没提交的改动（删了、写坏了、改了 `ignore`）不影响判断。
- 会话说明、停止门拦不拦、各条命令，看**工作区根目录**有没有 `testpace.json`。写坏了也算接入：会话开始时照样说明节奏并讲出问题，`testpace status` 给出原因。

通过记录只在 `testpace.json` 相同的代码之间沿用，所以改约定（包括改 `ignore`）的提交要在改完的代码上跑过整组才能落地。

改约定来放松把关有两条管法，一次改动改不了评判它自己的检查：

- **`ignore` 合并后才生效**。分支上新加的规则，这次改动自己用不上：落到默认分支以后才认。删掉的规则马上生效。`testpace status` 会列出哪些还没生效。
- **三条命令和 `tests` 规则要你同意**。和分叉点上的比，改了 `fast`、`files`、`full`，或者缩小了 `tests` 规则（去掉一条找测试的规则、多加一条排除），`testpace full` 先不跑，让 agent 调确认工具弹窗给你看原来是什么、现在是什么，你同意了才跑。多加一条找测试的规则、去掉一条排除是加严，不问。它们调到的脚本改了不在这里问：启用了 testcraft 的仓库里要写理由。
提交里的 `testpace.json` 写坏了（`testpace full` 跑不了）的代码拿不到通过记录，合并门拦下时说出坏在哪。删掉 `testpace.json` 的代码也拿不到：退出接入由用户自己在终端里提交；接入之前分出去、本来就没有它的分支，把默认分支合进来再测。

- **合并门**（git 的 `reference-transaction` 钩子，会话开始时自动配在全局 git 配置里，也可以用 `testpace install`）：agent 的 git 命令要移动本地默认分支时，git 把分支要指向的提交交给 `testpace gate`；那份代码没有 `testpace full` 通过的记录，git 就取消这次更新，默认分支不动，并说明原因。
  - 按实际要落地的提交判断，不管命令怎么写：`commit`、`merge`、`cherry-pick`、`rebase`、`reset`、包了一层的写法、脚本里的 git 都一样。
  - 退回默认分支以前的提交、快进到远程默认分支已有的提交（同步远程）不算新落地。工作分支上的提交不管。
  - "远程已有"按远程跟踪分支（`refs/remotes/<远程>/<默认分支>`）认，包括同一次更新里它的新位置。同步远程用 `git pull`、`git fetch <远程> main:main`，或先 `git fetch <远程>` 再快进。`git fetch <路径或 URL> main:main` 不经过远程跟踪分支，照样拦。
  - 被拦下后，工作区和暂存区里可能留着这次操作带来的改动；停在半路的 `cherry-pick`、`rebase` 要先 `--abort`。
  - 不经过本地默认分支的落地不拦：推送别的分支到默认分支（`git push origin 分支:main`）、在 GitHub 上合并 PR。停止门事后提示。
  - 钩子在所有仓库里都跑：没有分支要动（只是远程跟踪分支、`HEAD`）时什么都不做；有分支要动时调用一次 `testpace gate`，没接入 testpace 的仓库直接放行。
  - 只有 `testpace gate` 明确拒绝才拦。没得到检查结论的都不挡：会话里找不到 `testpace` 命令（插件没启用、Codex 里没放固定命令入口）、插件没装全、找不到够新的 node、会话里是旧版本的 testpace，在接入了 testpace 的仓库里说一句，附上 testpace 的输出。插件更新后，开着的会话要重开才换成新版本。`gate` 已经在检查、却确认不了要落地的代码测过时照样拦。
  - 钩子命令里记着是哪一版 testpace 配的。Claude Code 和 Codex 装的版本不同时，会话开始的自动更新只升不降，不来回覆盖。
  - 合并门没配、配的命令是更旧版本的、被仓库自己的配置关掉（`hook.testpace.enabled = false`）、git 太旧，或找不到默认分支（没有 `origin/HEAD`，本地和 origin 上也没有 `main`、`master`）时，`testpace status` 和会话开始时的说明会讲出来。找不到默认分支时，agent 的命令建出了 `main` 或 `master`（比如没有远程的仓库把 `main` 删了再建）、那份代码又没有整组通过记录的，不拦，当场说一句这次没有检查。
- **整组跑全部测试**：测试由 testpace 按 `tests` 规则自己找，交给 `files` 跑，不靠谁记得把新测试加进整组。放松整组的办法（改 `full`、`tests` 规则）要你同意，见上面。
- **整组里的检查**：仓库里有 `.modwall/`、`.testcraft/`、`.codekeep/` 时，`testpace full` 先跑 `modwall check`、`testcraft checklist`、`codekeep check`，再跑 `full` 和全部测试：检查便宜，有一段没过就不往下跑、不算整组通过，合并门照常拦。它们随插件一起装，不在仓库里也不在本机配置里登记；分支上删掉 `.modwall/`、`.testcraft/`、`.codekeep/` 躲不过（默认分支上有就算接入）。
- **用户确认**（确认工具 `confirm_with_user`）：要你同意的改动，检查把它们按编号存好，agent 调这个工具弹窗给你看，你点了同意才记下；agent 自己说"用户同意了"不算。同意按项记（哪项检查的、改之前是什么、改成什么、你看到的文字），同意过的那一项没再变就不再问。
- **停止门**（agent 的 Stop hook）：启用了 modwall 的仓库里，这个会话改了代码或配置、当前内容却没有 `modwall check` 的通过记录，同一份内容拦一次（架构要严：越界在分支上就查出来，不等到合并）。这个会话起的整组（按 agent 给命令带的会话号认，别的会话和终端里起的不算）还在跑，或这个会话还没看过结果（`testpace status`，或在前台等到了 `testpace full` 的输出，通过、失败都算），拦一次。每次整组只拦一次（还在跑时一次、跑完没看结果时一次），拦过的记在会话状态里。本地默认分支或 `origin` 上的默认分支在会话里有了没有通过记录的提交时，提示用户。会话从仓库外开始的，也查它碰过的仓库。
- **改文件之前**（agent 的 hook，在 Claude Code、Antigravity 里；Codex 改文件用补丁，钩子只记下改到哪，不在这一步检查）：启用了 modwall 的仓库里，agent 要新建或修改一个没有归属的代码文件时直接拒绝，附上该放哪；要写进文件的新文字里用相对路径直接引用了别的模块的内部文件（TypeScript、JavaScript），也直接拒绝，附上改法。只看路径；用命令行改文件绕得过这一步，结束前和合并前的 `modwall check` 照样查出来。
- **软提示**（agent 的 hook）：会话开始时说明测试节奏（上一节），会话从仓库外开始的，第一次在仓库里执行命令时补说，压缩、恢复后再说一次；agent 直接跑 `full` 配置的命令时，提示它只是整组的一部分、不留记录，改用 `testpace full`。

记录放在仓库的 `.git/testpace/`（所有 worktree、Claude Code 和 Codex 共用）：`runs.jsonl` 每次运行一行（记着哪个 agent、哪一版 testpace 跑的），`logs/` 是完整输出，`running/` 是每个工作区正在跑的命令（或借用着它的工具），`sessions/` 是各会话的状态，`flaky/` 是时好时坏的测试名单（一个测试一份），`rounds/` 是各工作区里测试连着几轮没过，`confirm/` 是等你确认的和你同意过的，`craft/` 是 testcraft 的证明、放水检查记录，`wall/` 是 modwall 的通过记录。

## 开发

需要 Node 22.18 以上（直接运行 TypeScript，不需要构建）和 git 2.54 以上（PATH 里排在前面的那个；合并门的测试要用）。测试用自己的全局 git 配置，不读也不改 `~/.gitconfig`。

这个仓库自己也接入了 testpace（`testpace.json`）：先 `npm install`，改完跑 `testpace focused`，合回 main 前跑 `testpace full`。`fast`、`full` 是类型检查加 lint（lint 查每个测试都有断言，和源码里模块的边界：底座不引用检查模块，检查模块之间不互相引用），`files` 是 `testpace run node-test`：用的是跑整组的那个 testpace（本机装的），不是仓库里正在改的这一版，正在改的跑法要是坏了（比如吞掉失败），不会连整组的结论一起带坏。`testpace run` 自己的测试另外调仓库里这一版（`plugin/bin/testpace`）。

```bash
testpace focused
```

本机开发时，Claude Code、Codex 把这个仓库的主目录加成本地市场（`claude plugin marketplace add <仓库目录>`、`codex plugin marketplace add <仓库目录>`），插件从 `plugin/` 拿：Claude Code 当场读目录，main 一快进就是新代码。Antigravity 在 `~/.gemini/config/plugins/gatelight` 放一个指向仓库 `plugin/` 的链接（`npx gatelight setup` 不动它）。

发版：插件清单（三份）和 `plugin/package.json` 的版本一起升，在 `plugin/` 里 `npm publish`。npm 先暂存，几分钟后才能装到。gatelight-marketplace 不写版本，不用改。装法的来由和实测见 [安装方案.md](安装方案.md)。
