# gatelight 适配 Antigravity 方案

2026-11-24 · 第三版。基于本机 Antigravity 桌面 App 2.34.0 自带的文档（`~/.gemini/antigravity/builtin/skills/agy-customizations/docs/` 下的 hooks、plugins、mcp_servers、json_configs）、官网的终端沙箱说明（<https://antigravity.google/docs/sandbox>），和同一天在 Antigravity 会话里用小仓库 `~/Developer/agy-probe` 做的实测（1.1 节）。实测推翻了第一版的几处推断，第 2 节已按实测改过；要在界面里点的几项当天第四轮测完了，剩下要等装好、验收时才能看的列在 3 节。

范围：只接桌面 App。CLI、IDE 两种形态文档上用同一套定制体系，但没看过，接完 App 再说。

## 0. 结论

- 能做，而且打包比 Codex 那次顺：Antigravity 有插件（技能、钩子、MCP 服务打成一包），钩子的事件 gatelight 用到的都有（SessionStart、PreToolUse、PostToolUse、Stop）。
- 一套代码，三份插件清单：规则都在底座和三个模块里，Antigravity 只多一份清单、一个钩子入口和一层钩子格式的转换，不复制逻辑。
- 最大的工作量是钩子格式：Antigravity 钩子的输入输出和 Claude Code、Codex 不是一种写法（字段名、工具名、怎么拒绝、怎么让 agent 继续都不同）。现在 `hook.ts` 直接读写 Claude Code 的格式，要先把"判断"和"格式"分开（2.2）。
- 认 agent、认会话都有现成的变量（实测）：命令环境里有 `ANTIGRAVITY_AGENT=1` 和 `ANTIGRAVITY_CONVERSATION_ID`，后者和钩子收到的 `conversationId` 是同一个值。合并门、停止门不用换办法。
- 沙箱和 Codex 一样写不了 `.git`（实测，第一版猜反了），但没有标记沙箱的变量。更要紧的是：沙箱里看不见 `~/.claude`、`~/.codex`、`~/.gemini/config`，固定命令入口找不到装着的 gatelight，三条命令在沙箱里一条都起不来。所以拒跑要提前到固定入口这一层，认沙箱改成"看不看得见 Antigravity 自己的配置目录"（2.3、2.5）。
- 钩子有两处和想的不一样（实测）：PreToolUse 不想干预时必须什么都不输出，输出 `{}` 或钩子出错都会把这次工具调用拦掉；PostToolUse 的输入里没有命令的输出。钩子入口要保证任何情况下都不误拦（2.2）。
- 用户确认用钩子的 `force_ask` 成立（实测）：弹窗里看得到钩子给的原文，拒绝后工具不执行；这种弹窗里两个"总是允许"是灰的、选不了，下一次调用照样弹。长原文显示得全，但换行会被压成一段，原文要写成连着读也清楚的样子（2.6）。
- 要在界面里点的都测完了。剩下的四项要等装好、验收时才能看（第 3 节），不挡第 5 节的第 2 步（钩子的判断和格式分开）。

## 1. 已确认的事实

这张表来源是文档；实测的在 1.1，两边不一样的以 1.1 为准。

| 项目 | 文档怎么说 |
|---|---|
| 插件 | 一个目录，里面有 `plugin.json`（或 `.antigravity-plugin/plugin.json`、`.gemini-plugin/plugin.json`）就是插件；可以带 `skills/<名字>/SKILL.md`、`hooks.json`、`mcp_config.json`、`rules/AGENTS.md`、`agents/` |
| 插件放哪 | 全局 `~/.gemini/config/plugins/<目录名>/`；项目里 `.agents/plugins/`；别处的用 `plugins.json`（全局的在 `~/.gemini/config/`，项目的在 `.agents/`）登记路径，登记的目录只往下找一层 |
| 插件的标识 | 是安装目录的名字，不是 `plugin.json` 里的 `name`；`name` 全局不能重，重了后发现的那个不加载，也不报错 |
| 清单里认的字段 | `name`、`description`、`version`、`author`、`homepage`、`repository`、`logo`、`suggestedPrompts`、`displayName`、`disabled`；别的字段不报错、不生效 |
| 钩子清单 | 必须是插件根目录的 `hooks.json`（Claude Code 的 `hooks/hooks.json` 只在导入"纯 Claude Code 插件"时才会被搬过去）。最外层是钩子的名字，下面才是事件 |
| 钩子事件 | SessionStart、PreToolUse、PostToolUse、PreInvocation（每次调模型之前）、PostInvocation、Stop。只有 PreToolUse、PostToolUse 按工具名匹配 |
| 钩子命令 | 用 `sh -c` 跑，工作目录是 `hooks.json` 所在的目录，默认 30 秒超时；插件的钩子带 `PLUGIN_ROOT`、`PLUGIN_DATA` 两个环境变量，但不会替换进命令文字里；同步执行，会挡住 agent |
| 钩子输入 | 标准输入一个 JSON，字段是驼峰写法：`conversationId`、`workspacePaths`、`cwd`（agent 的工作目录）、`hookEventName`、`lastUserInput`、`transcriptPath` 等；工具事件多 `toolCall: { id, name, args }` 和 `stepIdx` |
| 工具名 | 跑命令的是 `run_command`，命令在 `args.CommandLine`；改文件的工具叫什么文档没列 |
| PreToolUse 输出 | `decision`：`allow`（直接放行）、`deny`（拒绝）、`ask`（问用户，认"总是允许"）、`force_ask`（每次都问，不认缓存）；`reason` 给用户和 agent 看；`overwrite` 可以改参数 |
| SessionStart 输出 | `injectSteps`：`systemMessage`（给模型，留在对话里；`metadata.user_markdown` 是只给用户看的文字）、`errorMessage`（只给用户看） |
| Stop 输入输出 | 输入有 `terminationReason`（正常结束是 `NO_TOOL_CALL`，还有 `USER_CANCELED`、`ERROR` 等）、`fullyIdle`（后台任务都完了）、`continuationActive`（这一轮已经被 Stop 钩子要求继续过）；输出 `decision: "continue"` 加 `reason` 让 agent 继续 |
| MCP | `mcp_config.json`，`{ "mcpServers": { 名字: { command, args, env } } }`；插件里的随插件启停；服务名全局不能重 |
| 命令环境 | 文档提到 agent 的命令环境里"通常有" `ANTIGRAVITY_LS_ADDRESS`、`ANTIGRAVITY_CSRF_TOKEN`（后一个是令牌，不能打印它的值）；别的没写 |
| 终端沙箱 | 默认开，用系统自带的隔离（没有虚拟机）。沙箱里：项目目录、临时目录、"常见的构建缓存"可写；`/usr`、`/etc` 这类可读；`~/.ssh`、`.env` 被挡；没挂载的位置看不见；默认断网 |
| 沙箱外 | agent 可以申请在沙箱外跑。Default 预设每次问用户；Auto 预设由 Antigravity 自动审查，安全的放行、有风险的问用户；可以加放行规则 `command(...)` |
| 本机设置 | 沙箱开着，预设是 Auto；`~/.gemini/config/plugins/` 是空的，只有自带的 swarm 插件 |

### 1.1 实测结果（2026-11-24）

环境：Antigravity 2.34.0，模型 Claude Opus 5.5，权限预设 Auto，沙箱开着。一个对话里跑了三轮。原始日志在小仓库的 `probe-out/`、`.agents/probe/log/`、`.agents/plugins/agy-probe/log/`。

**插件和加载**

| 项目 | 实测 |
|---|---|
| 信任 | 打开项目、开始对话时都没有问要不要信任。项目里的钩子、项目里的插件（钩子和 MCP 服务）直接生效 |
| 清单 | 只有 `.antigravity-plugin/plugin.json` 的目录按原生插件加载；旁边放着的 Claude Code 清单和 `hooks/hooks.json` 没有被执行 |
| 插件目录 | 插件的钩子、MCP 服务的进程里都有 `PLUGIN_ROOT`（插件目录）；`PLUGIN_DATA` 没有（测的是项目里的插件，全局装的没测）。MCP 的 `args` 用 `sh -c` 包一层就能用 `$PLUGIN_ROOT` |
| 技能 | 名字就是 `probe-skill`，前面不带插件名。没有专门加载技能的工具，agent 是用 `read_file` 读 `SKILL.md` |

**钩子**

| 项目 | 实测 |
|---|---|
| 运行环境 | 钩子在沙箱外：能写 `.git`、能写家目录。PATH 上有 `~/.local/bin` 和 nvm 的 node，`testpace`、`node` 都找得到。环境里有 `ANTIGRAVITY_CONVERSATION_ID`，没有 `ANTIGRAVITY_AGENT` |
| SessionStart | 对话的第一条消息发出时来（打开项目时不来）。`injectSteps` 的 `systemMessage` 模型收到了，前面带一句 "The following system message was injected by a SessionStart hook:" |
| PreToolUse 的输出 | 什么都不输出、退出码 0：工具照常跑（不干预）。`{}`：拒绝，原因是空的。`{"decision":""}`：拒绝。钩子退出码非 0：这次工具调用报错、不执行。`allow`：跑。`ask`：Auto 预设下 `echo` 没问就跑了。`force_ask`：每次都弹窗 |
| 几个钩子的先后 | 项目的钩子先跑，插件的后跑；前一个拒绝了，后面的不再跑 |
| 工具名 | 跑命令 `run_command`（`CommandLine`、`WaitMsBeforeAsync`、`BypassSandbox`）；写文件 `write_file`（`Path` 是绝对路径、`Content`、`Append`）；读文件 `read_file`（`Path`）；MCP 工具统一走 `call_mcp_tool`（`ServerName`、`ToolName`、`Arguments`）。改文件的专门工具只有两个（agent 照工具定义列的）：`write_file`（`Path`、`Content`、`Overwrite`、`Append`、`ArtifactMetadata`）和 `edit_file`（`Path`、`Target`、`Replacement`、`ArtifactMetadata`）。没有专门删文件、移动文件的工具，那些只能走 `run_command`。`edit_file` 没实际调过，钩子收到的样子没见过 |
| 后台命令 | 没有"放后台"的开关：命令超过 `WaitMsBeforeAsync`（agent 自己填，见过 500、5000、10000 毫秒）还没结束就自动转成后台任务。`testpace full` 这类几分钟的命令一定会转后台。任务结束时 agent 会收到一条系统消息（退出码、输出、日志路径） |
| PostToolUse | 命令结束时才来（后台的也是，`sleep 30` 是 30 秒后来的）。输入里有 `toolCall` 和 `error`（成功是空字符串），**没有命令的输出和退出码**。被钩子拒绝、被用户拒绝的调用不来 PostToolUse |
| Stop | `decision: "continue"` 有效，模型收到 "Stop hook blocked termination: <reason>"。被要求继续后的第二次 Stop，`continuationActive` 仍是 `false`，变的是 `executionNum`（0 变 1）。有后台任务在跑时 agent 说完话不来 Stop，等任务结束、agent 再回一句之后才来（只见过一次） |
| PreInvocation、PostInvocation | 每次调模型前后各来一次，一轮里来很多次（每个工具调用一组）。PreInvocation 的 `injectSteps` 模型收得到：是一条单独的系统消息，排在用户这句话之后、第一次调工具之前，前面带一句 "The following system message was injected by a PreInvocation hook:"。界面的对话里会多出一行 "Hook Json PreInvocation" |
| 子代理 | agent 有起子代理的工具：`invoke_subagent`（`TypeName`、`Role`、`Prompt`、`Model`、`Workspace`），另有 `define_subagent`、`manage_subagents`、`send_message`、`swarm`、`run_workflow`。子代理里钩子来不来、会话号是谁的没测 |

**命令环境**

| 项目 | 实测 |
|---|---|
| 认 agent | `ANTIGRAVITY_AGENT`（值是 `1`），沙箱内外都有；我这边的终端里没有任何 `ANTIGRAVITY_` 开头的变量 |
| 认会话 | `ANTIGRAVITY_CONVERSATION_ID`，和钩子输入的 `conversationId`、MCP 调用里 `_meta` 的 `antigravity.google/conversation_id` 是同一个值 |
| 认沙箱 | 没有带 SANDBOX 字样的变量。沙箱内外的变量只差一个：沙箱里没有 `SSH_AUTH_SOCK` |
| PATH | 沙箱内外都有 `~/.local/bin`，`testpace`、`modwall`、`testcraft`、`layermap`、`node`、`git` 都找得到 |
| LayerMap | `layermap --version` 沙箱内外都跑得起来，都是 0.1.53。`~/.local/bin/layermap` 是 LayerMap 自己放的固定入口，运行 `~/Library/Caches/layermap/versions` 里装着的最高版本；这个目录沙箱里看得见（见下表） |

**沙箱**

| 项目 | 沙箱里 | 沙箱外 |
|---|---|---|
| 写 `.git`、`git commit` | 不行（Operation not permitted） | 行 |
| `~/.claude`、`~/.codex`、`~/.gemini/config` | 看不见 | 看得见 |
| `~/.local/bin` | 看得见 | 看得见 |
| `~/Library/Caches/layermap` | 看得见，可写 | 可写 |
| 家目录 | 不可写 | 可写 |
| `/tmp` | 可写 | 可写 |
| 开本机端口 | 行 | 行 |
| 外网 | 不通（域名都解析不了） | 通 |

申请到沙箱外：`run_command` 加 `BypassSandbox: true`。Auto 预设下没有弹窗问用户，等了大约 11 秒后直接跑了。

**用户确认**

| 项目 | 实测 |
|---|---|
| 怎么调 | MCP 工具不在 agent 直接可调的工具里，列在系统提示的 MCP 服务一节，要用 `call_mcp_tool` 调。服务名是"插件名_服务名"（`agy-probe_agy-probe`）。第一轮 agent 看漏了，说"没有这个工具"，第二轮才调到 |
| 钩子看到的 | `toolCall.name` 是 `call_mcp_tool`，`args` 里有 `ServerName`、`ToolName`、`Arguments` |
| 弹窗 | 标题 "Allow using this MCP tool?"，下面一行是钩子 `reason` 的原文，再下面是"服务名/工具名"；工具的参数显示在弹窗上方的对话里。选项：只这一次、这个对话里总是允许、总是允许、拒绝（可以写一句话给 agent） |
| "总是允许" | `force_ask` 的弹窗里，"这个对话里总是允许""总是允许"两项是灰的，点了没反应，鼠标移上去显示 "Requires manual confirmation: <钩子的 reason>"。只能选"只这一次"或拒绝。同一个对话里连调三次，三次都弹 |
| 长原文 | 约 250 个字、带换行的原文，从第一行到最后一行都显示出来了，没有截断，太长的一行会折行。但换行全被压成空格，连成一段；`**加粗**`、`` `代码` ``、`- 列表` 的记号原样显示，不渲染。字比选项小一号、灰色。更长的没测 |
| 拒绝 | 工具不执行（MCP 服务没收到调用），agent 收到 "user denied permission for mcp(...)" 和用户写的那句话，也不来 PostToolUse |
| 同意 | 工具执行，调用里带着会话号 |

代码里和适配有关的现状：

| 位置 | 现状 |
|---|---|
| `base/agent.ts` 的 `AGENTS` 表 | 有 claude、codex、dsh 三行；各 agent 的标记变量、会话号变量、沙箱变量、要不要固定入口都在这里 |
| `base/commandline.ts` | 三条命令的入口共用：沙箱里跑不了的子命令事先拒绝，写入被拒时说清楚。只看 `AGENTS` 表里的沙箱变量 |
| `base/hook.ts` 的 `handle()` | 输入按 Claude Code 的字段读（`hook_event_name`、`session_id`、`tool_name`、`tool_input.command`、`tool_input.file_path`），输出直接拼 Claude Code 的格式（`hookSpecificOutput`、`permissionDecision`、`decision: "block"`、`systemMessage`）。Codex 的格式和它兼容，所以没分开 |
| `hooks/testpace.ts <agent>` | 钩子入口，参数说明来自哪个 agent；出错时输出 `systemMessage` |
| `hooks/codex.sh`、`bin/node.sh` | Codex 的钩子环境里不一定有能跑 TypeScript 的 node，先找一个 |
| `entry/command` | 固定命令入口：在 Claude Code 的安装记录和 Codex 的缓存目录里找装着的最高版本 |
| `src/mcp.ts` | 确认工具标了 `anthropic/requiresUserInteraction`，Claude Code 每次都弹窗 |
| `.mcp.json` | 用 `${CLAUDE_PLUGIN_ROOT}` 找 `src/mcp.ts` |

## 2. 要改的地方

### 2.1 打包和安装

- 新加 `plugin/.antigravity-plugin/plugin.json`：`name`、`description`、`version`、`author`、`repository`。和另外两份清单一样放在点目录里。
- 新加 `plugin/hooks.json`（Antigravity 要求在插件根上）：SessionStart、PreToolUse、PostToolUse、Stop 四个事件，命令都是 `./hooks/antigravity.sh`（钩子的工作目录就是 `hooks.json` 所在的目录，实测）。Claude Code 读的是 `hooks/hooks.json`，Codex 读清单里指的 `hooks/codex.json`；Antigravity 不执行 `hooks/hooks.json`（实测）。Claude Code 不会把根上这份当成自己的，这一半还没测，加文件时在 Claude Code 里看一眼。 做的时候定了：PostToolUse 不接（它的输入里没有命令的输出、分不出转没转后台，接了也用不上，见 2.2），只接 SessionStart、PreToolUse（`run_command`、`write_file`、`edit_file` 各一组，不靠正则的写法）、Stop；入口用 `sh ./hooks/antigravity.sh`。Claude Code 不读插件根上的 `hooks.json`、也不认 `mcp_config.json`（官方文档；`claude plugin validate` 实测和 main 上的结果一样）。
- 新加 `plugin/mcp_config.json`：确认工具的服务。`command` 用 `sh`，`args` 用 `-c` 包一层，里面用 `$PLUGIN_ROOT` 找 `bin/node.sh` 和 `src/mcp.ts`（MCP 服务的进程里有 `PLUGIN_ROOT`，实测）。 放到第 4 步（2.6）和 `force_ask` 一起加：先加上服务、没有 `force_ask` 的话，Auto 预设下 agent 可能自己同意自己。
- 版本号三份清单一起升；核对清单版本一致的那条测试（`agents.test.ts`）加上第三份。
- 不加 `rules/AGENTS.md`：会话说明是按仓库现算的（模块列表、时好时坏的测试），由 SessionStart 钩子给，写不成固定文字。
- 安装（开发期）：**要你定**（第 4 节）。两种办法：
  - 在 `~/.gemini/config/plugins/` 下放一个指向仓库 `plugin/` 的链接，目录名 `gatelight`。
  - 在 `~/.gemini/config/plugins.json` 里登记仓库根目录，它往下找一层找到 `plugin/`。这样安装标识是目录名 `plugin`，不好看，也容易和别的仓库撞。
  
  建议第一种。发到 Antigravity 的插件市场这次不做。

  正式装法（给别人用）后来定为 `npx gatelight setup antigravity`：插件发 npm，复制到 `~/.gemini/config/plugins/gatelight/`，见 [安装方案.md](安装方案.md)。开发期的链接照旧，`setup` 不动它。
- 会话说明和技能里写的是 `gatelight:merge` 这类名字。Antigravity 里技能的名字不带插件名（实测是 `merge` 这样的光名字），agent 靠读 `SKILL.md` 用上它。会话说明里提到技能的地方按 agent 换说法，写法记在 `AGENTS` 表里。光名字可能和别的插件的技能撞名，`merge`、`setup` 这两个尤其容易，要不要给 Antigravity 改名**要你定**（第 4 节）。

### 2.2 钩子：把判断和格式分开

现在 `handle()` 一边判断一边拼 Claude Code 的输出。Antigravity 的格式不兼容，不能再往里加分支。改成三段：

1. **读**：各 agent 的输入转成同一种内部事件（哪个事件、会话号、工作目录、是跑命令还是改文件、命令或文件路径和要写的文字、命令是不是放到了后台、Stop 是不是已经被要求继续过）。
2. **判断**：`handle()` 只收内部事件，只返回结论（给模型的话、给用户的话、拒绝的原因、不让停的原因）。里面不再出现任何 agent 的字段名。
3. **写**：各 agent 把结论编成自己的输出。

读和写按 agent 放在一起（建议 `base/hookformat.ts`，一个 agent 一组读、写函数；claude 和 codex 共用一组）。哪个 agent 用哪组记在 `AGENTS` 表里，别处不判断 agent 的种类。

各事件在 Antigravity 里怎么对上（实测过的标了"实测"）：

| gatelight 要做的 | Antigravity 的写法 | 还没定、没测的 |
|---|---|---|
| 会话开始给说明 | SessionStart 输出 `injectSteps: [{ systemMessage }]`，模型收得到（实测）；给用户的那句（自动配了合并门）放 `metadata.user_markdown` | 压缩、恢复对话之后 SessionStart 会不会再来一次；`user_markdown` 用户看不看得到 |
| 改文件之前拒绝（modwall 的没有归属、绕过入口） | PreToolUse 输出 `{ decision: "deny", reason }`。`write_file` 的路径在 `args.Path`（绝对路径）、文字在 `args.Content`（实测） | `edit_file` 的路径在 `Path`、新文字在 `Replacement`（agent 照工具定义列的，钩子收到的样子做的时候核对一次）。删文件、移动文件没有专门的工具，走 `run_command`，和 Claude Code 下走 Bash 一样不在这条钩子里管。`deny` 的 `reason` agent 看到的原样没测（空原因时 agent 看到的是 "tool call denied by pre-tool hook: "） |
| 不干预 | **什么都不输出**，退出码 0（实测）。`{}`、空的 `decision`、退出码非 0 都会把工具拦掉 | |
| 跑命令之前给提示（直接跑 full 的命令时提醒改用 testpace full） | PreToolUse 没有"只加一段话"的写法。办法二选一，**要你定**（第 4 节）：改成拒绝一次并说明（agent 一定看得到，但从提醒变成了拦）；或者钩子先记下，下一次调模型前由 PreInvocation 的 `injectSteps` 带给模型（要多接一个每次调模型都跑的钩子） | 两种办法都做得到：PreInvocation 的 `injectSteps` 模型收得到（实测）。第二种是命令跑起来之后、下一次调模型时才带到，和 Claude Code 现在"提醒、不拦"的效果一样 |
| 跑完 testpace full 记下"看过结果" | PostToolUse 的输入里没有命令的输出，也分不出命令是不是转了后台（实测）。几分钟的命令一定会转后台，所以 Antigravity 下不靠 PostToolUse 记，只认 `testpace status`：它在命令环境里拿得到会话号 | 后台任务结束时 agent 收到的那条系统消息里带多少输出没测；带得全的话可以放宽，先不做 |
| 停止门 | Stop 输出 `{ decision: "continue", reason }`，模型收得到（实测）。"只拦一次"和 Claude Code 下一样靠停止门自己记下拦过的（`stop.ts`），不看输入里的标记（实测 `executionNum` 第一次是 0、被要求继续之后是 1；文档说的 `continuationActive` 实测一直是 `false`） | 只在 `terminationReason` 是 `NO_TOOL_CALL` 时管；提醒类的话（不拦、只说一句）Stop 的输出里没地方放，Antigravity 下先不说 |
| 钩子自己出错 | 不能照现在的做法往标准输出写东西，也不能让退出码非 0：PreToolUse 下那等于把用户的每一次工具调用都拦掉 | 出错的话怎么给用户看：SessionStart 可以用 `errorMessage`，别的事件先写到标准错误，用户看不看得到没测 |

两条硬规矩：

- PreToolUse 绝不输出 `allow`：那会替用户放行这次工具调用，绕过 Antigravity 自己的权限。
- 钩子入口（`hooks/antigravity.sh` 和它后面的写函数）在任何没想到的情况下都是"什么都不输出、退出码 0"：找不到 node、脚本抛错、输入不是 JSON 都算。这条要有测试。

钩子入口照 Codex 的做法加 `hooks/antigravity.sh`：先用 `bin/node.sh` 找能跑 TypeScript 的 node，再交给 `hooks/testpace.ts antigravity`。钩子在沙箱外跑，PATH 上有 node（实测），`bin/node.sh` 仍然留着兜底。

### 2.3 沙箱

实测和第一版的推断不一样，这一节重写。

- 沙箱里 gatelight 的命令一条都起不来：固定入口要到 `~/.claude`、`~/.codex`（以后加上 `~/.gemini/config`）下面找装着的插件，这三处在沙箱里都看不见。现在入口会说"这台机器上没找到装着的 gatelight"，这句话在沙箱里是错的，agent 照着它去重装就更糟。
- 所以拒跑放在固定入口，不放在 `base/commandline.ts`：入口找不到插件时，再看一眼那几个上级目录本身读不读得了。有在的、却一个都读不了，就说"读不了插件的安装目录，多半是在 agent 的沙箱里，申请在沙箱外重新运行这条命令"，退出码 2；其余的才说没装。（第一版按"在不在"判断，验收时实测沙箱里这几个目录都在、只是读不了，判成了没装，改成按读不读得了。）这个判断不分 agent，入口不用认识 Antigravity。
- `AGENTS` 表里 Antigravity 不填沙箱变量（本来也没有这样的变量）。`base/commandline.ts` 不用改；它里面"写入被拒时说清楚"那一层照常兜底：直接跑插件目录里的命令、绕过入口时，写 `.git/testpace/` 会被拒，说明照旧。
- 这样 Antigravity 的沙箱里和 Codex 的结果一样：命令不跑、不留记录、告诉 agent 申请到沙箱外。区别只是拦在哪一层。
- 会话说明里 Antigravity 的那句照 Codex 的写：testpace、modwall、testcraft 的命令申请在沙箱外跑（`run_command` 的 `BypassSandbox`）。Auto 预设下 Antigravity 自动审查，实测没有问用户。
- LayerMap 的地图目录在沙箱里可写，和这次无关了（命令到不了那一步），记在 1.1 备查。
- 放行规则（`command(testpace ...)`）只作为可选项，**要你定**（第 4 节）。风险和 Codex 那次一样：放行 testpace 等于放行 `testpace.json` 里的任何命令。

### 2.4 认 agent 和会话号

`AGENTS` 表加一行 `antigravity`（都是实测的值）：

- **标记变量**：`ANTIGRAVITY_AGENT`。沙箱内外都有，用户自己的终端里没有。合并门的 git 钩子靠它决定检查不检查。
- **会话号变量**：`ANTIGRAVITY_CONVERSATION_ID`，和钩子输入的 `conversationId` 同值。停止门、`testpace status` 的"看过结果"都用它。
- **沙箱变量**：不填（2.3）。
- **要不要固定入口**：要。`~/.local/bin` 沙箱内外都在 PATH 上（实测）。
- **在表里的先后**：从 Antigravity 的命令里起 Claude Code、Codex 时会继承 `ANTIGRAVITY_AGENT`，按现在"里层的排前面"的规矩，antigravity 排在 codex、claude 后面才对；但 Claude Code 现在排最后是因为别人会继承它的变量。三个互相嵌套时光看环境变量排不出一个都对的顺序，这是表头注释里写着的已知限制。建议 antigravity 排在 codex 后、claude 前，嵌套的情况不专门处理。

钩子不靠环境变量认 agent（入口参数说明），不受这个顺序影响。钩子的环境里也有 `ANTIGRAVITY_CONVERSATION_ID`，但会话号仍然从输入的 `conversationId` 读。

### 2.5 固定命令入口

- `entry/command` 找装着的版本时多看一处：Antigravity 的安装目录（2.1 定下来的那个位置）。三处里挑版本最高的，不按 agent 分先后。
- 版本从 `.antigravity-plugin/plugin.json` 读。
- 找不到时分两种说法（2.3）：安装目录的上级有在的、却都读不了，说在沙箱里、申请到沙箱外；其余的说没装。两种都是退出码 2。话里的变量写成 `${名字}`：紧跟着的中文标点在 UTF-8 语言环境里会被 sh（macOS 上是 bash）吞进变量名。
- 入口本身、`testpace install` 放入口的做法都不变。

### 2.6 用户确认

现在的保证是：检查要求用户同意的改动（放松测试、放宽规则），只有用户在弹窗里看到原文、点了同意才记下，agent 自己说"用户同意了"不算。

Antigravity 里 MCP 工具默认要不要问用户跟权限预设走，Auto 预设下可能直接放行，那就成了 agent 自己同意自己。办法：

- 给确认工具加一条 PreToolUse 钩子：`toolCall.name` 是 `call_mcp_tool`、`args.ServerName` 是 gatelight 的服务、`args.ToolName` 是确认工具时，输出 `{ decision: "force_ask", reason: <要用户确认的原文> }`。
- 实测成立的：弹窗里用户看得到 `reason` 的原文；拒绝后工具不执行，agent 收到"用户拒绝了"和用户写的话；同意后才执行。
- "总是允许"绕不过去（实测）：`force_ask` 的弹窗里那两项是灰的，每次调用都要用户当场点。没测的只剩一种：用户事先在 Antigravity 的设置里给这个工具写了放行规则。文档说 `force_ask` 不认这些；测它要改全局配置，留到验收时在你同意下看一次。
- 原文怎么写（实测）：长原文显示得全，但换行被压成一段、不渲染 Markdown。给 Antigravity 的 `reason` 要写成连着读也分得清的一段：每一项用"1.""2."开头、句号结尾，不用列表、加粗、代码记号。这是格式那一层的事（2.2 的 `base/hookformat.ts`），判断给出的还是同一份原文。很长的原文（几十项）没测，做的时候拿真实的最长一例看一眼。
- 钩子出错时不能变成不问就执行：2.2 定的是钩子出错一律不干预，唯独这里反过来。入口脚本先从输入里认出是不是确认工具的调用，是的话后面任何一步出错都输出 `deny`（原因写钩子出错了）。插件被关时钩子和 MCP 服务一起停，不存在只剩工具的情况。
- 技能里要写清楚 Antigravity 下怎么调：用 `call_mcp_tool`，服务名是"插件名_服务名"。实测 agent 第一轮没找到这个工具，直接说"没有"。
- 验收时发现放行规则能绕过 `force_ask` 的话，Antigravity 下不提供确认工具，检查要用户同意的改动一律按没同意算（拦住），告诉用户到 Claude Code 或终端里处理。不做一个可以被跳过的确认。

### 2.7 技能和子代理

- 技能文件格式一样，原样带过去。名字见 2.1。
- gatelight:write-tests 里写测试交给子代理，"没有起子代理的工具就自己写"的说法已经有了。Antigravity 里有起子代理的工具（`invoke_subagent`，实测），技能的说法不用改。子代理里钩子来不来、命令环境里的会话号是子代理自己的还是主对话的没测；会话号不一样的话，子代理跑的 `testpace focused` 记在另一个会话名下，验收时看。
- 技能里提到 Claude Code 专有工具名的地方（比如确认工具的调用方式）核对一遍，按 2.6 的结果改说法。

### 2.8 LayerMap

- gatelight 要的只是 `layermap` 这条命令：`testpace focused` 按改动挑测试、`modwall check` 读代码里的 import 都靠它，要 0.1.48 以上。Antigravity 的命令环境里找得到、跑得起来（实测，1.1）。它的固定入口读的是缓存目录，沙箱里看得见，不像 gatelight 的入口那样在沙箱里找不到东西。调用 LayerMap 的代码不用改。
- 要改的只有提示文字，都在 `base/layermap.ts`：`LAYERMAP_COMMAND`（"Codex 和终端里还要跑一次 npx layermap setup command"）补上 Antigravity；`tooOld()` 里升级的说法只写了 Claude Code。Antigravity 下怎么装、怎么升级，照 LayerMap 接入 Antigravity 之后的装法写（下面第 4 条）；它没接好之前先不写 Antigravity 的说法。
- 一条前提，归 LayerMap、不在这次范围里：入口背后的程序是各 agent 里的 LayerMap 插件启动时装进缓存的。只用 Antigravity 的机器上没有谁来装，`layermap` 命令会说没有装着的版本，`focused` 就挑不了测试、`modwall check` 查不了 R1–R4。这台机器 Claude Code、Codex 里都有 LayerMap，不受影响。
- 要给只用 Antigravity 的人用，得 LayerMap 先接 Antigravity（它的仓库里现在没有 Antigravity 的清单）。agent 自己用 LayerMap 的工具查调用关系，也要等这一步。gatelight 不替它装、不带一份它的程序：LayerMap 的入口归 LayerMap 管。
- 你定了要接（2026-11-24）。在 LayerMap 的仓库里单独做，不放在 gatelight 这个分支里：它给每个 agent 各有一份插件（`plugins/claude`、`plugins/codex`、`plugins/pi`），Antigravity 没有装插件的命令，所以不走这条路，走 `layermap setup antigravity`（见下面的表和表后的说明）。
- 两边互不等：这台机器上 gatelight 用的 `layermap` 命令已经有了，gatelight 这边照第 5 节的顺序做；LayerMap 那边接好后，回来补上面第 2 条的提示文字。
- README 的 Antigravity 一节写明这条前提。

LayerMap 在 Antigravity 里的实测（2026-11-24 第五、六轮，在小仓库里放了一份从 LayerMap 源码启动的试用插件）：

| 项目 | 实测 |
|---|---|
| 能不能用 | 能。四个工具都登记上了，`project_explore_map`、`project_check_changes` 调通，地图建出来了（服务能写 LayerMap 的缓存目录） |
| 新插件什么时候生效 | 不用重启：放进项目的插件目录后，下一次发消息时技能、规则、MCP 服务都加载了 |
| 服务名 | `layermap_layermap`（插件名_服务名）。agent 第一次猜成 `layermap`，报 "tool ... is not enabled for server layermap" |
| 工具怎么到 agent 手里 | 系统提示里只列服务名和工具名；调用前 agent 要先读 `~/.gemini/antigravity/mcp/<服务名>/<工具名>.json`。服务自带的使用说明存成同目录的 `instructions.md`，**不在系统提示里**，agent 不一定去读 |
| 插件的规则 | `rules/AGENTS.md` 会进系统提示的"用户规则"一节，一直在。要让 agent 想得起来用地图，得靠这份规则，不能靠服务自带的说明 |
| 服务在哪个目录启动 | 插件自己的目录，不是项目目录；发现插件时启动一次。试用插件放在项目里，所以 path 给 "." 碰巧落在项目上；装成全局插件后启动目录不在任何仓库里，LayerMap 会回 "LAYERMAP_NOT_A_GIT_REPOSITORY ... Name a file or directory in one, relative to that folder or absolute"（本地试过），agent 得给绝对路径 |
| 要不要用户点确认 | 要。Auto 预设下每个工具第一次用都弹窗，可以选"这个对话里总是允许"或"总是允许"，选了之后同一个工具不再问 |
| 怎么装 | 这台机器没有 `agy` 命令。Antigravity 自带的说明是：手写的插件放 `~/.gemini/config/plugins/<名字>/`，自己加载；另有一个要上架的 Marketplace（Customizations 页） |
| 服务进程能不能联网 | 能（第七轮，探测插件 `agy-net`）：域名解析得了，连 npm 的仓库回 HTTP 200，LayerMap 的缓存目录也写得进。LayerMap 第一次启动时用 npm 装程序这一步走得通 |
| 会不会告诉服务项目目录 | 不会（第七轮）：Antigravity 的 MCP 客户端不带 roots，服务去问 `roots/list`，回 "client does not support roots"。服务没法知道会话在哪个项目，只能由 agent 每次给绝对路径 |
| 新插件的工具什么时候到 agent 手里 | 服务在发消息时启动，那一轮的系统提示里还没有它；下一轮才有（第七轮） |
| 本机试装（第八、九轮） | 从 LayerMap 主目录跑 `setup antigravity`，写进 `~/.gemini/config/plugins/layermap/`，Antigravity 没重启。下一条消息里规则就进了系统提示，来源标的是这个目录下的 `rules/AGENTS.md`。不告诉服务名和参数，只说"照规则用地图看仓库结构、查未提交改动"：agent 自己填了 `layermap_layermap` 和项目的绝对路径，两次调用都成功 |
| 还没测 | 全局插件的服务在哪个目录启动：试装时 Antigravity 沿用了之前试用插件起的那个服务进程（名字、启动命令都一样），没重新起，看不到；它现在的目录不是仓库，和装成全局插件后的情形一样，所以上面那一轮算数。第一次启动时装程序要几十秒，Antigravity 等不等：要发版后才测得到 |

对 LayerMap 那边做法的影响：服务本身不用改（绝对路径、roots 它都已经支持）；要加的是 Antigravity 的插件（清单、MCP 配置、一份规则）和装它的办法。规则里除了现有那句说明，要多写两点：用 `call_mcp_tool` 调、服务名是 `layermap_layermap`；path 给绝对路径。**怎么装你定了（2026-11-24）**：做成 `layermap setup antigravity`，把插件目录写到 `~/.gemini/config/plugins/layermap/`（`layermap remove antigravity` 删掉），和它给别的 agent 的 setup 一个路子。

做到哪了：已合进 LayerMap 的 main（提交 `2d0744d`），随 0.1.56 发到 npm（2026-11-24，版本提交 `ff79f62`；LayerMap 的 main 没推送，MCP 服务目录没登记）。写进去的是三个文件：清单 `plugin.json`、`mcp_config.json`（启动 LayerMap 的启动脚本）、`rules/AGENTS.md`（现有那句说明，加上"用 `call_mcp_tool`、服务名 `layermap_layermap`、每次给绝对路径、`project_check_changes` 的 path 给项目根目录"）。不带钩子，不替用户放行工具。它的类型检查、lint 和整组测试都过了（347 条，345 条通过，2 条 Java 的跳过）。这台机器上已经试装（装的是从 LayerMap 主目录源码启动的版本，`layermap remove antigravity` 可以删掉）。还没做的：推送 LayerMap 的 main、登记 MCP 服务目录、用发布的 0.1.56 重装这台机器上的插件（顺便看第一次启动装程序时 Antigravity 等不等），都等你点头。

### 2.9 测试和文档

- `agents.test.ts`：认 Antigravity、沙箱里拒跑、会话说明里 Antigravity 的前提。
- 钩子格式：每个 agent 的读、写各有测试；`handle()` 的测试改成喂内部事件。现有按 Claude Code 格式写的钩子测试是接法变了，跟着改，规则不变。
- README 加 Antigravity 一节；`整体设计方案.md` 里底座的说明补上钩子格式这一层。

## 3. 实测

在 Antigravity 桌面 App 里做，用专门的小仓库 `~/Developer/agy-probe`（不放 `/tmp`：Codex 那次的教训，临时目录沙箱是放行的，测不出真实情况）。2026-11-24 跑了四轮，结果在 1.1。

小仓库里有：

- `probe/run.sh <标签>`：记下命令环境（变量只记名字和值的摘要，不记值）、PATH、找不找得到命令、能不能写 `.git`、`git commit`、项目外的位置看不看得见、端口、外网。结果写到 `probe-out/<标签>.txt`。
- `.agents/hooks.json`：项目的钩子，六个事件都接，记录输入和钩子自己的环境（写到 `.agents/probe/log/`）。PreToolUse 按命令里的标记（`V-NOOUT`、`V-EMPTYSTR`、`V-EXIT1`、`V-ALLOW`、`V-ASK`）给出不同的输出，没有标记的不输出。
- `.agents/plugins/agy-probe/`：探测插件。清单只放在 `.antigravity-plugin/` 里，旁边另放一份 Claude Code 的清单和 `hooks/hooks.json`；一个最小的 MCP 工具 `probe_confirm`，插件的 PreToolUse 钩子对它输出 `force_ask`；一个技能。

第一轮的教训：探测钩子的 PreToolUse 输出了 `{}`，结果所有工具都被拦了。这本身就是一条实测结果（1.1），改成不输出后重跑。

还没测的：

| 项目 | 影响哪里 | 怎么测 |
|---|---|---|
| 设置里事先写了放行规则时 `force_ask` 还弹不弹 | 2.6 的保证 | 要改全局配置，验收时你同意后看一次 |
| `edit_file` 调用时钩子收到的样子 | 2.2 改文件之前拒绝 | 做 2.2 时让 agent 改一个文件，看记录 |
| 子代理里钩子来不来、会话号是谁的 | 2.7 | 验收时看 |
| 压缩、恢复对话后 SessionStart 来不来 | 2.2 会话说明 | 要一个长对话，验收时看 |
| 全局装的插件：`PLUGIN_DATA`、沙箱外看不看得见 | 2.1、2.5 | 定了开发期怎么装（第 4 节）之后测 |
| Claude Code 不读插件根上的 `hooks.json` | 2.1 | 加文件时在 Claude Code 里看 |
| Auto 预设下 `testpace full` 申请到沙箱外会不会被问 | 2.3 | 验收时看 |

第四轮测完的四项（结果在 1.1）：`force_ask` 的弹窗里"总是允许"选不了；长原文显示得全、但压成一段；PreInvocation 能给模型带话；改文件的工具和参数名。

## 4. 要你定的

前四项 2026-11-24 你定了：都按建议，并且不能影响 Claude Code 现在的行为。

1. **开发期怎么装**：在 `~/.gemini/config/plugins/` 下放一个指向仓库 `plugin/` 的链接（定了：用链接），还是用 `plugins.json` 登记。都是改全局配置。
2. **放行规则**：要不要在 Antigravity 里放行 `testpace`、`modwall` 的命令。默认不放，每次申请到沙箱外（Auto 预设下实测不会问你）。定了：不放。
3. **跑命令之前的提示怎么给**（2.2，定了：拒绝一次并说明）：Antigravity 的 PreToolUse 只能放行、拒绝、问用户，不能只加一句话。两种办法实测都做得到。建议拒绝一次并说明：直接跑 full 的命令本来就不留记录，拦一次不亏，也不用多接一个每次调模型都跑的钩子。另一种（调模型前带话）和 Claude Code 现在"提醒、不拦"的效果一样，代价是每次调模型都多起一次钩子进程，对话里也多一行钩子的记录。
4. **技能要不要改名**（2.1，定了：先不改）：Antigravity 里技能名不带插件名，`merge`、`setup` 容易和别的插件撞。建议先不改，撞了再说：改名要动三个 agent 共用的技能目录。
5. **实测用的小仓库**：`~/Developer/agy-probe`，要在界面里点的已经测完；`edit_file` 和子代理那两项还用得上它，验收完再删，删之前问你。
6. **范围**：只接桌面 App。
7. ~~LayerMap 接不接 Antigravity~~：已定，要接（2026-11-24），在 LayerMap 的仓库里单独做（2.8）。

## 5. 做的顺序

1. 实测第 3 节，结果记进这份文档，按结果改第 2 节。（要在界面里点的都做了；剩下的见第 3 节，跟着后面几步一起看，不挡第 2 步。）
2. 钩子的判断和格式分开（2.2）。这一步不涉及 Antigravity，Claude Code、Codex 的行为不变，现有测试跟着接法改，单独合一次。（2026-11-24 写好，没提交：新加 `base/hookformat.ts`，内部事件、结论和 Claude Code 那一组读写都在里面，Codex、dsh 共用；`hook.ts` 的 `judge` 只看内部事件、只给结论；`AGENTS` 表每行带上用哪一组。现有测试一条没改，钩子相关的都过了。）
3. `AGENTS` 表加 Antigravity、钩子的读写、三份清单、固定入口多看一处并分清"在沙箱里"和"没装"（2.1、2.3、2.4、2.5）。（2026-11-24 写好，没提交：`AGENTS` 加 antigravity，排在 Codex 后；表里加 `leaveSandbox`（会话说明里怎么申请到沙箱外）和 `skill`（技能名的叫法，Antigravity 里写成"gatelight 的 merge 技能"）；`hookformat.ts` 加 Antigravity 的读写，执行命令前的提示改成拒绝、同一段提示一个会话只拦一次（记在会话状态的 `refused`）；会话记录的目录也认 `PLUGIN_DATA`；第三份清单 `.antigravity-plugin/plugin.json`、根上的 `hooks.json`、`hooks/antigravity.sh`（任何情况下退出码 0、不往标准输出写错误）；固定入口多找 `~/.gemini/config/plugins/*/`，三个配置目录都看不见时说多半在沙箱里。有一条已有的测试按新规则不过（空的 HOME 里入口现在说"在沙箱里"，原来说"没装"），合并时改。代码验收后补了两处：输入里没有 `cwd` 时不管（不拿钩子进程的目录、也就是插件目录顶替）；技能名改在钩子输出的出口（`handle`）统一换，合并门、modwall 这些命令自己的输出照原样。会话从仓库外开始、第一次碰到接入的仓库时补说的节奏也是靠拒绝那一次命令送到，每个仓库每个会话一次。还没在 Antigravity 里装上试。）
4. 用户确认（2.6）。（2026-11-25 写好，没提交：插件根上加 `mcp_config.json`，Antigravity 从它起确认工具的服务（服务名 `gatelight`，agent 看到的是 `gatelight_gatelight`；启动命令先找够新的 node）；`hooks.json` 多接 `call_mcp_tool`。`hookformat.ts` 里 Antigravity 读到调 `gatelight_gatelight` 的（这个服务只有确认工具，只看服务名；没有 `cwd` 也算）读成新的内部事件"调确认工具"，判断给出新的结论"要用户当场同意"（原文就是调用里填的 `text`，没填就拒），写成 `force_ask`，原文压成一段。`hooks/antigravity.sh` 先从输入里认出是不是确认工具的调用，是的话找不到 node、node 出错、没给结论都输出 `deny`；别的调用出错照旧什么都不输出。会话说明里 Antigravity 多一句怎么调（`call_mcp_tool`，ServerName、ToolName、Arguments 填什么，`AGENTS` 表的 `confirmCall`）。Claude Code、Codex 不变：它们的钩子读不出这种事件。本地核对过：弹窗原文、没填原文被拒、别的 MCP 服务不管、node 出错时只拒确认工具、按配置起得来服务。2026-11-25 在 Antigravity 里实测：试验仓库工作区放宽 `outside`，agent 在沙箱外跑 `modwall check` 后照输出用 `call_mcp_tool` 调到 `gatelight_gatelight` 的 `confirm_with_user`（新对话第一轮就找到了）；弹窗原文完整、压成一段，两个"总是允许"是灰的；点"拒绝"后工具没执行，`confirm/` 下只有 `pending.json`、没有 `confirmed.json`，agent 停下没改文件，停止门照常拦了一次。同意路径（用户自己点的"Yes, allow this time"）也过：工具执行后 `confirmed.json` 记下了这一项（模块 `wall`，文字就是弹窗里那一项），再跑 `modwall check` 通过，输出"放宽规则 1 项，用户都同意过"。顺带看到 agent 没照输出先在对话里白话讲清就直接调了工具，被拒后才补上；这是模型没照做，弹窗里原文是全的，暂不改。）
5. 在 Antigravity 里验收：会话开始有说明；沙箱里 `testpace focused`、`modwall check` 被固定入口拒掉并说明清楚；沙箱外能跑；改没有归属的文件被拦；没跑整组就合到默认分支被合并门拦；整组没看结果就结束被停止门拦一次。

第 3 步装上后又补了一处：固定入口第二行记着是哪一版放的（`# gatelight <版本> 放的`），会话开始的自动更新只升不降，`testpace status` 里更新的版本放的算"照常用"。原来只比内容，装着不同版本的 agent 轮流开会话时会把入口来回改。三份清单升到 0.17.9。（Codex 里装的还是 0.17.7，没有只升不降，开 Codex 会话会把入口改回去，等它更新。）

验收结果（2026-11-25，`~/Developer/agy-gatelight-try`：wall-sample 的副本，`full` 是 `node -e 0`；插件用链接装，指向这个分支的 worktree）：

| 项目 | 结果 |
|---|---|
| 会话开始的说明 | 过。SessionStart 钩子注入了 modwall、testpace 的说明，技能写成"gatelight 的 merge 技能"，带着 BypassSandbox 那句。系统提示的技能列表里是 `merge`、`modular` 这些短名字 |
| 固定入口自动更新 | 过。会话开始后 `~/.local/bin` 下三条入口第二行都成了 `# gatelight 0.17.9 放的` |
| 沙箱外跑 `testpace status`、`testpace focused` | 过。Auto 预设下申请 BypassSandbox 没有问用户 |
| 沙箱里跑 `testpace focused` | **没过，已改，2026-11-25 复测过**：拒了（退出码 2），说法错了，说"没找到装着的 gatelight"。实测沙箱里 `~/.claude`、`~/.codex`、`~/.gemini/config` 都**存在、读不了**（`[ -e ]` 真、`[ -r ]` 假、`ls` 失败），只有 `~/.gemini/config/plugins` 读得了，链接指向的插件目录读不了。入口拿"存在"判断在不在沙箱，判错了。第 1.1 节说的"看不见"是读不了，不是不存在。改成：三处有在的、却一个都读不了，才说在沙箱里；其余说没装（空的家目录里也说没装）。复测：新对话开始时入口换成了改后的内容（同一版本、内容不同也换），沙箱里说"读不了插件的安装目录……多半是在 agent 的沙箱里"，退出码 2 |
| 入口的提示开头少了字 | **没过，已改，2026-11-25 复测过**：输出开头是 `\xBC\x9A`，`testpace：` 整个没了。`"$name："` 里"："的第一个字节被 sh 当成变量名的一部分（UTF-8 语言环境下才会；C 语言环境下不会，合并时写测试才核对清楚，原先记反了），变量成了空的、还吃掉一个字节。`$claude、` 这些同样。main 上的入口也有这个问题，终端或别的 agent 在 UTF-8 语言环境下一样。改成变量都写 `${名字}`，测试在 C 和 UTF-8 两种语言环境下都核对开头不丢字；复测时沙箱里输出开头是完整的 `testpace：` |
| 改没有归属的文件 | 过。`write_file` 被 modwall 拦下，原因原样到了模型；只是 `<`、`>` 被 Antigravity 转成 `<`、`>`，模型自己认得出 |
| 直接跑 full 的命令 | 过。第一次被拒、说明原样到了模型，同一条命令第二次放行；拦过的记在会话状态的 `refused` |
| 合并门 | 过。`git merge --ff-only` 被 reference-transaction 钩子取消，main 没动。合并门自己的话里写的是 `gatelight:merge 技能`（命令的输出照原样，不换说法），模型看得懂 |
| 停止门 | 过。改了模块里的文件、没跑 `modwall check` 就结束，被拦一次；再结束放行 |
| `PLUGIN_DATA` | 过。是 `~/.gemini/antigravity/plugin_data/gatelight`，会话记录写在它下面的 `sessions/` |
| 给用户看的话（`user_markdown`） | 没碰到要说的情形（试验仓库已接入、入口装好），没看到。SessionStart 注入的说明在对话里是一条可展开的"Hook Json SessionStart"，用户点开看得到 |
| 说明里提到 `confirm_with_user` | 第 4 步加上了，2026-11-25 实测弹窗、拒绝、同意都过（见第 4 步） |

## 6. 不做的

- 不为 Antigravity 关沙箱、不改它的权限预设。
- 不接 CLI、IDE 两种形态，不发插件市场。
- 不在 Antigravity 下另写一套规则：规则只有一份。
- 不做可以被跳过的用户确认（2.6）。
