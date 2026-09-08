#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d web ]]; then
  echo "web directory not found" >&2
  exit 1
fi

cd web
exec pnpm dev "$@"
