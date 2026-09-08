# 文档

本目录包含 MCP Gateway 后端的公开文档。项目位于 Agent Runtime 与企业系统之间，负责统一的身份认证、权限控制、MCP 能力治理、调用门禁和审计。Agent Runtime 以及 OA、ERP、CRM、知识库等业务系统不由本项目实现。

## 阅读顺序

1. [架构总览](architecture/overview.md)：了解系统边界、组件和主要调用链路。
2. [安全与权限](architecture/security-and-permissions.md)：了解身份、RBAC、Agent 授权、门禁与审计。
3. [本地开发](getting-started/development.md)：启动数据库、后端和管理控制台。
4. [配置参考](getting-started/configuration.md)：配置来源、覆盖规则和 Secret 管理要求。
5. [生产部署](deployment/production.md)：迁移、启动、反向代理、健康检查和持久化要求。

公开仓库只保留 `configs/config.example.yaml`。真实配置必须复制到独立的 `CLAWEE_OPS_DIR` 中，不能写回源码仓库、发布包或容器镜像。

## 接入文档

- [Clawee Agent 接入](integration/clawee-agent.md)
- [上游 MCP Server 接入](integration/upstream-mcp.md)
- [Collector 接入](integration/collector.md)
- [HTTP API 概览](reference/http-api.md)

## 文档约定

- 文档只描述当前代码已经提供的能力。
- `example.com`、`127.0.0.1` 和示例标识均为占位内容。
- Secret 不应写入仓库、命令行历史、日志、诊断包或前端存储。
- 具体请求字段和响应结构以当前版本代码和测试为准。
