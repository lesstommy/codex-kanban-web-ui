#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js first." >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "node_modules not found. Run: npm install" >&2
  exit 1
fi

if [[ ! -x "$ROOT_DIR/node_modules/.bin/concurrently" ]]; then
  echo "concurrently not found. Run: npm install" >&2
  exit 1
fi

echo "Starting MongoDB..."
bash "$ROOT_DIR/scripts/mongo-start.sh"

echo "Initializing MongoDB replica set..."
for attempt in {1..20}; do
  if bash "$ROOT_DIR/scripts/mongo-init.sh"; then
    break
  fi

  if [[ "$attempt" -eq 20 ]]; then
    echo "MongoDB replica set initialization failed after $attempt attempts." >&2
    exit 1
  fi

  sleep 1
done

echo "Checking local dependencies..."
npm run doctor

echo "Building Harness..."
npm run build

echo "Starting Harness API and Web..."
echo "Web: http://127.0.0.1:5173"
echo "API: http://127.0.0.1:4317"
exec npm run serve
