#!/bin/sh
# Codex 的 hook 入口：Codex 的 hook 环境里不一定有能运行 TypeScript 的 node，先找一个，再交给 testpace.ts（说明是 Codex）。
# 找不到 node 时不挡 Codex，但说一声。
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$dir/../bin/node.sh"
node=$(testpace_node) || { printf '%s\n' '{"systemMessage":"testpace hook 没有运行：找不到 22.18 以上的 node（要能直接运行 TypeScript）。装一个，或用 TESTPACE_NODE 指给它。"}'; exit 0; }
exec "$node" --disable-warning=ExperimentalWarning "$dir/testpace.ts" codex
