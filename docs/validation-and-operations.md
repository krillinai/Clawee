# 功能验证与操作指南

更新日期：2026-09-08。本阶段在当前仓库验证启动、业务功能和部署，保持当前依赖、锁文件与 Runtime 不变。普通 CI、默认分支和分支保护均后置，见[正式发布前待处理事项](pre-release-checklist.md)。

本文是可执行的验收清单，不表示各项已经重新验证通过。整合阶段已有的本机测试证据见[开源整合方案](open-source-migration-plan.md#8-验证边界与本轮交付)；本次验收应记录实际 SHA、环境与结果。

## 1. 原仓库命令对应关系

原 `clawee-agent/` 对应当前 `client/`，原 `claw-mcp/` 对应当前 `server/`。子目录内的常用命令保留，根入口只是选择工作目录与工具链。

| 操作 | 在组件目录执行，延续原操作方式 | 在当前仓库根目录执行 |
| --- | --- | --- |
| 客户端安装 | `cd client` 后 `pnpm install --frozen-lockfile` | `pnpm run setup` 同时安装两端 |
| 管理台安装 | `cd server/web` 后 `pnpm install --frozen-lockfile` | 同上 |
| 桌面开发 | `client/`：`pnpm desktop:dev` | `pnpm run client:dev` |
| 客户端 Web 开发 | `client/`：`pnpm web:dev` | `pnpm run web:dev` |
| Gateway 与管理台联合开发 | `server/`：`make dev` | `node scripts/clawee.mjs server dev` |
| Gateway 单独开发 | `server/`：`make dev-backend` | `pnpm run server:dev` |
| 管理台单独开发 | `server/`：`make dev-web` | `pnpm run admin:dev` |
| 数据库迁移 | `server/`：`make db-migrate-up` | `pnpm run db:migrate` |
| 客户端测试 | `client/`：`pnpm test` | `pnpm run client:test` |
| 服务端测试 | `server/`：`make test` | `pnpm run server:test` |
| 客户端全量构建 | `client/`：`pnpm build` | `pnpm run client:build` |
| 服务端及 Collector 构建 | `server/`：`make build` | `pnpm run server:build` |
| 本机桌面完整预检 | `client/`：`pnpm desktop:preflight:local` | `pnpm run desktop:preflight:local` |
| Linux 服务端包 | `server/`：`make release-linux-amd64` / `make release-linux-arm64` | `node scripts/clawee.mjs server release-linux-amd64` 等 |
| SSH 服务端部署 | `server/`：`./scripts/deploy-release.sh staging` | 进入 `server/` 后执行 |

`client/` 的 `pnpm server:start`、`pnpm server:package`、`pnpm server:deploy:source` 仍是原来的 **Node daemon 服务模式**，不等于 Go Gateway 的启动、打包或部署。桌面与客户端 Web 会自行启动所需 daemon，正常验收无需另起 `pnpm daemon:dev`。

当前需要注意的差异：

- 私有运维配置通过仓库外的 `CLAWEE_OPS_DIR` 提供，不复制旧仓库真实配置。
- 客户端 pnpm 为 `9.15.0`，管理台为 `10.33.3`，不能用同一个固定全局版本替代。根入口会给子进程准备 Corepack；直接执行原命令时需先启用 Corepack。
- 根目录也固定 pnpm `9.15.0`，脚本统一使用 `pnpm run`，尤其不要省略 `setup`、`init` 前的 `run`。管理台命令进入 `server/web/` 再运行，保证 Corepack 根据该目录选择版本。
- Gateway 默认 `http://127.0.0.1:1904`，模型使用自带服务模式，模型凭据由验收者在界面填写。
- 不回退整合阶段已提交的依赖调整；从当前锁文件继续验证，不执行依赖升级。

Gateway、管理台和客户端 Web 的默认监听地址为 `0.0.0.0`，端口分别为 `1904`、`5904`、`19860`；本文的 `127.0.0.1` URL 是本机访问地址，其他设备应换为实际 IP 或域名。Gateway 的旧配置不会被重新初始化覆盖，需要时设置 `CLAW_MCP_SERVER_ADDR=0.0.0.0:1904`。数据库和内部 daemon 保持回环监听；Web 开发页面会代理本机 daemon，限定在受信开发网络内使用。

## 2. 验收准备

需要 Node.js 24、Corepack、Go 1.25 或与 `server/go.mod` 兼容的版本、Docker Compose，以及当前平台构建原生 Node 模块所需的工具。macOS 桌面验证需要图形登录会话。Windows 上服务端 Bash/Make 操作使用 WSL2。

以下命令从当前仓库根目录开始：

```bash
git branch --show-current
git rev-parse HEAD
git status --short
node --version
corepack --version
go version
docker compose version
corepack enable pnpm
pnpm run setup
```

在 `client/` 执行 `pnpm --version` 应为 `9.15.0`；在 `server/web/` 执行应为 `10.33.3`。若系统目录不允许启用 Corepack，使用表中的根入口，不用更换依赖来绕过工具链问题。

准备独立环境：

- 使用新的数据库卷和新的运维目录；先确认 `1904`、`5904`、`19860`、`15932`、`5933` 端口没有被其他实例使用，冲突时先确认占用者，不直接终止旧进程。
- 桌面手工验收推荐使用专用操作系统测试用户。`desktop:dev` 会读取 Electron 用户目录和该用户的 `~/.clawee/config.toml`；仅设置 `CLAWEE_DATA_DIR` 或切换源码目录不能隔离全部桌面状态。
- 使用测试账号、无敏感内容的工作目录和专用模型额度。禁止选择原仓库或业务数据目录让 Agent 写入。
- 每个终端都要重新设置本节或部署章节要求的环境变量。以下固定名称仅用于本次验收，已经用过的名称和目录不能当作全新环境。

## 3. 启动 Gateway、管理台和客户端

### 3.1 初始化与数据库

根目录执行：

```bash
export CLAWEE_OPS_DIR="$HOME/clawee-validation-ops"
export COMPOSE_PROJECT_NAME=clawee-validation-dev
pnpm run init --ops-dir "$CLAWEE_OPS_DIR"
node scripts/clawee.mjs server deps-up
pnpm run db:migrate
```

原命令等价为在 `server/` 执行 `make deps-up`、`make db-migrate-up`。本地开发数据库监听 `127.0.0.1:15932`，库名 `claw_mcp`。本节的 Compose project 名隔离命名卷，但不会改变固定端口。

- [ ] 首次初始化生成外部 `configs/config.yaml`，其中的密钥非示例常量，文件权限为 `0600`。
- [ ] 再次执行相同 `init` 显示“已有配置，未覆盖”，现有配置不变。
- [ ] 数据库就绪且迁移成功，重复迁移无错误。

### 3.2 启动服务端

在同一个终端、仓库根目录执行：

```bash
node scripts/clawee.mjs server dev
```

对应原 `server/` 下的 `make dev`，会启动 Gateway 和管理台开发服务器。保留此终端运行；访问管理台 `http://127.0.0.1:5904`，Gateway 为 `http://127.0.0.1:1904`。

另开终端验证：

```bash
curl --fail http://127.0.0.1:1904/healthz
curl --fail http://127.0.0.1:1904/readyz
curl --fail http://127.0.0.1:1904/version
```

- [ ] 健康、就绪接口均成功，版本接口可读；源码开发启动可能显示开发版本，正式包再核对构建 SHA。
- [ ] 注册首个测试账号，获得管理员入口；再注册普通账号，确认没有自动获得管理权限。
- [ ] 登录、退出、错误密码提示正常。首个管理员初始化期间仅允许验收者访问。

如只需内嵌管理台，在根目录运行 `pnpm run server:dev`，访问 `1904` 即可，不要同时再运行 `make dev`。其开发脚本仅在内嵌页面缺失时自动构建；修改管理台后用 `node scripts/clawee.mjs server build-web` 重建，或使用 `5904` 开发页面。

### 3.3 启动桌面

在专用操作系统测试用户的终端、仓库根目录执行：

```bash
pnpm run client:dev
```

对应原 `client/` 的 `pnpm desktop:dev`。首次运行会准备 Runtime、daemon 和桌面构建，耗时长于后续启动。

- [ ] 桌面窗口可见，进入登录页，没有持续白屏或 Runtime 启动失败。
- [ ] 登录页将 Gateway 设置为 `http://127.0.0.1:1904`，登录上述账号。
- [ ] 填写自己的模型 `base_url`、`model`、`api_key`，配置有效后能够创建任务。
- [ ] 退出并重启后 Gateway 和会话状态符合预期；切换账号没有出现其他账号数据。

### 3.4 验证共享 Web

先关闭桌面并停止其开发命令，释放 `19860`，再从根目录运行：

```bash
export CLAWEE_DATA_DIR="$HOME/clawee-validation-web-data"
pnpm run web:dev
```

访问 `http://127.0.0.1:19860`。Web 开发服务器会按需启动自己的 daemon，不需要另开 daemon 命令。

- [ ] Web 可以设置同一 Gateway、登录并完成相同任务。
- [ ] 两端采用相同测试账号、模型、输入文件和任务内容，以及相同内容视口验证通用流程。
- [ ] 桌面与 Web 的本地数据目录相互独立，不把本地历史自动跨端同步作为已有功能。
- [ ] 原生能力不可用时，Web 不显示无效入口；原生文件选择、托盘等单独在桌面验证。

## 4. 功能验收清单

每项记录“通过 / 失败 / 待验证 / 不适用”，失败附复现步骤；可选能力未配置时仍需验证不会妨碍通用功能。不要仅凭页面打开就标记通过。

| 编号 | 操作 | 预期结果 |
| --- | --- | --- |
| F01 | 新建任务，发送简单问题，再连续追问 | 模型真实回复，流式输出正常，上下文连贯 |
| F02 | 在测试工作目录创建文本文件，再让 Agent 读取并修改 | 文件实际落盘，内容与页面结果一致，路径位于测试目录 |
| F03 | 执行短命令，触发需要确认的操作，分别允许和拒绝 | 输出及退出状态正确；拒绝后不发生对应操作 |
| F04 | 停止正在输出的任务，重新发起任务 | 可以停止并恢复交互，不一直停留在运行状态 |
| F05 | 切换任务、关闭重开窗口和进程 | 历史、任务状态及文件保留，没有重复执行已结束任务 |
| F06 | 新建定时任务，等待一次运行，再暂停、恢复和删除 | 时间及运行记录正确；暂停或删除后不继续触发 |
| F07 | 导入可信测试 Skill，执行，再禁用或移除 | 可发现和调用；停用后不继续作为可用能力出现 |
| F08 | 更换模型或使用无效测试凭据，再恢复有效配置 | 错误可理解，修正后可继续任务；界面和普通日志不展示明文 Key |
| F09 | 在专用第二测试 Gateway 间切换，再切回 | 登录状态按 origin 隔离；重启不被模板地址覆盖；无第二实例则记待验证 |
| F10 | 普通用户访问管理入口或直接请求管理 API | UI 与接口均落实权限，不能读取或修改管理员资源 |
| F11 | 管理台创建测试 MCP 上游，同步能力 | 能力名称、输入 Schema、状态正确；纯文本工具返回可被客户端接收 |
| F12 | MCP 未授权调用、授权后调用、撤销后再调用 | 分别拒绝、成功、拒绝；审计账号、能力与结果对应 |
| F13 | 配置 MCP 确认或审批策略，分别允许和拒绝 | 门禁生效，拒绝不执行上游；执行结果不明确时不重复提交写操作 |
| F14 | 用两个账号测试 Agent、MCP Token 和数据权限 | 账号 B 不能使用账号 A 的 Agent 身份或访问其受限资源；停用后失效 |
| F15 | 共享文件上传、下载、删除，另一个无授权账号访问 | 内容正确、权限生效，删除后的资源不继续可用 |
| F16 | Skill Hub 导入测试包或公共测试 Git 源，同步并在客户端使用 | 列表、版本、内容和权限一致；错误来源有明确提示 |
| F17 | 在测试设备按安装页接入 Collector，检查心跳，再吊销 | 设备可见、身份稳定，吊销后旧身份不能继续上报 |
| F18 | 配置知识库测试资源，授权查询，再撤销 | 配置齐备时查询可用、撤销生效；所需外部服务未配置则记录待验证 |
| F19 | 不配置计费、钉钉、百炼及平台托管模型等外部服务 | 核心启动、登录、自带模型任务和 MCP 不被阻塞；入口显示合理状态 |
| F20 | 桌面原生文件选择、窗口重开、托盘退出；重启 Gateway | 桌面行为正确，连接恢复后可继续任务，无多余后台实例或丢失配置 |

MCP 配置详见[上游接入](../server/docs/integration/upstream-mcp.md)，Collector 在测试设备上按[接入说明](../server/docs/integration/collector.md)验收。F17 涉及安装常驻组件，仅在专用测试设备执行，并在完成后验证卸载。

## 5. 自动检查与实际打包验证

### 5.1 根入口与服务端

根目录执行；使用独立 `_test` 数据库，不能将开发库或原生产库 URL 填入测试变量：

```bash
pnpm run test
export COMPOSE_PROJECT_NAME=clawee-validation-test
docker compose -f server/deploy/docker-compose.test.yaml up -d --wait
export CLAW_MCP_TEST_DATABASE_URL='postgres://claw_mcp@127.0.0.1:5933/claw_mcp_test?sslmode=disable'
pnpm run server:test
```

`make test` 会构建管理台、检查服务端包、运行 Go、PostgreSQL 定向集成测试和管理台测试，并构建 Collector。显式导出测试 URL 后，首次 `go test ./...` 也能运行依赖 PostgreSQL 的测试。另在 `server/` 执行 `go vet ./...`。

完成后在相同终端停止本次测试容器，保留卷用于排查：

```bash
docker compose -f server/deploy/docker-compose.test.yaml down
unset CLAW_MCP_TEST_DATABASE_URL
unset COMPOSE_PROJECT_NAME
```

### 5.2 客户端与本机 App

根目录执行：

```bash
pnpm run desktop:preflight:local
```

这一入口已包含客户端测试、类型检查、Runtime 契约检查、本机 App 打包、包内 Runtime E2E 和内嵌 Web 哈希检查，不必为了相同结论重复运行整套测试。结果文件位于 `client/apps/desktop/release/clawee-desktop-local-preflight.json`，对应构建清单为同目录的 `clawee-desktop-build-manifest.json`。

本步骤使用本地模式，不要求正式 Apple 签名、公证凭据。本机通过只代表当前平台，不能推断其他桌面平台或正式安装包已通过。手工验收还需对实际打包 App 重做 F01、F02、F05、F20；使用专用系统测试用户，避免访问旧桌面配置。

### 5.3 隔离容器与真实模型联合验收

先在根目录构建镜像，再运行已有隔离脚本：

```bash
docker build -f server/Dockerfile -t clawee-server:oss-local .
node scripts/container-smoke.mjs
```

脚本使用随机项目名、宿主机随机端口、空数据库和新卷，覆盖迁移、首个管理员、Agent 登录、自带模型模式、MCP 授权及撤销和重启持久化，结束后自动清理自身容器与卷。

真实模型联调在桌面本地预检通过后执行。仓库外 JSON 包含 `base_url`、`model`、`api_key` 三个字段，填写自己的实际值，文件权限设为 `0600`：

```bash
chmod 600 "$HOME/clawee-validation-model.json"
CLAWEE_EXTERNAL_MODEL_CONFIG="$HOME/clawee-validation-model.json" node scripts/container-smoke.mjs
```

此命令会产生真实模型请求，自动运行隔离打包桌面并验证页面回复。不要把凭据写入本文或源码。该自动测试不替代第 4 节所有手工功能验收。

## 6. 部署操作验证

### 6.1 Docker Compose 全新部署

这条路径包含 PostgreSQL 和 Go Gateway，适合在本机验证部署流程。先停止第 3 节的 Gateway，释放 `1904`。从根目录开始，选择不同于开发环境的新目录与项目名：

```bash
export CLAWEE_OPS_DIR="$HOME/clawee-validation-container-ops"
export COMPOSE_PROJECT_NAME=clawee-validation-container
pnpm run init --ops-dir "$CLAWEE_OPS_DIR" --container --gateway http://127.0.0.1:1904
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml build
```

Linux 宿主机需要让容器 UID `65532` 读取挂载配置，按[生产部署说明](../server/docs/deployment/production.md#使用整合-compose)调整该文件所有者与权限；不要将包含数据库密码的 `.env` 改为公开可读。macOS Docker Desktop 也应检查是否出现挂载读取错误。

```bash
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml up -d --wait postgres
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml run --rm gateway migrate up
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml up -d gateway
curl --fail http://127.0.0.1:1904/readyz
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml ps
```

Gateway 启动后需要等待就绪；首次 `curl` 若早于服务启动完成，稍后重试。该 Compose 使用本次本地构建的镜像，不要求 GHCR 已经发行 `1.1.0`。

- [ ] `1904` 的内嵌管理台可访问，首个管理员注册成功；桌面连接后完成真实任务及 MCP 授权调用。
- [ ] 日志无反复崩溃、配置读取或数据库连接错误；版本接口与本次构建对应。
- [ ] 创建测试账号、上传测试文件后，执行以下重启和重建，账号、授权与文件仍保留。

```bash
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml restart gateway
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml down
docker compose --env-file "$CLAWEE_OPS_DIR/.env" -f deploy/docker-compose.yml up -d
```

不要加 `down -v`，它会删除本次验收数据。完成后用相同的项目名、配置与 `down` 停止实例。

### 6.2 原有 Linux 包与 SSH 部署

在 `server/` 目录执行，保留原命令：

```bash
make release-linux-amd64
# arm64 机器对应 make release-linux-arm64
```

产物位于 `server/release/claw-mcp-release-linux-<架构>-<日期>.tar.gz`。检查包含二进制、管理台、Collector、迁移与示例配置，不含真实配置。包名目前按日期命名，不要把包名当作版本证据，应核对 `/version` 和构建提交。

远端部署前，单独准备测试主机、数据库、SSH、systemd 权限、`yq`，以及仓库外运维文件。`$CLAWEE_OPS_DIR/deploy/servers.yaml` 示例结构如下，仅将占位主机替换为测试主机：

```yaml
servers:
  staging:
    ssh: deploy@staging.example.com
    deploy_dir: /opt/clawee-validation
    arch: linux-amd64
    service: clawee-validation.service
    config: configs/staging.yaml
```

`$CLAWEE_OPS_DIR/configs/staging.yaml` 应从示例生成独立密钥，并配置测试主机可访问的数据库、数据存储路径和实际 Gateway Origin。不能直接沿用本机数据库地址或 `/app/data` 容器路径。配置字段见[配置参考](../server/docs/getting-started/configuration.md)。

确认目标是测试实例后，在 `server/` 执行：

```bash
./scripts/deploy-release.sh staging
```

脚本会构建、传输、迁移数据库并重启服务，systemd 单元缺失或不匹配时会要求确认。这里使用明确的 `staging` 目标；`all` 仍引用原脚本的固定目标名，不用于新环境验收。

- [ ] 从空部署目录完成首次启动，校验健康、版本、登录、模型任务和 MCP。
- [ ] 在本次测试实例再次部署，检查重启、文件和权限持久化。
- [ ] 重复部署生成备份后，可用 `./scripts/rollback-release.sh staging` 验证应用回退；不同版本回退需对应版本证据。同一版本重部署只能证明脚本流程可运行。
- [ ] 回退脚本不会撤销数据库迁移，不会自动恢复数据库及业务文件。不得在旧生产实例试验。

### 6.3 备份恢复与 HTTPS

- [ ] 在验收实例暂停业务写入，按[生产部署说明](../server/docs/deployment/production.md#持久化与备份)备份 PostgreSQL、共享文件、Skill 数据与匹配的配置密钥。
- [ ] 在另一套隔离实例恢复同一备份点；检查登录、授权、文件内容和下载，不只检查备份文件存在。
- [ ] 需要验证远程部署时，使用真实测试域名与 HTTPS 代理，将配置中的公开 Origin、MCP 元数据和 Cookie 设置一并调整；先限制到验收人员访问并完成管理员初始化。
- [ ] 通过 HTTPS 完成桌面登录、真实任务、MCP、重启恢复；数据库不对公网开放。

缺少测试主机、域名或设备时，将相应条目标记为“待环境”，记录所需配合，不借用旧生产资源。

## 7. 结果记录与完成标准

在仓库外保存报告，例如 `$HOME/clawee-validation-reports/`。记录模板：

| 编号或命令 | SHA / 平台 / 环境 | 状态 | 实际结果、脱敏证据位置或失败复现 | 后续负责人 |
| --- | --- | --- | --- | --- |
| F01 | 填写实际值 | 待验证 |  |  |
| `desktop:preflight:local` | 填写实际值 | 待验证 |  |  |
| Compose 首次部署及重启 | 填写实际值 | 待验证 |  |  |
| SSH 部署与备份恢复 | 填写实际值 | 待验证 |  |  |

本阶段完成标准：所选环境中完成启动、通用功能、自动检查、实际 App 和至少一种全新部署路径；其他路径与可选功能逐项列出结果或待环境原因。真实模型、备份恢复、跨平台验证不得用 mock、进程启动或单平台结果代替。

复测时只重跑修复影响的功能及约定门禁；修改客户端可执行代码、依赖、构建或发布配置后，提交前必须重新通过完整 `desktop:preflight:local`。完成后检查 `git status --short`，确保配置、日志、截图、数据库和模型凭据没有加入提交。
