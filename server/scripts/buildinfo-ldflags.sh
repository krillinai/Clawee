#!/usr/bin/env bash
set -euo pipefail

if [ -n "${CLAW_GATEWAY_VERSION:-}" ]; then
  claw_gateway_version="$CLAW_GATEWAY_VERSION"
else
  script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [ -f "$script_root/../VERSION" ]; then
    claw_gateway_version="$(tr -d '[:space:]' < "$script_root/../VERSION")"
  fi
  claw_gateway_version="${claw_gateway_version:-0.0.0-dev}"
fi
claw_gateway_build_time="${CLAW_GATEWAY_BUILD_TIME:-$(TZ=Asia/Shanghai date +%Y%m%dT%H%M%S)BJT}"
claw_gateway_commit="${CLAW_GATEWAY_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || true)}"

ldflags=(
  "-X" "github.com/krillinai/Clawee/server/internal/buildinfo.Version=$claw_gateway_version"
  "-X" "github.com/krillinai/Clawee/server/internal/buildinfo.BuildTime=$claw_gateway_build_time"
)
if [ -n "$claw_gateway_commit" ]; then
  ldflags+=("-X" "github.com/krillinai/Clawee/server/internal/buildinfo.Commit=$claw_gateway_commit")
fi

printf '%s\n' "${ldflags[*]}"
