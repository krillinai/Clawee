#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  pnpm server:deploy:source -- --host <user@host> --dir <远端绝对目录> [--port <SSH端口>] [--service <systemd unit>]

示例：
  pnpm server:deploy:source -- \
    --host ubuntu@1.13.175.31 \
    --dir /home/ubuntu/clawee-agent

也可以通过环境变量设置默认值：
  CLAWEE_SERVER_SSH
  CLAWEE_SERVER_SOURCE_DIR
  CLAWEE_SERVER_SSH_PORT
  CLAWEE_SERVER_SYSTEMD_SERVICE

脚本同步源码、按锁文件安装依赖后会重启 systemd 服务（默认 clawee-server.service）。
服务启动命令仍负责构建 Web 和启动 Daemon。
远端目标必须是专用源码目录，运行数据应放在目标目录之外，例如 /var/lib/clawee。
非 root SSH 用户需要拥有无需交互输入密码的 systemctl 权限。
EOF
}

fail() {
  printf '部署失败：%s\n' "$1" >&2
  exit 1
}

remote_host="${CLAWEE_SERVER_SSH:-}"
remote_dir="${CLAWEE_SERVER_SOURCE_DIR:-}"
ssh_port="${CLAWEE_SERVER_SSH_PORT:-22}"
service_name="${CLAWEE_SERVER_SYSTEMD_SERVICE:-clawee-server.service}"

while (($# > 0)); do
  case "$1" in
    --)
      shift
      ;;
    --host)
      (($# >= 2)) || fail '--host 缺少参数'
      remote_host="$2"
      shift 2
      ;;
    --dir)
      (($# >= 2)) || fail '--dir 缺少参数'
      remote_dir="$2"
      shift 2
      ;;
    --port)
      (($# >= 2)) || fail '--port 缺少参数'
      ssh_port="$2"
      shift 2
      ;;
    --service)
      (($# >= 2)) || fail '--service 缺少参数'
      service_name="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$1"
      ;;
  esac
done

[[ -n "$remote_host" ]] || fail '必须通过 --host 或 CLAWEE_SERVER_SSH 指定 SSH 地址'
[[ "$remote_host" =~ ^([A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ ]] \
  || fail 'SSH 地址无效'
[[ "$ssh_port" =~ ^[0-9]+$ ]] || fail 'SSH 端口必须是数字'
((ssh_port >= 1 && ssh_port <= 65535)) || fail 'SSH 端口超出有效范围'
[[ "$service_name" =~ ^[A-Za-z0-9_.@:-]+\.service$ ]] \
  || fail 'systemd unit 名称无效，且必须以 .service 结尾'
[[ "$remote_dir" == /* ]] || fail '远端目录必须是绝对路径'
[[ "$remote_dir" =~ ^/[A-Za-z0-9._/-]+$ ]] \
  || fail '远端目录只能包含字母、数字、点、下划线、连字符和斜杠'
case "$remote_dir" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
    fail '远端目录范围过大，请指定专用源码子目录'
    ;;
  */../*|*/..)
    fail '远端目录不能包含 ..'
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/.." && pwd)"
git -C "$repository_root" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail '脚本必须在 Git 工作区中运行'

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/clawee-source-deploy.XXXXXX")"
archive_path="$temporary_dir/clawee-source.tar.gz"
file_list_path="$temporary_dir/source-files"
remote_upload_dir=''

cleanup() {
  rm -rf -- "$temporary_dir"
  if [[ -n "$remote_upload_dir" ]]; then
    ssh -p "$ssh_port" "$remote_host" \
      "rm -rf -- '$remote_upload_dir'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

git -C "$repository_root" ls-files \
  --cached --others --exclude-standard -z >"$file_list_path"
[[ -s "$file_list_path" ]] || fail '没有可部署的源码文件'

tar_options=(--no-xattrs)
if [[ "$(uname -s)" == 'Darwin' ]]; then
  tar_options+=(--no-mac-metadata)
fi
tar "${tar_options[@]}" -C "$repository_root" \
  -czf "$archive_path" --null -T "$file_list_path"

if command -v sha256sum >/dev/null 2>&1; then
  archive_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
else
  archive_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
fi

commit="$(git -C "$repository_root" rev-parse --short HEAD)"
if [[ -n "$(git -C "$repository_root" status --porcelain)" ]]; then
  commit="$commit-dirty"
fi

printf '正在上传 Clawee 源码（%s）到 %s:%s\n' \
  "$commit" "$remote_host" "$remote_dir"

remote_upload_dir="$(ssh -p "$ssh_port" "$remote_host" \
  'mktemp -d /tmp/clawee-source-deploy.XXXXXX')"
[[ "$remote_upload_dir" == /tmp/clawee-source-deploy.* ]] \
  || fail '无法创建安全的远端临时目录'

scp -P "$ssh_port" "$archive_path" \
  "$remote_host:$remote_upload_dir/clawee-source.tar.gz"

ssh -p "$ssh_port" "$remote_host" bash -s -- \
  "$remote_upload_dir/clawee-source.tar.gz" \
  "$archive_sha256" \
  "$remote_dir" \
  "$commit" \
  "$service_name" <<'REMOTE_SCRIPT'
set -euo pipefail

archive_path="$1"
expected_sha256="$2"
target_dir="${3%/}"
source_revision="$4"
service_name="$5"
target_parent="$(dirname "$target_dir")"
target_name="$(basename "$target_dir")"

actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
[[ "$actual_sha256" == "$expected_sha256" ]] || {
  echo 'SERVER_SOURCE_ARCHIVE_CHECKSUM_MISMATCH' >&2
  exit 1
}

mkdir -p "$target_parent"
stage_dir="$(mktemp -d "$target_parent/.${target_name}.deploy.XXXXXX")"
backup_dir=''

cleanup_remote() {
  if [[ -n "$stage_dir" ]]; then
    rm -rf -- "$stage_dir"
  fi
  if [[ -n "$backup_dir" && -d "$backup_dir" ]]; then
    if [[ ! -e "$target_dir" ]]; then
      mv "$backup_dir" "$target_dir"
    else
      rm -rf -- "$backup_dir"
    fi
  fi
}
trap cleanup_remote EXIT

tar -xzf "$archive_path" -C "$stage_dir" --no-same-owner
printf '%s\n' "$source_revision" >"$stage_dir/.clawee-source-revision"

command -v pnpm >/dev/null 2>&1 || {
  echo 'SERVER_SOURCE_PNPM_NOT_FOUND' >&2
  exit 1
}
printf '正在安装源码依赖\n'
pnpm --dir "$stage_dir" install --frozen-lockfile

if [[ -L "$target_dir" || (-e "$target_dir" && ! -d "$target_dir") ]]; then
  echo 'SERVER_SOURCE_TARGET_INVALID' >&2
  exit 1
fi
if [[ -d "$target_dir" && ! -f "$target_dir/.clawee-source-revision" ]]; then
  if find "$target_dir" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    echo 'SERVER_SOURCE_TARGET_NOT_MANAGED' >&2
    exit 1
  fi
fi
if [[ -e "$target_dir/.runtime" || -L "$target_dir/.runtime" ]]; then
  echo 'SERVER_SOURCE_TARGET_CONTAINS_RUNTIME_DATA' >&2
  exit 1
fi

if [[ -d "$target_dir" ]]; then
  backup_dir="$(mktemp -d "$target_parent/.${target_name}.previous.XXXXXX")"
  rmdir "$backup_dir"
  mv "$target_dir" "$backup_dir"
fi
if ! mv "$stage_dir" "$target_dir"; then
  if [[ -d "$backup_dir" && ! -e "$target_dir" ]]; then
    mv "$backup_dir" "$target_dir"
  fi
  exit 1
fi
stage_dir=''
if [[ -n "$backup_dir" ]]; then
  rm -rf -- "$backup_dir"
  backup_dir=''
fi

printf '源码已部署到 %s（%s）\n' "$target_dir" "$source_revision"

systemctl_command=(systemctl)
journalctl_command=(journalctl)
if ((EUID != 0)); then
  command -v sudo >/dev/null 2>&1 || {
    echo 'SERVER_SOURCE_SERVICE_RESTART_REQUIRES_SUDO' >&2
    exit 1
  }
  systemctl_command=(sudo -n systemctl)
  journalctl_command=(sudo -n journalctl)
fi

printf '正在重启 systemd 服务 %s\n' "$service_name"
if ! "${systemctl_command[@]}" restart "$service_name"; then
  "${systemctl_command[@]}" status "$service_name" --no-pager --lines=20 >&2 || true
  echo 'SERVER_SOURCE_SERVICE_RESTART_FAILED' >&2
  exit 1
fi

invocation_id="$(
  "${systemctl_command[@]}" show "$service_name" --property=InvocationID --value \
    2>/dev/null || true
)"
if [[ ! "$invocation_id" =~ ^[a-fA-F0-9]{32}$ ]]; then
  "${systemctl_command[@]}" status "$service_name" --no-pager --lines=20 >&2 || true
  echo 'SERVER_SOURCE_SERVICE_INVOCATION_ID_UNAVAILABLE' >&2
  exit 1
fi

for ((attempt = 1; attempt <= 120; attempt += 1)); do
  active_state="$(
    "${systemctl_command[@]}" show "$service_name" --property=ActiveState --value \
      2>/dev/null || true
  )"
  sub_state="$(
    "${systemctl_command[@]}" show "$service_name" --property=SubState --value \
      2>/dev/null || true
  )"
  if [[ "$active_state" != 'active' || "$sub_state" != 'running' ]]; then
    break
  fi
  ready_log="$(
    "${journalctl_command[@]}" "_SYSTEMD_INVOCATION_ID=$invocation_id" \
      --no-pager --output=cat 2>/dev/null || true
  )"
  if [[ "$ready_log" == *'"event":"SERVER_READY"'* ]]; then
    printf 'systemd 服务已重启并通过启动自检：%s\n' "$service_name"
    exit 0
  fi
  sleep 1
done

"${systemctl_command[@]}" status "$service_name" --no-pager --lines=20 >&2 || true
echo 'SERVER_SOURCE_SERVICE_NOT_READY' >&2
exit 1
REMOTE_SCRIPT

printf '源码同步及服务重启完成。\n'
