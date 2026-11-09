#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/require-ops-dir.sh"
require_clawee_ops_dir

WEB_DEV_HOST="${WEB_DEV_HOST:-0.0.0.0}"
WEB_DEV_PORT="${WEB_DEV_PORT:-5904}"

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${WEB_PID:-}" ]]; then
    kill "$WEB_PID" 2>/dev/null || true
  fi
  if [[ -n "${STATUS_DIR:-}" ]]; then
    rm -rf "$STATUS_DIR"
  fi
}
trap cleanup EXIT INT TERM

database_url="$(sed -nE 's/^[[:space:]]*url:[[:space:]]*"([^"]+)"[[:space:]]*$/\1/p' "$CLAWEE_OPS_DIR/configs/config.yaml" | head -n 1)"
database_authority="${database_url#*://}"
database_authority="${database_authority%%@*}"
if [[ "$database_url" != postgres://* && "$database_url" != postgresql://* ]] || [[ "$database_authority" != *:* ]]; then
  printf 'database.url must include a password for PostgreSQL container startup\n' >&2
  exit 1
fi
database_password="${database_authority#*:}"
if [[ -z "$database_password" ]]; then
  printf 'database.url password must not be empty\n' >&2
  exit 1
fi

CLAWEE_POSTGRES_PASSWORD="$database_password" \
  docker compose -f "$ROOT_DIR/deploy/docker-compose.yaml" up -d postgres

STATUS_DIR="$(mktemp -d)"
BACKEND_STATUS_FILE="$STATUS_DIR/backend.status"
WEB_STATUS_FILE="$STATUS_DIR/web.status"

echo "Starting backend on http://127.0.0.1:1904"
(
  set +e
  "$ROOT_DIR/scripts/dev-backend.sh"
  status=$?
  echo "$status" >"$BACKEND_STATUS_FILE"
  exit "$status"
) &
BACKEND_PID=$!

echo "Starting web dev server on http://$WEB_DEV_HOST:$WEB_DEV_PORT"
(
  set +e
  cd "$ROOT_DIR/web" && pnpm install --frozen-lockfile && pnpm dev --host "$WEB_DEV_HOST" --port "$WEB_DEV_PORT"
  status=$?
  echo "$status" >"$WEB_STATUS_FILE"
  exit "$status"
) &
WEB_PID=$!

while [[ ! -s "$BACKEND_STATUS_FILE" && ! -s "$WEB_STATUS_FILE" ]]; do
  sleep 1
done

if [[ -s "$BACKEND_STATUS_FILE" ]]; then
  exit "$(cat "$BACKEND_STATUS_FILE")"
fi

exit "$(cat "$WEB_STATUS_FILE")"
