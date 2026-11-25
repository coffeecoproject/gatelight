# gatelight

给 agent 写代码把关的插件（Claude Code、Codex、Antigravity）：测试跑了没有、测试怎么写、代码有没有越界。

这个 npm 包就是插件本身。说明、规则和开发都在 [gatelight 仓库](https://github.com/coffeecoproject/gatelight)。

## 安装

Claude Code：

```sh
claude plugin marketplace add coffeecoproject/gatelight-marketplace
claude plugin install gatelight@gatelight
```

Codex（要本机装着 `npm`）：

```sh
codex plugin marketplace add coffeecoproject/gatelight-marketplace
codex plugin add gatelight@gatelight
```

Antigravity（桌面 App）：

```sh
npx gatelight setup antigravity     # 装上，或换成这一版
npx gatelight remove antigravity    # 卸掉
```

需要 Node 22.18 以上，合并门要 git 2.54 以上。装好后开新会话，前提和用法见仓库的 README。
