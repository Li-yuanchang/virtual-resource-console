#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
API_LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.virtual-resource-console.api.plist"
API_LAUNCH_LABEL="com.virtual-resource-console.api"
WEB_LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.virtual-resource-console.web.plist"
WEB_LAUNCH_LABEL="com.virtual-resource-console.web"
USER_DOMAIN="gui/$(id -u)"

if launchctl print "$USER_DOMAIN/$API_LAUNCH_LABEL" >/dev/null 2>&1; then
  launchctl bootout "$USER_DOMAIN" "$API_LAUNCH_AGENT" 2>/dev/null || launchctl bootout "$USER_DOMAIN/$API_LAUNCH_LABEL" 2>/dev/null || true
  echo "API launchd 托管已停止: $API_LAUNCH_LABEL"
fi

if launchctl print "$USER_DOMAIN/$WEB_LAUNCH_LABEL" >/dev/null 2>&1; then
  launchctl bootout "$USER_DOMAIN" "$WEB_LAUNCH_AGENT" 2>/dev/null || launchctl bootout "$USER_DOMAIN/$WEB_LAUNCH_LABEL" 2>/dev/null || true
  echo "Web launchd 托管已停止: $WEB_LAUNCH_LABEL"
fi

stop_pid_file() {
  local name="$1"
  local pid_file="$2"
  if [[ ! -f "$pid_file" ]]; then
    echo "$name 未记录 PID。"
    return 0
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "$name 已停止: $pid"
  else
    echo "$name PID 不存在或已退出: ${pid:-unknown}"
  fi
  rm -f "$pid_file"
}

stop_pid_file "API" "$RUNTIME_DIR/api.pid"
stop_pid_file "Web" "$RUNTIME_DIR/web.pid"
