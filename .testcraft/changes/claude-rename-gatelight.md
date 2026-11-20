# claude/rename-gatelight

插件改名 gatelight（整体设计方案 9.6）：改插件名、介绍、技能前缀、确认工具所在的服务名；三条命令、`testpace.json`、记录目录不改。旧版本放的固定命令入口，会话开始时自动换成新的。

## 证明方式

- 固定命令入口按 gatelight 这个名字找装着的插件 —— 已有检查改了前提：`plugin/tests/agents.test.ts` 的"install 放到 ~/.local/bin/testpace；它转给这台机器上装着的最高版本"，假的安装目录按新名字建
- 会话开始时旧版本放的入口换成这一版的；没放过的不放；同名的别的文件不动 —— 新测试 `plugin/tests/agents.test.ts` 的"会话开始时：旧版本放的入口换成这一版的；没放过的不放；同名的别的文件不动"
- 市场清单里的插件名、确认工具所在的服务名、提示里"调用 gatelight 的 confirm_with_user 工具" —— 已有检查改了期望值（`plugin/tests/agents.test.ts`、`plugin/tests/base.test.ts`、`plugin/tests/wall/confirm.test.ts`、`plugin/tests/craft/module.test.ts`）
- 技能前缀（`gatelight:merge` 等 20 处）、插件的介绍、README、钩子配置的说明 —— 看代码：只是文字

## 清单

- `outside-repo-writes`：这次新写的仓库外位置是家目录下的固定命令入口（会话开始时更新旧入口）。`plugin/tests/helpers.ts` 的家目录隔离已经先单独落到默认分支（提交 `1139467`），这个分支合进了它，分叉点上就带隔离；进程里直接调的代码和测试起的命令都用临时家目录。隔离落地之前出过问题：这个分支的测试和放水检查两次把真实入口换成了没发布的新版（22:08、22:26），用户手动恢复（22:16、22:57）；第一次核对只比了修改时间，比的时候入口已经是被换掉的那份，没看出来。隔离落地、入口恢复后重新核对：先确认真实入口是该有的那份（`testpace status` 显示"已放好"，和默认分支的 `plugin/entry/testpace` 内容一样），留副本；跑相关测试（6 个文件，含直接调会话开始判断的和 `plugin/tests/wall/` 里真起 layermap 的，49 秒；之前按改动选出的 27 个文件 1 分 04 秒，用时没变长）、放水检查、证明，每步之后用 `cmp` 和副本比，内容都没变。现在没问题。条目的查法跟着改成比内容

## 放水理由

- `plugin/tests/agents.test.ts`：插件改了名，固定入口改成按新名字找装着的那份。假的安装目录从 `testpace/<版本>` 改成 `gatelight/<版本>`，安装记录里的键从 `testpace@m` 改成 `gatelight@m`，找不到时的报错和市场清单里的名字跟着改（名字改成从插件清单里取，并加查 `.mcp.json` 的服务名、Claude Code 的市场清单和它一样）。查的事情没变：按版本号挑最高的、只认装着的、只认装全的、同名的别的文件不覆盖
- `plugin/tests/base.test.ts`：确认工具所在的服务名从 `testpace` 改成 `gatelight`；检查让 agent 去调确认工具的那句话里，插件名跟着改。别的断言没动
- `plugin/tests/wall/confirm.test.ts`、`plugin/tests/craft/module.test.ts`：同一句话里的插件名从 testpace 改成 gatelight，别的没动
- `.testcraft/checklist/outside-repo-writes.md`：改了"怎么查"里核对真实那份的办法，是收紧。原来写的是跑测试前后看修改时间；改成跑之前先确认它是该有的样子、留副本，跑完比内容。原因：只看修改时间时，更早一次运行已经把它换掉的话看不出来（这次就是这样漏掉的）。触发条件和别的查法没动

## 给用户过目

- `plugin/tests/agents.test.ts`：原来查的是"固定命令入口能找到装着的 testpace 插件里最新的那份"；现在插件改名叫 gatelight，改成查"能找到装着的 gatelight 插件里最新的那份"，怎么挑没变。市场清单里登记的插件名也从 testpace 换成 gatelight，并多查一条：插件的名字在几份清单和确认工具那里都一样。另外新加了一条：旧入口在新会话开始时自动换成新的。你定的：插件叫 gatelight；旧入口"会话开始时自动更新"
- `plugin/tests/base.test.ts`：原来查的是提示里让 agent"调用 testpace 的确认工具"、工具所在的服务叫 testpace；现在插件改名，这两处都改成 gatelight。弹窗确认本身怎么查没有变
- `plugin/tests/wall/confirm.test.ts`、`plugin/tests/craft/module.test.ts`：同上，只是提示那句话里的插件名从 testpace 换成 gatelight
- `.testcraft/checklist/outside-repo-writes.md`：这条清单管的是"测试不能动你机器上真实的文件"。原来核对的办法是跑测试前后看那个文件的修改时间；现在改成先确认它是好的、留一份副本，跑完比内容。查得更严了，没有放松：只看时间的话，文件早先已经被换坏就看不出来，这次就是这样漏掉的
