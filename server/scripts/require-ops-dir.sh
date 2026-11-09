#!/usr/bin/env bash

require_clawee_ops_dir() {
  local check_default_config=true

  case "${1:-}" in
    "") ;;
    --skip-config-check) check_default_config=false ;;
    *)
      printf 'unknown require_clawee_ops_dir option: %s\n' "$1" >&2
      return 2
      ;;
  esac

  if [[ -z "${CLAWEE_OPS_DIR:-}" ]]; then
    printf 'CLAWEE_OPS_DIR must point to the private operations directory\n' >&2
    return 1
  fi
  if [[ ! -d "$CLAWEE_OPS_DIR" ]]; then
    printf 'CLAWEE_OPS_DIR is not a directory: %s\n' "$CLAWEE_OPS_DIR" >&2
    return 1
  fi

  CLAWEE_OPS_DIR="$(cd "$CLAWEE_OPS_DIR" && pwd -P)"
  if [[ "$check_default_config" == true && ! -f "$CLAWEE_OPS_DIR/configs/config.yaml" ]]; then
    printf 'configuration file not found: %s/configs/config.yaml\n' "$CLAWEE_OPS_DIR" >&2
    return 1
  fi
  export CLAWEE_OPS_DIR
}
