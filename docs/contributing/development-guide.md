# 开发指南

本文面向希望参与 Clawee 开发、测试、文档维护或发布工作的贡献者。建议先按“快速启动”运行一套隔离的本地环境，再根据改动范围阅读客户端、Gateway、管理台或共享协议章节。

本文只描述当前仓库已经提供的开发能力。服务端配置字段、HTTP API、MCP 接入和生产部署细节见 [服务端文档](../../server/docs/README.md)。

## 目录

- [1. 项目定位与贡献边界](#1-项目定位与贡献边界)
- [2. 开发环境要求](#2-开发环境要求)
- [3. 快速启动](#3-快速启动)
- [4. 仓库结构与模块职责](#4-仓库结构与模块职责)
- [5. 架构与关键调用链](#5-架构与关键调用链)
- [6. 本地配置与开发数据](#6-本地配置与开发数据)
- [7. 客户端开发](#7-客户端开发)
- [8. Gateway 与管理台开发](#8-gateway-与管理台开发)
- [9. 跨组件接口与兼容性](#9-跨组件接口与兼容性)
- [10. 数据库与迁移开发](#10-数据库与迁移开发)
- [11. 测试、构建与验收](#11-测试构建与验收)
- [12. 调试与诊断](#12-调试与诊断)
- [13. 安全、依赖与许可证](#13-安全依赖与许可证)
- [14. 开源贡献流程](#14-开源贡献流程)
- [15. 构建与发布](#15-构建与发布)
- [16. 附录](#16-附录)

## 1. 项目定位与贡献边界

### 1.1 运行层

- **本地执行层**：共享 Web、本地 daemon、Electron 桌面端和内嵌 Codex Runtime，负责任务、会话、模型、工作区文件、Skill 和定时任务。
- **企业治理层**：Go Gateway 和管理台，负责账号、Agent 身份、RBAC、MCP 上游、能力授权、门禁、审计和共享资源。

### 1.2 组件职责

| 组件 | 主要职责 |
| --- | --- |
| `client/apps/web` | 桌面端与浏览器端共用的 React 任务界面 |
| `client/apps/daemon` | 本地任务、模型、会话、文件、Skill、定时任务和 Runtime 调用 |
| `client/apps/desktop` | Electron 外壳、窗口、文件选择、通知、更新和原生 Bridge |
| `client/apps/harness` | 受控的客户端开发和验证环境 |
| `client/packages` | 客户端共享协议和 Skill 市场能力 |
| `server` | Go Gateway、HTTP/MCP API、权限、审计、资源和可选集成 |
| `server/web` | Gateway 管理台和用户端界面 |
| `server/db` | PostgreSQL 迁移和测试 Seed |

### 1.3 贡献边界与数据边界

贡献应围绕清晰的问题或用户可见变化展开。通用界面只在共享 Web 中实现；企业治理逻辑留在 Gateway；本地执行和持久化逻辑留在 daemon。

本项目不实现模型服务和 OA/ERP/CRM 等企业业务系统。任务、Runtime 会话、工作区文件和模型凭据默认在用户设备；账号、授权、审计和共享资源由自托管 Gateway 管理。不要将真实配置、客户数据或生产凭据放入仓库。

更完整的边界说明见[架构与数据边界](../architecture.md)和[服务端架构总览](../../server/docs/architecture/overview.md)。

## 2. 开发环境要求

- Node.js 24；
- Corepack；
- pnpm 10.33.3（由各工作区 `packageManager` 锁定）；
- Go 1.25 或与 `server/go.mod` 兼容的版本；
- Docker 与 Docker Compose；
- 当前平台构建原生 Node 模块所需的工具；
- macOS 桌面开发需要图形登录会话；Windows 上的服务端 Bash/Make 使用 WSL2。

检查工具链：

```bash
node --version
corepack --version
go version
docker compose version
```

客户端和 `server/web` 使用独立依赖工作区和锁文件。修改依赖时只更新所属工作区，不跨目录重建锁文件。

## 3. 快速启动

以下命令从仓库根目录执行，使用仓库外运维目录和独立开发数据库。

### 3.1 安装依赖和初始化配置

```bash
corepack enable pnpm
pnpm run setup

export CLAWEE_OPS_DIR="$HOME/clawee-development-ops"
pnpm run init --ops-dir "$CLAWEE_OPS_DIR"
```

`init` 会生成仓库外的 `configs/config.yaml` 和随机密钥；重复执行不会覆盖已有配置。运行 Gateway 的每个终端都要设置同一个 `CLAWEE_OPS_DIR`。

### 3.2 启动数据库和迁移

```bash
docker compose -f server/deploy/docker-compose.yaml up -d --wait postgres
pnpm run db:migrate
```

开发数据库默认使用 `127.0.0.1:15932`，名称为 `claw_gateway`。不要将测试库或生产库作为开发库。

### 3.3 启动 Gateway、管理台和客户端

在第一个终端运行 Gateway 与管理台联合开发：

```bash
export CLAWEE_OPS_DIR="$HOME/clawee-development-ops"
node scripts/clawee.mjs server dev
```

默认地址为 Gateway `http://127.0.0.1:1904`、管理台 `http://127.0.0.1:5904`。也可以分别运行 `pnpm run server:dev` 和 `pnpm run admin:dev`。

另开终端启动 Electron：

```bash
pnpm run client:dev
```

只开发共享 Web 时，先停止桌面端，再运行：

```bash
pnpm run web:dev
```

客户端 Web 默认地址为 `http://127.0.0.1:19860`。桌面端和浏览器端会按需启动各自的本地 daemon，不需要额外运行 `pnpm daemon:dev`。

### 3.4 验证和停止

```bash
curl --fail http://127.0.0.1:1904/healthz
curl --fail http://127.0.0.1:1904/readyz
curl --fail http://127.0.0.1:1904/version
```

首次访问管理台后注册专用开发账号。桌面端将 Gateway 设置为 `http://127.0.0.1:1904`，模型服务使用个人或测试凭据。

停止服务时在对应终端按 `Ctrl-C`，按需停止数据库：

```bash
docker compose -f server/deploy/docker-compose.yaml down
```

`down` 不会删除数据库卷。需要重建数据时先确认目标为本地开发项目，再清理对应 Compose 项目，不要对不明确的环境执行 `down -v`。

### 3.5 快速启动问题

- 端口占用：先确认占用进程和环境，不直接终止未知实例。
- 配置找不到：确认每个终端设置了同一个 `CLAWEE_OPS_DIR`。
- 迁移失败：确认 PostgreSQL 已就绪且连接地址指向开发库。
- 管理台未更新：使用 `5904` 开发页面，或重新执行服务端 Web 构建。
- 桌面端白屏或 Runtime 失败：使用专用系统测试用户，检查桌面开发日志和本地数据目录。

## 4. 仓库结构与模块职责

根目录脚本通过 `scripts/clawee.mjs` 选择工作目录和工具链。常用入口：

| 命令 | 用途 |
| --- | --- |
| `pnpm run setup` | 安装客户端和管理台依赖 |
| `pnpm run init --ops-dir <目录>` | 初始化仓库外配置 |
| `pnpm run client:dev` | Electron 桌面开发 |
| `pnpm run web:dev` | 共享 Web 开发 |
| `pnpm run server:dev` | Gateway 后端开发 |
| `pnpm run admin:dev` | 管理台开发 |
| `pnpm run db:migrate` | 执行数据库迁移 |
| `pnpm run client:test` | 客户端测试 |
| `pnpm run server:test` | 服务端和管理台测试 |

组件目录内仍保留原命令。进入子目录后，应使用该目录声明的 pnpm 版本和锁文件。

## 5. 架构与关键调用链

### 5.1 客户端

桌面端或浏览器端加载共享 Web，通过本地 API 与 daemon 通信。daemon 管理任务、会话、模型、文件和 Runtime；桌面端通过 preload/Bridge 提供文件选择、通知和更新等系统能力。

### 5.2 企业能力

管理台配置 MCP 上游并同步能力目录，管理员将能力授权给 Agent。Agent 通过 Gateway 调用能力；Gateway 在调用前重新校验身份、Agent 状态、Grant 和门禁策略，并写入审计。

### 5.3 边界规则

- Web 不直接访问数据库或承担本地持久化。
- daemon 不应作为公网多用户服务暴露。
- 客户端提交的账户、Agent 或角色标识不能作为服务端授权依据。
- 能力发现结果不能替代工具调用前的实时授权检查。

详见[安全与权限](../../server/docs/architecture/security-and-permissions.md)。

## 6. 本地配置与开发数据

Gateway 从 `CLAWEE_OPS_DIR/configs/config.yaml` 读取配置，已绑定的 `CLAW_GATEWAY_*` 环境变量可以覆盖字段。加载顺序和字段映射见[配置参考](../../server/docs/getting-started/configuration.md)。

开发、测试和生产必须使用不同的运维目录、数据库和文件目录。PostgreSQL 集成测试使用名称以 `_test` 结尾的独立数据库，并设置 `CLAW_GATEWAY_TEST_DATABASE_URL`。测试 Seed、模拟上游和夹具只能用于测试环境。

API Key、JWT 密钥、Agent Token 密钥、OAuth Secret、数据库密码和上游凭据必须保存在仓库外；命令历史、日志、截图、trace 和诊断包也不得包含明文 Secret。

## 7. 客户端开发

### 7.1 共享 Web

通用任务、会话、模型、文件、Skill、定时任务和企业能力界面位于 `client/apps/web`。桌面端与浏览器端的通用流程只实现一次，平台差异通过能力检测和 Bridge 处理。

### 7.2 daemon

本地执行、SQLite、工作区文件、模型配置、Runtime 会话和任务调度属于 `client/apps/daemon`。Web 通过现有 API 调用 daemon，不复制执行或持久化逻辑。

### 7.3 Electron

主进程、preload 和渲染进程保持权限隔离。新增原生能力时沿用现有 Bridge/IPC 边界，只暴露完成任务所需的最小接口。

修改客户端可执行代码、依赖、构建或发布配置后，提交前必须运行：

```bash
pnpm run desktop:preflight:local
```

## 8. Gateway 与管理台开发

### 8.1 Gateway

Go 服务位于 `server`。路由、中间件、Service、Store、MCP Gateway、RBAC、审计和可选集成按现有包边界维护。新增接口时同时考虑认证、授权、错误响应、审计和测试。

### 8.2 管理台

管理台位于 `server/web`，使用 React、Vite、Tailwind、Radix UI 和现有 `components/ui`。页面隐藏入口不能替代 Gateway 的服务端权限校验。

### 8.3 可选能力

知识库、Skill Hub、共享文件、钉钉、Bilibili、模型和计费属于可选能力。未配置外部服务时，核心 Gateway、账号、RBAC、MCP 纳管和审计仍应能够启动和测试。

## 9. 跨组件接口与兼容性

修改 HTTP API、MCP endpoint/Schema、daemon API、Electron Bridge、`client/packages/protocol` 或数据库结构时，应同步更新实现、调用方和测试。不要通过复制业务代码绕过 HTTP、MCP、IPC 或共享协议边界。

数据库结构变化必须通过迁移表达，并评估旧版本应用、新版本应用和回滚之间的兼容性。

## 10. 数据库与迁移开发

1. 在 `server/db/migrations` 新增向上迁移。
2. 为迁移、Store 和 Service 补充测试。
3. 在空数据库上验证完整迁移链路。
4. 使用 `_test` 数据库运行 PostgreSQL 集成测试。
5. 记录迁移对旧版本读取和回滚的影响。

迁移只支持向上执行。不要手工修改共享开发库、生产库或迁移历史，也不要把测试 Seed 导入生产环境。

## 11. 测试、构建与验收

### 11.1 常用测试

```bash
pnpm run test
pnpm run client:test
pnpm run server:test
```

服务端集成测试示例：

```bash
docker compose -f server/deploy/docker-compose.test.yaml up -d --wait
export CLAW_GATEWAY_TEST_DATABASE_URL='postgres://claw_gateway@127.0.0.1:5933/claw_gateway_test?sslmode=disable'
pnpm run server:test
docker compose -f server/deploy/docker-compose.test.yaml down
```

### 11.2 构建和容器验收

```bash
pnpm run client:build
pnpm run server:build
docker build -f server/Dockerfile -t clawee-server:oss-local .
node scripts/container-smoke.mjs
```

### 11.3 验收要求

测试结果应记录实际提交 SHA、平台、环境、命令和失败复现。跨组件改动应同时运行相关单元测试、集成测试、构建和手工链路验证。真实模型联调使用仓库外、权限为 `0600` 的配置文件，不提交测试报告和凭据。

## 12. 调试与诊断

优先使用结构化日志、请求 ID、内部资源 ID 和错误码定位问题。服务端先检查 `/healthz`、`/readyz`、`CLAWEE_OPS_DIR`、数据库和迁移状态；MCP 问题依次检查身份、Agent、能力、Grant、门禁和上游连接。

客户端问题确认 Gateway 地址、daemon 状态、本地数据目录和 Runtime 配置。桌面端使用专用系统测试用户复现，避免把旧用户目录状态误认为代码行为。

## 13. 安全、依赖与许可证

- 校验外部输入、文件路径、URL、上游响应和权限边界。
- 在服务层重新校验身份和资源权限，不信任客户端提交的主体信息。
- 不记录或返回明文凭据。
- 依赖升级时只更新正确工作区的锁文件，并运行相关测试。
- 保留 Apache-2.0、NOTICE 和第三方组件声明。
- 疑似漏洞使用[安全报告流程](../../SECURITY.md)，不要在公开 Issue 披露可利用细节。

第三方 Skill 和 MCP 工具可能执行代码或访问外部网络，新增来源时应说明来源、权限和风险。

## 14. 开源贡献流程

开始修改前阅读[参与贡献](../../CONTRIBUTING.md)、目标组件实现和专项文档，明确问题、影响范围、验收标准和不包含的内容。

实现应保持边界清晰，不混入无关格式化或重构；新行为补充测试；文档、配置示例和 API 变化保持同步。

PR 至少说明解决的问题、用户可见变化、测试/构建/预检命令、未覆盖的平台或外部服务，以及数据库迁移、兼容性和回滚影响。提交者应拥有代码授权并遵守 Apache-2.0；推荐使用 `git commit -s` 添加 DCO 签署。

## 15. 构建与发布

客户端、Gateway 和管理台按同一版本组合交付。发布前检查版本号、构建产物、内嵌 Web、Runtime 契约、第三方许可和发布清单。

```bash
pnpm run desktop:preflight:local
pnpm run desktop:preflight:release
```

正式发布还需要在目标干净提交上完成远端 Release Preflight、签名/公证和 Tag 检查，顺序见[正式发布前待处理事项](../pre-release-checklist.md)。发布镜像、安装包和压缩包不得包含生产配置、`.env`、数据库数据、私有凭据或模型 Key。

## 16. 附录

### 16.1 重要端口

| 服务 | 默认地址 |
| --- | --- |
| Gateway | `127.0.0.1:1904` |
| 管理台开发服务器 | `127.0.0.1:5904` |
| 客户端 Web 开发服务器 | `127.0.0.1:19860` |
| PostgreSQL 开发数据库 | `127.0.0.1:15932` |
| PostgreSQL 测试数据库 | `127.0.0.1:5933` |

### 16.2 相关文档

- [项目架构与数据边界](../architecture.md)
- [功能验证与操作指南](../validation-and-operations.md)
- [服务端本地开发](../../server/docs/getting-started/development.md)
- [服务端配置参考](../../server/docs/getting-started/configuration.md)
- [服务端架构总览](../../server/docs/architecture/overview.md)
- [HTTP API 概览](../../server/docs/reference/http-api.md)
- [生产部署](../../server/docs/deployment/production.md)
- [参与贡献](../../CONTRIBUTING.md)
- [安全报告](../../SECURITY.md)

### 16.3 文档维护

工具链版本、根目录脚本、端口、目录职责、测试门禁或发布流程变化时，应同步更新本文和对应专项文档。文档中的命令应从当前仓库实际验证，不保留已经失效的旧流程。
