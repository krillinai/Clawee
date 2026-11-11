# 配置参考

[English](../en/getting-started/configuration.md) · **简体中文**

## 配置来源

服务读取 YAML，并允许已绑定的 `CLAW_GATEWAY_*` 环境变量覆盖对应字段。配置路径规则如下：

1. `--config` 为绝对路径时直接读取该文件。
2. 设置 `CLAWEE_OPS_DIR` 且传入相对路径时，从该目录下解析相对路径。
3. 设置 `CLAWEE_OPS_DIR` 且未传 `--config` 时，读取其 `configs/config.yaml`。
4. 未设置 `CLAWEE_OPS_DIR` 时不读取任何配置文件；显式相对路径会被拒绝，仅允许完全通过环境变量启动。
5. `CLAWEE_OPS_DIR/.env` 存在时会先加载，再应用进程环境变量覆盖。

显式配置了外部配置根目录但文件不可用时，程序直接失败，不回退到仓库内配置。

公开仓库只提供 `configs/config.example.yaml`。首次使用时复制到独立的私有运维目录：

```bash
# 从整合仓库根目录执行；已完成 pnpm run setup。
export CLAWEE_OPS_DIR="$HOME/clawee-ops"
pnpm run init --ops-dir "$CLAWEE_OPS_DIR"
```

初始化会生成两个独立随机密钥，并拒绝向源码目录写入配置。JWT 签名密钥至少为 32 个 ASCII 字符，Agent Token 加密密钥必须恰好为 32 个 ASCII 字符。`--container` 生成容器网络数据库地址及仓库外 `.env` 中的随机数据库密码；重复执行不会转换或覆盖已有配置。

## 环境变量命名

已绑定字段使用 `CLAW_GATEWAY_` 前缀，并将 YAML 层级中的点替换为下划线。例如：

```text
database.url                    -> CLAW_GATEWAY_DATABASE_URL
server.addr                     -> CLAW_GATEWAY_SERVER_ADDR
security.user_jwt_signing_key   -> CLAW_GATEWAY_SECURITY_USER_JWT_SIGNING_KEY
mcp.public_base_url             -> CLAW_GATEWAY_MCP_PUBLIC_BASE_URL
```

并非所有可选集成字段都支持环境变量覆盖。部署前应以 `internal/config/config.go` 中的 `bindEnv` 列表为准。

## 配置分组

| 分组 | 用途 |
| --- | --- |
| `server` | 监听地址和性能分析开关 |
| `database` | PostgreSQL 连接地址 |
| `admin` | 管理引导令牌 |
| `security` | Cookie、Session、JWT 和 Token 加密配置 |
| `logging` | 日志级别、格式、输出和访问日志 |
| `static` | 管理控制台静态文件 |
| `mcp` | 公共 MCP 地址、OAuth 元数据和作用域 |
| `knowledge` | 知识库开关及 Provider 配置 |
| `skillhub` | Skill 包、Git 来源和工作目录 |
| `shared_files` | 共享文件本地目录与 OSS CNAME 允许列表 |
| `dingtalk`、`bilibili` | 可选外部身份和数据集成 |
| `claw_admin`、`sub2api`、`model_access` | 可选模型配置和计费集成 |
| `agent_activity` | Agent 活动直报开关 |
| `feedback` | 反馈收集服务及管理台页面展示开关 |

## Secret 管理

以下值必须由部署环境提供，不得提交到 Git：

- 数据库密码和完整生产连接串；
- 管理令牌；
- JWT 签名密钥和 Agent Token 加密密钥；
- OAuth Client Secret；
- 云服务 AccessKey；
- 上游 MCP 凭据；
- 外部管理服务部署凭据和 API Key。

示例配置只包含空值、本地地址或不可用于生产的占位内容。日志中不得输出完整配置对象。

## 可选能力

知识库、Skill Git 同步、钉钉、Bilibili、外部模型配置和计费集成均应显式启用。启用前必须同时提供对应 Provider 的完整配置；不使用时保持关闭，核心 Gateway 不应依赖这些服务。

共享网盘默认使用 `shared_files.storage_root` 指向的本地目录。OSS Profile、加密凭据和当前激活存储在管理台维护；官方 `aliyuncs.com` OSS Endpoint 无需额外配置。仅当使用已审核的 OSS 自定义 CNAME 时，部署者才可在仓库外配置中加入：

```yaml
shared_files:
  storage_root: "data/shared-files"
  oss:
    allowed_endpoint_hosts:
      - "storage.example.com"
```

允许列表只接受主机名，不填写 Scheme、路径或端口。管理台不能放行任意 Endpoint。

## 问题反馈管理页面

问题反馈管理菜单和页面默认不展示。需要展示时，在仓库外配置中设置：

```yaml
feedback:
  enabled: true
  admin_ui_enabled: true
```

也可通过 `CLAW_GATEWAY_FEEDBACK_ADMIN_UI_ENABLED=true` 覆盖展示开关，修改后重启 Gateway。展示还要求反馈服务可用且账号具有 `console:feedback:read` 权限；读取反馈仍需「中心问题反馈 → 全部反馈」数据授权。`admin_ui_enabled` 仅控制管理台展示，不改变反馈提交、收集策略或接口权限。

## 生产校验


- 使用不同名称的用户 Session Cookie 和管理员 Session Cookie。
- JWT 签名密钥至少为 32 个 ASCII 字符。
- 开启钉钉或 Bilibili 时使用受控的回调 URL。
- MCP 公共地址、资源地址和 OAuth 元数据地址必须与外部 HTTPS 地址一致。
- 文件存储目录应位于持久卷并限制操作系统权限。

## RAGFlow 1.0 知识库

知识库默认关闭，Provider 默认保留 `bailian`。在仓库外 `$CLAWEE_OPS_DIR/configs/config.yaml` 启用 RAGFlow：

```yaml
knowledge:
  enabled: true
  provider_type: ragflow
  ragflow:
    base_url: http://127.0.0.1:18080
    api_key_ref: RAGFLOW_API_KEY
    embedding_model: ""
    rerank_id: ""
```

真实 Key 只放在外部 `.env` 的 `RAGFLOW_API_KEY` 中，或由运行环境注入。`api_key_ref` 保存变量名称；没有明文 `api_key` 配置。`embedding_model` 为空时继承 RAGFlow 服务账号的默认模型，非空时填写已注册的完整 `model_name@model_factory`；`rerank_id` 为可选字段。RAGFlow 独立部署，使用 v1.0.0 HTTP API，不在 Gateway 启动时探测网络。

| 配置覆盖变量 | 用途 |
| --- | --- |
| `CLAW_GATEWAY_KNOWLEDGE_PROVIDER_TYPE` | `bailian` 或 `ragflow` |
| `CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_BASE_URL` | HTTP(S) 根服务地址，不能包含用户信息、额外路径、查询串或 fragment |
| `CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_API_KEY_REF` | Key 环境变量名称，默认 `RAGFLOW_API_KEY` |
| `CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_EMBEDDING_MODEL` | 可选 Embedding 模型 |
| `CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_RERANK_ID` | 可选 Reranker |

宿主机原生 Gateway 使用 `http://127.0.0.1:18080`。Docker Desktop 容器访问宿主机使用 `http://host.docker.internal:18080`；Linux Docker 同时需要 `host-gateway`，并确保该网络可访问宿主机入口。同一 Docker 网络可以使用 RAGFlow 服务 DNS 与内部 Nginx 端口，例如 `http://ragflow-cpu:80`。容器中的 `127.0.0.1` 是容器自身。

容器部署显式合并可选覆盖文件；Compose `--env-file` 只用于插值，需要覆盖文件将 Key 传入 Gateway：

```bash
docker compose --env-file "$CLAWEE_OPS_DIR/.env" \
  -f deploy/docker-compose.yml -f deploy/docker-compose.ragflow.yml \
  up -d --build gateway
```

覆盖文件假设使用默认 `RAGFLOW_API_KEY` 引用；自定义引用时必须显式注入对应变量。共享网络部署请调整覆盖文件中的地址与网络配置。生产 Gateway 镜像为 distroless，通过宿主机 HTTP 请求、日志和管理台检查，不依赖容器内的 curl/sh。

每个 Gateway 部署只启用一个 Provider。存在未删除且具有外部 ID 的其他 Provider 绑定时，启动会报告冲突类型及数量；禁止修改旧记录类型来切换数据归属。隔离验收使用独立 Gateway 数据库和专用 RAGFlow 服务账号。本次接入无需迁移，不自动导入外部数据集或未登记文档。

上传完成先返回 `processing`。App 与管理台读取文档列表时，存在处理中记录会在 10 秒总预算内同步；失败返回既有上游服务错误并保留本地状态。没有处理中记录时只读本地状态，管理员仍可主动同步。检索继续通过 Gateway `knowledge.search`，范围为账号获得 `mcp` 授权的知识库集合。
