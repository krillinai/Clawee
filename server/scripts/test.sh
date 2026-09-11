#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/build-web.sh
./scripts/test-package-release.sh
go test ./...

TEST_COMPOSE_FILE="$ROOT_DIR/deploy/docker-compose.test.yaml"
TEST_DATABASE_URL="${CLAW_MCP_TEST_DATABASE_URL:-postgres://claw_mcp@localhost:5933/claw_mcp_test?sslmode=disable}"
STARTED_TEST_POSTGRES=false

cleanup_test_postgres() {
  if [[ "$STARTED_TEST_POSTGRES" == true ]]; then
    docker compose -f "$TEST_COMPOSE_FILE" stop postgres-test >/dev/null
  fi
}
trap cleanup_test_postgres EXIT

if [[ -z "${CLAW_MCP_TEST_DATABASE_URL:-}" ]]; then
  if ! docker compose -f "$TEST_COMPOSE_FILE" ps --status running --services | grep -qx postgres-test; then
    docker compose -f "$TEST_COMPOSE_FILE" up -d postgres-test
    STARTED_TEST_POSTGRES=true
  fi
  for _ in {1..30}; do
    if docker compose -f "$TEST_COMPOSE_FILE" exec -T postgres-test pg_isready -U claw_mcp -d claw_mcp >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

CLAW_MCP_TEST_DATABASE_URL="$TEST_DATABASE_URL" go test ./internal/sharedfiles -run TestPostgresSharedFilesLifecycleAndUploadAuthorizationRace -count=1
CLAW_MCP_TEST_DATABASE_URL="$TEST_DATABASE_URL" go test ./internal/accounts -run TestPostgresStoreBindsExternalIdentity -count=1

if [[ -d web ]]; then
  (cd web && pnpm test)
fi
