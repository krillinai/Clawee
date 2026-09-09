#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_VERSION="$(
  node -e \
    'const fs = require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' \
    "$ROOT_DIR/../package.json"
)"
PACKAGE_SCRIPT="$ROOT_DIR/scripts/package-release.sh"
DEPLOY_SCRIPT="$ROOT_DIR/scripts/deploy-release.sh"
ROLLBACK_SCRIPT="$ROOT_DIR/scripts/rollback-release.sh"
TEST_DIR="$(mktemp -d)"
TEST_OPS_DIR="$TEST_DIR/ops"
RELEASE_DIR="$TEST_DIR/release"
SENTINEL="private-config-sentinel-must-not-ship"
PRIVATE_DOMAIN_SUFFIX="clawee"".""work"
PERSONAL_HOME_PREFIX="/U""sers/"
KEY_PREFIX="s""k-"

trap 'rm -rf "$TEST_DIR"' EXIT

mkdir -p "$TEST_OPS_DIR/configs"
printf 'security:\n  user_jwt_signing_key: "%s"\n' "$SENTINEL" >"$TEST_OPS_DIR/configs/config.yaml"

if [[ ! -f "$ROOT_DIR/configs/config.example.yaml" ]]; then
  printf 'public example config is missing\n' >&2
  exit 1
fi
if [[ -e "$ROOT_DIR/configs/config.yaml" ]]; then
  printf 'public repository still contains configs/config.yaml\n' >&2
  exit 1
fi
if grep -Eq "(gateway|admin)\\.${PRIVATE_DOMAIN_SUFFIX}|${PERSONAL_HOME_PREFIX}[A-Za-z0-9._-]+" \
    "$ROOT_DIR/configs/config.example.yaml" "$ROOT_DIR/internal/config/config.go"; then
  printf 'public configuration contains a fixed domain or personal path\n' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*(token|user_jwt_signing_key|agent_token_encryption_key|access_key_id|access_key_secret|deployment_credential|admin_api_key|client_secret):[[:space:]]*"[^"]+"' \
    "$ROOT_DIR/configs/config.example.yaml"; then
  printf 'public example config contains a credential value\n' >&2
  exit 1
fi

if ! grep -Fq 'RELEASE_PATHS=(claw-mcp public db deploy)' "$DEPLOY_SCRIPT" ||
   ! grep -Fq 'RELEASE_PATHS=(claw-mcp public db deploy)' "$ROLLBACK_SCRIPT"; then
  printf 'deployment scripts still treat configs as release-owned files\n' >&2
  exit 1
fi
if ! grep -Fq 'scp "$config_source" "$ssh_host:$remote_config"' "$DEPLOY_SCRIPT" ||
   ! grep -Fq 'install -m 0600 "$REMOTE_CONFIG" "$CONFIG_PATH"' "$DEPLOY_SCRIPT"; then
  printf 'deployment script does not transfer private config separately\n' >&2
  exit 1
fi
if ! grep -Fq './claw-mcp migrate up --config "$DEPLOY_DIR/$CONFIG_PATH"' "$DEPLOY_SCRIPT"; then
  printf 'deployment script does not migrate with an absolute external config path\n' >&2
  exit 1
fi

PACKAGE_PATH="$(
  CLAWEE_OPS_DIR="$TEST_OPS_DIR" \
  RELEASE_DIR="$RELEASE_DIR" \
  PACKAGE_NAME="claw-mcp-open-source-test.tar.gz" \
    "$PACKAGE_SCRIPT"
)"

if [[ ! -f "$PACKAGE_PATH" ]]; then
  printf 'release package was not created\n' >&2
  exit 1
fi

PACKAGE_LIST="$TEST_DIR/package.list"
tar -tzf "$PACKAGE_PATH" >"$PACKAGE_LIST"
if ! grep -Fxq './configs/config.example.yaml' "$PACKAGE_LIST"; then
  printf 'release package is missing configs/config.example.yaml\n' >&2
  exit 1
fi
if ! grep -Fxq './release-manifest.json' "$PACKAGE_LIST"; then
  printf 'release package is missing release-manifest.json\n' >&2
  exit 1
fi
if grep -Eq '(^|/)config\.yaml$|(^|/)\.env$' "$PACKAGE_LIST"; then
  printf 'release package contains a private config or .env\n' >&2
  exit 1
fi

EXTRACT_DIR="$TEST_DIR/extracted"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$PACKAGE_PATH" -C "$EXTRACT_DIR"
if grep -R -I -Fq "$SENTINEL" "$EXTRACT_DIR"; then
  printf 'release package contains data from the private operations config\n' >&2
  exit 1
fi
if grep -R -I -Eq "(gateway|admin)\\.${PRIVATE_DOMAIN_SUFFIX}|${PERSONAL_HOME_PREFIX}[A-Za-z0-9._-]+|${KEY_PREFIX}standalone-secret-value" "$EXTRACT_DIR"; then
  printf 'release package contains a fixed private marker\n' >&2
  exit 1
fi
node --input-type=module - "$EXTRACT_DIR/release-manifest.json" "$EXPECTED_VERSION" <<'NODE'
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const expectedVersion = process.argv[3];
if (
  manifest.schemaVersion !== 1
  || manifest.product !== 'clawee-server'
  || manifest.version !== expectedVersion
  || manifest.platform !== 'linux'
  || manifest.arch !== 'amd64'
) {
  throw new Error(`invalid release manifest: ${JSON.stringify(manifest)}`);
}
NODE

bash "$ROOT_DIR/scripts/test-deploy-release-service-unit.sh"
printf 'package release tests passed\n'
