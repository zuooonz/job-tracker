#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
LOG_DIR="$ROOT/logs"
BACKEND_PID="$RUN_DIR/backend.pid"
FRONTEND_PID="$RUN_DIR/frontend.pid"
EVALUATION_WORKER_PID="$RUN_DIR/evaluation-worker.pid"
BOSS_CHAT_MONITOR_PID="$RUN_DIR/boss-chat-monitor.pid"
BACKEND_PORT=8888
FRONTEND_PORT=5175
BROWSER_PORT=18800
BROWSER_PROFILE="$ROOT/data/browser-profile"
BROWSER_LOG="$LOG_DIR/browser.log"

# 加载项目根 .env（KEY=value 行）到进程环境：
# 在 .env 里配置 TRACKER_LOGIN_PASSWORD 即可本地开启登录页，TRACKER_API_TOKEN 供采集器使用。
if [ -f "$ROOT/.env" ]; then
  while IFS= read -r line; do
    case "$line" in
      \#*|'') continue ;;
      *=*) export "$line" ;;
    esac
  done < "$ROOT/.env"
fi

mkdir -p "$RUN_DIR" "$LOG_DIR" "$ROOT/data"

is_running() {
  local pid_file="$1"
  test -f "$pid_file" && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

user_systemctl() {
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
  DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}" \
    systemctl --user "$@"
}

monitor_service_installed() {
  user_systemctl cat jobs-boss-monitor.service >/dev/null 2>&1
}

status() {
  if is_running "$BACKEND_PID"; then echo "Backend: running (http://127.0.0.1:$BACKEND_PORT)"; else echo "Backend: stopped"; fi
  if is_running "$FRONTEND_PID"; then echo "Frontend: running (http://127.0.0.1:$FRONTEND_PORT)"; else echo "Frontend: stopped"; fi
  if is_running "$EVALUATION_WORKER_PID"; then echo "Evaluation worker: running"; else echo "Evaluation worker: stopped"; fi
  if is_running "$BOSS_CHAT_MONITOR_PID" || user_systemctl is-active --quiet jobs-boss-monitor.service 2>/dev/null; then
    echo "BOSS chat monitor: running"
  else
    echo "BOSS chat monitor: stopped"
  fi
}

automation_status() {
  curl -fsS -H "Authorization: Bearer ${TRACKER_API_TOKEN:-}" "http://127.0.0.1:$BACKEND_PORT/api/automation/budget" | python3 -m json.tool
}

automation_reset_cooldown() {
  local platform="${1:-}"
  if [[ "$platform" != "boss" && "$platform" != "liepin" ]]; then echo "用法：$0 automation-reset-cooldown boss|liepin" >&2; return 2; fi
  curl -fsS -X POST -H "Authorization: Bearer ${TRACKER_API_TOKEN:-}" -H 'Content-Type: application/json' \
    -d "{\"action\":\"reset_cooldown\",\"platform\":\"$platform\"}" "http://127.0.0.1:$BACKEND_PORT/api/automation/budget" | python3 -m json.tool
}

boss_chat_monitor_start() {
  if user_systemctl is-active --quiet jobs-boss-monitor.service 2>/dev/null || is_running "$BOSS_CHAT_MONITOR_PID"; then return 0; fi
  if monitor_service_installed; then
    user_systemctl start jobs-boss-monitor.service
    echo "BOSS chat monitor started (systemd user service)"
    return 0
  fi
  browser_start
  cd "$ROOT/automation"
  setsid nohup node src/boss-chat-monitor.js "$@" > "$LOG_DIR/boss-chat-monitor.log" 2>&1 < /dev/null &
  echo $! > "$BOSS_CHAT_MONITOR_PID"
  echo "BOSS chat monitor started (pid $(cat "$BOSS_CHAT_MONITOR_PID"))"
}

boss_chat_monitor_stop() {
  if monitor_service_installed; then user_systemctl stop jobs-boss-monitor.service; fi
  stop_one "$BOSS_CHAT_MONITOR_PID"
}

evaluation_worker_start() {
  if is_running "$EVALUATION_WORKER_PID"; then return 0; fi
  cd "$ROOT/automation"
  setsid nohup node src/evaluation-worker.js > "$LOG_DIR/evaluation-worker.log" 2>&1 < /dev/null &
  echo $! > "$EVALUATION_WORKER_PID"
}

browser_status() {
  if curl -fsS "http://127.0.0.1:$BROWSER_PORT/json/version" >/dev/null 2>&1; then
    echo "Browser: running (CDP http://127.0.0.1:$BROWSER_PORT)"
  else
    echo "Browser: stopped"
    return 1
  fi
}

browser_start() {
  if browser_status >/dev/null 2>&1; then return 0; fi
  # auto：有可用 X socket 时用有头模式，否则用无头模式。
  local requested_mode="${BROWSER_MODE:-auto}"
  local mode="$requested_mode"
  local runtime_dir="/run/user/$(id -u)"
  local xauthority=""
  local detected_display="${DISPLAY:-}"
  local display_number="${detected_display#:}"
  display_number="${display_number%%.*}"
  if [[ -z "$detected_display" || ! -S "/tmp/.X11-unix/X${display_number}" ]]; then
    local socket=""
    socket="$(find /tmp/.X11-unix -maxdepth 1 -type s -user "$(id -u)" -name 'X*' -printf '%T@ %f\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2-)"
    [[ -n "$socket" ]] && detected_display=":${socket#X}"
  fi
  if [[ "$mode" == "auto" ]]; then
    if [[ -n "$detected_display" ]]; then mode="headed"; else mode="headless"; fi
  fi
  xauthority="$(find "$runtime_dir" -maxdepth 1 -type f -name '.mutter-Xwaylandauth.*' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2-)"
  mkdir -p "$BROWSER_PROFILE" "$LOG_DIR"
  local headless_args=()
  if [[ "$mode" == "headless" ]]; then
    headless_args=(--headless=new --disable-dev-shm-usage --disable-crash-reporter \
      --enable-unsafe-swiftshader --lang=zh-CN \
      --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$(/usr/bin/google-chrome-stable --version | grep -oE '[0-9]+' | head -1).0.0.0 Safari/537.36")
  fi
  echo "Browser mode: $mode${detected_display:+ (DISPLAY=$detected_display)}"
  DISPLAY="${detected_display:-:0}" XDG_RUNTIME_DIR="$runtime_dir" XAUTHORITY="$xauthority" \
    setsid nohup /usr/bin/google-chrome-stable \
      --user-data-dir="$BROWSER_PROFILE" \
      --remote-debugging-port="$BROWSER_PORT" \
      --disable-blink-features=AutomationControlled \
      --disable-background-timer-throttling --disable-renderer-backgrounding \
      --disable-backgrounding-occluded-windows \
      --no-first-run --no-default-browser-check \
      "${headless_args[@]}" \
      https://www.zhipin.com/ >"$BROWSER_LOG" 2>&1 < /dev/null &
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$BROWSER_PORT/json/version" >/dev/null 2>&1; then
      browser_status
      return 0
    fi
    sleep 1
  done
  echo "Browser start failed; check $BROWSER_LOG"
  return 1
}

browser_stop() {
  if ! browser_status >/dev/null 2>&1; then return 0; fi
  node -e 'fetch("http://127.0.0.1:18800/json/version").then(r=>r.json()).then(({webSocketDebuggerUrl})=>{const ws=new WebSocket(webSocketDebuggerUrl);ws.onopen=()=>ws.send(JSON.stringify({id:1,method:"Browser.close"}));ws.onerror=()=>process.exitCode=1})'
}

ensure_local_headed_browser() {
  # --local-headed-login 明确要求本机可见窗口；若 18800 当前是 headless，先优雅关闭再重启。
  if browser_status >/dev/null 2>&1 && pgrep -af 'remote-debugging-port=18800' | grep -q -- '--headless'; then
    echo "检测到现有无头浏览器，正在切换为本机有头模式..."
    browser_stop
    for _ in $(seq 1 20); do
      browser_status >/dev/null 2>&1 || break
      sleep 1
    done
  fi
  BROWSER_MODE=headed browser_start
}

start() {
  if ! is_running "$BACKEND_PID"; then
    cd "$ROOT/backend"
    setsid nohup python3 -m uvicorn main:app --host 127.0.0.1 --port "$BACKEND_PORT" > "$LOG_DIR/backend.log" 2>&1 < /dev/null &
    echo $! > "$BACKEND_PID"
  fi
  if ! is_running "$FRONTEND_PID"; then
    cd "$ROOT/frontend"
    setsid nohup ./node_modules/.bin/vite --host 0.0.0.0 --port "$FRONTEND_PORT" > "$LOG_DIR/frontend.log" 2>&1 < /dev/null &
    echo $! > "$FRONTEND_PID"
  fi
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$BACKEND_PORT/" >/dev/null && curl -fsS "http://127.0.0.1:$FRONTEND_PORT/" >/dev/null; then
      # 演示模式不启动评价 worker，避免对虚构岗位调用模型
      [[ "${TRACKER_DEMO:-}" == "1" ]] || evaluation_worker_start
      status
      return 0
    fi
    sleep 1
  done
  echo "服务启动未完成，请检查 $LOG_DIR"; return 1
}

demo() {
  # 用虚构数据体验完整界面：独立数据库 data/demo.sqlite3，不影响真实数据
  export TRACKER_DB_PATH="$ROOT/data/demo.sqlite3"
  export TRACKER_DEMO=1
  # 演示使用公开示例配置的独立副本，不读取本机私有配置
  export TRACKER_CONFIG_DIR="$ROOT/data/demo-config"
  if [[ ! -f "$TRACKER_DB_PATH" || "${1:-}" == "--reset" ]]; then
    python3 "$ROOT/scripts/seed_demo.py" --db "$TRACKER_DB_PATH"
  fi
  start
}

stop_one() {
  local pid_file="$1"
  if is_running "$pid_file"; then kill "$(cat "$pid_file")"; fi
  rm -f "$pid_file"
}

stop() { boss_chat_monitor_stop; stop_one "$EVALUATION_WORKER_PID"; stop_one "$BACKEND_PID"; stop_one "$FRONTEND_PID"; }

collect() {
  local source="${1:?Usage: ./scripts/manage.sh collect boss-or-liepin KEYWORD [options]}"
  local keyword="${2:?Usage: ./scripts/manage.sh collect boss-or-liepin KEYWORD [options]}"
  shift 2
  browser_start
  cd "$ROOT/automation"
  npm run collect -- --source="$source" --keyword="$keyword" "$@"
}

collect_plan() {
  local dry_run=0
  local remote_api=0
  for arg in "$@"; do
    if [[ "$arg" == "--dry-run" ]]; then dry_run=1; fi
    # 推送模式下采集器直连服务器 API，无需启动本机后端/前端/worker
    if [[ "$arg" == "--api="* ]]; then remote_api=1; fi
  done
  if [[ "$dry_run" -eq 1 ]]; then
    cd "$ROOT/automation"
    npm run collect-plan -- "$@"
    return
  fi
  if [[ "$remote_api" -eq 0 ]]; then
    start
  fi
  browser_start
  cd "$ROOT/automation"
  npm run collect-plan -- "$@"
}

evaluate() {
  local mode="${1:-preview}"
  shift || true
  cd "$ROOT/automation"
  npm run evaluate -- --mode="$mode" "$@"
}

apply_records() {
  cd "$ROOT/automation"
  npm run apply-records -- "$@"
}

boss_chat_snapshot() {
  cd "$ROOT/automation"
  npm run boss-chat-snapshot -- "$@"
}

chat_latest_local() {
  start
  ensure_local_headed_browser
  export BROWSER_MODE=headed
  export BROWSER_REUSE_WORK_PAGE=1
  export TRACKER_API_URL="http://127.0.0.1:$BACKEND_PORT"
  cd "$ROOT/automation"
  node src/local-headed-login.js "--login-timeout=${LOCAL_LOGIN_TIMEOUT_MINUTES:-60}"
  npm run boss-chat-snapshot
  npm run chat-pipeline -- --only=liepin \
    "--stale-after=${CHAT_STALE_AFTER_HOURS:-24}" \
    --delay-min=18000 --delay-max=30000 --batch-size=3 \
    --batch-break-min=45000 --batch-break-max=75000
}

chat_pipeline() {
  local local_headed=0
  for arg in "$@"; do
    if [[ "$arg" == "--local-headed-login" ]]; then local_headed=1; fi
  done
  if [[ "$local_headed" -eq 1 ]]; then
    start
    ensure_local_headed_browser
    export BROWSER_MODE=headed
    export BROWSER_REUSE_WORK_PAGE=1
    export TRACKER_API_URL="http://127.0.0.1:$BACKEND_PORT"
  fi
  cd "$ROOT/automation"
  npm run chat-pipeline -- "$@"
}

chat_summarize() {
  cd "$ROOT/automation"
  npm run chat-summarize -- "$@"
}

qr_login() {
  local platform="${1:-boss}"
  shift || true
  local script="src/qr-relay.js"
  local port=3081
  if [[ "$platform" == "liepin" ]]; then script="src/qr-relay-liepin.js"; port=3082; fi
  if [[ "$platform" != "boss" && "$platform" != "liepin" ]]; then
    echo "用法: $0 qr-login boss|liepin [--exit-after-login]" >&2
    return 2
  fi
  cd "$ROOT/automation"
  echo "扫码页面: http://127.0.0.1:$port/"
  node "$script" "$@"
}

verify_status() {
  cd "$ROOT/automation"
  npm run verify-status -- "$@"
}

case "${1:-}" in
  start) start ;; demo) shift; demo "$@" ;; stop) stop ;; restart) stop; start ;; status) status ;;
  browser-start) browser_start ;; browser-stop) browser_stop ;; browser-status) browser_status ;;
  collect) shift; collect "$@" ;;
  collect-plan) shift; collect_plan "$@" ;;
  evaluate) shift; evaluate "$@" ;;
  apply-records) shift; apply_records "$@" ;;
  boss-chat-snapshot) shift; boss_chat_snapshot "$@" ;;
  chat-latest-local) shift; chat_latest_local "$@" ;;
  chat-pipeline) shift; chat_pipeline "$@" ;;
  chat-summarize) shift; chat_summarize "$@" ;;
  qr-login) shift; qr_login "$@" ;;
  verify-status) shift; verify_status "$@" ;;
  boss-chat-monitor-start) shift; boss_chat_monitor_start "$@" ;;
  boss-chat-monitor-stop) boss_chat_monitor_stop ;;
  automation-status) automation_status ;;
  automation-reset-cooldown) shift; automation_reset_cooldown "$@" ;;
  *) echo "Usage: $0 {start|demo [--reset]|stop|restart|status|browser-start|browser-stop|browser-status|collect|collect-plan|evaluate|boss-chat-snapshot|chat-latest-local|chat-pipeline|chat-summarize|boss-chat-monitor-start|boss-chat-monitor-stop|automation-status|automation-reset-cooldown boss|liepin|qr-login boss|liepin|verify-status}"; exit 1 ;;
esac
