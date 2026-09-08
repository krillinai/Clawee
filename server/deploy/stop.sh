#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-claw-mcp}"
PID_FILE="${PID_FILE:-./run/${APP_NAME}.pid}"
STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-20}"

if [[ ! -f "$PID_FILE" ]]; then
  echo "$APP_NAME is not running: missing $PID_FILE"
  exit 0
fi

pid="$(cat "$PID_FILE")"
if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "$APP_NAME is not running: stale pid file removed"
  exit 0
fi

kill "$pid"

for ((i = 0; i < STOP_TIMEOUT_SECONDS; i++)); do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "$APP_NAME stopped"
    exit 0
  fi
  sleep 1
done

kill -KILL "$pid" 2>/dev/null || true
rm -f "$PID_FILE"
echo "$APP_NAME force stopped"
