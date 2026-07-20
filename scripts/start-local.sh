#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
LOG_DIR="$RUNTIME_DIR/logs"
API_PID_FILE="$RUNTIME_DIR/api.pid"
WEB_PID_FILE="$RUNTIME_DIR/web.pid"
API_LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.virtual-resource-console.api.plist"
API_LAUNCH_LABEL="com.virtual-resource-console.api"
WEB_LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.virtual-resource-console.web.plist"
WEB_LAUNCH_LABEL="com.virtual-resource-console.web"
USER_DOMAIN="gui/$(id -u)"

mkdir -p "$LOG_DIR"

seed_ip_pools_config() {
  local data_dir="${VRC_DATA_DIR:-$HOME/.virtual-resource-console}"
  local target_file="$data_dir/ip-pools.json"
  local source_file="$ROOT_DIR/config/ip-pools.json"
  if [[ -f "$target_file" || ! -f "$source_file" ]]; then
    return 0
  fi
  mkdir -p "$data_dir"
  cp "$source_file" "$target_file"
  chmod 600 "$target_file" 2>/dev/null || true
  echo "IP 池默认配置已写入: $target_file"
}

is_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

port_in_use() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

detect_lan_ip() {
  local ip
  for iface in en0 en1 en2 en3 en4 en5; do
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    if is_usable_lan_ip "$ip"; then
      printf '%s\n' "$ip"
      return 0
    fi
  done
  ip="$(python3 - <<'PY'
import socket
def usable(ip):
    return (
        ip.startswith("10.")
        or ip.startswith("172.16.")
        or ip.startswith("172.17.")
        or ip.startswith("172.18.")
        or ip.startswith("172.19.")
        or ip.startswith("172.20.")
        or ip.startswith("172.21.")
        or ip.startswith("172.22.")
        or ip.startswith("172.23.")
        or ip.startswith("172.24.")
        or ip.startswith("172.25.")
        or ip.startswith("172.26.")
        or ip.startswith("172.27.")
        or ip.startswith("172.28.")
        or ip.startswith("172.29.")
        or ip.startswith("172.30.")
        or ip.startswith("172.31.")
        or ip.startswith("192.168.")
    )
for _, _, _, _, sockaddr in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
    ip = sockaddr[0]
    if usable(ip):
        print(ip)
        raise SystemExit(0)
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.connect(("1.1.1.1", 80))
    ip = s.getsockname()[0]
    if usable(ip):
        print(ip)
finally:
    s.close()
PY
)"
  if is_usable_lan_ip "$ip"; then
    printf '%s\n' "$ip"
    return 0
  fi
  printf '127.0.0.1\n'
}

is_usable_lan_ip() {
  local ip="${1:-}"
  [[ -n "$ip" ]] || return 1
  [[ "$ip" != 127.* ]] || return 1
  [[ "$ip" != 169.254.* ]] || return 1
  [[ "$ip" != 198.18.* ]] || return 1
  [[ "$ip" == 10.* || "$ip" == 192.168.* || "$ip" =~ ^172\\.(1[6-9]|2[0-9]|3[0-1])\\. ]]
}

cd "$ROOT_DIR"
seed_ip_pools_config
lan_ip="$(detect_lan_ip)"

write_api_launch_agent() {
  python3 - "$API_LAUNCH_AGENT" "$ROOT_DIR" "$LOG_DIR" <<'PY'
import plistlib
import shlex
import sys

plist_path, root_dir, log_dir = sys.argv[1:4]
command = (
    f"cd {shlex.quote(root_dir)} && "
    f"HOST=0.0.0.0 PORT=3987 "
    f"VRC_RUNTIME_MODE=web "
    "exec node apps/api/dist/index.js"
)
data = {
    "Label": "com.virtual-resource-console.api",
    "ProgramArguments": [
        "/bin/zsh",
        "-lc",
        command,
    ],
    "WorkingDirectory": root_dir,
    "RunAtLoad": True,
    "KeepAlive": True,
    "EnvironmentVariables": {
        "NODE_ENV": "development",
    },
    "StandardOutPath": f"{log_dir}/api.launchd.log",
    "StandardErrorPath": f"{log_dir}/api.launchd.err.log",
}
with open(plist_path, "wb") as fp:
    plistlib.dump(data, fp)
PY
}

if [[ -f "$API_LAUNCH_AGENT" ]]; then
  if launchctl print "$USER_DOMAIN/$API_LAUNCH_LABEL" >/dev/null 2>&1; then
    launchctl bootout "$USER_DOMAIN" "$API_LAUNCH_AGENT" 2>/dev/null || launchctl bootout "$USER_DOMAIN/$API_LAUNCH_LABEL" 2>/dev/null || true
  fi
  write_api_launch_agent
  launchctl bootstrap "$USER_DOMAIN" "$API_LAUNCH_AGENT"
  launchctl enable "$USER_DOMAIN/$API_LAUNCH_LABEL"
  echo "API 已交给 launchd 启动: $API_LAUNCH_LABEL"
  echo "API 日志: $LOG_DIR/api.launchd.log"
elif is_running "$API_PID_FILE"; then
  echo "API 已运行: $(cat "$API_PID_FILE")"
elif port_in_use 3987; then
  echo "API 端口 3987 已被其他进程占用，未重复启动。"
else
  lan_ip="$(detect_lan_ip)"
  export HOST="${HOST:-0.0.0.0}"
  export PORT="${PORT:-3987}"
  export VRC_RUNTIME_MODE="${VRC_RUNTIME_MODE:-web}"
  nohup npm --workspace apps/api run dev:serve >"$LOG_DIR/api.log" 2>&1 &
  echo "$!" >"$API_PID_FILE"
  echo "API 已启动: $(cat "$API_PID_FILE")"
  echo "API 日志: $LOG_DIR/api.log"
fi

if [[ -f "$WEB_LAUNCH_AGENT" ]]; then
  if launchctl print "$USER_DOMAIN/$WEB_LAUNCH_LABEL" >/dev/null 2>&1; then
    echo "Web 已由 launchd 托管运行: $WEB_LAUNCH_LABEL"
  else
    launchctl bootstrap "$USER_DOMAIN" "$WEB_LAUNCH_AGENT"
    launchctl enable "$USER_DOMAIN/$WEB_LAUNCH_LABEL"
    echo "Web 已交给 launchd 启动: $WEB_LAUNCH_LABEL"
  fi
  rm -f "$WEB_PID_FILE"
  echo "Web 日志: $LOG_DIR/web.launchd.log"
elif is_running "$WEB_PID_FILE"; then
  echo "Web 已运行: $(cat "$WEB_PID_FILE")"
elif port_in_use 5173; then
  echo "Web 端口 5173 已被其他进程占用，未重复启动。"
else
  nohup bash -c "cd '$ROOT_DIR/apps/web' && exec '$ROOT_DIR/node_modules/.bin/vite' --host 0.0.0.0" >"$LOG_DIR/web.log" 2>&1 &
  echo "$!" >"$WEB_PID_FILE"
  echo "Web 已启动: $(cat "$WEB_PID_FILE")"
  echo "Web 日志: $LOG_DIR/web.log"
fi

echo "访问地址: http://127.0.0.1:5173/"
if [[ "${lan_ip:-}" != "" && "${lan_ip:-}" != "127.0.0.1" ]]; then
  echo "局域网访问: http://$lan_ip:5173/"
fi
