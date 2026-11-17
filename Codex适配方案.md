# testpace 适配 Codex 方案

2026-11-17 · 第二版。第一版（2026-11-16）基于本机 Codex 0.167.0 的实测和已装插件（smartcompact、twin、layermap 的 Codex 版）；第二版按对照代码的评审修订，并留出 DeepSeek Harness（dsh）的口子。

## 0. 结论

- 能做。Codex 有插件、技能和 hook，hook 的写法和 Claude Code 很接近（smartcompact 的 Codex 版就是同一种 `hookSpecificOutput.additionalContext`）。
- 一套代码，两份插件清单：规则全在 testpace 里，Codex 只多一层入口和 hook 适配，不复制逻辑。
- 最大的障碍是 Codex 沙箱：工作区可写的沙箱（Auto 和你现在的 no-twin 都是）不让写 `.git`。testpace 要写 `.git/testpace/`，git 提交也要写 `.git`，所以 testpace 的命令在 Codex 里必须在沙箱外跑。默认每次提权、交给自动审查；放行规则只作为可选项（2.3）。
- 第二个障碍是 PATH：Codex 不把插件的 `bin/` 加进 PATH，testpace、layermap 在 Codex 的命令里都找不到；合并门的 git 钩子也靠 PATH 找 testpace。
- hook 自己可能也在沙箱里：会话开始和工具调用前的 hook 都要写 `.git/testpace/`、全局 git 配置和数据目录，被拦了现在是一声不响。
- 动手前先实测 7 件事（第 3 节），其中"提权后的命令还带不带 `CODEX_THREAD_ID`、`CODEX_SANDBOX`"决定合并门能不能认出 Codex、沙箱判断能不能成立。

## 1. 已确认的事实

| 项目 | 实测结果 |
|---|---|
| 命令里的环境变量 | 有 `CODEX_THREAD_ID`、`CODEX_SESSION_ID`（同值）、`CODEX_SANDBOX=seatbelt`、`CODEX_CI=1`；没有 `CLAUDECODE` |
| PATH | 没有任何插件的 `bin/`；有 `~/.local/bin` |
| 沙箱（no-twin、`:workspace`、`workspace-write` 三种都一样） | 写工作区可以；写 `.git` 被拒；git commit 失败；写 `~` 被拒 |
| 沙箱放行 `/tmp` | 仓库放在 `/tmp` 下时，带着 `CODEX_SANDBOX=seatbelt` 也能写 `.git`：能写记录目录不代表在沙箱外 |
| 插件 | `codex plugin` 支持本地和 git 来源的 marketplace；清单是 `.codex-plugin/plugin.json`，marketplace 是 `.agents/plugins/marketplace.json` |
| hook 事件 | 本机插件用到的：SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd、PostCompact；hook 命令里用 `${PLUGIN_ROOT}` |
| hook 环境 | 不保证有能跑 TypeScript 的 node；smartcompact 用 `hook.sh` 依次找 nvm、Homebrew 里 22.18 以上的 node |
| 命令放行规则 | `~/.codex/rules/default.rules` 里可以写 `prefix_rule(pattern=[...], decision="allow")` |

代码里和适配有关的现状：

| 位置 | 现状 |
|---|---|
| `store.claim()`（`repo.ts:104`、`cli.ts` 的 `full`） | 跑测试之前先写 `.git/testpace/running/`；写不了就直接报错，测试不跑，不留记录 |
| `cli.ts:326`（`status`） | 按命令环境里的 `CLAUDE_CODE_SESSION_ID` 记下"这个会话看过整组结果" |
| `hook.ts:161` → `stop.ts` | 停止门"只拦一次"靠 hook 输入的 `stop_hook_active` |
| `hook.ts` 工具调用前 | 管三件事：直接跑 `full` 的提醒；会话从仓库外开始时第一次碰到接入的仓库补说节奏；记下会话起点（默认分支当时的位置，停止门查"默认分支落了没测过的代码"靠它） |
| `hooks/testpace.ts` | 出错时只写 stderr、退出码 0，agent 和用户都看不到 |
| `bin/testpace` | 直接调 `node`，要 22.18 以上才能跑 TypeScript |

## 2. 要改的地方

### 2.1 打包和安装

- `plugin/.codex-plugin/plugin.json`：名字、版本、`hooks` 指向 Codex 版的 hooks 清单、`skills`。
- 仓库根目录 `.agents/plugins/marketplace.json`：来源 `./plugin`。
- 版本号两份清单一起升；`tools/` 里加一条检查两边版本一致。
- 安装：`codex plugin marketplace add coffeecoproject/testpace`，再 `codex plugin add testpace`。第一次用时 Codex 会要求信任插件的 hook。
- 节奏说明和技能里写的是 `testpace:merge`、`testpace:setup`，Codex 里插件技能怎么称呼要核对（第 3 节），不一样就按 agent 换说法。

### 2.2 命令入口（PATH）

Codex 里 agent 要能直接打 `testpace`，合并门的 git 钩子也要找得到它。插件安装目录随版本变（缓存目录带版本号），不能把路径写死进 git 配置。

建议：放一个固定的小入口 `~/.local/bin/testpace`（Codex 和终端的 PATH 里都有这个目录）。它不带版本，运行时：

- 找当前装着的 testpace：Claude Code 和 Codex 都装了时挑版本最高的那份，不按 agent 定先后；都找不到就按"插件没启用"处理。
- 找 22.18 以上的 node：git 钩子和 Codex 命令的环境里不一定有，和 `codex.sh` 共用同一段找法（照 smartcompact 的 `hook.sh`）。

`testpace install` 和会话开始时的自动配置一起负责放它。

这是全局安装，**要你定**（第 4 节）。不这样做的替代办法：会话开始时把 testpace 的完整路径告诉 agent，合并门在 Codex 里找不到 testpace 就不挡，等于 Codex 下没有合并门。

layermap 的 `layermap` 命令在 Codex 里同样找不到，`focused` 会退回"建议跑整组"。这是 layermap 那边的事，用同样的办法解决，在那个仓库另做。

### 2.3 沙箱

testpace 的命令要在沙箱外跑：要写 `.git/testpace/`，项目的测试也常要起服务、开端口、用浏览器。

默认：每次提权，交给你配好的自动审查。git 提交本来就要提权，不另加规则。

可选：在 `~/.codex/rules/default.rules` 加 `prefix_rule(pattern=["testpace"], decision="allow")`，让 testpace 的命令不用每次申请（要先实测 `allow` 的命令是不是在沙箱外跑）。风险要写清楚：

- 放行 testpace 等于放行 `testpace.json` 里的任何命令、`files` 的参数和全局 git 配置里的附加检查。agent 先改 `testpace.json` 再跑 `testpace focused`，任何命令都能不经审批在沙箱外跑。
- 即使每次提权，审查看到的也只是 `testpace full`，看不到它实际会跑什么。这条在默认做法下同样存在。

### 2.4 合并门

- 钩子命令现在只看 `CLAUDECODE`，改成 `CLAUDECODE` 或 `CODEX_THREAD_ID` 有一个就管（以后加 dsh 时再加 `DSH_SHELL`）。
- 钩子命令里带上 testpace 的版本号，自动更新只升不降（2.8 第 3 条）。
- 这会改 `HOOK_COMMAND`，已配好的机器上 `testpace status` 会报"不是这一版的"，会话开始时自动更新，和现在升级的流程一样。
- 前提是提权后的 git 命令里还有 `CODEX_THREAD_ID`（第 3 节第 1 条）。

### 2.5 hook 适配

新增 `plugin/hooks/codex.json` 和 `plugin/hooks/codex.sh`（照 smartcompact 找 node），调用同一个 `hooks/testpace.ts`，入口参数说明是哪个 agent。hook 不靠环境变量认 agent。

`hook.ts` 的判断不变，只在入口和出口转换：

- **会话号**：Codex 的 hook 输入里的 `session_id`，要确认和命令里的 `CODEX_THREAD_ID` 是同一个值。
- **工具名和命令字段**：转换层统一成现在的 `Bash` 和 `command`（各家叫法不同，dsh 是小写的 `bash`）。
- **会话开始说明**：同样的 `additionalContext`。
- **工具调用前的三件事**（第 1 节）：Codex 有工具调用前的 hook 就照搬；没有的话，补说节奏和记下会话起点改由 UserPromptSubmit 做，直接跑 `full` 的提醒放弃。
- **"看过整组结果"**：Codex 下不靠工具调用后的 hook，靠 `testpace status`（`cli.ts:326` 已经按命令环境里的会话号记下），会话号换成从认 agent 的模块取。节奏说明写成"跑完用 `testpace status` 看结果"。
- **停止门只拦一次**：不再靠 hook 输入的 `stop_hook_active`（dsh 永远传 false，Codex 有没有要实测），改成停止门自己记"这个会话为这次整组拦过了"，Claude Code 也一起换成这个，去掉对 `stop_hook_active` 的依赖。
- **停止门能不能拦**：Codex 的 Stop 支不支持 `decision: block` 要实测；不能拦就只提示。
- **给用户的提示**：合并门自动配好的通知、默认分支落了没测过的代码的提醒都走 `systemMessage`。Codex 显不显示要核对；不显示就改成在给 agent 的说明里请它转告用户。
- **hook 出错**：不能再一声不响，至少输出一句能看到的诊断（走哪个字段按实测定）。Claude Code 下一样。

命令里认会话：`cli.ts` 现在读 `CLAUDE_CODE_SESSION_ID`，改成从认 agent 的模块取（2.8）。

### 2.6 会话记录

`sessions.ts` 存在 `CLAUDE_PLUGIN_DATA` 下。实测 Codex 也给 hook 这个变量（`~/.codex/plugins/data/testpace-testpace`），两边都用它（第 7 节）。

### 2.7 说明、技能和整组的跑法

- 节奏说明和两个技能里的"放后台（run_in_background）"是 Claude Code 的说法。改成两边通用的："整组要跑几分钟，不要干等，跑完用 `testpace status` 看结果"。
- 整组在 Codex 里怎么起，看第 3 节第 5 条的实测：前台能跑完就前台跑；会超时被杀的话，给 `testpace full` 加一种"起完立刻返回、在后台跑完"的跑法，结果用 `testpace status` 看，Claude Code 下也能用。
- Codex 下的说明加一句：testpace 的命令要在沙箱外跑。
- README 删掉"Codex 等其他 agent 的提交不会被拦"，改成两边各自怎么装、各自的前提。

### 2.8 和 Claude Code 共用结果，防止互相污染

结果不分开存。通过记录按代码内容记：同一份代码、同一份 `testpace.json`、同一套命令，谁跑的都是同一个证明。分开存会让 Claude 测过的代码到 Codex 合并时重跑，合并门也要查两处。同一个工作区"一次只跑一轮"的锁也要共用，才能防止两边同时跑整组、抢端口和测试库。会话记录本来就分开：存放目录不同（2.6），会话号也不会撞。

要防的是这 6 处边界：

1. **沙箱里跑测试**：仓库在 `.git` 不可写的位置时，`claim()` 先写记录目录就会失败，测试不跑也不留记录，问题只是报错是一句看不懂的写入被拒。但仓库在沙箱放行的位置（比如 `/tmp`）时，记录目录写得进去，测试会在沙箱里跑，可能因为端口、网络被拒跑出假失败，记进去后 `report` 会把"先失败后通过"误判成不稳定。办法：两样都看。带 `CODEX_SANDBOX` 就拒跑，说明要在沙箱外跑，什么都不记；写不了记录目录时也说清楚原因。前提是提权后的命令不带 `CODEX_SANDBOX`（第 3 节第 1 条），带的话要另找判断办法。
2. **认错 agent**：Codex 从 Claude Code 里启动时，会继承 `CLAUDECODE` 和 Claude 的会话号（第一次实测就是这样被污染的），记录会被算到 Claude 的会话头上，停止门也会认错。办法：Codex 优先，有 `CODEX_THREAD_ID` 就算 Codex，会话号也取它，不看继承来的 `CLAUDE_CODE_SESSION_ID`。光看环境变量分不出嵌套顺序，Claude Code 从 Codex 里启动时会被认成 Codex，算已知限制。hook 由入口参数说明是哪个 agent，不受影响。
3. **两个版本来回改全局钩子**：会话开始时，发现合并门钩子"不是这一版的"就不打招呼地重装（`gate.ts` 的 `ensureGate`）。Claude 和 Codex 装的 testpace 版本不同时，两边每次开会话都把全局 git 配置改成自己那一版，来回覆盖。办法：两份清单一起发版、版本一致；钩子命令里带上版本号，自动更新只升不降。
4. **新旧版本共写一份记录**：两边版本不同时会读写同一份 `runs.jsonl` 和 `running/`。记录格式要能新旧互读：认不出的字段留着不动，缺的字段按默认值算，不因为对方版本写的一行而读坏整份。
5. **统计混在一起**：两个 agent 的耗时、重跑轮数混在同一份 `report` 里，分不出谁慢。办法：运行记录加上跑的 agent 和 testpace 版本，`report` 可以按 agent 分开看，存储仍然是一份。
6. **环境变量不同**：Codex 给命令带 `CODEX_CI=1`。个别工具可能因此按 CI 模式运行，同一份代码在两边跑出不同结果。第 3 节实测时一起核对。

代码上的分离：

- 新加一个专门判断"当前在哪个 agent 里"的模块：认出是 Claude、Codex 还是以后的 dsh（`DSH_SHELL`、`DSH_SESSION_ID`，从 Claude 里启动时同样继承 `CLAUDECODE`），取会话号、找数据目录、看是不是在沙箱里。非 Claude 的 agent 标记优先于 `CLAUDECODE`。
- 现在散在 `cli.ts`（`CLAUDE_CODE_SESSION_ID`）、`sessions.ts`（`CLAUDE_PLUGIN_DATA`）和合并门钩子命令（`CLAUDECODE`）里的判断，都改成调用这个模块。
- Codex 的 hook 入口和格式转换放在单独的适配层（2.5），判断规则不分叉。

## 3. 动手前先实测

每条都用一个只读的小任务在 Codex 里跑，会调用模型。各种 hook 的真实输入都录下来，留作单元测试的数据。

1. **提权后的命令带不带 `CODEX_THREAD_ID`、`CODEX_SANDBOX`**：前者决定合并门能不能认出 Codex，不带的话要另找办法（比如让 Codex 的会话开始 hook 写一个标记）；后者决定 2.8 第 1 条的沙箱判断能不能成立。
2. **`prefix_rule` 的 `allow` 是否在沙箱外跑**：只在你选了可选的放行规则时有用（2.3）。
3. **hook 在不在沙箱里**：能不能写仓库的 `.git/testpace/`、全局 git 配置、`$CODEX_HOME`。不能的话，会话开始的记录和合并门自动配置都要换地方做。
4. **Codex hook 的细节**：
   - 有没有工具调用前的 hook；工具名、命令字段；
   - Stop 能不能拦（`decision: block`），输入里有没有 `stop_hook_active`；
   - `session_id` 和 `CODEX_THREAD_ID` 是不是同一个值；
   - `systemMessage` 显不显示给用户；hook 出错时什么能被看到。
5. **长命令**：Codex 前台跑 `testpace full`（几分钟到十几分钟）会不会超时、超时后进程会不会被杀（2.7）。
6. **`CODEX_CI=1` 的影响**：在已接入的项目里，对比带和不带这个变量时 `testpace files` 的行为（2.8 第 6 条）。
7. **技能的称呼**：Codex 里插件技能怎么引用，节奏说明里的 `testpace:merge`、`testpace:setup` 要不要换说法。

## 4. 要你定的事

1. **放不放 `~/.local/bin/testpace` 这个固定入口**（全局安装）。不放，Codex 下就没有合并门。
2. **放不放 `testpace` 的命令放行规则**（改 `~/.codex/rules/default.rules`）。默认不放、每次提权交给自动审查；放了省去每次申请，但等于放行 `testpace.json` 里的任何命令（2.3）。
3. **layermap 的 Codex 命令入口**：另在 layermap 仓库做，还是先不做（Codex 下 `focused` 只会建议跑整组）。

## 5. 步骤和验收

1. 第 3 节的实测，结果写回本文，hook 的真实输入存成测试数据。
2. 新加判断"当前在哪个 agent 里"的模块，原来散在各处的 `CLAUDE_*` 判断都改成调用它。在这个基础上：
   - 合并门认 Codex，钩子命令带版本号、只升不降；
   - 命令认 Codex 的会话号，会话记录改存放目录；
   - 沙箱里拒跑，写不了记录目录时说清楚原因；
   - 运行记录带上 agent 和版本，新旧版本互读；
   - 停止门自己记"拦过了"，去掉对 `stop_hook_active` 的依赖；
   - hook 出错时给出看得见的诊断。

   单元测试补上 Codex 的环境变量、Codex 嵌在 Claude Code 里启动的情况，以及用录下的真实输入测转换层。
3. 固定命令入口（按第 4 节的决定），和 hook 共用找 node 的办法。
4. Codex 的插件清单、marketplace、hook 适配；整组的跑法按实测第 5 条定。
5. 说明、技能、README。
6. 验收：在一个接入了 testpace 的示例仓库里，用 Codex 走一遍：
   - 会话开始看到节奏说明；
   - `testpace focused` 能跑；在沙箱里跑会被拒，说明清楚；
   - 没跑整组就提交到 main 被拦；
   - `testpace full` 通过后能落地；
   - 整组没看结果就结束会被拦，而且只拦一次（如果 Codex 的 Stop 能拦）；
   - 合并门自动配好、默认分支落了没测过的代码时，用户看得到提示。

## 6. 不做的

- 不为 Codex 放宽沙箱（不用 `danger-full-access`）。
- 不为 Codex 另写一套判断规则，所有规则只在 testpace 里。
- 不管 Codex Cloud：云端没有本机的 git 配置和插件。
- 不在这次接入 DeepSeek Harness，只在认 agent 的模块和 hook 转换层留好口子。

## 7. 进度（2026-11-17）

分工（用户定的）：这个分支做三个 agent 共用的底座（dsh 只认出来、留口子）和 Codex 自己的部分；dsh 等这个分支合进 main 后另开分支做。

**从 Codex 0.167.0 程序里内嵌的 hook 格式（JSON schema）确认的**，第 3 节第 4 条大部分不用再测：

- 有工具调用前的 hook（PreToolUse），输入有 `tool_name`、`tool_input`、`session_id`，输出可以带 `additionalContext`；
- Stop 的输入有 `stop_hook_active`，输出支持 `decision: block` 和 `reason`；
- 各事件的输出都有 `systemMessage` 字段（显不显示给用户还要实测）；
- 没有 PostToolUseFailure，工具调用后只有 PostToolUse；
- 执行命令的工具叫什么名字，schema 里看不出来，留给实测（实测：叫 `Bash`）。

**已做完**（单元测试 135 个通过，类型检查通过；shell.test.ts 没碰，没跑）：

- `src/agent.ts` 认 agent：Codex 优先，dsh 认 `DSH_SHELL`、`DSH_SESSION_ID`；会话号、在不在沙箱都从这里取，`cli.ts` 不再直接读 `CLAUDE_*`。（复查后改成一张表，见下面“复查后改的”）
- 合并门：钩子命令认各 agent 的标记变量，开头记着 testpace 版本；更新的版本配的不改回去。
- 停止门：每次整组只拦一次，拦过的记在会话状态（`blocked`），不再用 `stop_hook_active`，Claude Code 下也一样。
- hook：入口参数说明是哪个 agent；工具名不分大小写；出错时输出 `systemMessage`，不再一声不响。Codex 会话开始时多说两句：要在沙箱外跑、没放固定入口时用插件里 `testpace` 的完整路径并先问用户。
- 命令：在 Codex 沙箱里（`CODEX_SANDBOX`）不跑测试；写不了记录目录时说清楚；运行记录带 `agent`、`version`；`report` 有几个 agent 跑过时按谁跑的分开。
- 固定入口：`entry/testpace` 挑最高版本；`bin/node.sh` 找 22.18 以上的 node，`bin/testpace`、`hooks/codex.sh` 共用。只由 `testpace install` 放到 `~/.local/bin/testpace`，会话开始不自动放；同名的别的文件不覆盖。
- Codex 的插件清单、marketplace、`hooks/codex.json`、`hooks/codex.sh`；节奏说明、两个技能、README 改成两边通用的说法。

**和方案不同的地方**：

- 固定入口只在 `testpace install` 时放（全局安装要用户同意），不随会话开始自动放。
- Claude Code 的 hook 仍直接用 PATH 上的 `node`，没有改用 `node.sh`。
- `tools/` 下的版本一致检查改成了单元测试。

**主线程审查（2026-11-17）**：Claude Code 这条路径上没有挡路的问题，可以实测。

- 停止门的行为变化：一次整组最多拦两次（还在跑时一次、跑完没看结果时一次）。以前 agent 不理会提醒的话，之后每一轮结束都会再拦；现在拦过就不拦了。
- hook 出错时 Claude Code 下也会输出 `systemMessage`（以前不出声）。
- 实测后要改：
  - Codex 按 `command` 是字符串认执行命令。改文件（apply_patch）也会触发工具调用前后的 hook，补丁正文里有 `testpace full` 时可能误记"看过结果"；不按工具名过滤，每次工具调用都要起两个 node。录下真实输入、确定工具名后，`codex.json` 加 matcher，`isShellTool` 改成按名字认。
  - 固定入口扫插件缓存挑最高版本，卸载或降级后，旧缓存里更高的版本还会被选中。改成优先读已安装的记录（Claude Code 是 `~/.claude/plugins/installed_plugins.json` 的 installPath，Codex 看它自己的安装记录），读不到再扫缓存。
- 实测一定要覆盖：提权后还带不带 `CODEX_SANDBOX`；hook 在不在沙箱里。前台长命令到时间会先返回（`default_exec_yield_time_ms`），这时记下的"看过结果"早于整组结束，停止门不会误放行，实测确认。
- 合并：这个仓库没有 `testpace.json`，不走 `testpace:merge`。提交（先问用户）→ 跑插件的全部测试（先问用户）→ 主线程在主目录把 main 快进过来。主目录有未跟踪的第一版方案，快进前要处理；方案要不要进仓库由用户定。

**Codex 实测（2026-11-17，用户同意后做的）**

做法：两份清单升到 0.6.0（不升的话固定入口分不出 Claude Code 里已装的 0.5.0 和这个分支）；`testpace install` 放了 `~/.local/bin/testpace` 并更新全局合并门；用 `codex plugin marketplace add <worktree>`、`codex plugin add testpace@testpace` 装进 Codex；在 `~/Developer/testpace-codex-lab`（示例项目副本，测完已删）里用 `codex exec --dangerously-bypass-hook-trust --approve-for-me` 跑，hook 信任只对那一次运行生效，不写进配置；在 Codex 缓存里那份插件副本的 hook 入口加探针，记下 hook 的输入和环境（测完重装去掉了）。

| 实测项 | 结果 |
|---|---|
| 沙箱里命令的环境 | 有 `CODEX_THREAD_ID`、`CODEX_SANDBOX=seatbelt`、`CODEX_SANDBOX_NETWORK_DISABLED`、`CODEX_CI=1` |
| 提权后命令的环境（第 3 节第 1 条） | 有 `CODEX_THREAD_ID`，没有 `CODEX_SANDBOX`：沙箱拒跑的判断和合并门认 Codex 都成立。直接打印整个环境被自动审查拒了（会泄露令牌），改成只看变量在不在 |
| `CODEX_THREAD_ID` 和 hook 的 `session_id` | 同一个值 |
| hook 在不在沙箱里（第 3 节第 3 条） | 不在：能写仓库的 `.git` 和 `~/.codex` |
| hook 的环境 | 没有 `CODEX_THREAD_ID`；有 `CLAUDE_PLUGIN_ROOT` 和 `CLAUDE_PLUGIN_DATA`（`~/.codex/plugins/data/testpace-testpace`） |
| 执行命令的工具 | `tool_name` 是 `Bash`，`tool_input` 是 `{command: 字符串}`，和 Claude Code 一样 |
| 改文件 | `tool_name` 是 `apply_patch`，`tool_input.command` 是补丁正文：审查担心的误解析是真的 |
| Stop | 输入有 `stop_hook_active`；`decision: block` 能拦，拦下的原话作为提示交给 agent 继续 |
| `systemMessage` | hook 输出了，但 `codex exec` 的事件流和会话记录里都没有；交互界面里显不显示没验证 |
| 长命令（第 3 节第 5 条） | 前台命令到时间先返回（没有输出），进程接着跑；这时结束被停止门拦一次（"整组还在跑"）。整组跑完后 Codex 才发 PostToolUse，带完整结果，记下看过；agent 跑完 status 再结束，第二次不拦 |
| 验收流程（第 5 节第 6 步） | 会话开始有节奏说明和 Codex 的前提；沙箱里 `testpace files` 被拒、说明清楚；沙箱里 `testpace status` 输出后在写"看过结果"时报 EPERM（说明清楚）；提权后 `focused` 能跑；没跑整组的提交被合并门拦下；`testpace full` 通过后提交落地；前台跑完的整组不拦结束 |
| `CODEX_CI=1`（第 3 节第 6 条） | 示例项目的 `files`、`full` 在 Codex 里照常通过；别的项目没测 |
| 技能的称呼（第 3 节第 7 条） | 没测 |

按实测改的：

- 执行命令的工具三个 agent 都按名字 `Bash` 认（不分大小写）；`hooks/codex.json` 的 PreToolUse、PostToolUse 加 matcher `^Bash$`。复测：改文件不再触发 hook。
- 会话记录两边都放在 hook 的 `CLAUDE_PLUGIN_DATA`，去掉 `CODEX_HOME` 的推算。复测：写进了 `~/.codex/plugins/data/testpace-testpace/sessions/`。
- 固定入口：Claude Code 只认安装记录（`~/.claude/plugins/installed_plugins.json`）里的 installPath（复查后去掉了没有记录时扫缓存）；Codex 卸载时会删缓存，照旧扫缓存。

- 测试辅助函数 `agent()`：install 测试把整份 `ENV` 传进去，连 PATH 一起换掉，原来靠这台机器 PATH 上 Claude Code 装的 testpace 碰巧通过；放了 `~/.local/bin/testpace` 后用到了它。改成只传要改的变量。

改完：类型检查通过；agents、cli、focused、units、hooks 五个测试文件 135 个全过（shell.test.ts 没跑）。

实测中看到的问题：

- 旧版本来回改全局钩子（2.8 第 3 条）实际出现了：Claude Code 里装的还是 0.5.0，它把 0.6.0 的钩子命令当成"不是这一版的"，下次开 Claude Code 会话会改回旧命令（只认 `CLAUDECODE`）；Codex 会话开始又改回新的。Claude Code 里的插件升到 0.6.0 以后就不会了。
- 在 Codex 沙箱里跑 `testpace status` 会因为写不了"看过结果"退出码 2；结果照常输出，提权再跑一次才会记下看过。（复查后改成沙箱里直接拒跑 status）

实测期间 Codex 的 marketplace 临时指向这个分支的 worktree；落地后已改指仓库主目录（见文末"落地"）。

**复查后改的（2026-11-17）**：

- 各 agent 的差别收进 `agent.ts` 的 `AGENTS` 表（标记变量、会话变量、沙箱变量、要不要固定入口），别处只从表里取：认 agent、合并门钩子看哪些变量（由表拼出，只取已接入的：Claude Code 的 `CLAUDECODE`、Codex 的 `CODEX_THREAD_ID`；dsh 标着还没接入，合并门不拦它，接入时改成已接入）、hook 给哪些前提（按有没有沙箱、要不要固定入口，不再写 `agent === 'codex'`）、测试环境去掉哪些变量。接 dsh 时只填表里它那一行（沙箱、固定入口实测后填）。
- 去掉 `dataDir` 和其中对 dsh 的推测；会话记录照旧直接读 `CLAUDE_PLUGIN_DATA`，`sessions.ts` 恢复原样。
- 固定入口去掉"没有安装记录就扫 Claude Code 缓存"：没有记录就是没装，缓存里只会是残留。
- 合并门钩子只比命令正文：正文没变时不看开头的版本，发版不再重配全局 git 配置；正文不同时才按版本只升不降。
- hook 入口必须说明是哪个 agent：`hooks.json` 写明 `claude`，去掉两处默认值；没说时输出 `systemMessage`。
- Codex 沙箱里 `status` 也拒跑，说明要提权（它要记下这个会话看过结果）。`gate` 不拒：拒了会被钩子当成没法检查而放行。
- `report` 把"终端"（有版本没 agent）和"未记录（旧版本）"（版本也没有）分开。
- 测试：类型检查通过；agents、cli、focused、units、hooks 134 个全过（shell.test.ts 没跑）。合并门"更新的版本"那条测试改用正文不同的命令，否则正文一样会按"已装上"通过，测不到只升不降。

主线程第二轮审查后收窄两处：合并门不看 dsh（"只留口子"）；Claude Code 的标记只留 `CLAUDECODE`，会话号照旧取 `CLAUDE_CODE_SESSION_ID`（测试里给会话号的地方一起带上 `CLAUDECODE`）。这样钩子正文和实测时写进全局配置的一样，本机不会来回改。过渡期还会来回覆盖的只有 Claude Code 里的 0.5.0：合进 main 后把 Claude Code 的插件更新到 0.6.0。

## 8. 落地（2026-11-17）

- 合进 main：7eb8836，发版号 0.6.0。合并前在提交的代码上跑了插件的全部测试（6 个文件，含 shell.test.ts），140 个全过。
- Claude Code 的插件已更新到 0.6.0；`testpace install` 把全局合并门和 `~/.local/bin/testpace` 更新成 0.6.0 版。
- Codex 的 marketplace 改指仓库主目录，重装了 testpace 0.6.0；实测用的分支和 worktree 已删。
- 第 4 节：固定入口已放；命令放行规则没放（Codex 下每次提权）；layermap 的 Codex 命令入口还没定。
- 还没验证：`systemMessage` 在 Codex 交互界面里显不显示。
- 过渡期提醒：更新前就开着的 Claude Code 会话还在跑 0.5.0，会话开始或压缩时可能把合并门改回只认 `CLAUDECODE` 的旧版；重开这些会话即可，之后任何 0.6.0 会话开始时也会改回新版。
- dsh 接入暂缓。
