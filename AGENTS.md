# 在 gatelight 仓库里开发

- 需要 Node 22.18 以上（直接运行 TypeScript，不构建）和 git 2.54 以上（PATH 里排在前面的那个，合并门的测试要用）。测试用自己的全局 git 配置，不读也不改 `~/.gitconfig`。
- 仓库自己接入了 testpace、testcraft：先 `npm install`（worktree 里不跑 `npm ci`，把主目录的 `node_modules` 链过来），改完跑 `testpace focused`，合回 main 照 gatelight:merge。`files` 用本机装的 testpace 跑，不用仓库里正在改的这一版：正在改的跑法坏了（比如吞掉失败）不会连整组的结论一起带坏；`testpace run` 自己的测试另外调 `plugin/bin/testpace`。
- 源码的边界：底座（`plugin/src/base/`）不引用检查模块，检查模块之间不互相引用，lint 查。
- 本机用的插件：Claude Code 从仓库主目录的 `plugin/` 当场读（本地市场），main 一快进就是新代码；命令行的 `testpace` 走 `~/.local/bin` 的入口，转给装着的最高版本。说"哪一版在生效"两处都查。Antigravity 在 `~/.gemini/config/plugins/gatelight` 放一个指向 `plugin/` 的链接。
- 升版本：三份插件清单（`plugin/.claude-plugin/`、`.codex-plugin/`、`.antigravity-plugin/` 的 `plugin.json`）和 `plugin/package.json` 一起升，和代码在同一个分支、放在最后一轮验证之前（合并后再单独升，证明记录要全部重跑）。`.testcraft/defaults` 记的是 gatelight 自己补到了哪一版的默认清单条目，不跟着升。
- 发布由用户在自己的终端里做：`npm login` 后在 `plugin/` 里 `npm publish`（浏览器确认，不带 `--otp`）。gatelight-marketplace 不写版本，不用改。
