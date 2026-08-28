#!/usr/bin/env bash
set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required to install MongoDB Community." >&2
  exit 1
fi

brew tap mongodb/brew

if brew info mongodb-community@8.0 >/dev/null 2>&1; then
  brew install mongodb-community@8.0
else
  brew install mongodb-community
fi

echo "MongoDB installed. Run: npm run mongo:start && npm run mongo:init"
