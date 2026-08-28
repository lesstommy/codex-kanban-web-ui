#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONGO_PORT="${MONGO_PORT:-27017}"

if command -v mongosh >/dev/null 2>&1; then
  mongosh "mongodb://127.0.0.1:$MONGO_PORT/admin" "$ROOT_DIR/scripts/mongo-init-rs.js"
else
  node "$ROOT_DIR/scripts/mongo-init-rs.mjs"
fi
