#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="${HARNESS_LOCAL_DIR:-$ROOT_DIR/.local}"
PID_PATH="${HARNESS_PID_PATH:-$LOCAL_DIR/harness.pid}"

collect_descendants() {
  local parent="$1"
  local child
  if ! command -v pgrep >/dev/null 2>&1; then
    return
  fi
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    collect_descendants "$child"
    echo "$child"
  done
}

if [[ ! -f "$PID_PATH" ]]; then
  echo "Harness pid file not found: $PID_PATH"
  exit 0
fi

pid="$(cat "$PID_PATH")"
if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
  rm -f "$PID_PATH"
  echo "Harness is not running."
  exit 0
fi

pids="$(collect_descendants "$pid"; echo "$pid")"
echo "Stopping Harness processes: $pids"
kill $pids >/dev/null 2>&1 || true

for _ in {1..20}; do
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    rm -f "$PID_PATH"
    echo "Harness stopped."
    exit 0
  fi
  sleep 0.5
done

echo "Harness did not stop after SIGTERM; sending SIGKILL."
kill -9 $pids >/dev/null 2>&1 || true
rm -f "$PID_PATH"
echo "Harness stopped."
