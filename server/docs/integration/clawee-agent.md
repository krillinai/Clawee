# Clawee Agent 接入

## 调用边界

Clawee Web 或 Desktop 负责用户交互，本地 Daemon 负责持有认证状态、调用 Gateway、下载 Skill 和执行安装。浏览器渲染进程不应保存 Bearer Token、模型密钥或 Collector 注册码。

所有示例路径均相对于 Gateway Origin，例如 `https://gateway.example.com`。

## 注册与登录

Clawee Agent 调用以下接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/v1/auth/register` | 注册账号并绑定 Agent |
| `POST` | `/api/v1/auth/login` | 登录并恢复 Agent 上下文 |
| `GET` | `/api/v1/auth/me` | 查询当前账号和 Agent |
| `POST` | `/api/v1/auth/logout` | 注销当前 Session |
| `GET` | `/api/v1/auth/methods` | 查询可用登录方式 |
| `POST` | `/api/v1/auth/dingtalk/clawee/token` | 交换钉钉登录结果 |

注册或登录时使用固定的 `client_id: "clawee-agent"`，并提交本机持久化的稳定 `agent_id`。`agent_id` 去除首尾空白后必须非空且不超过 64 个字符；同一 ID 不能被不同账号复用。

收到 `401 Unauthorized` 后，Daemon 应清除失效认证状态并要求重新登录，不得无限重试。

## Agent 与 MCP

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/app/agents` | 查询当前账户的 Agent |
| `GET` | `/api/v1/app/agents/tools` | 查询 Agent 可用工具 |
| `GET` | `/api/v1/app/mcp/catalog` | 查询 MCP 能力目录 |
| `GET` | `/api/v1/app/mcp/token` | 查询 MCP Token 元数据 |
| `POST` | `/api/v1/app/mcp/token/reveal` | 在受控操作中显示 Token |
| `POST` | `/api/v1/app/mcp/token/rotate` | 轮换 Token |
| `POST` | `/api/v1/app/mcp/token/revoke` | 吊销 Token |

Agent 的 MCP Grant 由服务端决定。客户端只能展示服务端返回的能力，不能自行扩大授权。

## Skill Hub

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/app/skill-spaces` | 查询有权限的 Skill 空间 |
| `GET` | `/api/v1/app/skills` | 查询已发布 Skill |
| `GET` | `/api/v1/app/skills/detail` | 查询 Skill 详情 |
| `GET` | `/api/v1/app/skills/version-files` | 查询版本文件 |
| `GET` | `/api/v1/app/skills/version-file` | 下载单个版本文件 |
| `GET` | `/api/v1/app/skills/package` | 下载发布包 |
| `POST` | `/api/v1/app/skills/versions` | 上传并发布新版本 |

安装前必须校验服务端提供的版本和摘要。版本发生变化时重新读取详情，由用户确认后重试；安装失败应使用客户端自己的事务和回滚机制。

## 知识库和共享文件

Clawee 只能访问当前账户获得授权的知识库、文档和共享空间。上传使用流式 multipart，不要把文档完整复制到浏览器进程、日志或诊断包。请求结果未知时不要自动重复上传，以免创建重复文档。

主要路径：

- `/api/v1/app/knowledge-bases*`
- `/api/v1/app/shared-spaces*`
- `/api/v1/app/shared-files*`

## 可选接口

后端还提供 Agent 活动上报、模型配置、余额和充值会话等接口。这些接口依赖部署时启用的相应服务；收到 `503` 时，客户端应显示能力不可用，而不是猜测或构造结果。

## 安全要求

- 生产环境只连接 HTTPS Origin。
- Token 只由本地 Daemon 持有，不进入 URL、页面状态和普通日志。
- 密码只在登录请求期间传递，不持久化。
- Skill 包和下载文件在使用前校验摘要、大小与目标路径。
- 注销时清除认证数据，但保留稳定 `agent_id`。
