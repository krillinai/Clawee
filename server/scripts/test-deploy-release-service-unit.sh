#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_SCRIPT="$ROOT_DIR/scripts/deploy-release.sh"
TEST_DIR="$(mktemp -d)"

trap 'rm -rf "$TEST_DIR"' EXIT

fail() {
  printf 'test-deploy-release-service-unit: %s\n' "$*" >&2
  exit 1
}

run_case() {
  local name="$1"
  local check_status="$2"
  local answer="$3"
  local expected_status="$4"
  local expected_action="$5"
  local output_file="$TEST_DIR/$name.out"
  local action_file="$TEST_DIR/$name.actions"
  local configured_file="$TEST_DIR/$name.configured"
  local actual_status

  set +e
  printf '%s\n' "$answer" | \
    DEPLOY_SCRIPT="$DEPLOY_SCRIPT" \
    CHECK_STATUS="$check_status" \
    ACTION_FILE="$action_file" \
    CONFIGURED_FILE="$configured_file" \
    bash -c '
      set -euo pipefail
      source "$DEPLOY_SCRIPT"

      service_unit_action() {
        local config_path="$4"
        local action="$5"

        if [[ "$config_path" != "configs/config.yaml" ]]; then
          return 98
        fi

        printf "%s\n" "$action" >>"$ACTION_FILE"
        case "$action" in
          check)
            if [[ -f "$CONFIGURED_FILE" ]]; then
              return 0
            fi
            return "$CHECK_STATUS"
            ;;
          configure)
            touch "$CONFIGURED_FILE"
            ;;
          *)
            return 99
            ;;
        esac
      }

      ensure_service_unit test deploy@example.com /srv/clawee claw-mcp.service configs/config.yaml
    ' >"$output_file" 2>&1
  actual_status="$?"
  set -e

  if [[ "$actual_status" != "$expected_status" ]]; then
    printf '%s\n' "--- $name output ---" >&2
    cat "$output_file" >&2
    fail "$name exit status = $actual_status, want $expected_status"
  fi

  case "$expected_action" in
    none)
      if [[ "$(cat "$action_file" 2>/dev/null || true)" != "check" ]]; then
        fail "$name unexpectedly configured the unit"
      fi
      ;;
    configure)
      if [[ "$(tr '\n' ' ' <"$action_file")" != "check configure check " ]]; then
        fail "$name did not configure and re-check the unit"
      fi
      ;;
    check-error)
      if [[ "$(cat "$action_file" 2>/dev/null || true)" != "check" ]]; then
        fail "$name handled a remote check error as a configurable state"
      fi
      ;;
  esac
}

run_case matching 0 '' 0 none
run_case missing-confirmed 10 y 0 configure
run_case missing-declined 10 n 1 none
run_case mismatch-confirmed 11 y 0 configure
run_case mismatch-declined 11 n 1 none
run_case remote-check-error 255 y 1 check-error

grep -Fq 'Install it?' "$TEST_DIR/missing-confirmed.out" || \
  fail "missing unit confirmation prompt was not shown"
grep -Fq 'Update it?' "$TEST_DIR/mismatch-confirmed.out" || \
  fail "mismatched unit confirmation prompt was not shown"

printf 'test-deploy-release-service-unit: ok\n'
