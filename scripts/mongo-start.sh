#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="${HARNESS_LOCAL_DIR:-$ROOT_DIR/.local}"
MONGO_PORT="${MONGO_PORT:-27017}"
DB_PATH="$LOCAL_DIR/mongo/db"
LOG_PATH="$LOCAL_DIR/mongo/mongod.log"
PID_PATH="$LOCAL_DIR/mongo/mongod.pid"

find_mongod() {
  if [[ -n "${MONGOD_BIN:-}" && -x "$MONGOD_BIN" ]]; then
    echo "$MONGOD_BIN"
    return
  fi
  if command -v mongod >/dev/null 2>&1; then
    command -v mongod
    return
  fi
  for candidate in "$ROOT_DIR"/.local/mongodb/current/bin/mongod "$ROOT_DIR"/.local/mongodb/*/bin/mongod; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  if command -v brew >/dev/null 2>&1; then
    for formula in mongodb-community@8.0 mongodb-community@7.0 mongodb-community; do
      prefix="$(brew --prefix "$formula" 2>/dev/null || true)"
      if [[ -n "$prefix" && -x "$prefix/bin/mongod" ]]; then
        echo "$prefix/bin/mongod"
        return
      fi
    done
  fi
}

MONGOD="$(find_mongod || true)"
if [[ -z "$MONGOD" ]]; then
  echo "mongod not found. Run: npm run mongo:install" >&2
  exit 1
fi

mkdir -p "$DB_PATH" "$(dirname "$LOG_PATH")"

if [[ -f "$PID_PATH" ]] && kill -0 "$(cat "$PID_PATH")" >/dev/null 2>&1; then
  echo "MongoDB already running with pid $(cat "$PID_PATH")."
  exit 0
fi

"$MONGOD" \
  --dbpath "$DB_PATH" \
  --replSet rs0 \
  --bind_ip 127.0.0.1 \
  --port "$MONGO_PORT" \
  --logpath "$LOG_PATH" \
  --pidfilepath "$PID_PATH" \
  --fork

echo "MongoDB started on 127.0.0.1:$MONGO_PORT with replica set rs0."
echo "Log: $LOG_PATH"
