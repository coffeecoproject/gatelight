# 找一个能直接运行 TypeScript 的 node（22.18 及以上），打印它的路径；找不到返回 1。
# bin/testpace 和 Codex 的 hook 入口共用（. 进来再调 testpace_node）。git 钩子、Codex 的命令和 hook 的环境里，
# PATH 上的 node 不一定够新，依次试 TESTPACE_NODE、PATH 里的 node、nvm 装的各个版本（从新到旧）、Homebrew。
testpace_node() {
  testpace_ok='const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'
  for testpace_try in "$TESTPACE_NODE" "$(command -v node 2>/dev/null)" $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -rV) /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$testpace_try" ] && [ -x "$testpace_try" ] || continue
    if "$testpace_try" -e "$testpace_ok" 2>/dev/null; then
      printf '%s\n' "$testpace_try"
      return 0
    fi
  done
  return 1
}
