# 配置参考

## 配置来源

服务读取 YAML，并允许已绑定的 `CLAW_MCP_*` 环境变量覆盖对应字段。配置路径规则如下：

1. `--config` 为绝对路径时直接读取该文件。
2. 设置 `CLAWEE_OPS_DIR` 且传入相对路径时，从该目录下解析相对路径。
3. 设置 `CLAWEE_OPS_DIR` 且未传 `--config` 时，读取其 `configs/config.yaml`。
4. 未设置 `CLAWEE_OPS_DIR` 时不读取任何配置文件；显式相对路径会被拒绝，仅允许完全通过环境变量启动。
5. `CLAWEE_OPS_DIR/.env` 存在时会先加载，再应用进程环境变量覆盖。

显式配置了外部配置根目录但文件不可用时，程序直接失败，不回退到仓库内配置。

公开仓库只提供 `configs/config.example.yaml`。首次使用时复制到独立的私有运维目录：

```bash
# 从整合仓库根目录执行；已完成 npm run setup。
export CLAWEE_OPS_DIR="$HOME/clawee-ops"
npm run init -- --ops-dir "$CLAWEE_OPS_DIR"
```

初始化会生成两个独立随机密钥，并拒绝向源码目录写入配置。JWT 签名密钥至少为 32 个 ASCII 字符，Agent Token 加密密钥必须恰好为 32 个 ASCII 字符。`--container` 生成容器网络数据库地址及仓库外 `.env` 中的随机数据库密码；重复执行不会转换或覆盖已有配置。

## 环境变量命名

已绑定字段使用 `CLAW_MCP_` 前缀，并将 YAML 层级中的点替换为下划线。例如：

```text
database.url                    -> CLAW_MCP_DATABASE_URL
server.addr                     -> CLAW_MCP_SERVER_ADDR
security.user_jwt_signing_key   -> CLAW_MCP_SECURITY_USER_JWT_SIGNING_KEY
mcp.public_base_url             -> CLAW_MCP_MCP_PUBLIC_BASE_URL
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
| `office.install` | Collector 下载地址和二进制目录 |
| `knowledge` | 知识库开关及 Provider 配置 |
| `skillhub` | Skill 包、Git 来源和工作目录 |
| `shared_files` | 共享文件存储目录 |
| `dingtalk`、`bilibili` | 可选外部身份和数据集成 |
| `claw_admin`、`sub2api`、`model_access` | 可选模型配置和计费集成 |
| `agent_activity` | Agent 活动直报开关 |

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

## 生产校验

- 使用不同名称的用户 Session Cookie 和管理员 Session Cookie。
- JWT 签名密钥至少为 32 个 ASCII 字符。
- 开启钉钉或 Bilibili 时使用受控的回调 URL。
- MCP 公共地址、资源地址和 OAuth 元数据地址必须与外部 HTTPS 地址一致。
- 文件存储目录应位于持久卷并限制操作系统权限。
