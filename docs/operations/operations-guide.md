# Clawee 运维部署指南

本文面向负责企业私有化部署的运维人员，目标是在具备主机、数据库和网络访问条件后，完成 Gateway 的首次部署、管理员注册和基本可用性验证。

本文覆盖基础部署、服务操作和客户端 Server 模式的 MCP 接入，不介绍其他业务能力的配置和运营。

## 1. 部署组成

一次基础部署包含以下组件：

| 组件 | 作用 | 是否必须 |
| --- | --- | --- |
| Clawee Gateway | 提供账号、管理台和基础 HTTP 服务 | 是 |
| PostgreSQL | 保存账号、权限、审计和其他服务端数据 | 是，可由企业单独提供 |
| 持久化数据目录 | 保存服务端运行所需的持久化数据 | 按启用能力决定；建议预先规划 |
| 企业 DNS | 将访问域名解析到 Gateway 所在服务器 IP | 是 |

Gateway 默认监听 `0.0.0.0:1904`。数据库只需要允许 Gateway 主机访问，不需要向普通用户开放。

## 2. 部署资源清单

部署前请由企业运维人员准备并确认以下资源。资源规格根据预计用户数、并发量和数据量评估，本文不规定固定的 CPU 和内存下限。

### 2.1 主机资源

- 一台可长期运行 Gateway 的 Linux 主机，或企业容器平台中的运行环境。
- 足够的 CPU、内存和磁盘空间，并预留日志、升级包和临时文件空间。
- 能够执行 Docker，或能够运行 Linux 二进制文件。
- 能够创建服务目录、数据目录和日志目录。
- 能够配置服务自启动和服务重启。

### 2.2 数据库资源

- PostgreSQL 16 或与当前版本兼容的 PostgreSQL 服务。
- 数据库名称、数据库用户、密码和连接地址。
- Gateway 主机到数据库主机和端口的网络连通性。
- 数据库创建、迁移和备份权限。

企业已经提供专用 PostgreSQL 时，不需要部署项目附带的 PostgreSQL 容器。

### 2.3 网络和访问资源

- 一个供用户访问的 Gateway 域名。
- 企业 DNS 将该域名解析到 Gateway 服务器 IP。
- 防火墙允许用户访问 Gateway 服务端口，默认是 `1904`。
- 防火墙允许 Gateway 访问 PostgreSQL 端口。
- 运维人员具备服务器登录权限、服务管理权限和数据库管理权限。

### 2.4 配置和 Secret

- 一个位于源码仓库或程序目录之外的运维配置目录，例如 `/etc/clawee/ops`。
- 数据库连接串。
- JWT 签名密钥和 Agent Token 加密密钥。首次初始化时可由脚本生成。
- Secret 的安全保存位置和访问权限。

不要将生产配置、数据库密码、密钥或真实业务数据提交到 Git，也不要放入镜像或安装包。

## 3. 部署前环境核验

以下检查均应在部署记录中保存结果。命令中的路径、域名和端口替换为企业实际值。

### 3.1 主机和运行时

```bash
uname -a
df -h
free -h
```

确认主机磁盘空间满足程序、日志和数据目录要求，且运维账号可以创建和读取部署目录。

如果使用二进制部署，确认可以运行目标平台的 Linux 二进制；如果使用容器运行 Gateway，确认容器平台可以挂载配置和持久化目录。Docker 不是 Gateway 部署的强制要求。

### 3.2 端口和网络

```bash
ss -lnt
```

确认以下网络关系：

- 用户或客户端可以访问 Gateway 的 `1904` 端口。
- Gateway 主机可以访问 PostgreSQL 主机和端口。
- 域名已经解析到 Gateway 服务器 IP。

### 3.3 域名解析

```bash
dig +short <Gateway 域名>
```

返回结果应包含 Gateway 服务器的实际 IP。用户访问时使用域名和 Gateway 服务端口；不要把 `0.0.0.0` 作为客户端访问地址。

### 3.4 数据库核验

使用企业提供的 PostgreSQL 客户端验证数据库、用户和权限。例如：

```bash
psql "postgres://<用户>:<密码>@<数据库主机>:<端口>/<数据库名>?sslmode=<模式>" \
  -c 'select version();'
```

确认：

- 数据库可以登录。
- 目标用户可以创建和修改 Clawee 所需表结构。
- 数据库名称不是日常开发或其他系统的数据库。
- 已明确数据库备份和恢复责任人。

## 4. 准备数据库

根据企业实际情况选择一种方式。

### 4.1 使用企业专用 PostgreSQL

由数据库管理员完成以下准备工作：

1. 创建生产数据库和专用数据库用户。
2. 设置强密码和最小必要权限。
3. 允许 Gateway 主机访问数据库端口。
4. 提供完整数据库连接串。
5. 确认数据库已纳入企业备份策略。

数据库连接串稍后写入 `database.url`，不要写入仓库内的示例配置。

### 4.2 使用项目附带 PostgreSQL 容器

该方式适合快速部署或由企业自行维护容器数据卷的环境。它只启动 PostgreSQL，不代表 Gateway 必须使用 Docker 部署。

在仓库根目录执行：

```bash
docker compose -f server/deploy/docker-compose.yaml up -d --wait postgres
```

确认数据库状态：

```bash
docker compose -f server/deploy/docker-compose.yaml exec postgres \
  pg_isready -U claw_gateway -d claw_gateway
```

该 Compose 默认将数据库映射到本机 `127.0.0.1:15932`，仅适用于 Gateway 与数据库位于同一主机的场景。跨主机部署时应改用企业专用数据库或按企业规范调整数据库网络配置。

## 5. 准备配置

### 5.1 创建运维目录

运维目录必须位于源码仓库和程序发布目录之外：

```bash
export CLAWEE_OPS_DIR=/etc/clawee/ops
sudo mkdir -p "$CLAWEE_OPS_DIR"
sudo chmod 700 "$CLAWEE_OPS_DIR"
```

### 5.2 初始化配置文件

在仓库根目录执行：

```bash
pnpm run init \
  --ops-dir "$CLAWEE_OPS_DIR" \
  --gateway "http://<Gateway 域名>:1904"
```

初始化脚本会生成：

- `$CLAWEE_OPS_DIR/configs/config.yaml`
- 随机 JWT 签名密钥
- 随机 Agent Token 加密密钥

重复执行不会覆盖已有配置。配置文件应仅允许运行 Gateway 的账号读取：

```bash
sudo chmod 600 "$CLAWEE_OPS_DIR/configs/config.yaml"
```

### 5.3 调整生产配置

编辑 `$CLAWEE_OPS_DIR/configs/config.yaml`，至少确认以下字段：

```yaml
server:
  addr: "0.0.0.0:1904"

database:
  url: "postgres://<用户>:<密码>@<数据库主机>:<端口>/<数据库名>?sslmode=<模式>"

mcp:
  public_base_url: "http://<Gateway 域名>:1904"
```

其中：

- `database.url` 必须替换为企业数据库连接串；使用附带容器时填写容器或本机可访问的地址。
- `mcp.public_base_url` 必须使用用户实际访问的 Gateway 地址。
- `security.user_jwt_signing_key` 必须至少为 32 个 ASCII 字符。
- `security.agent_token_encryption_key` 必须为 32 个 ASCII 字符。
- `logging.output` 建议使用 `stdout`，由企业平台统一采集；二进制直接运行时也可以指定日志文件。

不使用的可选集成保持关闭，不要为了完成基础部署填写无关凭据。

## 6. 执行程序部署

### 6.1 准备数据库迁移

部署新版本前，先使用最终配置执行迁移。二进制部署示例：

```bash
export CLAWEE_OPS_DIR=/etc/clawee/ops
./claw-gateway migrate up
```

从源码验证时可以在仓库根目录执行：

```bash
CLAWEE_OPS_DIR="$CLAWEE_OPS_DIR" pnpm run db:migrate
```

迁移前确认数据库连接指向生产数据库，并由数据库管理员完成必要备份。不要并发执行迁移。

### 6.2 部署 Gateway 程序

企业可以按现有标准选择二进制或容器运行 Gateway。

二进制部署的目录至少应包含：

- `claw-gateway` 可执行文件；
- `deploy/start.sh`、`deploy/stop.sh`、`deploy/restart.sh` 和 `deploy/healthcheck.sh`；
- 可写的运行状态和日志目录。

启动前设置运维目录：

```bash
export CLAWEE_OPS_DIR=/etc/clawee/ops
./deploy/start.sh
./deploy/healthcheck.sh
```

容器运行 Gateway 时，将配置目录以只读方式挂载，并通过环境变量指定：

```bash
docker run -d --name clawee-gateway \
  -p 1904:1904 \
  -e CLAWEE_OPS_DIR=/run/clawee-ops \
  -v /etc/clawee/ops:/run/clawee-ops:ro \
  -v clawee-data:/app/data \
  <Gateway 镜像>
```

容器部署不要求同时启动 PostgreSQL 容器；如果企业已提供专用数据库，只需保证容器能够访问该数据库，并在配置文件中填写对应连接串。

### 6.3 配置服务自启动

使用企业现有的 systemd、容器编排或主机服务管理方式配置自启动。自启动配置至少应满足：

- 服务异常退出后能够告警或按企业策略自动拉起；
- 服务停止时允许正常退出；
- 配置目录以只读方式提供给服务；
- 日志和数据目录不会因重启丢失。

### 6.4 部署 Clawee client Server 模式

`client/` 下的 `server:deploy:source` 用于将 Clawee client 的源码部署到 Linux 服务器，并以 Node daemon Server 模式运行。它不是 Gateway 的部署命令，也不会部署 `server/` 下的 Go 服务。

本节示例使用以下目录：

```text
源码目录：/home/<SSH 用户>/clawee-agent
数据目录：/home/<SSH 用户>/data/clawee-agent
```

远端服务器需要具备 Node.js 24、Corepack、pnpm 10.33.3、可执行的 `codex` 命令和 systemd。SSH 用户还需要能够免密码执行 `sudo systemctl`。先检查环境：

```bash
ssh <SSH 用户>@<服务器地址> '
set -e
node --version
corepack --version
corepack enable
pnpm --version
command -v codex
command -v systemctl
command -v sudo
sudo -n true
'
```

在远端创建源码和运行数据目录。运行数据必须位于源码目录之外，避免源码同步时被替换：

```bash
ssh <SSH 用户>@<服务器地址> '
set -e
mkdir -p /home/<SSH 用户>/clawee-agent
mkdir -p /home/<SSH 用户>/data/clawee-agent/projects
chmod 700 /home/<SSH 用户>/data/clawee-agent
'
```

部署脚本只负责同步源码、安装依赖和重启服务，不会自动创建 systemd unit。首次部署前，在远端创建 `clawee-server.service`：

```bash
ssh <SSH 用户>@<服务器地址>
```

```bash
PNPM_BIN="$(command -v pnpm)"
CODEX_BIN="$(command -v codex)"
CODEX_DIR="$(dirname "$CODEX_BIN")"

sudo tee /etc/systemd/system/clawee-server.service >/dev/null <<EOF
[Unit]
Description=Clawee Client Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<SSH 用户>
Group=<SSH 用户>
WorkingDirectory=/home/<SSH 用户>/clawee-agent
Environment=PATH=${CODEX_DIR}:/home/<SSH 用户>/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${PNPM_BIN} --dir /home/<SSH 用户>/clawee-agent server:start -- --server --host 0.0.0.0 --port 19860 --data-dir /home/<SSH 用户>/data/clawee-agent
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable clawee-server.service
```

退出远端 Shell，回到本地仓库的 `client/` 目录执行源码部署：

```bash
cd <Clawee 仓库>/client

pnpm server:deploy:source -- \
  --host <SSH 用户>@<服务器地址> \
  --dir /home/<SSH 用户>/clawee-agent \
  --service clawee-server.service
```

如果 SSH 使用非 22 端口，增加 `--port <SSH 端口>`。目标源码目录首次使用时应为空，或者必须是此前由该脚本管理的目录；不要将现有的非 Clawee 目录直接作为 `--dir`。脚本会在远端按锁文件执行 `pnpm install --frozen-lockfile`，然后重启 systemd 服务并等待 `SERVER_READY`。

部署完成后验证服务和客户端 Server 接口：

```bash
ssh <SSH 用户>@<服务器地址> \
  'sudo systemctl status clawee-server.service --no-pager'

ssh <SSH 用户>@<服务器地址> \
  'sudo journalctl -u clawee-server.service -n 100 --no-pager'

curl --fail http://<服务器地址>:19860/healthz
```

客户端 Server 的访问 Token 保存在数据目录中：

```bash
ssh <SSH 用户>@<服务器地址> \
  'cat /home/<SSH 用户>/data/clawee-agent/server-token'
```

客户端访问地址为 `http://<服务器地址>:19860`。正式对外提供服务时，应通过 HTTPS 反向代理访问，并按企业防火墙策略限制 `19860` 端口。已有客户端运行数据时，迁移前应先停止服务并备份 `/home/<SSH 用户>/data/clawee-agent`。

### 6.5 将客户端 Server 模式接入 Gateway MCP 上游

完成 6.4 的部署后，可以将该远程 Agent 注册为现有 Go Gateway 的 MCP 上游，让已授权用户通过 Gateway 提交远程任务并查询结果。此操作需要 Gateway 已部署且操作者具备 MCP 上游、能力和授权管理权限；源码部署命令不会自动完成后台配置。

#### 6.5.1 确认地址和访问 Token

`server:deploy:source` 的 `--host` 是 SSH 目标，`--port` 是 SSH 端口，`--dir` 是源码目录；Agent 的监听端口和数据目录以 systemd unit 的 `ExecStart` 为准：

```bash
ssh <SSH 用户>@<服务器地址> \
  'sudo systemctl cat clawee-server.service'
```

核对 `--port` 和 `--data-dir`。本指南示例分别为 `19860` 和 `/home/<SSH 用户>/data/clawee-agent`。按实际数据目录读取 `server-token`：

```bash
ssh <SSH 用户>@<服务器地址> \
  'cat /home/<SSH 用户>/data/clawee-agent/server-token'
```

该 Token 是远程 Agent 的访问凭据，不是 Gateway 的账号 MCP Token。只在受控终端读取并填入后台，不写入文档、Git、普通日志或工单。

上游地址必须从 Gateway 的运行环境可达，而不只是运维人员的电脑可达。同主机且同网络命名空间时可使用 `http://127.0.0.1:19860/mcp`，跨主机优先使用内网地址；容器中的 `127.0.0.1` 不指向宿主机。跨公网接入应使用 HTTPS 反向代理，并限制 Agent 原始端口的访问来源，不直接公开整个 Agent Web/API。反向代理需透传 `Authorization`、允许 MCP POST 请求，并禁用缓存和流式响应缓冲。

#### 6.5.2 新增 MCP 上游服务

在 Gateway 管理后台进入「MCP 上游服务」，点击「新增上游服务」，填写以下配置。名称、团队和分类按企业实际情况调整：

| 字段 | 示例或说明 |
| --- | --- |
| `server_id` | `remote-agent`；使用唯一 ID，支持字母、数字、点、下划线和连字符 |
| 名称 | `远程任务 Agent` |
| `domain` | `agent`，用于分类 |
| `transport` | `streamable_http`，不选择 `stdio`、`sse` 或 `collector_pull` |
| `endpoint` | `https://<Agent 域名>/mcp`；受信内网可使用 `http://<Agent 内网地址>:19860/mcp`，端口以实际配置为准 |
| `token` | `server-token` 文件中的原文，不添加 `Bearer ` 前缀 |
| `namespace` | `remote_agent`；不同上游使用不同命名空间，避免同名工具冲突 |
| `owner_team` | `<负责团队>` |
| 负责内容 | 按实际用途描述，例如「负责服务端项目任务执行与结果查询」 |

保存后点击「同步工具」，预期同步出以下三个工具，而不是 `codex.ask`：

| 上游工具 | 用途 |
| --- | --- |
| `clawee_submit_task` | 提交任务，立即返回任务 ID |
| `clawee_get_task` | 查询任务状态和持久化事件 |
| `clawee_get_task_result` | 查询任务终态结果 |

上述命名空间下，能力目录中的暴露名称类似 `remote_agent.clawee_submit_task`。新同步能力默认处于待审核状态；进入「MCP 能力目录」审核 Schema 和风险，配置门禁并启用能力，确认上游处于启用状态，再通过 MCP 授权入口显式授权给需要使用的用户账号。同步或启用能力不会自动授予调用权限。

`clawee_submit_task` 会实际启动远程执行，应按业务风险配置用户确认或管理员审批。所有获授权调用均使用同一远程 Agent 的运行环境；Gateway 的账号授权不等于远程工作区或任务数据的账号级隔离，不应将该服务直接作为不互信用户的共享执行环境。

#### 6.5.3 验证调用和排查故障

用已授权账号通过 Gateway 调用提交工具，先使用不修改文件的测试请求：

```json
{
  "prompt": "仅回复：远程 Agent MCP 接入成功，不修改任何文件。"
}
```

不指定项目时使用远程 Agent 的默认项目；也可以提交 `project_id` 或 `project_name`，但对应项目必须已存在、处于活动状态且目录可访问。提交后用返回的 `task_id` 调用状态查询工具，再查询终态结果，并检查后台代理审计。工具同步成功只说明 MCP 发现可用，不代表模型配置、Runtime 和实际任务执行均正常。

终端 MCP Client 应使用后台上游详情提供的 Gateway MCP 地址，例如 `https://<Gateway 域名>/mcp/servers/remote-agent`，并携带 Gateway 账号 MCP Token（`Authorization: Bearer <账号 MCP Token>`）和属于该账号且已启用的 `X-Claw-Agent-ID: <agent_id>`。不要向终端用户分发远程 Agent 的 `server-token`。

- 同步失败：检查 Gateway 到 Agent 的网络连通性、endpoint、Token 和反向代理配置。
- 同步成功但工具不可见或调用被拒绝：检查上游和能力是否启用、账号授权是否正确，以及门禁是否已完成。
- 工具可见但任务失败：检查远程 Agent 的模型配置、Codex Runtime、项目状态和目录权限。
- 浏览器直接打开 `/mcp` 返回 `405`：该接口不支持普通 GET 请求，不能据此判定服务故障，应使用后台同步或 MCP Client 验证。

其他上游接入和 Gateway endpoint 规则见 [上游 MCP Server 接入](../../server/docs/integration/upstream-mcp.md)。

## 7. 配置域名访问

将企业域名解析到 Gateway 服务器 IP，并让访问请求指向 Gateway 的 `1904` 端口。

完成解析后，在客户端或浏览器中使用该域名访问 Gateway，不使用 `127.0.0.1`、`localhost` 或 `0.0.0.0`。

### 7.1 反向代理和 CDN 缓存策略

如果 Gateway 前面使用 Nginx、云负载均衡或 CDN，必须将带认证、运行时状态或部署配置的响应设置为不缓存。不能只依赖浏览器的 `Cache-Control` 处理，也不能按 URL 缓存而忽略 Cookie、`Authorization` 或其他认证信息。

以下路径应在 CDN 和反向代理层配置为完全绕过缓存，并由应用返回 `Cache-Control: no-store`：

```text
/api/
/mcp
/mcp/*
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-protected-resource/mcp/*
/metrics
/healthz
/readyz
/version
/install
/install.sh
/install.ps1
/office/collectors/install
/office/collectors/install.sh
/office/collectors/install.ps1
/downloads/clawee-collector/*
/office/collectors/downloads/clawee-collector/*
```

其中：

- `/api/*` 包含认证、当前账户、应用数据、管理数据、文件和权限信息，禁止公共缓存。
- `/mcp*` 的响应受 Bearer Token、账户授权和上游状态影响，必须禁止缓存。`no-cache` 只要求重新验证，不等于禁止存储，应使用 `no-store`。
- `/.well-known/oauth-protected-resource/mcp*` 虽然是公开元数据，但内容依赖当前 Gateway 配置和上游状态；建议不缓存，至少不能使用长期缓存。
- `/metrics` 可能包含运行和业务统计信息，应禁止缓存，并按企业规范限制访问来源。
- `/healthz`、`/readyz` 和 `/version` 应反映当前实例状态和版本，不能缓存数小时或数天。
- 安装页面和脚本包含注册码、动态域名和安装参数，必须禁止缓存。采集器二进制只有在文件路径包含不可变版本号且不会被覆盖时才可以公共缓存，否则也必须禁止缓存。

以下静态资源不包含用户数据，可以继续使用公共缓存：

```text
/assets/*
/favicon.*
/logo.*
/krillinai-*.png
/krillinai-*.svg
```

`/admin`、`/app`、`/login`、`/register` 和 `/downloads` 返回 SPA 的 `index.html`，应保持 `Cache-Control: no-cache` 或更严格的 `no-store`，以便部署新版本后及时重新校验；不要将这些页面配置为长期公共缓存。静态带哈希的 `/assets/*` 可以继续使用长期不可变缓存。

部署完成后应清理 CDN 中旧的动态响应，并确认以下行为：

```bash
curl -i https://<Gateway 域名>/api/v1/auth/me
curl -i https://<Gateway 域名>/api/v1/admin/accounts
curl -i https://<Gateway 域名>/.well-known/oauth-protected-resource/mcp
curl -i https://<Gateway 域名>/mcp
```

未携带认证信息的 `/api/v1/auth/me`、`/api/v1/admin/accounts` 和 `/mcp` 应返回未认证错误，不能返回其他账户或权限数据。动态接口响应不应出现 `X-Cache: HIT`、较大的 `Age` 或长期 `max-age`。

## 8. 部署验证

### 8.1 服务接口验证

```bash
curl --fail http://<Gateway 域名>:1904/healthz
curl --fail http://<Gateway 域名>:1904/readyz
curl --fail http://<Gateway 域名>:1904/version
```

三个接口均应返回成功响应，其中 `/version` 应显示本次部署的版本信息。

如果域名经过 CDN 或反向代理，还应检查响应头：

```bash
curl -sS -D - -o /dev/null https://<Gateway 域名>/healthz
curl -sS -D - -o /dev/null https://<Gateway 域名>/version
```

健康检查和版本接口不得命中长期缓存；认证、管理、应用和 MCP 接口必须返回 `Cache-Control: no-store` 或由代理直接绕过缓存。

### 8.2 管理员账户验证

1. 打开 `http://<Gateway 域名>:1904`。
2. 进入注册页面，注册第一个管理员账户。
3. 使用该账户退出并重新登录。
4. 确认登录后可以正常打开管理台页面。
5. 确认浏览器刷新后登录状态仍然有效。

首次注册的账户会获得管理员权限。注册完成后，应立即按照企业账号管理规范设置后续账户和权限。

### 8.3 部署完成标准

满足以下条件后，基础部署视为完成：

- Gateway 进程或容器持续运行。
- `/healthz`、`/readyz` 和 `/version` 均验证通过。
- 域名可以访问 Gateway。
- 首个管理员注册、退出和重新登录成功。
- 日志中没有持续出现数据库连接或配置解析错误。
- 已记录部署版本、配置目录、数据库地址、域名和负责人。

## 9. 常规服务操作

### 9.1 二进制部署

在 Gateway 程序目录执行：

```bash
export CLAWEE_OPS_DIR=/etc/clawee/ops

# 查看健康状态
./deploy/healthcheck.sh

# 启动
./deploy/start.sh

# 重启
./deploy/restart.sh

# 停止
./deploy/stop.sh
```

`start.sh`、`stop.sh` 和 `restart.sh` 使用当前目录下的运行状态和日志目录。执行重启后应再次运行 `healthcheck.sh`。

### 9.2 容器部署

使用企业实际的 Gateway 容器名称执行：

```bash
docker ps --filter name=clawee-gateway
docker restart clawee-gateway
docker logs --tail 200 -f clawee-gateway
```

重启后执行：

```bash
curl --fail http://<Gateway 域名>:1904/readyz
```

### 9.3 数据库容器操作

仅当使用项目附带 PostgreSQL 容器时执行以下命令：

```bash
docker compose -f server/deploy/docker-compose.yaml ps
docker compose -f server/deploy/docker-compose.yaml restart postgres
docker compose -f server/deploy/docker-compose.yaml logs --tail 200 postgres
```

企业专用数据库的启动、重启、备份和故障处理由数据库运维规范负责，Clawee 运维人员只需确认 Gateway 到数据库的连接状态。

### 9.4 配置变更后的操作

修改 `config.yaml` 或替换密钥后：

1. 检查 YAML 格式和文件权限。
2. 重启 Gateway。
3. 查看启动日志。
4. 重新执行 `/healthz` 和 `/readyz`。
5. 登录管理台确认访问正常。

不要在 Gateway 运行期间直接删除或覆盖正在使用的数据库、配置和持久化数据目录。
