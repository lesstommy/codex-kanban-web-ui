#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="${HARNESS_LOCAL_DIR:-$ROOT_DIR/.local}"
PID_PATH="${HARNESS_PID_PATH:-$LOCAL_DIR/harness.pid}"
LOG_DIR="${HARNESS_LOG_DIR:-$LOCAL_DIR/logs}"
LOG_PATH="${HARNESS_LOG_PATH:-$LOG_DIR/harness.log}"

cd "$ROOT_DIR"
mkdir -p "$LOG_DIR" "$(dirname "$PID_PATH")"

if [[ -f "$PID_PATH" ]]; then
  existing_pid="$(cat "$PID_PATH")"
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
    echo "Harness already running with pid $existing_pid."
    echo "Log: $LOG_PATH"
    exit 0
  fi
  rm -f "$PID_PATH"
fi

if command -v lsof >/dev/null 2>&1; then
  api_port="${SERVER_PORT:-4317}"
  web_port="${VITE_PORT:-5173}"
  if lsof -iTCP:"$api_port" -sTCP:LISTEN >/dev/null 2>&1 || lsof -iTCP:"$web_port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Harness ports look busy. Check existing processes before starting another server." >&2
    echo "API port: $api_port, Web port: $web_port" >&2
    exit 1
  fi
fi

nohup bash "$ROOT_DIR/scripts/start-server.sh" >"$LOG_PATH" 2>&1 &
pid="$!"
echo "$pid" >"$PID_PATH"

sleep 2
if ! kill -0 "$pid" >/dev/null 2>&1; then
  rm -f "$PID_PATH"
  echo "Harness failed to start. Last log lines:" >&2
  tail -n 80 "$LOG_PATH" >&2 || true
  exit 1
fi

echo "Harness started in background with pid $pid."
echo "Web: http://127.0.0.1:5173"
echo "API: http://127.0.0.1:4317"
echo "Log: $LOG_PATH"
echo "Stop: npm run stop"
