#!/usr/bin/env bash
# AI 评分 worker —— 一键启动/停止/状态/日志
#
# 从 tracker 服务器的 evaluation_queue 领取岗位，调用 DeepSeek 评分并写回。
# 遵循服务器低谷调度：高峰时段只处理 immediate（手动"立即评分"）请求，
# 低谷时段自动批量处理 offpeak（入库自动排队）任务。
#
# 用法: ./eval-worker.sh [start|stop|status|log]
set -euo pipefail
CONTRIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$CONTRIB_DIR/.." && pwd)"
cd "$ROOT/automation"
# 从项目根 .env 读取 TRACKER_SERVER_URL / TRACKER_API_TOKEN（不在脚本中硬编码）
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi

API_URL="${TRACKER_API_URL:-${TRACKER_SERVER_URL:?请在 .env 设置 TRACKER_SERVER_URL}}"
TOKEN="${TRACKER_API_TOKEN:?请在 .env 设置 TRACKER_API_TOKEN}"
LOG="$ROOT/logs/eval-worker.log"
PIDFILE="$ROOT/logs/eval-worker.pid"

start() {
  mkdir -p "$ROOT/logs"
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "worker 已在运行 (pid $(cat "$PIDFILE"))"
    return 0
  fi
  TRACKER_API_URL="$API_URL" TRACKER_API_TOKEN="$TOKEN" \
    setsid nohup node src/evaluation-worker.js >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  echo "✅ 已启动 (pid $(cat "$PIDFILE"))，日志: $LOG"
  echo "   调度: 高峰只处理 immediate，低谷(18:00 后/早晨)自动批量处理 offpeak"
}

stop() {
  local pid="" found=""
  [ -f "$PIDFILE" ] && pid="$(cat "$PIDFILE")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" && echo "已停止"
  else
    found="$(pgrep -f "^node src/evaluation-worker.js$" || true)"
    if [ -n "$found" ]; then
      kill $found && echo "已停止"
    else
      echo "worker 未在运行"
    fi
  fi
  rm -f "$PIDFILE"
}

case "${1:-start}" in
  start)  start ;;
  stop)   stop ;;
  status)
    pid=""; found=""
    [ -f "$PIDFILE" ] && pid="$(cat "$PIDFILE")"
    found="$(pgrep -f "^node src/evaluation-worker.js$" || true)"
    if [ -n "$pid$found" ]; then
      echo "运行中 (pid ${pid:-$found})"
      tail -n 5 "$LOG" 2>/dev/null || true
    else
      echo "未在运行"
    fi ;;
  log)    tail -f "$LOG" ;;
  *) echo "用法: $0 [start|stop|status|log]"; exit 1 ;;
esac
