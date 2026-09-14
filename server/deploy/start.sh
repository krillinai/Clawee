#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-claw-gateway}"
APP_BIN="${APP_BIN:-./claw-gateway}"
PID_FILE="${PID_FILE:-./run/${APP_NAME}.pid}"
LOG_FILE="${LOG_FILE:-./logs/${APP_NAME}.log}"
LEGACY_PID_FILE="${LEGACY_PID_FILE:-./run/claw-mcp.pid}"

if [[ -z "${CLAWEE_OPS_DIR:-}" || ! -f "$CLAWEE_OPS_DIR/configs/config.yaml" ]]; then
  echo "CLAWEE_OPS_DIR must contain configs/config.yaml" >&2
  exit 1
fi

mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

if [[ "$PID_FILE" != "$LEGACY_PID_FILE" && ! -f "$PID_FILE" && -f "$LEGACY_PID_FILE" ]]; then
  legacy_pid="$(cat "$LEGACY_PID_FILE")"
  if [[ -n "$legacy_pid" ]] && kill -0 "$legacy_pid" 2>/dev/null; then
    echo "stopping legacy claw-mcp process: pid $legacy_pid"
    kill "$legacy_pid"
    for ((i = 0; i < 20; i++)); do
      if ! kill -0 "$legacy_pid" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    if kill -0 "$legacy_pid" 2>/dev/null; then
      kill -KILL "$legacy_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$LEGACY_PID_FILE"
fi

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
