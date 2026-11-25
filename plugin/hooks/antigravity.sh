#!/bin/sh
# Antigravity 的 hook 入口（插件根上的 hooks.json 用它；hook 的工作目录是 hooks.json 所在的插件目录）：
# 先找一个能运行 TypeScript 的 node，再交给 testpace.ts（说明是 Antigravity）。
# Antigravity 下 hook 不干预时必须什么都不输出、退出码 0：PreToolUse 输出 {}、空的 decision、退出码非 0 都会把这次工具调用拦掉（实测）。
# 所以这里无论出了什么事（找不到 node、脚本抛错、node 自己退出码非 0）都只往标准错误说，退出码一律 0；不用 exec，好在 node 之后补上退出码。
# 唯一反过来的是调确认工具（gatelight 自己的 MCP 服务，ServerName 是 gatelight_gatelight，见 hookformat.ts）：
# 那次调用要靠这里输出 force_ask 才会弹窗问用户，出错了不输出就成了不问就执行，所以出错一律拒绝。
# 认它只看输入里的 "ServerName":"gatelight_gatelight"：别处（比如用户的话）出现这几个字时引号是转义过的，对不上。
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
input=$(cat)
confirm=
printf '%s' "$input" | grep -Eq '"ServerName"[[:space:]]*:[[:space:]]*"gatelight_gatelight"' && confirm=1
refuse() {
  echo "$1" >&2
  [ -z "$confirm" ] || printf '%s\n' '{"decision":"deny","reason":"gatelight 的 hook 出错了，这次确认没能弹窗给用户看，所以没有执行。告诉用户 hook 出错了，不要换别的办法记下同意。"}'
  exit 0
}
. "$dir/../bin/node.sh"
node=$(testpace_node) || refuse 'testpace hook 没有运行：找不到 22.18 以上的 node（要能直接运行 TypeScript）。装一个，或用 TESTPACE_NODE 指给它。'
output=$(printf '%s' "$input" | "$node" --disable-warning=ExperimentalWarning "$dir/testpace.ts" antigravity) || refuse "testpace hook 异常退出（$?），这次没有检查。"
# 确认工具的调用一定有输出（弹窗或拒绝）；没有就是哪里出错了
[ -n "$output" ] || [ -z "$confirm" ] || refuse 'testpace hook 对确认工具的调用没有给出结论。'
[ -z "$output" ] || printf '%s\n' "$output"
exit 0
