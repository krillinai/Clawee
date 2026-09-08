#!/usr/bin/env bash
set -euo pipefail

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:1904/healthz}"
READY_URL="${READY_URL:-http://127.0.0.1:1904/readyz}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-3}"
HEALTHCHECK_ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-10}"
HEALTHCHECK_RETRY_INTERVAL="${HEALTHCHECK_RETRY_INTERVAL:-1}"

check_url() {
  local name="$1"
  local url="$2"
  local attempt

  for attempt in $(seq 1 "$HEALTHCHECK_ATTEMPTS"); do
    if curl -fsS --max-time "$TIMEOUT_SECONDS" "$url" >/dev/null 2>&1; then
      echo "$name check passed: $url"
      return 0
    fi

    if [[ "$attempt" -lt "$HEALTHCHECK_ATTEMPTS" ]]; then
      echo "$name check attempt $attempt/$HEALTHCHECK_ATTEMPTS failed; retrying" >&2
      sleep "$HEALTHCHECK_RETRY_INTERVAL"
    fi
  done

  echo "$name check failed after $HEALTHCHECK_ATTEMPTS attempts: $url" >&2
  return 1
}

check_url "healthz" "$HEALTH_URL"
check_url "readyz" "$READY_URL"
