#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_ROOT=""
SERVERS_CONFIG=""

source "$ROOT_DIR/scripts/require-ops-dir.sh"

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/rollback-release.sh self
  scripts/rollback-release.sh belead
  scripts/rollback-release.sh self claw-mcp-20260706-153000.tar.gz
EOF
}

fail() {
  printf 'rollback-release: %s\n' "$*" >&2
  exit 1
}

configure_paths() {
  require_clawee_ops_dir || exit 1
  CONFIG_ROOT="$CLAWEE_OPS_DIR"

  SERVERS_CONFIG="$CONFIG_ROOT/deploy/servers.yaml"
  if [[ ! -f "$SERVERS_CONFIG" ]]; then
    fail "servers config not found: $SERVERS_CONFIG"
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "$1 is required but was not found in PATH"
  fi
}

server_value() {
  local target="$1"
  local key="$2"
  yq -r ".servers.${target}.${key} // \"\"" "$SERVERS_CONFIG"
}

rollback_target() {
  local target="$1"
  local backup_arg="${2:-}"
  local ssh_host deploy_dir service

  ssh_host="$(server_value "$target" ssh)"
  deploy_dir="$(server_value "$target" deploy_dir)"
  service="$(server_value "$target" service)"

  if [[ -z "$ssh_host" || -z "$deploy_dir" || -z "$service" ]]; then
    fail "missing server config for target: $target"
  fi

  printf '[%s] rolling back on remote host\n' "$target"
  ssh "$ssh_host" \
    "DEPLOY_DIR='$deploy_dir' SERVICE_NAME='$service' BACKUP_ARG='$backup_arg' bash -s" <<'REMOTE_SCRIPT'
set -Eeuo pipefail

SERVICE_UNIT="$SERVICE_NAME"
VERSION_URL="${VERSION_URL:-http://127.0.0.1:1904/version}"
SERVICE_STOPPED=0
RELEASE_PATHS=(claw-mcp public db deploy)

case "$SERVICE_UNIT" in
  *.service) ;;
  *)
    printf '[remote] service config must include .service suffix: %s\n' "$SERVICE_UNIT" >&2
    exit 1
    ;;
esac

systemctl_show() {
  local label="$1"

  printf '[remote] %s\n' "$label"
  systemctl show "$SERVICE_UNIT" \
    --property=Id \
    --property=FragmentPath \
    --property=ExecMainPID \
    --property=MainPID \
    --property=ActiveState \
    --property=SubState \
    --property=InvocationID \
    --property=ExecStart \
    --no-pager
}

remove_release_paths() {
  rm -rf -- "${RELEASE_PATHS[@]}"
}

restore_release_paths() {
  local backup_path="$1"
  local archive_paths=()
  local path

  for path in "${RELEASE_PATHS[@]}"; do
    archive_paths+=("./$path")
  done
  tar --warning=no-unknown-keyword -xzf "$backup_path" -C "$DEPLOY_DIR" "${archive_paths[@]}"
}

recover_service() {
  if [[ "$SERVICE_STOPPED" != "1" ]]; then
    return 0
  fi

  printf '[remote] attempting service recovery for %s\n' "$SERVICE_UNIT" >&2
  if [[ ! -x ./claw-mcp ]]; then
    printf '[remote] ./claw-mcp is missing or not executable; attempting backup restore\n' >&2
    if [[ -n "${backup_path:-}" && -f "$backup_path" ]]; then
      remove_release_paths
      restore_release_paths "$backup_path"
      if [[ -f ./claw-mcp ]]; then
        chmod +x ./claw-mcp
      fi
      if [[ -d ./deploy ]]; then
        chmod +x ./deploy/*.sh
      fi
    else
      printf '[remote] recovery skipped: backup is unavailable\n' >&2
      return 0
    fi
  fi

  if sudo systemctl restart "$SERVICE_UNIT"; then
    systemctl_show "systemd state after recovery restart" || true
  else
    printf '[remote] recovery restart failed for %s\n' "$SERVICE_UNIT" >&2
  fi
}

on_error() {
  local exit_code="$1"
  local line_no="$2"
  local command="$3"

  printf '[remote] rollback failed: exit=%s line=%s command=%s\n' "$exit_code" "$line_no" "$command" >&2
  systemctl_show "systemd state at rollback failure" || true
  recover_service
  exit "$exit_code"
}

on_signal() {
  local signal="$1"

  printf '[remote] rollback interrupted by %s\n' "$signal" >&2
  systemctl_show "systemd state at rollback interrupt" || true
  recover_service
  exit 130
}

trap 'on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
trap 'on_signal HUP' HUP
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

print_version() {
  local version_response=""
  local attempt

  printf '[remote] version check: %s\n' "$VERSION_URL"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if version_response="$(curl -fsS "$VERSION_URL" 2>/dev/null)"; then
      printf '%s\n' "$version_response"
      return 0
    fi
    printf '[remote] version check attempt %s failed; retrying\n' "$attempt" >&2
    sleep 1
  done

  printf '[remote] version check failed after %s attempts: %s\n' "$attempt" "$VERSION_URL" >&2
  return 1
}

cd "$DEPLOY_DIR"
printf '[remote] deploy dir: %s\n' "$DEPLOY_DIR"
printf '[remote] service unit: %s\n' "$SERVICE_UNIT"

if [[ ! -d .deploy-backups ]]; then
  printf '[remote] missing .deploy-backups directory\n' >&2
  exit 1
fi

if [[ -n "$BACKUP_ARG" ]]; then
  backup_path="$BACKUP_ARG"
  case "$backup_path" in
    /*) ;;
    *) backup_path=".deploy-backups/$backup_path" ;;
  esac
else
  backup_path="$(find .deploy-backups -maxdepth 1 -type f -name 'claw-mcp-*.tar.gz' -print | sort | tail -n 1)"
fi

if [[ -z "$backup_path" || ! -f "$backup_path" ]]; then
  printf '[remote] backup not found: %s\n' "${backup_path:-<latest>}" >&2
  exit 1
fi

printf '[remote] rollback backup: %s\n' "$backup_path"
printf '[remote] database migrations are not rolled back automatically\n'

if ! systemctl cat "$SERVICE_UNIT" >/dev/null 2>&1; then
  printf '[remote] systemd service %s is not installed yet\n' "$SERVICE_UNIT" >&2
  exit 1
fi
printf '[remote] stopping %s\n' "$SERVICE_UNIT"
sudo systemctl stop "$SERVICE_UNIT"
SERVICE_STOPPED=1

remove_release_paths
restore_release_paths "$backup_path"

if [[ -f ./claw-mcp ]]; then
  chmod +x ./claw-mcp
fi
if [[ -d ./deploy ]]; then
  chmod +x ./deploy/*.sh
fi

printf '[remote] restarting %s\n' "$SERVICE_UNIT"
sudo systemctl restart "$SERVICE_UNIT"
SERVICE_STOPPED=0

deploy/healthcheck.sh </dev/null
print_version
printf '[remote] rollback completed\n'
REMOTE_SCRIPT
}

main() {
  local target="${1:-}"
  local backup_arg="${2:-}"

  if [[ -z "$target" ]]; then
    usage
    exit 2
  fi

  configure_paths
  require_command yq
  require_command ssh

  if [[ "$(yq -r ".servers.${target} // \"\"" "$SERVERS_CONFIG")" == "" ]]; then
    fail "unknown target: $target"
  fi

  rollback_target "$target" "$backup_arg"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
