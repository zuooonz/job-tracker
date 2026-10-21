#!/usr/bin/env bash
# 启动爬虫专用 Chrome（CDP 18800）。
# 模式开关：BROWSER_MODE=auto|headless|headed（默认 auto）
#   headless：无图形会话（SSH/服务器）下使用，配合 stealth 反检测
#   headed  ：有桌面环境时使用，反爬检测更宽松（BOSS/猎聘 lp-security）
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${JOB_TRACKER_BROWSER_PROFILE:-$ROOT/data/browser-profile}"
LOG="$ROOT/logs/browser.log"
MODE="${BROWSER_MODE:-auto}"

DISPLAY_NUMBER="${DISPLAY#:}"
DISPLAY_NUMBER="${DISPLAY_NUMBER%%.*}"
if [[ -z "${DISPLAY:-}" || ! -S "/tmp/.X11-unix/X${DISPLAY_NUMBER}" ]]; then
  SOCKET="$(find /tmp/.X11-unix -maxdepth 1 -type s -user "$(id -u)" -name 'X*' -printf '%T@ %f\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2-)"
  [[ -n "$SOCKET" ]] && export DISPLAY=":${SOCKET#X}"
fi
if [[ "$MODE" == "auto" ]]; then
  if [[ -n "${DISPLAY:-}" ]]; then MODE="headed"; else MODE="headless"; fi
fi

EXTRA_ARGS=()
if [[ "$MODE" == "headless" ]]; then
  EXTRA_ARGS=(--headless=new --disable-dev-shm-usage --disable-crash-reporter \
    --enable-unsafe-swiftshader --lang=zh-CN \
    --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$(/usr/bin/google-chrome-stable --version | grep -oE '[0-9]+' | head -1).0.0.0 Safari/537.36")
fi

exec setsid /usr/bin/google-chrome-stable \
  --no-sandbox --disable-setuid-sandbox \
  --disable-blink-features=AutomationControlled \
  --disable-background-timer-throttling --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  --window-size=1440,900 \
  "${EXTRA_ARGS[@]}" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port=18800 \
  about:blank > "$LOG" 2>&1 < /dev/null
