# aigateway

可自托管的 Agent 企业治理 Gateway，包含 Go 服务端和 Web 管理台，提供账号与会话、Agent 身份、MCP 上游及能力目录、权限门禁、审计、Skill Hub、知识库、共享文件与可选企业集成。

[ClaweeAgent](https://github.com/krillinai/ClaweeAgent) 独立维护 Web 任务工作台、本地 daemon、Electron 与 Codex Runtime。Gateway 也可供其他 MCP Client 和 Agent Runtime 使用。

## 安装与开发

使用 Go 1.25、Node.js 24、Corepack 和 pnpm 10.33.3。

```sh
git clone git@github.com:krillinai/aigateway.git
cd aigateway
corepack pnpm run setup
corepack pnpm run init --ops-dir /path/outside-repository/aigateway-ops --gateway http://127.0.0.1:1904
export CLAWEE_OPS_DIR=/path/outside-repository/aigateway-ops
corepack pnpm db:migrate
corepack pnpm server:dev
```

数据库连接通过外部配置目录中的 configs/config.yaml 设置。另开终端运行 `corepack pnpm admin:dev` 启动管理台；本地 Gateway 默认端口为 1904，管理台开发端口为 5904。

Docker 部署使用 `deploy/docker-compose.yml`；先运行 `corepack pnpm run init --ops-dir /path/outside-repository/aigateway-ops --container`，再提供 CLAWEE_OPS_DIR 和该目录的 .env。镜像为 `ghcr.io/krillinai/aigateway-server`。

## 验证与发布

```sh
corepack pnpm test
corepack pnpm server:test
corepack pnpm server:build
```

测试使用隔离 PostgreSQL，可显式提供 CLAW_GATEWAY_TEST_DATABASE_URL。`corepack pnpm container:smoke` 使用独立 Compose 项目、临时数据库卷和外部配置，退出时清理。根目录工具依赖独立锁定，任何命令都不需要 client/ 或相邻客户端仓库。

VERSION 是 Gateway 发布版本来源。`vX.Y.Z` 标签触发 Gateway Release Preflight，验证 Go、管理台、服务端包与隔离容器，再发布 Linux amd64/arm64 压缩包和多架构镜像。release Environment 保护正式发布；本仓库不读取客户端签名或 COS 更新凭据。

## 文档

- [架构与职责](docs/architecture.md)
- [仓库边界和联调](docs/repository-maintenance.md)
- [Gateway 专项文档](server/docs/README.md)
- [客户端接入](server/docs/integration/clawee-agent.md)
- [管理台开发指南](docs/frontend/frontend-development-guidelines.md)
- [第三方声明](third_party/README.md)

客户端从公开提交 `3ddfa81a51584f3f6b8815686a2afd9569119e48` 拆至 ClaweeAgent，本仓库保留既有公开历史、Tag 和 Release。拆分保持现有 API、认证、数据库迁移和服务端业务逻辑。
