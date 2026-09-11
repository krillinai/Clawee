#!/usr/bin/env bash
set -euo pipefail

claw_mcp_version="${CLAW_MCP_VERSION:-0.1.4}"
claw_mcp_build_time="${CLAW_MCP_BUILD_TIME:-$(TZ=Asia/Shanghai date +%Y%m%dT%H%M%S)BJT}"
claw_mcp_commit="${CLAW_MCP_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || true)}"

ldflags=(
  "-X" "github.com/krillinai/Clawee/server/internal/buildinfo.Version=$claw_mcp_version"
  "-X" "github.com/krillinai/Clawee/server/internal/buildinfo.BuildTime=$claw_mcp_build_time"
)
if [ -n "$claw_mcp_commit" ]; then
  ldflags+=("-X" "github.com/krillinai/Clawee/server/internal/buildinfo.Commit=$claw_mcp_commit")
fi

printf '%s\n' "${ldflags[*]}"
