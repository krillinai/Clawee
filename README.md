# Clawee

Clawee 是可自托管的 Agent 工作台，包含桌面客户端、本地执行服务和用于账号、MCP 授权与审计的 Gateway。桌面与 Web 使用同一套任务界面，桌面额外提供系统原生能力和内嵌 Codex Runtime。

项目采用 Apache-2.0。通用能力全部开放；模型托管、计费、钉钉、百炼等外部服务按需配置。默认使用自带模型服务，不依赖维护者运营的网关。

当前优先开放客户端与服务端源码，整合版本目标为 **1.1.0**。保留现有依赖，第三方再分发许可补齐或替换另作专项处理，进度见 [第三方组件说明](third_party/README.md)。正式安装包与镜像尚在准备中，以 [GitHub Releases](https://github.com/krillinai/Clawee/releases) 实际发布内容为准。

## 本地启动

需要 Node.js 24、Corepack、Go 1.25 或更新兼容版本，以及 Docker Compose。客户端与管理台分别使用锁定的 pnpm 版本，由 Corepack 选择。Windows 服务端源码脚本请在 WSL2 中执行。

统一使用 `pnpm run <脚本名>`；其中 `setup`、`init` 必须保留 `run`，避免执行 pnpm 自带的同名命令。根目录和客户端使用 pnpm 9.15.0，管理台使用 10.33.3，首次使用先执行 `corepack enable pnpm`。

在仓库根目录运行：

```bash
pnpm run setup
export CLAWEE_OPS_DIR="$HOME/clawee-ops"
pnpm run init --ops-dir "$CLAWEE_OPS_DIR"
docker compose -f server/deploy/docker-compose.yaml up -d --wait
pnpm run db:migrate
pnpm run server:dev
```

初始化命令在仓库外生成随机密钥和权限为 `0600` 的配置，重复运行不会覆盖已有配置。开发数据库仅监听 `127.0.0.1:15932`，使用本机 trust 认证，仅用于开发。Gateway 与内嵌管理台监听 `0.0.0.0:1904`，管理台开发页面监听 `0.0.0.0:5904`，客户端 Web 开发页面监听 `0.0.0.0:19860`。本机访问 `http://127.0.0.1:<端口>`，其他设备使用本机实际 IP 或域名；`0.0.0.0` 是监听地址，不是客户端连接地址。

已有运维配置保持不变。如需明确覆盖 Gateway 监听地址，启动前设置 `CLAW_MCP_SERVER_ADDR=0.0.0.0:1904`，或在外部配置中将 `server.addr` 设为相同值。本地 daemon 继续只监听回环地址；客户端 Web 开发页面会代理访问该 daemon，仅用于受信开发网络。

首次部署应通过防火墙或访问控制限制到部署者，由部署者完成首个账号注册；该账号会获得管理员权限。完成初始化后再通过 HTTPS 反向代理开放服务。普通用户的注册、权限和 MCP 上游由部署者管理。

另开终端，在根目录启动桌面：

```bash
pnpm run client:dev
```

在登录页面设置自己的 Gateway 地址，登录后填写模型服务地址、模型名和 API Key，再创建任务。远程 Gateway 必须使用 HTTPS；本机 HTTP 可用于开发。切换 Gateway 前需退出登录并结束任务，登录凭据按地址隔离。

真实模型任务需要自行提供有效模型服务。单元测试和受控 Runtime 测试使用模拟服务，无需维护者账号。MCP 调用还需在管理台配置上游服务并给账号授权。

## 目录与命令

| 目录 | 职责 |
| --- | --- |
| `client/apps/web` | 桌面与浏览器共用任务界面 |
| `client/apps/daemon` | 本地任务、模型、文件、Skill 与会话执行 |
| `client/apps/desktop` | Electron 外壳、内嵌 Runtime、原生能力与更新 |
| `server` | Go Gateway、MCP 权限审计、Collector 和 Skill Hub |
| `server/web` | 管理台 |
| `scripts` | 整合项目的安装、初始化与命令入口 |

```bash
pnpm run test                         # 初始化与根脚本测试
pnpm run client:test              # 客户端测试
pnpm run server:test              # 服务端测试
pnpm run web:dev                  # 客户端 Web 开发模式
pnpm run admin:dev                # 管理台开发服务器
pnpm run desktop:preflight:local  # 提交前完整桌面预检
```

服务端 PostgreSQL 集成测试必须使用独立、名称以 `_test` 结尾的数据库，并设置 `CLAW_MCP_TEST_DATABASE_URL`。它们会修改测试数据，不能指向日常开发或生产数据库。

端到端验收使用全新的容器、数据库卷和随机端口，结束后自动清理：

```bash
docker build -f server/Dockerfile -t clawee-server:oss-local .
node scripts/container-smoke.mjs
```

该验收覆盖数据库初始化、登录、MCP 未授权拒绝、授权调用、撤销和重启持久化。真实模型验收还需要先通过桌面本地预检，再将包含 `base_url`、`model`、`api_key` 的 JSON 配置放在仓库外，以权限 `0600` 保存，并运行：

```bash
CLAWEE_EXTERNAL_MODEL_CONFIG="$HOME/clawee-test-model.json" node scripts/container-smoke.mjs
```

真实模型验收使用隔离的打包 App，关闭截图、视频与 trace，执行任务并检查页面回复；会向所配置模型发出请求。配置文件及测试报告不得提交。

## 部署与开发资料

- [功能验证与操作指南](docs/validation-and-operations.md)：原仓库命令对应、启动、功能验收与部署步骤
- [正式发布前待处理事项](docs/pre-release-checklist.md)：功能验证后再处理 CI、仓库设置、签名及正式发行
- [服务端开发](server/docs/getting-started/development.md)
- [配置参考](server/docs/getting-started/configuration.md)
- [生产部署与备份](server/docs/deployment/production.md)
- [MCP 上游集成](server/docs/integration/upstream-mcp.md)
- [架构与数据边界](docs/architecture.md)
- [贡献约定](CONTRIBUTING.md)及[安全报告](SECURITY.md)

桌面正式更新来自本仓库 GitHub Releases 的 stable 渠道。社区开发构建默认不启用上游自动更新。服务端与桌面按同一版本组合交付，旧私有仓库的历史不会导入这里。

项目许可证见 [LICENSE](LICENSE)，归属说明见 [NOTICE](NOTICE)。第三方依赖与内嵌工具保留各自许可。
