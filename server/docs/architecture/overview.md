# 架构总览

## 项目定位

本项目是企业 Agent 与企业系统之间的 MCP 安全治理中间层。它让不同 Agent Runtime 通过统一入口访问已经存在的 MCP Server、知识库和企业能力，并集中执行认证、授权、门禁和审计。

本项目不提供 Agent Runtime，也不替代企业已有业务系统。

```text
Agent 层
Clawee / Codex / Hermes / 其他 MCP Client
                    |
                    v
治理中间层（本项目）
身份认证 -> Agent 绑定 -> 能力目录 -> 授权 -> 门禁 -> 审计
                    |
                    v
企业系统层
MCP Server / 知识库 / 协作系统 / 业务系统
```

## 当前组件

| 组件 | 职责 |
| --- | --- |
| HTTP Server | 提供用户、管理员、Collector 和集成 API |
| MCP Endpoint | 对 Agent 暴露统一或按上游隔离的 MCP 入口 |
| Account Service | 管理账号、登录 Session 和 Agent 归属 |
| RBAC Service | 管理控制台角色和权限 |
| MCP Gateway | 管理上游服务、能力目录、Agent Grant、门禁和审计 |
| Skill Hub | 管理 Skill、版本、空间和 Git 来源 |
| Knowledge | 管理知识库元数据、文档与 MCP 知识能力 |
| Collector | 采集 Agent 活动并上报心跳、事件和任务结果 |
| Shared Files | 管理账户授权的共享空间和文件 |
| Management Console | 提供用户端与管理员端操作界面 |

钉钉登录、百炼知识库、Bilibili 数据、模型配置和计费接口属于可选集成。未配置相应外部服务时，不应影响核心 Gateway、账号、RBAC、MCP 纳管和审计能力。

## 核心对象

- **Account**：登录主体，拥有 Session、角色和数据资源权限。
- **Agent**：受治理的 Agent 身份，归属于账户并使用独立 MCP 访问凭据。
- **Upstream Server**：被 Gateway 纳管的 MCP Server。
- **Capability**：从上游同步并进入能力目录的 tool、resource 或 prompt。
- **Grant**：Agent 对某项能力的显式授权。
- **Gate**：用户确认或管理员审批记录。
- **Audit**：能力发现、授权判断和工具调用形成的审计记录。
- **Collector**：与 Agent 绑定的活动采集进程。

## MCP 调用链路

1. MCP Client 携带凭据连接 Gateway。
2. Gateway 校验凭据、作用域、Agent 状态和目标 endpoint。
3. Gateway 按当前 Agent Grant 裁剪可见能力。
4. 工具调用再次校验能力状态和授权，不信任客户端缓存。
5. 命中确认或审批策略时创建 Gate；通过后只执行已确认的参数快照。
6. Gateway 调用上游 MCP Server，并记录结果、耗时和决策信息。

## HTTP 边界

| 路径 | 用途 |
| --- | --- |
| `/mcp` | 聚合 MCP 入口 |
| `/mcp/servers/:server_id` | 指定上游服务的 MCP 入口 |
| `/mcp/knowledge` | 知识库 MCP 入口 |
| `/api/v1/auth/*` | 注册、登录、注销和外部身份登录 |
| `/api/v1/app/*` | 当前账户和 Agent 使用的应用 API |
| `/api/v1/admin/*` | 受 RBAC 保护的管理 API |
| `/api/v1/collector/*` | Collector 注册、心跳、事件和任务 API |
| `/healthz`、`/readyz` | 存活与就绪检查 |
| `/metrics` | Prometheus 指标 |

## 数据与运行边界

- PostgreSQL 保存账号、Agent、RBAC、能力目录、授权、门禁、审计和业务元数据。
- Skill 包、共享文件及上游 Git 工作区使用配置指定的本地目录。
- 管理控制台静态文件可以嵌入后端二进制，也可以由开发服务器单独提供。
- Secret 通过部署环境提供，不应进入镜像层、发布包或版本控制。
