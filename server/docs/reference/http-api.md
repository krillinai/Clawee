# HTTP API 概览

## 基础约定

- API 前缀为 `/api/v1`。
- 请求和响应使用 UTF-8 JSON；文件上传下载接口除外。
- 时间字段使用 RFC 3339。
- 应用 API 使用当前用户身份，管理 API 额外执行 RBAC 校验。
- 列表接口返回数组时保证空结果为 `[]`，不返回 `null`。

错误响应使用稳定的机器可读错误码。客户端应按 HTTP 状态和错误码处理，不依赖错误文案。

## 公共与认证接口

| 路径组 | 说明 |
| --- | --- |
| `/healthz`、`/readyz`、`/version` | 健康与版本信息 |
| `/api/v1/auth/*` | 注册、登录、注销、当前账户和外部身份认证 |
| `/api/v1/integrations/*` | 受控 OAuth 回调和 Webhook |
| `/api/v1/collector/*` | Collector 专用认证接口 |

## 应用 API

`/api/v1/app/*` 面向当前账户及其绑定 Agent，主要资源包括：

- `agents`、`mcp/catalog`、`mcp/token`；
- `skills`、`skill-spaces`；
- `knowledge-bases` 及其文档；
- `shared-spaces`、`shared-files`；
- `activity`、`collectors`；
- `business-data-sources`、`business-dashboards`；
- `billing`、`model-configuration`。

某项可选服务未启用时，相关接口可能返回 `503 Service Unavailable`。

## 管理 API

`/api/v1/admin/*` 面向具有相应权限的管理员：

| 路径组 | 权限范围 |
| --- | --- |
| `accounts` | 账号查看、创建、停用和密码重置 |
| `rbac` | 权限目录、角色和账号角色 |
| `mcp/upstream-servers` | 上游 MCP Server 管理与能力同步 |
| `mcp/capabilities` | 能力目录和门禁策略 |
| `mcp/agents` | Agent 管理与归属 |
| `mcp/grants` | Agent 能力授权 |
| `mcp/gates` | 用户确认和管理员审批 |
| `mcp/audits` | MCP 调用审计 |
| `knowledge-bases` | 知识库和文档管理 |
| `skills`、`skill-sources`、`skill-spaces` | Skill 及来源管理 |
| `shared-spaces`、`shared-files` | 共享文件管理 |
| `data-resource-grants` | 账户数据资源权限 |
| `activity`、`collectors` | Agent 活动和 Collector 管理 |

具体权限代码定义在 `internal/rbac/catalog.go`。

## MCP 与 OAuth 元数据

MCP 请求不使用 `/api/v1` 前缀：

- `/mcp`
- `/mcp/servers/:server_id`
- `/mcp/knowledge`

客户端通过相应的 `/.well-known/oauth-protected-resource/...` 端点发现资源和授权服务器信息。MCP Token 必须具有服务端要求的 scope，并绑定有效账户和 Agent。

## 客户端处理要求

- `400`：修正请求参数后再提交。
- `401`：清除失效认证状态并重新登录或重新获取凭据。
- `403`：当前主体无权执行，不应自动重试。
- `404`：资源不存在或当前主体不可见。
- `409`：资源状态或版本冲突，重新读取后由用户决定。
- `429`：遵守响应中的限流提示并退避。
- `500`：记录请求 ID，避免自动重试非幂等操作。
- `503`：依赖服务未启用或暂时不可用。

所有会创建、修改、删除、上传、同步、轮换或充值的请求都应视为非幂等操作，除非具体接口明确提供幂等键或幂等语义。
