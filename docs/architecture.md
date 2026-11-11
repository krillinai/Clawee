# aigateway 架构

[English](./en/architecture.md) · **简体中文**

Go Gateway 和 server/web 管理台维护账号、Agent 身份、HTTP/MCP 接口、授权门禁、审计、Skill Hub、知识库与共享文件。数据存储使用 PostgreSQL，结构由 server/db/migrations 管理。可选企业集成按部署配置启用。

管理台构建到 server/internal/server/webdist/dist，随 Go 二进制或容器分发。管理台与服务端保留同一仓库和发布版本。

ClaweeAgent 在独立仓库维护本地执行能力，通过 Gateway Origin 调用 HTTP/MCP 接口；本地任务、Runtime 会话与模型凭据在用户设备。Gateway 保存账号、授权、审计和共享资源，不直接读取客户端 SQLite。

server/cmd/clawee-collector* 与企业治理 API 有现有 Go 依赖，首轮保持在本仓库。详见 server/docs/architecture/overview.md 和 server/docs/integration/clawee-agent.md。
