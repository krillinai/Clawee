#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_BIN="${APP_BIN:-$ROOT_DIR/bin/claw-mcp}"

source "$ROOT_DIR/scripts/require-ops-dir.sh"
require_clawee_ops_dir

if [[ ! -f internal/server/webdist/dist/index.html ]]; then
  ./scripts/build-web.sh
fi

mkdir -p "$(dirname "$APP_BIN")"
go build -ldflags "$("$ROOT_DIR/scripts/buildinfo-ldflags.sh")" -o "$APP_BIN" ./cmd/claw-mcp

exec "$APP_BIN" migrate up
