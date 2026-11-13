---
name: setup
description: 给项目接入 testpace：写仓库根目录的 testpace.json，配好 fast、files、full 三条命令并验证。用户要给项目接入 testpace、配置 testpace.json，或 testpace 报"仓库根目录没有 testpace.json"、配置有问题时使用。
---

# 给项目接入 testpace

testpace 只靠仓库根目录的 `testpace.json` 认项目：有它，命令和 hook（合并门、停止门、测试节奏提醒）才对这个仓库起作用。接入只需要写这个文件、配好三条命令。testpace 不管测试怎么写，接入时不要改测试本身，也不要替项目加 lint、加依赖。

## testpace.json

```json
{
  "fast": "pnpm -s check:fast",
  "files": "pnpm -s test:files",
  "full": "pnpm -s test:full",
  "ignore": ["docs/**"]
}
```

| 字段 | 要做到什么 |
|---|---|
| `fast` | 快速检查，通常是类型检查加 lint，应当是增量的（几秒到十几秒）。`testpace focused` 每次先跑它 |
| `files` | 只跑给定的测试文件。testpace 把文件路径（相对仓库根目录）接在命令后面传进去。环境（数据库、服务）自己准备；有文件不存在，或有文件一个测试都没跑，返回非零 |
| `full` | 落地到默认分支前必须通过的全部检查和测试。合并门只认 `testpace full` 跑出的通过记录 |
| `ignore` | 可选。不影响测试的路径，改了它们不用重跑。`**` 跨目录，`*` 不跨目录，结尾 `/` 表示整个目录。不要写 `**/*.md` 这类通配 |

三条命令都从仓库根目录运行、不需要交互、退出码 0 表示通过。不能有别的字段。

## 步骤

1. **找项目已有的命令**：看 `package.json` 的 scripts、Makefile、CI 配置、README。三条命令尽量直接用现成的，不另造一套；不是 JavaScript 项目（Go、Python、Swift 等）也一样写三条命令。缺哪一条（比如没有类型检查可做 `fast`，或说不清落地前该跑哪些算 `full`），问用户，不要自己定。
2. **`files` 接不了文件路径时**，写一个小脚本包一层（比如 `scripts/testpace.sh files a.test.ts b.test.ts`），把路径交给测试框架。很多测试框架把参数当成筛选条件：给了几个文件、其中一个不存在时，只跑找得到的那些，照样报通过。所以脚本要自己检查每个文件都存在、每个文件都跑到了测试，否则返回非零。
3. **写 `testpace.json`**，放在仓库根目录，进版本库。
4. **改项目说明**：项目给 agent 的说明（CLAUDE.md、AGENTS.md 等）里写着直接跑测试命令的地方，改成 testpace 的命令。直接跑项目自己的命令不留记录，合并门不认。
5. **检查**：
   - `testpace status`：配置那一行应当是"正常"，三条命令都找得到。
   - `testpace files <一个测试文件>`：应当通过；再同时给一个真的和一个不存在的路径，应当失败。
   - 所有改动都做完后，把 `testpace full` 放后台跑一次，确认整组能通过，顺便知道它要跑多久。
6. **提交前先问用户**。接入后，提交、合并、推送到默认分支都要有落地那份代码的整组通过记录。记录按跑的那一刻工作区的内容算：第 5 步的整组跑完后又改了文件（`ignore` 里的除外），要再跑一次，合并门才会放行。

## 接入以后的节奏

- 改完先跑 `testpace focused`：`fast` 加上和改动相关的测试。它提示跑整组时照做。
- 一个阶段做完，把 `testpace full` 放后台跑。
- 有失败，用 `testpace files <测试文件>` 只重跑失败的文件，修好后再交一次整组。

`focused` 靠 layermap 按改动选测试：PATH 里要有 `layermap` 命令（装上 layermap 插件并开新会话就有）。没有时 `focused` 只跑 `fast`，然后建议跑整组；其余命令和合并门照常。
