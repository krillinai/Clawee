#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

target_goos="${GOOS:-$(go env GOOS)}"
target_goarch="${GOARCH:-$(go env GOARCH)}"
binary_name="clawee-collector"
if [ "$target_goos" = "windows" ]; then
  binary_name="clawee-collector.exe"
fi

OUTPUT_PATH="${COLLECTOR_OUTPUT:-./bin/$binary_name}"
OUTPUT_DIR="$(dirname "$OUTPUT_PATH")"

collector_version="${COLLECTOR_VERSION:-0.1.1}"
collector_build_time="${COLLECTOR_BUILD_TIME:-$(TZ=Asia/Shanghai date +%Y%m%dT%H%M%S)BJT}"
collector_commit="${COLLECTOR_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || true)}"
ldflags=(
  "-X" "github.com/krillinai/Clawee/server/internal/collector/version.Version=$collector_version"
  "-X" "github.com/krillinai/Clawee/server/internal/collector/version.BuildTime=$collector_build_time"
)
if [ -n "$collector_commit" ]; then
  ldflags+=("-X" "github.com/krillinai/Clawee/server/internal/collector/version.Commit=$collector_commit")
fi

mkdir -p "$OUTPUT_DIR"
GOOS="$target_goos" GOARCH="$target_goarch" CGO_ENABLED="${CGO_ENABLED:-0}" go build -trimpath -ldflags "${ldflags[*]}" -o "$OUTPUT_PATH" ./cmd/clawee-collector

if [ "$target_goos" = "windows" ]; then
  runner_output_path="$(dirname "$OUTPUT_PATH")/clawee-collector-runner.exe"
  runner_ldflags=("${ldflags[@]}" "-H=windowsgui")
  GOOS="$target_goos" GOARCH="$target_goarch" CGO_ENABLED="${CGO_ENABLED:-0}" go build -trimpath -ldflags "${runner_ldflags[*]}" -o "$runner_output_path" ./cmd/clawee-collector-runner
fi
