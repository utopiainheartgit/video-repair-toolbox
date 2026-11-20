#!/bin/bash
# 双击此文件即可启动视频工具箱（修复 / 合并）并打开网页。
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8731}"
URL="http://127.0.0.1:${PORT}"

echo "============================================"
echo "  视频工具箱 · 修复 / 合并"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
    [ -x "$p" ] && export PATH="$(dirname "$p"):$PATH" && break
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 找不到 Node.js。请先安装： brew install node"
  read -r -p "按回车键退出…" _; exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  [ -x /opt/homebrew/bin/ffmpeg ] && export PATH="/opt/homebrew/bin:$PATH"
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "✗ 找不到 ffmpeg。请先安装： brew install ffmpeg"
  read -r -p "按回车键退出…" _; exit 1
fi

echo "✓ node   $(node -v)"
echo "✓ ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f1-3)"
if [ -x "vendor/untrunc/untrunc-81" ] || [ -x "vendor/untrunc/untrunc" ]; then
  echo "✓ untrunc 已就绪（可修复 moov 索引缺失）"
else
  echo "⚠ untrunc 未编译，moov 缺失的文件将无法用索引重建修复"
fi
echo

# Already running? Just open the page.
if curl -s -o /dev/null --max-time 2 "${URL}/api/capabilities"; then
  echo "服务已在运行，直接打开网页。"
else
  echo "启动本地服务（仅监听 127.0.0.1，不对外网开放）…"
  PORT="$PORT" node server.mjs &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM
  for _ in $(seq 1 40); do
    curl -s -o /dev/null --max-time 1 "${URL}/api/capabilities" && break
    sleep 0.25
  done
fi

# Everything runs on real local paths, so any modern browser works; Chromium
# builds are preferred because the native-picker flow is smoothest there.
OPENED=""
for APP in "Google Chrome" "Microsoft Edge" "Chromium" "Brave Browser" "Arc"; do
  if [ -d "/Applications/${APP}.app" ]; then
    open -a "$APP" "$URL" && OPENED="$APP" && break
  fi
done
if [ -z "$OPENED" ]; then
  echo "⚠ 未检测到 Chrome/Edge，用默认浏览器打开。"
  echo "  功能不受影响（全程走本地路径），只是原生选择器体验略差。"
  open "$URL"
else
  echo "✓ 已在 ${OPENED} 中打开"
fi

echo
echo "地址： ${URL}"
echo "关闭此窗口或按 Ctrl+C 即可停止服务。"
echo
wait $SERVER_PID 2>/dev/null