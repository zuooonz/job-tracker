#!/usr/bin/env bash
# 本机招聘平台扫码登录：qr-login.sh boss|liepin [start|stop|status|log]
set -euo pipefail
cd "$(dirname "$0")"

platform="${1:-boss}"
action="${2:-start}"
case "$platform" in
  boss) script="qr-relay.js"; port=3081 ;;
  liepin) script="qr-relay-liepin.js"; port=3082 ;;
  *) echo "用法: $0 boss|liepin [start|stop|status|log]" >&2; exit 2 ;;
esac
case "$action" in start|stop|status|log) ;; *) echo "用法: $0 boss|liepin [start|stop|status|log]" >&2; exit 2 ;; esac

mkdir -p ../logs
log="../logs/qr-${platform}.log"
pidfile="../logs/qr-${platform}.pid"
url="http://127.0.0.1:${port}/"

case "$action" in
  start)
    if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo "中继已在运行 (pid $(cat "$pidfile"))"
    else
      nohup node "src/$script" >> "$log" 2>&1 &
      echo $! > "$pidfile"
      echo "✅ 已启动 (pid $(cat "$pidfile"))"
    fi
    echo "扫码页面: $url"
    ;;
  stop)
    if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      kill "$(cat "$pidfile")"
      echo "已停止 $platform 中继（Chrome 登录态保持）"
    else
      echo "$platform 中继未运行"
    fi
    rm -f "$pidfile"
    ;;
  status)
    if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo "运行中 (pid $(cat "$pidfile")) — $url"
      curl -s --max-time 3 "${url}status.json" || true
    else
      echo "未运行"
    fi
    ;;
  log) tail -f "$log" ;;
esac
