# Clawee 运维部署指南

本文面向负责企业私有化部署的运维人员，目标是在具备主机、数据库和网络访问条件后，完成 Gateway 的首次部署、管理员注册和基本可用性验证。

本文只覆盖基础部署和服务操作，不介绍业务能力的配置和运营。

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
  pg_isready -U claw_mcp -d claw_mcp
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

- `claw-mcp` 可执行文件；
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

## 7. 配置域名访问

将企业域名解析到 Gateway 服务器 IP，并让访问请求指向 Gateway 的 `1904` 端口。

完成解析后，在客户端或浏览器中使用该域名访问 Gateway，不使用 `127.0.0.1`、`localhost` 或 `0.0.0.0`。

## 8. 部署验证

### 8.1 服务接口验证

```bash
curl --fail http://<Gateway 域名>:1904/healthz
curl --fail http://<Gateway 域名>:1904/readyz
curl --fail http://<Gateway 域名>:1904/version
```

三个接口均应返回成功响应，其中 `/version` 应显示本次部署的版本信息。

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
