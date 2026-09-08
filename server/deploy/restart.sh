#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/stop.sh"
"$SCRIPT_DIR/start.sh"
"$SCRIPT_DIR/healthcheck.sh"
