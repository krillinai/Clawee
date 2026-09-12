# 生产部署

## 部署边界

生产部署由一个 Gateway 后端、PostgreSQL、管理控制台静态文件和可选外部服务组成。Agent Runtime 与企业业务系统独立部署，通过 MCP 或 HTTP 与 Gateway 连接。

本文不提供特定公司的服务器、账号和网络拓扑。部署者需要根据自己的基础设施实现 Secret 注入、TLS、备份和发布审批。

## 构建

```bash
# 在整合仓库根目录执行：
docker build -f server/Dockerfile -t clawee-server:local .
```

镜像不包含配置文件。运行时将私有运维目录只读挂载到固定位置：

镜像默认使用 UID/GID `65532` 的 nonroot 用户。Linux 宿主机需允许该用户读取并遍历配置目录，同时继续禁止其他用户访问：

```bash
sudo chown -R 65532:65532 /etc/clawee/ops
sudo find /etc/clawee/ops -type d -exec chmod 750 {} +
sudo find /etc/clawee/ops -type f -exec chmod 600 {} +
```

```bash
docker run --rm --name mcp-gateway \
  -p 0.0.0.0:1904:1904 \
  -e CLAWEE_OPS_DIR=/run/clawee-ops \
  -v /etc/clawee/ops:/run/clawee-ops:ro \
  -v claw-mcp-data:/app/data \
  clawee-server:local
```

挂载目录必须包含 `configs/config.yaml`。数据库地址必须能从容器网络访问，不能使用只指向容器自身的 `localhost`。

## 使用整合 Compose

在根目录完成依赖安装，使用新的仓库外运维目录。以下流程用于全新部署，不会转换已有开发配置：

```bash
export CLAWEE_OPS_DIR="$HOME/clawee-container-ops"
pnpm run init --ops-dir "$CLAWEE_OPS_DIR" --container --gateway https://agent.example.com
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml build
```

将 `agent.example.com` 替换为实际 HTTPS 域名。Linux 宿主机需让容器 UID 65532 能读取配置文件；只调整该配置文件，不把 `.env` 的数据库密码改为公开可读：

```bash
sudo chown 65532:65532 "$CLAWEE_OPS_DIR/configs/config.yaml"
sudo chmod 600 "$CLAWEE_OPS_DIR/configs/config.yaml"
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml up -d --wait postgres
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml run --rm gateway migrate up
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml up -d gateway
```

Gateway 映射宿主机 `0.0.0.0:1904`，数据库不映射宿主机端口。镜像内服务也监听 `0.0.0.0:1904`。使用 HTTPS Origin 初始化时会开启 Secure Cookie；通过防火墙限制 Gateway 端口，并将 HTTPS 代理限制到部署者可访问的网络，完成首个管理员注册后再扩大访问范围。客户端填写实际域名，不填写 `0.0.0.0`。

发行后可使用 `ghcr.io/krillinai/clawee-server:0.1.0`，并根据实际发行摘要锁定镜像。尚未发布的版本应先本地构建，不能假定镜像已存在。

数据库与文件分别位于 Compose 命名卷，`docker compose down` 不会删除它们；不要在备份前执行 `down -v`。数据备份可使用 `pg_dump`；文件卷在暂停写入后归档，连同对应配置密钥一起加密保管。恢复时先停止 Gateway，将数据库与文件恢复到同一备份点，再验证就绪、登录和文件下载。

也可以构建本地二进制：

```bash
./scripts/build-all.sh
```

发布镜像和压缩包不得包含生产配置、`.env`、数据库数据、私有 Git 凭据或 Collector 注册码。

## 数据库迁移

每次部署新版本前，使用与服务相同的配置执行：

```bash
CLAWEE_OPS_DIR=/etc/clawee/ops ./claw-mcp migrate up
```

迁移应由单独的受控任务运行。备份数据库后再执行，不要让多个副本并发执行迁移。

## 启动服务

```bash
CLAWEE_OPS_DIR=/etc/clawee/ops ./claw-mcp serve
```

容器部署时，将配置以只读文件或 Secret 挂载到容器，并为 Skill 包、共享文件等本地数据目录挂载持久卷。不要把宿主机 Secret 烘焙进镜像。

## 网络与 TLS

- 对外流量通过反向代理或负载均衡器终止 TLS。
- 只公开业务需要的 HTTP、MCP 和 OAuth 回调路径。
- 数据库、管理接口、指标和性能分析端点应限制到受信网络。
- 转发时保留请求 ID，并正确设置 Host 与协议相关 Header。

## 健康检查

| 路径 | 说明 |
| --- | --- |
| `/healthz` | 进程存活检查 |
| `/readyz` | 服务就绪检查 |
| `/version` | 构建版本信息 |
| `/metrics` | Prometheus 指标，建议限制访问 |

部署完成后至少验证登录、MCP 能力发现、一次授权调用和审计记录。

## 持久化与备份

至少备份：

- PostgreSQL 数据；
- Skill 包目录；
- Skill Git 工作目录（也可以从来源重新同步）；
- 共享文件目录；
- 部署配置和 Secret 的版本记录。

共享网盘切换到阿里云 OSS 后，还必须备份对应 Bucket 数据和 `security.agent_token_encryption_key`。PostgreSQL、对象数据和加密密钥必须来自一致的备份点；不能只恢复其中一项。建议在 Bucket 侧开启版本控制或跨区域复制，并保持 Bucket 为私有读写。

使用 ECS RAM Role 时，将权限限制到实际 Bucket 和 Profile Prefix，至少包含对象上传、读取、删除，以及 Multipart Upload 的创建、上传分片、列出分片、完成和终止权限；不要授予 Bucket 创建、删除或 ACL 管理权限。非 ECS 环境可在管理台使用 AccessKey，凭据只会以 AES-GCM 密文保存。

备份中的 Secret 与业务数据应加密，并使用与生产服务不同的访问权限。

## 升级与回滚

1. 记录当前应用版本和数据库备份点。
2. 在预发布环境运行迁移和核心链路验证。
3. 部署新二进制或镜像并检查就绪状态。
4. 发现问题时回退应用版本；数据库回退需根据对应迁移单独评估。

不要假设应用二进制回滚能够自动撤销数据库结构变化。

共享网盘一旦已有文件写入 OSS，不得直接回退到不识别 `storage_profile_id` 的版本。应先在当前版本中执行反向迁移，确认本地 Profile 包含全部文件且迁移失败数、待清理数均为零，再评估版本回退和本地持久卷变更。切换激活 Profile 只影响后续写入，不会自动搬迁存量文件。

非迁移上传或替换产生的清理任务达到 10 次自动重试上限后，运维人员应先恢复对应存储，再在备份完成且限定具体 `cleanup_id` 的维护事务中，将该任务改回 `pending`、清零 `attempt_count` 并更新 `next_attempt_at`。禁止按 Profile 或全表批量重置，也不得手工删除仍被 `shared_files` 引用的对象。
