#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
API_LAUNCH_LABEL="com.virtual-resource-console.api"
WEB_LAUNCH_LABEL="com.virtual-resource-console.web"
USER_DOMAIN="gui/$(id -u)"

show_pid_file() {
  local name="$1"
  local pid_file="$2"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$name: running pid=$pid"
      return 0
    fi
    echo "$name: stopped stale_pid=${pid:-unknown}"
    return 0
  fi
  echo "$name: no pid file"
}

show_pid_file "API" "$RUNTIME_DIR/api.pid"
show_pid_file "Web" "$RUNTIME_DIR/web.pid"

if launchctl print "$USER_DOMAIN/$API_LAUNCH_LABEL" >/dev/null 2>&1; then
  echo "API launchd: running label=$API_LAUNCH_LABEL"
else
  echo "API launchd: not loaded"
fi

if launchctl print "$USER_DOMAIN/$WEB_LAUNCH_LABEL" >/dev/null 2>&1; then
  echo "Web launchd: running label=$WEB_LAUNCH_LABEL"
else
  echo "Web launchd: not loaded"
fi

echo
echo "Ports:"
lsof -nP -iTCP:3987 -sTCP:LISTEN 2>/dev/null || true
lsof -nP -iTCP:5173 -sTCP:LISTEN 2>/dev/null || true

echo
echo "Health:"
curl -s http://127.0.0.1:3987/api/health 2>/dev/null || echo "API health unavailable"
