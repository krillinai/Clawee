#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-claw-mcp}"
APP_BIN="${APP_BIN:-./claw-mcp}"
PID_FILE="${PID_FILE:-./run/${APP_NAME}.pid}"
LOG_FILE="${LOG_FILE:-./logs/${APP_NAME}.log}"

if [[ -z "${CLAWEE_OPS_DIR:-}" || ! -f "$CLAWEE_OPS_DIR/configs/config.yaml" ]]; then
  echo "CLAWEE_OPS_DIR must contain configs/config.yaml" >&2
  exit 1
fi

mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE")"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "$APP_NAME is already running: pid $old_pid"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

nohup "$APP_BIN" >>"$LOG_FILE" 2>&1 &
pid="$!"
printf '%s\n' "$pid" >"$PID_FILE"

sleep 1
if ! kill -0 "$pid" 2>/dev/null; then
  echo "$APP_NAME failed to start. Check $LOG_FILE" >&2
  rm -f "$PID_FILE"
  exit 1
fi

echo "$APP_NAME started: pid $pid"
