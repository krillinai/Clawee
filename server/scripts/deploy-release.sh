#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_ROOT=""
SERVERS_CONFIG=""

source "$ROOT_DIR/scripts/require-ops-dir.sh"

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/deploy-release.sh ubuntu
  scripts/deploy-release.sh belead
  scripts/deploy-release.sh all
EOF
}

fail() {
  printf 'deploy-release: %s\n' "$*" >&2
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

print_deploy_result() {
  local exit_code="$?"

  if [[ "$exit_code" == "0" ]]; then
    printf '\n\033[32mdeploy-release: OK\033[0m\n' >&2
  else
    printf '\n\033[31mdeploy-release: FAIL\033[0m\n' >&2
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

confirm_action() {
  local prompt="$1"
  local answer

  printf '%s [y/N] ' "$prompt" >&2
  if ! IFS= read -r answer; then
    return 1
  fi

  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

service_unit_action() {
  local ssh_host="$1"
  local deploy_dir="$2"
  local service="$3"
  local config_path="$4"
  local action="$5"

  ssh "$ssh_host" \
    "DEPLOY_DIR='$deploy_dir' SERVICE_NAME='$service' CONFIG_PATH='$config_path' UNIT_ACTION='$action' bash -s" <<'REMOTE_SERVICE_UNIT'
set -Eeuo pipefail

SERVICE_UNIT="$SERVICE_NAME"
SERVICE_USER="$(id -un)"
SERVICE_GROUP="$(id -gn)"

if [[ ! "$SERVICE_UNIT" =~ ^[A-Za-z0-9_.@-]+\.service$ ]]; then
  printf '[remote] invalid systemd service unit name: %s\n' "$SERVICE_UNIT" >&2
  exit 1
fi
case "$DEPLOY_DIR" in
  /*) ;;
  *)
    printf '[remote] deploy dir must be absolute: %s\n' "$DEPLOY_DIR" >&2
    exit 1
    ;;
esac

unit_dir="$(mktemp -d)"
expected_unit="$unit_dir/$SERVICE_UNIT"
trap 'rm -rf "$unit_dir"' EXIT

cat >"$expected_unit" <<EOF
[Unit]
Description=Claw MCP Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$DEPLOY_DIR
ExecStart=$DEPLOY_DIR/claw-mcp --config $DEPLOY_DIR/$CONFIG_PATH
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

case "$UNIT_ACTION" in
  check)
    if ! systemctl cat "$SERVICE_UNIT" >/dev/null 2>&1; then
      exit 10
    fi

    fragment_path="$(systemctl show "$SERVICE_UNIT" --property=FragmentPath --value --no-pager)"
    mismatch=0
    if [[ -z "$fragment_path" || ! -f "$fragment_path" ]]; then
      printf '[remote] systemd unit fragment is unavailable: %s\n' "${fragment_path:-<empty>}" >&2
      mismatch=1
    elif ! cmp -s "$expected_unit" "$fragment_path"; then
      printf '[remote] systemd unit config differs from expected: %s\n' "$fragment_path" >&2
      diff -u "$fragment_path" "$expected_unit" >&2 || true
      mismatch=1
    fi

    if ! systemctl is-enabled "$SERVICE_UNIT" >/dev/null 2>&1; then
      printf '[remote] systemd unit is not enabled: %s\n' "$SERVICE_UNIT" >&2
      mismatch=1
    fi

    if [[ "$mismatch" == "1" ]]; then
      exit 11
    fi
    ;;
  configure)
    if ! sudo -n true; then
      printf '[remote] passwordless sudo is required to configure %s\n' "$SERVICE_UNIT" >&2
      exit 1
    fi

    sudo install -m 0644 "$expected_unit" "/etc/systemd/system/$SERVICE_UNIT"
    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_UNIT"
    printf '[remote] systemd unit configured: %s\n' "$SERVICE_UNIT"
    ;;
  *)
    printf '[remote] unsupported systemd unit action: %s\n' "$UNIT_ACTION" >&2
    exit 1
    ;;
esac
REMOTE_SERVICE_UNIT
}

ensure_service_unit() {
  local target="$1"
  local ssh_host="$2"
  local deploy_dir="$3"
  local service="$4"
  local config_path="$5"
  local check_status
  local prompt

  if service_unit_action "$ssh_host" "$deploy_dir" "$service" "$config_path" check; then
    printf '[%s] systemd unit matches expected config: %s\n' "$target" "$service"
    return 0
  else
    check_status="$?"
  fi

  case "$check_status" in
    10)
      prompt="Systemd unit $service is missing on target $target. Install it?"
      ;;
    11)
      prompt="Systemd unit $service differs from expected config on target $target. Update it?"
      ;;
    *)
      fail "failed to inspect systemd unit $service on target $target: exit $check_status"
      ;;
  esac

  if ! confirm_action "$prompt"; then
    fail "systemd unit configuration was declined for target: $target"
  fi

  if ! service_unit_action "$ssh_host" "$deploy_dir" "$service" "$config_path" configure; then
    fail "failed to configure systemd unit $service on target: $target"
  fi
  if ! service_unit_action "$ssh_host" "$deploy_dir" "$service" "$config_path" check; then
    fail "systemd unit verification failed after configuration on target: $target"
  fi
}

build_package() {
  local arch="$1"

  case "$arch" in
    linux-amd64)
      TARGET_GOOS=linux TARGET_GOARCH=amd64 "$ROOT_DIR/scripts/package-release.sh"
      ;;
    linux-arm64)
      TARGET_GOOS=linux TARGET_GOARCH=arm64 "$ROOT_DIR/scripts/package-release.sh"
      ;;
    *)
      fail "unsupported arch: $arch"
      ;;
  esac
}

deploy_target() {
  local target="$1"
  local ssh_host deploy_dir arch service config_path config_source package package_checksum remote_package remote_config package_name release_id

  ssh_host="$(server_value "$target" ssh)"
  deploy_dir="$(server_value "$target" deploy_dir)"
  arch="$(server_value "$target" arch)"
  service="$(server_value "$target" service)"
  config_path="$(server_value "$target" config)"

  if [[ -z "$ssh_host" || -z "$deploy_dir" || -z "$arch" || -z "$service" || -z "$config_path" ]]; then
    fail "missing server config for target: $target"
  fi
  if [[ ! "$config_path" =~ ^configs/[A-Za-z0-9._-]+\.ya?ml$ ]]; then
    fail "invalid config path for target $target: $config_path"
  fi
  config_source="$CONFIG_ROOT/$config_path"
  if [[ ! -f "$config_source" ]]; then
    fail "config file not found for target $target: $config_source"
  fi

  ensure_service_unit "$target" "$ssh_host" "$deploy_dir" "$service" "$config_path"

  printf '[%s] building package for %s\n' "$target" "$arch"
  package="$(build_package "$arch")"
  if [[ -z "$package" || ! -f "$package" ]]; then
    fail "release package was not created for $arch"
  fi
  package_name="$(basename "$package")"
  package_checksum="$(shasum -a 256 "$package" | awk '{print $1}')"
  release_id="${package_name%.tar.gz}"
  remote_package="/tmp/${package_name}.${target}.$$.${RANDOM}"
  remote_config="${remote_package}.config"

  printf '[%s] uploading %s to %s:%s\n' "$target" "$package_name" "$ssh_host" "$remote_package"
  scp "$package" "$ssh_host:$remote_package"
  printf '[%s] uploading external configuration\n' "$target"
  if ! scp "$config_source" "$ssh_host:$remote_config"; then
    ssh "$ssh_host" "rm -f -- '$remote_package' '$remote_config'" >/dev/null 2>&1 || true
    fail "failed to upload external config for target: $target"
  fi

  printf '[%s] deploying on remote host\n' "$target"
  ssh "$ssh_host" \
    "DEPLOY_DIR='$deploy_dir' SERVICE_NAME='$service' CONFIG_PATH='$config_path' REMOTE_PACKAGE='$remote_package' REMOTE_CONFIG='$remote_config' PACKAGE_SHA256='$package_checksum' RELEASE_ID='$release_id' bash -s" <<'REMOTE_SCRIPT'
set -Eeuo pipefail

SERVICE_UNIT="$SERVICE_NAME"
VERSION_URL="${VERSION_URL:-http://127.0.0.1:1904/version}"
SERVICE_STOPPED=0
DOCKER_COMMAND=()
RELEASE_PATHS=(claw-mcp public db deploy)
trap 'rm -f "$REMOTE_PACKAGE" "$REMOTE_CONFIG"' EXIT

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

systemctl_pid() {
  systemctl show "$SERVICE_UNIT" --property=MainPID --value --no-pager
}

systemctl_invocation_id() {
  systemctl show "$SERVICE_UNIT" --property=InvocationID --value --no-pager
}

configure_docker_command() {
  if docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DOCKER_COMMAND=(docker)
    return 0
  fi

  if sudo -n docker info >/dev/null 2>&1 && sudo -n docker compose version >/dev/null 2>&1; then
    DOCKER_COMMAND=(sudo -n docker)
    printf '[remote] Docker API requires elevated permissions; using sudo\n'
    return 0
  fi

  printf '[remote] Docker is unavailable for the current user and passwordless sudo Docker access failed\n' >&2
  printf '[remote] grant access to /var/run/docker.sock or allow sudo -n docker on this host\n' >&2
  return 1
}

docker_compose() {
  "${DOCKER_COMMAND[@]}" compose -f deploy/docker-compose.yaml "$@"
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
    if [[ -n "${backup_name:-}" && -f ".deploy-backups/$backup_name" ]]; then
      remove_release_paths
      restore_release_paths ".deploy-backups/$backup_name"
      chmod +x ./claw-mcp ./deploy/*.sh
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

  printf '[remote] deploy failed: exit=%s line=%s command=%s\n' "$exit_code" "$line_no" "$command" >&2
  systemctl_show "systemd state at deploy failure" || true
  recover_service
  exit "$exit_code"
}

on_signal() {
  local signal="$1"

  printf '[remote] deploy interrupted by %s\n' "$signal" >&2
  systemctl_show "systemd state at deploy interrupt" || true
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

wait_for_postgres() {
  local attempt

  printf '[remote] waiting for postgres readiness\n'
  for attempt in $(seq 1 60); do
    printf '[remote] postgres readiness attempt %s/60\n' "$attempt"
    if timeout 10 "${DOCKER_COMMAND[@]}" compose -f deploy/docker-compose.yaml \
      exec -T postgres pg_isready -U claw_mcp -d claw_mcp </dev/null; then
      return 0
    fi
    sleep 1
  done

  printf '[remote] postgres did not become ready after 60 attempts\n' >&2
  return 1
}

mkdir -p "$DEPLOY_DIR"
cd "$DEPLOY_DIR"

printf '[remote] deploy dir: %s\n' "$DEPLOY_DIR"
printf '[remote] service unit: %s\n' "$SERVICE_UNIT"
printf '[remote] config path: %s\n' "$CONFIG_PATH"
printf '[remote] release package: %s\n' "$REMOTE_PACKAGE"
printf '[remote] release id: %s\n' "$RELEASE_ID"

printf '[remote] checking Docker access\n'
configure_docker_command

printf '[remote] verifying release package checksum\n'
actual_package_sha256="$(sha256sum "$REMOTE_PACKAGE" | awk '{print $1}')"
if [[ "$actual_package_sha256" != "$PACKAGE_SHA256" ]]; then
  printf '[remote] release package checksum mismatch: expected=%s actual=%s\n' \
    "$PACKAGE_SHA256" "$actual_package_sha256" >&2
  exit 1
fi

printf '[remote] verifying release package archive\n'
tar -tzf "$REMOTE_PACKAGE" >/dev/null
if tar -tzf "$REMOTE_PACKAGE" | grep -Eq '(^|/)(config\.ya?ml|\.env)$'; then
  printf '[remote] release package must not contain private config or .env files\n' >&2
  exit 1
fi
if [[ ! -f "$REMOTE_CONFIG" ]]; then
  printf '[remote] external config upload is missing\n' >&2
  exit 1
fi

mkdir -p .deploy-backups
backup_name="claw-mcp-$(date +%Y%m%d-%H%M%S).tar.gz"
if find . -mindepth 1 -maxdepth 1 \
  ! -name '.deploy-backups' \
  ! -name 'configs' \
  ! -name 'logs' \
  ! -name 'run' \
  -print -quit | grep -q .; then
  tar --warning=no-file-changed --warning=no-unknown-keyword \
    --exclude='./.deploy-backups' \
    --exclude='./configs' \
    --exclude='./logs' \
    --exclude='./run' \
    -czf ".deploy-backups/$backup_name" .
  printf '[remote] backup created: .deploy-backups/%s\n' "$backup_name"
else
  printf '[remote] deployment directory is empty; skip backup\n'
fi

if ! systemctl cat "$SERVICE_UNIT" >/dev/null 2>&1; then
  printf '[remote] systemd service %s is not installed yet\n' "$SERVICE_UNIT" >&2
  exit 1
fi

systemctl_show "systemd state before stop"
old_pid="$(systemctl_pid)"
old_invocation_id="$(systemctl_invocation_id)"
printf '[remote] stopping %s\n' "$SERVICE_UNIT"
sudo systemctl stop "$SERVICE_UNIT"
SERVICE_STOPPED=1
systemctl_show "systemd state after stop"

remove_release_paths

printf '[remote] extracting release package\n'
tar --warning=no-unknown-keyword -xzf "$REMOTE_PACKAGE" -C "$DEPLOY_DIR"
chmod +x ./claw-mcp ./deploy/*.sh
mkdir -p "$(dirname "$CONFIG_PATH")"
install -m 0600 "$REMOTE_CONFIG" "$CONFIG_PATH"

printf '[remote] starting postgres\n'
docker_compose up -d postgres </dev/null
wait_for_postgres

printf '[remote] running migrations\n'
./claw-mcp migrate up --config "$DEPLOY_DIR/$CONFIG_PATH" </dev/null

printf '[remote] restarting %s\n' "$SERVICE_UNIT"
sudo systemctl restart "$SERVICE_UNIT"
SERVICE_STOPPED=0
systemctl_show "systemd state after restart"
new_pid="$(systemctl_pid)"
new_invocation_id="$(systemctl_invocation_id)"
printf '[remote] restart evidence: old_pid=%s new_pid=%s old_invocation_id=%s new_invocation_id=%s\n' \
  "${old_pid:-<empty>}" "${new_pid:-<empty>}" "${old_invocation_id:-<empty>}" "${new_invocation_id:-<empty>}"
if [[ -n "$old_invocation_id" && -n "$new_invocation_id" && "$old_invocation_id" == "$new_invocation_id" ]]; then
  printf '[remote] systemd invocation id did not change after restart: %s\n' "$new_invocation_id" >&2
  exit 1
fi
if [[ -z "$new_pid" || "$new_pid" == "0" ]]; then
  printf '[remote] service %s has no running MainPID after restart\n' "$SERVICE_UNIT" >&2
  exit 1
fi

deploy/healthcheck.sh </dev/null
print_version
printf '[remote] deployed %s\n' "$RELEASE_ID"
REMOTE_SCRIPT
}

main() {
  local target="${1:-}"

  if [[ -z "$target" ]]; then
    usage
    exit 2
  fi

  configure_paths
  require_command yq
  require_command ssh
  require_command scp
  require_command shasum

  case "$target" in
    all)
      deploy_target ubuntu
      deploy_target belead
      ;;
    *)
      if [[ "$(yq -r ".servers.${target} // \"\"" "$SERVERS_CONFIG")" == "" ]]; then
        fail "unknown target: $target"
      fi
      deploy_target "$target"
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap print_deploy_result EXIT
  main "$@"
fi
