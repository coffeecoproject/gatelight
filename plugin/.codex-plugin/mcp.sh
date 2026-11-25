#!/bin/sh
# Codex 起确认工具服务的入口（.codex-plugin/mcp.json）：Codex 起服务的环境里不一定有能运行 TypeScript 的 node，先找一个，
# 再起 src/mcp.ts（参数 codex：服务自己向 Codex 发表单问用户）。找不到 node 时说一声、退出，Codex 里就没有这个工具。
dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$dir/bin/node.sh"
node=$(testpace_node) || { echo "gatelight 的确认工具没有启动：找不到 22.18 以上的 node（要能直接运行 TypeScript）。装一个，或用 TESTPACE_NODE 指给它。" >&2; exit 1; }
exec "$node" --disable-warning=ExperimentalWarning "$dir/src/mcp.ts" codex
