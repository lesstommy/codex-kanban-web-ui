#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="${HARNESS_LOCAL_DIR:-$ROOT_DIR/.local}"
PID_PATH="${HARNESS_PID_PATH:-$LOCAL_DIR/harness.pid}"
LOG_DIR="${HARNESS_LOG_DIR:-$LOCAL_DIR/logs}"
LOG_PATH="${HARNESS_LOG_PATH:-$LOG_DIR/harness.log}"

if [[ -f "$PID_PATH" ]]; then
  pid="$(cat "$PID_PATH")"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    echo "Harness running with pid $pid."
  else
    echo "Harness pid file exists, but process is not running."
  fi
else
  echo "Harness background pid file not found."
fi

echo "Web: http://127.0.0.1:5173"
echo "API: http://127.0.0.1:4317"
echo "Log: $LOG_PATH"

if command -v lsof >/dev/null 2>&1; then
  api_port="${SERVER_PORT:-4317}"
  web_port="${VITE_PORT:-5173}"
  echo "Listening processes:"
  lsof -nP -iTCP:"$api_port" -sTCP:LISTEN 2>/dev/null || true
  lsof -nP -iTCP:"$web_port" -sTCP:LISTEN 2>/dev/null || true
fi
