#!/bin/bash
# 以调试端口启动 Chrome 并加载 JobCopilot 扩展，使 tools/watch-reload.mjs 可以自动热重载。
# 注意：若 Chrome 已在运行，此命令会被忽略。请先完全退出 Chrome（Cmd+Q）再运行本脚本。
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
EXT="$(cd "$(dirname "$0")/.." && pwd)"
if ! "$CHROME" --version >/dev/null 2>&1; then
  echo "未找到 Chrome: $CHROME"
  exit 1
fi
"$CHROME" --remote-debugging-port=9222 --load-extension="$EXT" >/dev/null 2>&1 &
echo "Chrome 已启动（调试端口 9222，已加载 JobCopilot 扩展）"
echo "之后运行: node tools/watch-reload.mjs  即可在代码改动时自动重载扩展"
