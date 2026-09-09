#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_GOOS="${TARGET_GOOS:-linux}"
TARGET_GOARCH="${TARGET_GOARCH:-amd64}"
DATE_TAG="${DATE_TAG:-$(date +%Y%m%d)}"
PACKAGE_NAME="${PACKAGE_NAME:-claw-mcp-release-${TARGET_GOOS}-${TARGET_GOARCH}-${DATE_TAG}.tar.gz}"
RELEASE_DIR="${RELEASE_DIR:-$ROOT_DIR/release}"
BUILD_DIR="$RELEASE_DIR/build-${TARGET_GOOS}-${TARGET_GOARCH}"
PACKAGE_PATH="$RELEASE_DIR/$PACKAGE_NAME"
EXAMPLE_CONFIG="$ROOT_DIR/configs/config.example.yaml"

if [[ ! -f "$EXAMPLE_CONFIG" ]]; then
  printf 'package-release: example config not found: %s\n' "$EXAMPLE_CONFIG" >&2
  exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$RELEASE_DIR"
mkdir -p "$BUILD_DIR/public" "$BUILD_DIR/configs" "$BUILD_DIR/db" "$BUILD_DIR/deploy"
mkdir -p "$BUILD_DIR/licenses/clawee"
cp "$ROOT_DIR/../LICENSE" "$ROOT_DIR/../NOTICE" "$BUILD_DIR/licenses/clawee/"
cp -R "$ROOT_DIR/../third_party" "$BUILD_DIR/licenses/third_party"

"$ROOT_DIR/scripts/build-web.sh" >&2
make collector-downloads-all >&2

CGO_ENABLED=0 GOOS="$TARGET_GOOS" GOARCH="$TARGET_GOARCH" go build -trimpath -ldflags "$("$ROOT_DIR/scripts/buildinfo-ldflags.sh")" -o "$BUILD_DIR/claw-mcp" ./cmd/claw-mcp

cp -R "$ROOT_DIR/public/collectors" "$BUILD_DIR/public/"
cp "$EXAMPLE_CONFIG" "$BUILD_DIR/configs/config.example.yaml"
cp "$ROOT_DIR/deploy/docker-compose.yaml" "$BUILD_DIR/deploy/docker-compose.yaml"
cp "$ROOT_DIR/deploy/start.sh" "$BUILD_DIR/deploy/start.sh"
cp "$ROOT_DIR/deploy/stop.sh" "$BUILD_DIR/deploy/stop.sh"
cp "$ROOT_DIR/deploy/restart.sh" "$BUILD_DIR/deploy/restart.sh"
cp "$ROOT_DIR/deploy/healthcheck.sh" "$BUILD_DIR/deploy/healthcheck.sh"
cp -R "$ROOT_DIR/db/migrations" "$BUILD_DIR/db/"
RELEASE_VERSION="${CLAW_MCP_VERSION:-$(node -p "require('../package.json').version")}"
RELEASE_COMMIT="${CLAW_MCP_COMMIT:-$(git rev-parse HEAD 2>/dev/null || printf unknown)}"
RELEASE_BUILD_TIME="${CLAW_MCP_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
node --input-type=module - \
  "$BUILD_DIR/release-manifest.json" \
  "$RELEASE_VERSION" \
  "$RELEASE_COMMIT" \
  "$RELEASE_BUILD_TIME" \
  "$TARGET_GOOS" \
  "$TARGET_GOARCH" <<'NODE'
import { writeFileSync } from 'node:fs';

const [
  outputPath,
  version,
  commit,
  buildTime,
  goos,
  goarch
] = process.argv.slice(2);
writeFileSync(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  product: 'clawee-server',
  version,
  commit,
  buildTime,
  platform: goos,
  arch: goarch
}, null, 2)}\n`);
NODE
find "$BUILD_DIR" -type f -name '.DS_Store' -delete

COPYFILE_DISABLE=1 tar --no-xattrs -czf "$PACKAGE_PATH" -C "$BUILD_DIR" .
printf '%s\n' "$PACKAGE_PATH"
