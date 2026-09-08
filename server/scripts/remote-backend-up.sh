#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/require-ops-dir.sh"
require_clawee_ops_dir

APP_NAME="${CLAW_MCP_APP_NAME:-claw-mcp}"
APP_BIN="${CLAW_MCP_APP_BIN:-$ROOT_DIR/bin/claw-mcp}"
APP_ADDR="${CLAW_MCP_SERVER_ADDR:-:1904}"
APP_HOST="${CLAW_MCP_HEALTH_HOST:-127.0.0.1}"
APP_PORT="${CLAW_MCP_PORT:-${APP_ADDR##*:}}"
APP_PID_FILE="${CLAW_MCP_PID_FILE:-$ROOT_DIR/tmp/claw-mcp.pid}"
APP_LOG_FILE="${CLAW_MCP_LOG_FILE:-$ROOT_DIR/tmp/claw-mcp.log}"

POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-claw-mcp-postgres}"
POSTGRES_DB="${POSTGRES_DB:-claw_mcp}"
POSTGRES_USER="${POSTGRES_USER:-claw_mcp}"
POSTGRES_PORT="${POSTGRES_PORT:-5932}"

export CLAW_MCP_SERVER_ADDR="$APP_ADDR"

info() {
  printf '[%s] %s\n' "$APP_NAME" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$APP_NAME" "$*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "$1 is required but was not found in PATH"
  fi
}

wait_for_url() {
  local url="$1"
  local attempts="$2"
  local delay="$3"

  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

stop_existing_app() {
  if [[ ! -f "$APP_PID_FILE" ]]; then
    return
  fi

  local pid
  pid="$(cat "$APP_PID_FILE")"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    info "stopping existing backend process pid=$pid"
    kill "$pid"
    for _ in {1..20}; do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        rm -f "$APP_PID_FILE"
        return
      fi
      sleep 0.5
    done
    info "existing process did not exit after 10s; sending SIGKILL"
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$APP_PID_FILE"
}

ensure_postgres() {
  if docker ps -a --format '{{.Names}}' | grep -Fxq "$POSTGRES_CONTAINER"; then
    info "starting existing Postgres container: $POSTGRES_CONTAINER"
    docker start "$POSTGRES_CONTAINER" >/dev/null
  else
    info "creating Postgres container: $POSTGRES_CONTAINER"
    docker run -d \
      --name "$POSTGRES_CONTAINER" \
      -e POSTGRES_DB="$POSTGRES_DB" \
      -e POSTGRES_USER="$POSTGRES_USER" \
      -e POSTGRES_HOST_AUTH_METHOD=trust \
      -p "127.0.0.1:${POSTGRES_PORT}:5432" \
      -v "${POSTGRES_CONTAINER}-data:/var/lib/postgresql/data" \
      "$POSTGRES_IMAGE" >/dev/null
  fi

  info "waiting for Postgres readiness"
  for _ in {1..60}; do
    if docker exec "$POSTGRES_CONTAINER" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  fail "Postgres did not become ready within 60s"
}

build_backend() {
  if [[ ! -f "$ROOT_DIR/internal/server/webdist/dist/index.html" ]]; then
    info "web dist is missing; building web assets required by Go embed"
    ./scripts/build-web.sh
  fi

  info "building backend binary: $APP_BIN"
  mkdir -p "$(dirname "$APP_BIN")"
  go build -ldflags "$("$ROOT_DIR/scripts/buildinfo-ldflags.sh")" -o "$APP_BIN" ./cmd/claw-mcp
}

run_migrations() {
  info "running database migrations"
  "$APP_BIN" migrate up
}

start_backend() {
  mkdir -p "$(dirname "$APP_PID_FILE")" "$(dirname "$APP_LOG_FILE")"
  : >"$APP_LOG_FILE"

  stop_existing_app

  info "starting backend binary"
  nohup "$APP_BIN" >>"$APP_LOG_FILE" 2>&1 &
  echo "$!" >"$APP_PID_FILE"
}

verify_backend() {
  local health_url="http://${APP_HOST}:${APP_PORT}/healthz"
  local ready_url="http://${APP_HOST}:${APP_PORT}/readyz"

  info "checking backend health: $health_url"
  wait_for_url "$health_url" 30 1 || {
    tail -n 80 "$APP_LOG_FILE" >&2 || true
    fail "backend health check failed"
  }

  info "checking backend readiness stability"
  for _ in {1..5}; do
    curl -fsS "$ready_url" >/dev/null || {
      tail -n 80 "$APP_LOG_FILE" >&2 || true
      fail "backend readiness check failed"
    }
    sleep 1
  done

  local pid
  pid="$(cat "$APP_PID_FILE")"
  kill -0 "$pid" >/dev/null 2>&1 || fail "backend process exited after health checks"

  info "backend is running"
  info "pid: $pid"
  info "log: $APP_LOG_FILE"
  info "listening: $APP_ADDR"
  info "local health: $health_url"
  info "remote URL: http://<server-ip>:${APP_PORT}"
}

main() {
  require_command go
  require_command docker
  require_command curl

  build_backend
  ensure_postgres
  run_migrations
  start_backend
  verify_backend
}

main "$@"
