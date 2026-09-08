#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p bin
go build -trimpath -ldflags "$("$ROOT_DIR/scripts/buildinfo-ldflags.sh")" -o bin/claw-mcp ./cmd/claw-mcp
