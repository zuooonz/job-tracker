#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
RUNTIME_DIR="/run/user/$(id -u)"
MONITOR_ENV="$ROOT/.run/boss-monitor.env"
SERVER_ENV="$ROOT/contrib/server.env"
if [[ -f "$ROOT/.env" ]]; then set -a; . "$ROOT/.env"; set +a; fi
MONITOR_API_URL="${MONITOR_API_URL:-${TRACKER_SERVER_URL:?请在 .env 设置 TRACKER_SERVER_URL}}"
mkdir -p "$USER_UNIT_DIR" "$ROOT/.run"
if [[ ! -f "$SERVER_ENV" ]]; then
  echo "缺少 $SERVER_ENV；先运行 python3 contrib/deploy.py env init"
  exit 1
fi
TRACKER_API_TOKEN="$(sed -n 's/^TRACKER_API_TOKEN=//p' "$SERVER_ENV" | head -n1)"
if [[ -z "$TRACKER_API_TOKEN" ]]; then
  echo "server.env 缺少 TRACKER_API_TOKEN"
  exit 1
fi
umask 077
printf 'TRACKER_API_URL=%s\nTRACKER_API_TOKEN=%s\n' "$MONITOR_API_URL" "$TRACKER_API_TOKEN" > "$MONITOR_ENV"
# 由模板渲染本机路径，仓库内不保存任何绝对路径
NODE_BIN="$(command -v node)"
sed -e "s#@ROOT@#$ROOT#g" -e "s#@NODE_BIN@#$NODE_BIN#g" -e "s#@NODE_DIR@#$(dirname "$NODE_BIN")#g" \
  "$ROOT/contrib/jobs-boss-monitor.service" > "$USER_UNIT_DIR/jobs-boss-monitor.service"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$RUNTIME_DIR}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$RUNTIME_DIR/bus}"
systemctl --user daemon-reload
systemctl --user disable jobs-boss-monitor.service >/dev/null 2>&1 || true
echo "已安装但未启用自启动。需要时显式运行："
echo "  systemctl --user start jobs-boss-monitor.service"
echo "监测器默认不随登录自动启动；仅显式 start 后运行。"
echo "查看状态："
echo "  systemctl --user status jobs-boss-monitor.service"
echo "监测 API：$MONITOR_API_URL（令牌已写入受限运行文件）"
