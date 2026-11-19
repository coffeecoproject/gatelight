---
name: setup-testcraft
description: 给项目接入 testcraft：确认已接入 testpace，建 .testcraft/ 目录和配置，补上项目里测试辅助文件的认法，并在示例改动上核对。用户要给项目接入 testcraft 时使用。
---

# 接入 testcraft

testcraft 和 testpace 在同一个插件里：它用 `testpace.json` 的 `files` 命令跑测试；仓库里有 `.testcraft/` 目录，`testpace full` 就会在测试之前跑一次 `testcraft check`，不用另外登记。

## 步骤

1. **确认接入了 testpace**：仓库根目录有 `testpace.json`，`testpace verify` 能过。没有就先用 `testpace:setup` 接入。
2. **建 `.testcraft/config.json`**。看一遍项目里的测试，常见命名之外的写进来：
   - `tests`：能单独跑、但名字不是 `*.test.*` / `*.spec.*` / `*_test.go` / `test_*.py` 的测试文件。
   - `helpers`：只给测试用的代码和数据，放在源码目录里、名字也不带 test 字样的（比如 `src/testing/**`、`**/*-test-support.ts` 已经默认认得）。
   - `contract`：测试的约定里、testcraft 自己认不出的文件：testpace 命令调到的脚本再读的配置（比如测试用的 compose 文件、测试库的初始化脚本），放在脚本目录之外、交给 node 这类命令跑的文件。命令直接写到的脚本、`package.json` 脚本写到的文件、shell 脚本再调的 `.sh`、交给 node 跑的 `scripts/` 里的文件已经默认认得。
   - `notTests`：名字或位置像测试、但项目的 `files` 命令不跑它的文件（比如手动跑的练习脚本 `e2e/import/`），或者其实是业务代码的（比如 `src/spec/`）。不写的话，改它们会被当成改了测试。
   - `timeoutSeconds`：跑一次测试最多等多久，默认 900。

   ```json
   { "helpers": ["services/api/src/fixtures-builder.ts"] }
   ```

   认不全也不会放过空洞测试，只会让"回旧代码跑"做不了、转去改坏证明，多花一点时间。

   这份配置合并后才生效：检查按"默认分支上原来那份"和"现在这份"里更严的一边判。分支上新加的 `notTests`、删掉的 `tests`、`helpers`、`contract` 条目，这次改动不算，合并以后才算；新加的 `tests`、`helpers`、`contract` 条目马上算。所以首次接入时写的 `notTests` 要等这次接入合并以后才起作用，`testcraft status` 会列出这次不算的地方。
3. **建 `.testcraft/changes/` 和 `.testcraft/rules/`**（各放一个 `.gitkeep`）。清单 `.testcraft/checklist/` 不用先建，第一次有写不成测试的坑时再加。
4. **核对**：在一个临时分支上加一个只检查"有返回值"的测试，`testcraft prove` 要拦下；把它改成检查具体结果，要能过。核对完删掉这个分支。
5. 把 `.testcraft/` 提交（提交前问用户）。

## 测试怎么连数据库

`testcraft prove` 和 `testcraft weaken` 在一次性副本里跑测试：把工作区复制一份，在副本里换文件。项目的 `files` 命令如果每次用 napbox 临时环境（`napbox run`、`up --temp`）新建库、按当前代码迁移，副本里直接能跑。测试连的是常驻的开发环境、库已经按新代码迁移过的，换回旧代码会对不上：先把测试改成用临时环境；做不到的，告诉用户这类测试只能用改坏证明。
