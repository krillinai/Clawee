# 上游 MCP Server 接入

## 接入模型

Gateway 纳管现有 MCP Server，不要求把上游实现复制进本项目。管理员注册上游、同步能力并向用户账号授权后，该账号的 Agent 通过 Gateway 的统一 MCP endpoint 调用能力。

```text
MCP Client -> Gateway endpoint -> 认证/授权/门禁/审计 -> 上游 MCP Server
```

## 支持的传输

- `streamable_http`：配置上游 HTTP endpoint 和所需认证信息。
- `stdio`：配置服务端可执行命令、参数和受控环境。

stdio 命令运行在 Gateway 所在主机，等同于服务端执行权限。只允许管理员配置经过审核的可执行文件，并使用独立低权限账户运行 Gateway。

## 管理流程

1. 通过管理控制台或 `/api/v1/admin/mcp/upstream-servers` 创建上游。
2. 调用同步接口读取上游 tools、resources 和 prompts。
3. 在能力目录中检查名称、Schema、风险级别和状态。
4. 设置用户确认或管理员审批策略。
5. 将所需能力显式授权给用户账号；授权 API 使用 `user_id`、`capability_id` 和 `grant_type`。
6. 使用对应 MCP endpoint 验证发现和调用，并检查审计记录。

上游配置变更后应重新同步。能力被上游删除或 Schema 发生变化时，调用端不得继续使用旧缓存执行写操作。

## Endpoint

| 路径 | 用途 |
| --- | --- |
| `/mcp` | 聚合当前账号已获授权的能力 |
| `/mcp/servers/:server_id` | 只暴露指定上游的已授权能力 |
| `/mcp/knowledge` | 内置知识库 MCP 能力 |

每个 MCP endpoint 都有对应的 OAuth Protected Resource Metadata 路径：

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-protected-resource/mcp/servers/:server_id
/.well-known/oauth-protected-resource/mcp/knowledge
```

## 能力命名与裁剪

使用账号 MCP Token 调用时，同时发送 `Authorization: Bearer <token>` 与 `X-Claw-Agent-ID: <agent_id>`。该 Agent 必须处于启用状态且属于 Token 对应的账号；仅携带 Token 不足以完成认证。

能力进入目录后使用稳定的暴露名称。Gateway 根据 endpoint、账号授权、能力状态和上游状态裁剪列表；客户端不应直接依赖上游原始名称跨环境保持不变。

## 门禁与重试

需要确认或审批的工具调用会返回门禁信息。客户端应展示服务端生成的摘要并等待决策，不能绕过 Gateway 直接调用上游。对于执行结果未知的非幂等调用，不得自动重试。

## 上游凭据

- 凭据只保存在受控配置或 Secret 管理系统中。
- 管理 API 和日志只返回脱敏元数据，不返回明文凭据。
- 不同上游使用独立凭据和最小权限账户。
- 停用或删除上游时同步撤销对应访问凭据。
