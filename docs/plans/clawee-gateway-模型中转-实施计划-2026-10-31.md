# Clawee Gateway 模型中转实施计划

> 状态：已审核修订
> 体量判断：复杂。外部 OpenAI 兼容协议、账号 Key 生命周期、PostgreSQL 审计、流式响应、管理台权限和生产迁移共享一条请求链路；保持一份内聚 Plan，不拆成多个独立交付。
> 来源方案：`docs/specs/clawee-gateway-模型中转-方案-2026-10-31.md`
> 用户批准：已批准（2026-10-31）；批准证据为用户在 Brainstorm 审核后连续回复“没问题,继续”。
> Plan Reviewer：Ampere，第一版结论 `REVISE`；R-01 至 R-03 已按关闭条件修订
> 流程结论：`PASS`（主 Agent 已完成 Plan 修订；不对同一版本重复启动 Reviewer）
> 执行授权：用户已明确授权开始执行（2026-10-31）

## 1. 执行边界

本 Plan 是实现合同。执行者只需要读取本文件和当前代码库即可完成实现、测试与验收；不需要回看聊天或重新设计需求。

目标是让已登录的 Clawee 账号生成一个可用于 OpenAI 兼容客户端的 Gateway API Key。调用方配置 Gateway 的 `/v1` `base_url` 和 Bearer API Key 后，可以访问 `models`、`chat/completions`、`responses`，透明转发多模态 JSON 与 SSE，并把可识别请求保存为可查询的模型中转审计记录。

非目标包括：多供应商路由、模型目录同步、复杂计费、配额、按 Key 限流、多 Key 并存、消息队列、独立数仓、音视频对象存储、供应商特判和新的登录体系。

本轮不处理当前工作区原有的 `.gitignore` 修改，也不改写或删除已有方案文档。

## 2. 契约快照

### 2.1 需求与规则

| ID | 本轮必须保持的约束 |
|---|---|
| `FR-1` | 提供 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`，支持非流式与 SSE 流式响应。 |
| `FR-2` | 外部请求只用 `Authorization: Bearer <api_key>` 识别账号；模型入口不要求登录 Cookie 或 `X-Claw-Agent-ID`。 |
| `FR-3` | 已登录用户可以查询元数据、生成、轮换和撤销 Key；生成/轮换模型 Key 前必须有非空账号用户名。 |
| `FR-4` | 上游配置来自现有 `ModelConfigurationProvider`；请求缺少 `model` 时注入账号默认模型，已有 `model` 时原样转发。 |
| `FR-5` | 每个已识别的模型请求只有一条持久化审计记录，记录用户、Key、请求/响应、状态、耗时、上下游状态和 Token 用量。 |
| `FR-6` | 管理台可以按用户、时间、模型、endpoint、状态查询明细，查看脱敏请求/响应，并按用户或模型聚合。 |
| `BR-1` | 账号必须为 `active`；账号没有用户名时不能生成或启用模型 Key。 |
| `BR-2` | 每账号最多一个 active Key；轮换后旧 Key 立即失效，撤销后不能继续调用。 |
| `BR-3` | MCP 原有 Token、scope、`X-Claw-Agent-ID`、Agent 绑定和审计行为保持不变；模型鉴权不复用 MCP Agent 绑定校验。 |
| `BR-4` | 审计和结构化日志不能保存明文 API Key、Authorization、Cookie 或上游凭据；二进制只保存媒体类型、字节数和 SHA-256。 |
| `BR-5` | Gateway 不自动重试模型请求；上游错误、超时、非法响应和客户端流式断开都记录终态。 |
| `NFR-1` | 不接受 Query 参数或 Cookie 传 Key；错误响应和日志不得回显上游凭据。 |
| `NFR-2` | 审计沿用全局 `X-Request-ID`，记录 Gateway 状态、上游状态、耗时和错误码。 |
| `NFR-3` | 保持 OpenAI 兼容 JSON 错误结构、SSE 帧和结束语义；未知 JSON 字段透明转发。 |

### 2.2 不得改变的设计决策

| ID | 决定与实现边界 |
|---|---|
| `DEC-1` | 外部协议固定为 `/v1/models`、`/v1/chat/completions`、`/v1/responses`，只接受 Bearer API Key。 |
| `DEC-2` | 复用 `mcp_account_tokens` 的哈希、密文、指纹、账号归属、轮换、撤销和 active 唯一约束。所有面向用户的生成/轮换入口由服务端固定签发恰有 `mcp:call`、`model:call` 两个 scope；忽略调用方传入的 scopes。旧的只有 `mcp:call` 的 Token 保持 MCP 能力，但不能调用 `/v1/*`。 |
| `DEC-3` | 模型鉴权独立于 `mcpauth.verifyAccountToken`：按 Key Hash 查询后检查 Token 状态、过期、`model:call`、账号状态并更新最近使用时间，不读取或要求 `X-Claw-Agent-ID`。 |
| `DEC-4` | 上游使用现有 `ModelConfigurationProvider`。`BaseURL` 是包含上游版本前缀的 OpenAI 兼容 API 根地址；只去除末尾斜杠并追加 `models`、`chat/completions`、`responses`，不自行增删 `/v1`。 |
| `DEC-5` | 新增 `model_proxy_audit_records`。查到可关联账号的 Key 后，在 scope/账号/配置策略判定前创建一条记录；格式错误或完全未知 Key 不写该表，只进入现有 access log。审计插入失败时 fail-closed，不调用上游；终态更新失败保留请求结果并写结构化错误。 |

### 2.3 外部接口契约

#### Gateway 模型入口

- 根路径挂载 `/v1`，不经过 `/api/v1` 登录 Cookie 中间件。
- `Authorization` 必须严格解析为 Bearer Token；缺失、格式错误、Query 参数或 Cookie 鉴权统一返回 OpenAI 风格错误 `{ "error": { "message": "...", "type": "...", "code": "invalid_api_key" } }`，HTTP `401`。
- `GET /v1/models` 不请求上游，返回：

  ```json
  {
    "object": "list",
    "data": [{ "id": "<configured-model>", "object": "model", "created": 0, "owned_by": "clawee" }]
  }
  ```

- `POST /v1/chat/completions` 与 `POST /v1/responses` 读取 JSON；只有 `model` 为空时补入默认模型。未知字段、文本、图片、`image_url`、data URL、`input_image`、音频字段和其他 content part 作为 JSON 原样转发，不下载、不转换、不重写。
- 上游 `BaseURL` 例如 `https://model.example/v1` 时，最终 URL 必须依次为 `https://model.example/v1/models`、`https://model.example/v1/chat/completions`、`https://model.example/v1/responses`。
- 转发请求的 `Content-Type`、必要的 `Accept` 和 JSON body；使用 Provider 的 API Key 覆盖上游 `Authorization`；不转发客户端 `Authorization`、Cookie、`Set-Cookie` 或其他客户端凭据。
- 上游合法 OpenAI `error` JSON 保留非敏感字段和 HTTP 状态；不可解析错误包装为稳定 `upstream_error`。429 保持 HTTP `429` 并使用 `upstream_rate_limited`。Gateway 只发起一次上游请求。
- `stream=true` 时按字节转发上游 `Content-Type`、SSE 事件、数据字段和结束标记；`chat/completions` 的 `[DONE]`、`responses` 的正常结束事件和上游直接 EOF 都接受。可解析 usage 才写入用量，缺失时 `usage_available=false`，不把缺失值伪造为零。

#### Key 管理

- 保留现有 `/api/v1/app/mcp/token`、`/reveal`、`/rotate`、`/revoke` 和管理员对应 Token 路由，避免新增第二套 Key 生命周期入口。
- `/rotate` 的请求体可以继续携带旧 `scopes` 字段，但服务层忽略其值，固定签发 `mcp:call`、`model:call`。
- 生成/轮换时账号必须 `active` 且 `strings.TrimSpace(account.Name) != ""`，否则返回稳定 `username_required`；页面检查不是安全边界。
- 普通查询只返回 Key 元数据、scope、状态、指纹和最近使用时间；生成/轮换成功响应返回明文一次以供复制。现有显式 reveal 接口为 MCP 兼容行为继续保留。

### 2.4 审计数据与状态机

`model_proxy_audit_records` 每行代表一次可关联到账号或账号 Key 的模型请求。建议字段必须落地为以下语义：

| 字段组 | 字段 |
|---|---|
| 身份 | `audit_id`、`request_id`、`user_id`、`user_name_snapshot`、`api_key_id`、`api_key_fingerprint` |
| 调用 | `endpoint`、`method`、`model`、`created_at`、`completed_at`、`duration_ms` |
| 结果 | `status`、`gateway_status`、`upstream_status`、`error_code`、`error_summary` |
| 用量 | `input_tokens`、`output_tokens`、`total_tokens`、`usage_available` |
| 快照 | 脱敏 `request_headers`、`request_body`、`response_headers`、`response_body`、`request_bytes`、`response_bytes`、`chunk_count`、`truncated` |

`audit_id` 为主键；`request_id` 只做索引和链路关联，不设唯一约束。JSONB 快照分别以 64 KiB 为采集上限，超出时保留可解析的前缀/结构化摘要并设置 `truncated=true`；快照截断不能影响状态、耗时和 Token 统计。二进制或 base64/data URL 统一替换为媒体类型、字节数和 SHA-256 元数据。

状态只允许：

| 当前 | 终态 | 说明 |
|---|---|---|
| `started` | `succeeded`、`failed`、`client_disconnected` | 已识别 Key 并创建起始记录，开始模型链路。 |
| `rejected_scope` | 保持 `rejected_scope` | Key 不 active、过期、缺 `model:call` 或被撤销。 |
| `rejected_account` | 保持 `rejected_account` | 账号不存在或不为 active。 |
| `rejected_configuration` | 保持 `rejected_configuration` | Provider 不可用、配置缺失或无法取得模型配置。 |
| 任意终态 | 无 | `Finalize` 使用状态条件更新，重复调用不改变记录。 |

模型审计服务至少提供以下公开的存储契约，Memory Store 与 PostgreSQL Store 都实现：

```go
SaveModelProxyAuditRecord(context.Context, ModelProxyAuditRecord) error
FinalizeModelProxyAuditRecord(context.Context, ModelProxyAuditFinalize) error
GetModelProxyAuditRecord(context.Context, string) (ModelProxyAuditRecord, error)
ListModelProxyAuditRecords(context.Context, ModelProxyAuditFilter) (ModelProxyAuditPage, error)
SummarizeModelProxyAuditRecords(context.Context, ModelProxyAuditSummaryFilter) (ModelProxyAuditSummary, error)
```

列表使用 keyset cursor，排序固定为 `created_at DESC, audit_id DESC`；cursor 编码 `created_at` 与 `audit_id`，对外为不透明 base64url 字符串。列表默认 50、最大 100。汇总支持 `group_by=user|model`，返回请求数、成功数、失败数、成功率、Token 汇总、平均耗时和错误分布。

### 2.5 错误、迁移和回滚

| 场景 | HTTP | 错误码/状态 |
|---|---:|---|
| 缺失/格式错误/未知/过期/撤销 Key | 401 | `invalid_api_key`；未知或格式错误 Key 不写模型审计表。 |
| 账号禁用 | 403 | `account_disabled`；已识别账号写 `rejected_account`。 |
| 无模型配置 | 503 | `model_configuration_unavailable`；写 `rejected_configuration`。 |
| 审计起始记录失败 | 503 | `model_audit_unavailable`；不调用上游。 |
| endpoint 不支持 | 404 | `unsupported_endpoint`。 |
| 上游限流 | 429 | `upstream_rate_limited`，不重试。 |
| 上游连接/超时/5xx/非法响应 | 502/503 | `upstream_error`，保存上游状态和脱敏摘要。 |
| 客户端流式断开 | 请求已开始 | `client_disconnected`，停止写客户端并完成审计终态。 |

新增一条稳定命名 Goose migration（当前最后迁移为 `00080_platform...`，因此使用 `server/db/migrations/00081_model_proxy_audit.sql` 的下一稳定序号），只创建 `model_proxy_audit_records` 和索引，不改写 `mcp_account_tokens`。迁移文件可保留隔离测试用的 Down 段，但生产回滚只停止/关闭模型路由并回滚代码，不执行 Down、不删除审计表、不删除 Token 表。

## 3. 基线与文件地图

### 3.1 版本与当前状态

- 项目根目录：`/Users/example/develop/clawee/Clawee`
- 当前分支：`unified-gateway-20261031`
- 基线提交：`2a0a8fbb7086f2cb63dd876108a5369499d3d74a`
- 当前已存在且不属于本任务的工作区变化：`.gitignore`；Brainstorm 方案为新增未跟踪文档。
- Go 版本约束为 1.25；Node.js 约束为 24；包管理器为 pnpm 10.33.3。

### 3.2 后端证据文件与符号

| 路径 | 现有职责与执行落点 |
|---|---|
| `server/internal/server/http.go` | `Options`、`NewRouter`；挂载根 `/v1`、管理台模型审计路由，并沿用全局 request ID、访问日志和恢复中间件。 |
| `server/internal/server/agent_http.go` | `handleAccountToken`、`handleRotateAccountToken`、`handleRevokeAccountToken`、`mountAgentRoutes`；接入固定双 scope、用户名校验和 Gateway Base URL 展示所需响应。 |
| `server/internal/server/mcp_admin_http.go` | 管理员 Token 元数据/轮换/撤销闭包、`validateAdminAccountTokenTarget`；保持旧权限与路由，改为模型 Key 生成规则。 |
| `server/internal/mcpgateway/types.go` | `AccountToken`、`ProxyAuditRecord`；新增模型 Token scope 常量、模型审计类型、状态和查询结果类型。 |
| `server/internal/mcpgateway/service.go` | `AccountTokenIssueRequest`、`prepareAccountToken`、`RotateAccountToken`、`CopyActiveAccountToken`；新增面向用户的固定 scope 轮换入口，并保留旧 `EnsureAccountToken` 的 MCP-only 行为。 |
| `server/internal/mcpgateway/store.go` | `Store`、`MemoryStore`、账号 Token Hash/Touch/Rotate；增加模型审计存储契约与内存实现。 |
| `server/internal/store/mcp_gateway_store.go` | `MCPGatewayStore` 的账号 Token、MCP 审计和 PostgreSQL 查询实现；增加模型审计 SQL、脱敏 JSONB 存取、条件 finalize、keyset 分页和汇总查询。 |
| `server/internal/mcpauth/auth.go` | 现有 `NewStaticTokenVerifier`/`verifyAccountToken`；只做回归保护，不让模型鉴权复用或改变 MCP Agent Header 校验。 |
| `server/internal/clawadmin/client.go` | `ModelConfiguration`、`AccountReference`、`EnsureModelConfiguration`；作为唯一上游配置来源。 |
| `server/internal/app/app.go` | `proxyStore`、`proxyGateway`、`server.NewRouter(server.Options{...})`；保证 PostgreSQL/Memory Store 均把同一模型审计 Store 注入 Gateway。 |
| `server/internal/rbac/catalog.go` | `PermissionMCPAuditRead = "console:mcp:audit:read"`；模型审计复用该授权标识，不新增权限码。 |
| `server/internal/server/mcp_governance_http.go` | 现有 `adminListLimit`、MCP 审计分页/过滤模式和 `requirePermission` 使用方式；模型审计 API 复用模式但直接查询新表。 |
| `server/db/migrations/00002_mcp_gateway_proxy.sql`、`00047_mcp_account_authorization.sql` | 现有 MCP 审计和 `mcp_account_tokens` 的结构证据；不得把模型记录写入 MCP 表。 |
| `server/internal/server/http_middleware.go` | `requestIDMiddleware`、`accessLogMiddleware`、`logAPIErrorResponses`；模型请求使用已有 `X-Request-ID`。 |

### 3.3 前端证据文件与符号

| 路径 | 现有职责与执行落点 |
|---|---|
| `server/web/src/lib/agent-api.ts` | `AccountTokenInfo`、`AccountTokenSecret`、`getMyAccountToken`、`rotateMyAccountToken`；显示 `model:call` 和 Gateway `/v1` 地址。 |
| `server/web/src/pages/agent-access.tsx` | `AgentAccessPage`、Token drawer 状态；增加用户名缺失、模型 scope、Gateway Base URL 和复制文案测试。 |
| `server/web/src/components/mcp-agent-access-ui.tsx` | `MCPAgentTokenDrawer`/Token 表；复用现有 Key 展示与轮换交互，避免新增第二套组件。 |
| `server/web/src/pages/mcp-proxy-audit.tsx` | `MCPProxyAuditPage` 的列表、筛选、摘要和详情交互基线；模型审计页面沿用交互模式但使用专用字段和 API。 |
| `server/web/src/lib/mcp-admin-api.ts` | 现有管理员 MCP API 的请求/响应映射；新建同风格的模型审计 API 模块。 |
| `server/web/src/app.tsx` | 页面 lazy import 与路由；新增 `/admin/model-proxy/audits`。 |
| `server/web/src/components/admin-sidebar.tsx` | 管理台导航与 `permissions.mcpAuditRead` 门禁；增加模型中转日志入口。 |
| `server/web/src/pages/agent-access.test.tsx`、`server/web/src/pages/mcp-proxy-audit.test.tsx` | 前端测试夹具与公开交互断言基线。 |

### 3.4 公共命令与隔离环境

命令从项目根运行，除非另有注明：

- Go 单元/包测试：`cd server && go test ./...`
- Go 目标测试：`cd server && go test ./internal/mcpgateway ./internal/mcpauth ./internal/server ./internal/store -count=1`
- 前端测试：`cd server/web && pnpm test`
- 前端构建：`cd server/web && pnpm build`
- 完整服务端脚本：`pnpm server:test`；它会构建 Web、运行 Go 测试并使用隔离的 `postgres-test`。
- 服务端构建：`pnpm server:build`
- 数据库迁移：`pnpm db:migrate`，只允许对明确的开发数据库执行。

PostgreSQL 迁移/Store/HTTP 集成测试必须设置仓库外的 `CLAWEE_OPS_DIR` 或 `CLAW_GATEWAY_TEST_DATABASE_URL`，使用 `server/deploy/docker-compose.test.yaml` 的隔离数据库；禁止连接生产实例或旧用户数据。测试结束清理测试数据库，不能把测试证据写入仓库。

## 4. 追踪矩阵

| 实施任务 | 需求/规则 | 关键决策 | 自动化测试 | 功能验收 |
|---|---|---|---|---|
| `TASK-0` | 全部契约基线 | 全部 `DEC-1` 至 `DEC-5` | 分支、提交、文件、命令和现有 MCP 基线检查 | 为 `AC-1` 至 `AC-7` 建立验收前置条件 |
| `TASK-1` | `FR-2`、`FR-3`、`BR-1`、`BR-2`、`BR-3`、`NFR-1` | `DEC-2`、`DEC-3` | `server/internal/mcpgateway/service_test.go`、`server/internal/mcpauth/auth_test.go`、`server/internal/server/agent_http_test.go`、`server/web/src/pages/agent-access.test.tsx` | `AC-2`、`AC-3`、`AC-7` |
| `TASK-2` | `FR-5`、`BR-4`、`NFR-2` | `DEC-5` | `server/internal/mcpgateway/service_test.go`、`server/internal/store/mcp_gateway_postgres_integration_test.go`、模型审计 Store/脱敏测试 | `AC-5` |
| `TASK-3` | `FR-1`、`FR-2`、`FR-4`、`BR-5`、`NFR-1`、`NFR-3` | `DEC-1`、`DEC-3`、`DEC-4`、`DEC-5` | 新增 `server/internal/server/model_proxy_http_test.go`，使用 `httptest` 上游和可控流式 ResponseWriter | `AC-1`、`AC-2`、`AC-4`、`AC-5` |
| `TASK-4` | `FR-6`、`BR-4`、`NFR-2` | `DEC-5` | 新增 `server/internal/server/model_proxy_admin_http_test.go`、`server/web/src/pages/model-proxy-audit.test.tsx` | `AC-6` |
| `TASK-5` | `BR-3`、`NFR-1`、`NFR-2`、`NFR-3` | `DEC-2`、`DEC-4`、`DEC-5` | 迁移集成、MCP 鉴权/Endpoint/审计、Agent Access 和管理台 MCP 审计回归 | `AC-5`、`AC-7` |
| `TASK-6` | 全部 P0/P1 `FR`、`BR`、`NFR` | 全部 `DEC-1` 至 `DEC-5` | 最后一次目标测试、全量回归和构建 | `AC-1` 至 `AC-7` |

## 5. 实施任务

### TASK-0：确认 Plan 仍然有效

**交付结果**

- 在开始改代码前确认分支、基线提交、方案批准记录、当前 `.gitignore` 无关变化和本 Plan 的契约仍有效。
- 确认 `server/internal/app/app.go` 的 `proxyStore`、`proxyGateway`、`NewRouter` wiring、`ModelConfigurationProvider` 和当前 migration 序号没有发生不改变契约的路径漂移。

**文件与符号**

- 读取：`docs/specs/clawee-gateway-模型中转-方案-2026-10-31.md`、本文件、`server/internal/server/http.go:Options/NewRouter`、`server/internal/app/app.go:New`、`server/internal/mcpgateway/service.go:RotateAccountToken`、`server/internal/store/mcp_gateway_store.go:MCPGatewayStore`。
- 基线测试：`server/internal/mcpauth/auth_test.go`、`server/internal/server/mcp_endpoint_http_test.go`、`server/web/src/pages/mcp-proxy-audit.test.tsx`。

**实施步骤**

1. 运行 `git status --short`、`git branch --show-current`、`git rev-parse HEAD`，记录与本 Plan 头部不一致的事实。
2. 用 CodeGraph 核对上述符号；若 `DEC`、接口路径、字段语义、迁移序号或 `AC` 已失效，停止编码并先更新方案/Plan。
3. 运行一次现有 MCP Token、MCP Endpoint 和前端审计基线；允许已有测试通过，记录为 characterization 基线。

**TDD**

- 策略：基线检查，不新增行为测试。
- 基线：`cd server && go test ./internal/mcpauth ./internal/server -run 'Test.*(Token|MCP|Audit)' -count=1` 与 `cd server/web && pnpm test -- pages/mcp-proxy-audit.test.tsx`；命令失败时先区分既有环境问题和本任务问题，不修改业务代码掩盖失败。

**任务完成门**

- 当前基线与本文件一致，已记录现有失败或通过证据；否则状态为 `BLOCKED`，不能进入 `TASK-1`。

### TASK-1：统一模型 API Key 生命周期与独立模型鉴权 `[FR-2, FR-3, BR-1, BR-2, BR-3, NFR-1, DEC-2, DEC-3, AC-2, AC-3, AC-7]`

**交付结果**

- app/admin 现有 Token rotate 入口生成固定双 scope `mcp:call`、`model:call`，忽略客户端 scopes。
- 无用户名或非 active 账号无法生成模型 Key；轮换、撤销、active 唯一约束和旧 Token MCP 兼容行为保持可观察。
- `/v1/*` 的鉴权按 Bearer Key Hash 识别账号，不要求 `X-Claw-Agent-ID`，且不会改变 MCP verifier。

**文件与符号**

- 修改：`server/internal/mcpgateway/types.go` - 增加 `AccountTokenScopeMCPCall`、`AccountTokenScopeModelCall` 和固定 scope 归一化所需类型。
- 修改：`server/internal/mcpgateway/service.go` - 增加 `RotateModelAccountToken(context.Context, userID, accountName string, expiresAt *time.Time, issuer string)`；保留 `EnsureAccountToken`/旧 `RotateAccountToken` 的 MCP-only 内部行为。
- 修改：`server/internal/server/agent_http.go` - `handleRotateAccountToken`、`mountAgentRoutes` 使用当前账号名调用模型 Key 入口。
- 修改：`server/internal/server/mcp_admin_http.go` - 管理员 rotate 目标账号校验同时要求 active 和非空 `Account.Name`，调用固定 scope 入口；不要移除现有 admin 权限。
- 新增/修改：`server/internal/server/model_proxy_http.go` - `resolveModelBearer` 的 Bearer/Key Hash 身份解析和 `evaluateModelPolicy` 的 scope/账号策略判定，供 `TASK-3` 使用；本任务只完成两阶段鉴权契约，不在身份解析阶段提前丢弃已知 revoked/expired/缺 scope Key。
- 修改：`server/internal/mcpgateway/service_test.go`、`server/internal/server/agent_http_test.go`、`server/internal/mcpauth/auth_test.go`；新增模型 verifier 测试。
- 修改：`server/web/src/lib/agent-api.ts`、`server/web/src/pages/agent-access.tsx`、`server/web/src/components/mcp-agent-access-ui.tsx`、`server/web/src/pages/agent-access.test.tsx`；显示 `model:call`、Gateway Base URL（浏览器当前 origin + `/v1`）和用户名缺失提示。

**实施步骤**

1. 把用户可调用的 app/admin rotate 统一改为 `RotateModelAccountToken`；服务端固定 scopes，不能由请求体删除、替换或扩展。
2. 在模型 Key 入口校验 `Account.Name` 的 trim 结果和账号状态；`EnsureAccountToken` 继续允许历史 MCP-only 自动 Token，避免改变 MCP 初始化行为。
3. 把模型鉴权拆成两个阶段：`resolveModelBearer` 只严格解析 Header、Hash 查询并区分格式错误/未知 Key/已查到 Key；已查到 Key 时保留 Token 状态、过期时间、scope、user ID、Key ID 和指纹供审计，不能在此阶段因策略拒绝直接返回。
4. `evaluateModelPolicy` 在审计起始记录创建后检查 `active`、过期、`model:call` 和账号 `active`；分别映射 `rejected_scope` 或 `rejected_account`，只有策略通过后才 `TouchAccountToken`。模型配置检查属于 `TASK-3` 的审计后策略阶段并映射 `rejected_configuration`。
5. 为模型鉴权返回明确的身份结果：`user_id`、用户名快照、Key ID、Key 指纹和 scopes；完全未知/格式错误 Key 不泄露是否存在对应账号。前端只显示 Key 元数据和 scope；生成/轮换响应显示明文一次；在 Token drawer 中显示可复制的 Gateway `/v1` Base URL，使用现有组件和样式。

**TDD**

- 策略：必须先 RED。
- RED：`TestRotateModelAccountTokenRequiresUsernameAndFixedScopes` 传空用户名、`scopes:["admin:all"]` 和 `scopes:["mcp:call"]`，断言空用户名失败、成功 Token 恰有两个固定 scope；`TestResolveModelBearerReturnsKnownRevokedExpiredAndMissingScopeTokens` 分别准备 revoked、expired、只有 `mcp:call` 的已知 Token，断言身份解析仍返回 Token 快照，策略阶段而不是身份解析阶段负责拒绝；`TestModelBearerVerifierDoesNotRequireAgentHeader` 只带 Bearer 调用成功身份路径；`TestModelBearerVerifierRejectsQueryAndCookieToken` 将相同 Key 放入 Query/Cookie，期望 `invalid_api_key`；`TestAppRotateAccountTokenRejectsUnnamedAccount` 通过现有 app route 发送 rotate，期望 `username_required`；这些测试在旧代码上因没有模型入口、固定 scope、两阶段身份解析或独立 verifier 而失败。
- 基线：`TestAccountTokenVerifierRejectsInvalidAccountOrAgentContext` 等现有 MCP verifier 测试必须先通过，证明 `X-Claw-Agent-ID` 规则仍是旧链路行为。
- GREEN：完成固定 scope 服务方法、app/admin 传入用户名、模型 Bearer verifier 和前端展示后，目标 Go/React 测试通过；旧 `EnsureAccountToken` 仍产生仅 `mcp:call` 的 MCP-only Token。
- REFACTOR：只允许合并重复的 scope 常量、Token response 映射和错误映射；重跑目标 Go 测试、`server/internal/mcpauth` 回归和 `server/web/src/pages/agent-access.test.tsx`。

**任务完成门**

- Key 生命周期目标测试、MCP verifier 回归和 Agent Access 页面测试通过；对应 `AC-2`、`AC-3`、`AC-7` 的实现前置条件已满足。

### TASK-2：落地模型中转审计存储、脱敏与终态更新 `[FR-5, BR-4, NFR-2, DEC-5, AC-5]`

**交付结果**

- PostgreSQL 新增 `model_proxy_audit_records` 与用户/模型/状态/时间/request_id 索引，Memory Store 和 PostgreSQL Store 提供同一存储行为。
- 审计起始记录、条件终态更新、keyset 列表和 user/model 汇总可单独测试；敏感头、凭据、base64/data URL 和过大快照不会落明文。

**文件与符号**

- 新增：`server/db/migrations/00081_model_proxy_audit.sql` - 表、索引、隔离测试 Down 段。
- 修改：`server/internal/mcpgateway/types.go` - `ModelProxyAuditRecord`、`ModelProxyAuditFinalize`、`ModelProxyAuditFilter`、`ModelProxyAuditPage`、`ModelProxyAuditSummaryFilter`、`ModelProxyAuditSummary` 和 `ModelProxyAuditStatus`。
- 修改：`server/internal/mcpgateway/store.go` - `Store` 接口、`MemoryStore` 字段和五个模型审计方法。
- 修改：`server/internal/store/mcp_gateway_store.go` - PostgreSQL insert/finalize/get/list/summary 实现与 JSONB 映射。
- 新增：`server/internal/server/model_proxy_audit.go` - `sanitizeModelProxyHeaders`、`sanitizeModelProxyJSON`、`snapshotModelProxyBody`、usage 提取和 keyset cursor 编解码；这些函数只负责可验证的脱敏/快照，不负责 HTTP 转发。
- 测试：`server/internal/store/mcp_gateway_postgres_integration_test.go` 增加 migration、索引、条件 finalize 和聚合验证；`server/internal/mcpgateway/service_test.go` 或新增 `server/internal/server/model_proxy_audit_test.go` 覆盖内存 Store、脱敏和快照上限。

**实施步骤**

1. 创建 migration：`audit_id` 主键；身份、endpoint/method/model、状态、上下游状态、错误、usage、快照、字节数、chunk 数和时间字段按契约落库；索引至少为 `(user_id, created_at DESC)`、`(model, created_at DESC)`、`(status, created_at DESC)`、`(request_id)`。
2. 在 `mcpgateway.Store` 中增加模型审计方法；Memory Store 深拷贝 JSONMap/切片，保持测试与 PostgreSQL 读写语义一致。
3. PostgreSQL `FinalizeModelProxyAuditRecord` 使用 `WHERE audit_id=$1 AND status IN ('started')`，拒绝二次终态变更；拒绝状态在创建时直接写终态或由统一 finalize 规则写入，不能产生第二行。
4. 实现头部脱敏：`Authorization`、`Cookie`、`Set-Cookie`、上游 API Key 和常见 secret/password/token 字段替换为固定掩码；不把 Token Hash 当作可展示凭据。
5. 实现 JSON 脱敏：递归处理对象和数组；对 base64/data URL/媒体 content part 写入 `media_type`、`bytes`、`sha256`；文本、model、参数和可分析字段保留；64 KiB 后设置 `truncated`。
6. 实现不透明 cursor 和聚合 SQL；summary 的成功率以 `succeeded / request_count` 计算，usage 缺失按 `usage_available=false` 处理。

**TDD**

- 策略：必须先 RED；数据库行为用隔离 PostgreSQL，不用生产库。
- RED：`TestModelProxyAuditFinalizeIsIdempotent` 先插入 `started`，两次 finalize，期望第二次不改变终态；`TestSanitizeModelProxyJSONRedactsMediaAndSecrets` 传 Authorization、Cookie、data URL、base64 和未知文本字段，期望凭据不出现且媒体只保留类型/大小/hash；`TestListModelProxyAuditRecordsUsesCreatedAtAndIDCursor` 插入同一时间的多行，期望第二页无重复/遗漏；`TestModelProxyAuditPostgresMigrationCreatesIndexesAndSummary` 在隔离数据库运行 migration 后查询表、索引和按用户/模型汇总，旧代码因表和方法不存在而失败。
- 基线：现有 `TestP8MigrationRunsOnPostgres` 等 migration/Store 测试首次通过即记录为数据库基线，不伪装成 RED。
- GREEN：完成表、两类 Store、脱敏、cursor、条件 finalize 和 summary 后，目标内存/PostgreSQL 测试通过；插入失败能被调用方识别并 fail-closed。
- REFACTOR：只合并 JSON 脱敏的递归辅助函数和 PostgreSQL scan/encode 重复逻辑；重跑目标 Store、migration 和脱敏测试。

**任务完成门**

- 审计表可在隔离 PostgreSQL 中创建；插入、查询、条件终态、聚合、脱敏、截断和未知 Key 不入表的存储前置行为均有通过证据，对应 `AC-5`。

### TASK-3：实现 OpenAI 兼容模型代理与流式生命周期 `[FR-1, FR-2, FR-4, BR-5, NFR-1, NFR-3, DEC-1, DEC-3, DEC-4, DEC-5, AC-1, AC-2, AC-4, AC-5]`

**交付结果**

- `/v1/models`、`/v1/chat/completions`、`/v1/responses` 在统一 Key 鉴权、账号配置、审计和错误语义下可被 OpenAI 兼容客户端调用。
- 非流式、多模态 JSON、未知字段、合法错误、429/5xx、超时、SSE `[DONE]`/responses 结束事件、直接 EOF 和客户端断开均符合契约。

**文件与符号**

- 新增：`server/internal/server/model_proxy_http.go` - `mountModelProxyRoutes`、`handleModelList`、`handleModelProxy`、`loadModelConfiguration`、上游请求构造和响应转发；请求链路固定为“解析 Bearer/Hash → 已知 Key 创建 started 审计 → scope/账号/配置策略判定 → 上游调用”。
- 修改：`server/internal/server/http.go` - `NewRouter` 在根路由挂载 `mountModelProxyRoutes(router, opts)`；`Options` 保持使用现有 `ProxyGateway`、`AccountService`、`ModelConfigurationProvider`，不新增供应商配置体系。
- 修改：`server/internal/app/app.go` - 确保生产 Router 使用现有 `clawAdminClient` 和 `proxyGateway.Store()`；Memory/DB 两种运行模式都能关闭或返回服务不可用。
- 新增：`server/internal/server/model_proxy_http_test.go` - `httptest.Server` 上游、请求头/body、路径、SSE 和客户端断开测试。
- 关联：`server/internal/server/http_middleware.go` 的 request ID/access log 只作为公共基础设施，不复制一套日志中间件。

**实施步骤**

1. 路由只注册三个规定 endpoint；未知 `/v1/*` 返回 `unsupported_endpoint` OpenAI 错误 JSON，不接受 `/v1/models?api_key=...` 或 Cookie。
2. 先解析 Bearer 并按 Hash 查询；格式错误或完全未知 Key 直接返回 `invalid_api_key` 且不写模型审计表。只要查到 Key，就用 Key/账号身份快照创建唯一 `started` 审计行，然后按 Token active/过期/`model:call`、账号 active、Provider 配置顺序判定；失败分别 finalize 为 `rejected_scope`、`rejected_account`、`rejected_configuration`。起始审计插入失败返回 `503 model_audit_unavailable`，不上游。
3. 对 `models` 读取 Provider 默认模型并返回固定列表；对 POST 读取 JSON，只有 model 为空时补默认模型，保留未知字段后重新编码。
4. 构造上游 URL 时只执行 `strings.TrimRight(BaseURL, "/") + "/" + endpoint`；Provider API Key 只存在上游请求，不进入客户端响应、error body、日志或审计。
5. 使用单次 `http.Client.Do`；非流式响应复制状态、允许的响应头和 body，脱敏快照后 finalize。上游非 2xx 合法 OpenAI error 原样保留非敏感字段和状态，其他错误包装为 `upstream_error`。
6. 流式响应使用受限 tee 记录 bytes/chunks/usage/snapshot；每次写出后 flush。写客户端失败或 request context 取消时停止写入并 finalize `client_disconnected`；上游读错、超时或非法响应 finalize `failed`，不重试。
7. 所有 finalize 错误只写 `model_audit_finalize_failed`（包含 `audit_id`/`request_id`）并保留原 HTTP 结果；不重新发送上游请求。

**TDD**

- 策略：必须先 RED。
- RED：`TestModelProxyModelsReturnsFixedListAndRegistersModelsAudit` 调用 `/v1/models`，断言固定响应、默认模型和审计；`TestModelProxyForwardsDefaultModelAndMultimodalJSON` 通过 `httptest` 上游收到 `/v1/chat/completions`，发送无 model、图片 data URL、未知字段和 Bearer Key，期望旧代码路由不存在而失败；`TestModelProxyResponsesForwardsUnknownFieldsAndAcceptsDirectEOF` 发送 `/v1/responses`，断言 body/未知字段和 direct EOF；`TestModelProxyRejectsMissingMalformedQueryAndCookieBearer` 覆盖缺失、错误 Header、Query、Cookie，断言均为 `401 invalid_api_key`；`TestModelProxyKnownRejectedTokensCreateAuditBeforePolicy` 分别使用 revoked、expired、缺 scope Key 和 disabled account，断言各有一条拒绝终态、上游计数为零；`TestModelProxyUsesBaseURLVersionPrefixWithoutDuplicatingV1` 让 Provider 返回 `https://model.example/v1`，期望最终 path 为 `/v1/responses`；`TestModelProxyStreamsSSEAndFinalizesAudit` 返回 SSE `[DONE]`，期望客户端看到原始帧并得到 succeeded 审计；`TestModelProxyClientDisconnectFinalizesWithoutRetry` 中途关闭客户端，断言 `client_disconnected` 且上游只收到一次；`TestModelProxyPropagatesOpenAIErrorAndMaps4295xxTimeoutAndInvalidResponse` 覆盖合法 error、429、5xx、连接失败、超时和非法响应；`TestModelProxyRejectsAuditInsertBeforeUpstreamCall` 注入失败 Audit Store，期望 `503 model_audit_unavailable` 且上游计数为零；`TestModelProxyDoesNotRequireAgentHeader` 只带 Bearer，期望成功。这些测试在旧代码上因路由、审计顺序、错误映射和流式生命周期均不存在而失败。
- 基线：现有 `model_configuration_http_test.go` 的 Provider error/默认配置行为和 `mcp_endpoint_http_test.go` 的 MCP 路由行为先通过，证明新增根路由没有改变 `/mcp`。
- GREEN：完成三条路由、上游 URL/body/header、非流式/SSE、默认 model、错误映射、审计生命周期和不重试后，目标模型 HTTP 测试通过。
- REFACTOR：仅整理 endpoint 常量、OpenAI error response、非流式/流式 finalize 共用逻辑；每次整理后重跑模型 HTTP 测试和 MCP 路由回归。

**任务完成门**

- `model_proxy_http_test.go` 覆盖主流程、认证边界、BaseURL、三 endpoint、多模态、SSE、上游失败、客户端断开和审计失败；Go 目标测试通过，对应 `AC-1`、`AC-2`、`AC-4`、`AC-5`。

### TASK-4：提供管理台模型中转日志 API 与页面 `[FR-6, BR-4, NFR-2, DEC-5, AC-6]`

**交付结果**

- 管理员拥有 `console:mcp:audit:read` 时，可以通过三条 API 和管理台独立页面查询模型中转明细、脱敏详情与 user/model 汇总。
- 普通账号、无权限管理员和空结果都得到稳定响应；页面不显示任何明文 Key、Authorization 或上游凭据。

**文件与符号**

- 新增：`server/internal/server/model_proxy_admin_http.go` - `mountModelProxyAdminRoutes`、列表/详情/summary handler、过滤与 cursor 解码、`requirePermission(opts.RBACService, rbac.PermissionMCPAuditRead)`。
- 修改：`server/internal/server/http.go` - 在 `adminAPI` 挂载模型审计路由。
- 新增：`server/internal/server/model_proxy_admin_http_test.go` - 403、空结果、cursor、详情脱敏和 summary 分组测试。
- 新增：`server/web/src/lib/model-proxy-admin-api.ts` - 三条 API 的类型与映射。
- 新增：`server/web/src/pages/model-proxy-audit.tsx`、`server/web/src/pages/model-proxy-audit.test.tsx` - 独立模型审计页面，复用 `mcp-proxy-audit.tsx` 的筛选、详情和摘要交互结构。
- 新增：`server/web/e2e/model-proxy-audit.spec.ts` - 复用现有 Playwright API route fixture，验证真实浏览器路由、筛选、详情和无权限门禁。
- 修改：`server/web/src/app.tsx`、`server/web/src/components/admin-sidebar.tsx` - lazy route `/admin/model-proxy/audits` 与 `permissions.mcpAuditRead` 门禁。

**实施步骤**

1. 新增 `GET /api/v1/admin/model-proxy/audits`，解析 `limit`、`cursor`、`user_id`、`model`、`endpoint`、`status`、`error_only`、`created_from`、`created_to`，只调用模型审计 Store，返回 `{items,next_cursor}`。
2. 新增 `GET /api/v1/admin/model-proxy/audits/detail?audit_id=...`，返回身份快照、调用定位、状态、用量和脱敏快照；不存在返回 404，缺 audit_id 返回 400。
3. 新增 `GET /api/v1/admin/model-proxy/audits/summary`，解析时间范围与 `group_by=user|model`，返回请求数、成功数、失败数、成功率、Token 汇总、平均耗时和错误分布；缺少/非法 `group_by`、时间格式和 `audit_id` 都有稳定 400 行为，空结果返回合法空数组/零统计。
4. 三条 API 都使用现有统一 `/api/v1/admin` 包装、JWT/admin session 和 `console:mcp:audit:read`；不新增 RBAC catalog code，不直接复用 MCP 审计表。
5. 页面使用模型专用字段（用户、用户名快照、endpoint、model、状态、耗时、usage、时间），详情按已脱敏值渲染；列表和 summary 的筛选条件可刷新 URL query。

**TDD**

- 策略：必须先 RED。
- RED：`TestModelProxyAdminAuditsRequiresMCPAuditRead` 用普通管理员调用列表/详情/summary，期望 `403 forbidden`；`TestModelProxyAdminAuditsReturnsCursorAndSummary` seed 两页同时间审计数据，期望列表无重复且 summary 按 user/model 聚合；`TestModelProxyAdminAuditDetailRejectsMissingAndUnknownID` 分别断言缺 `audit_id` 为 400、未知 ID 为 404；`TestModelProxyAdminAuditsApplyEveryFilterAndEmptyResult` 覆盖 user/model/endpoint/status/error_only/time 和空结果；`ModelProxyAuditPage renders filters and redacted detail` 使用 API mock，期望显示 model/endpoint/status 而不显示 Authorization/API Key；`model-proxy-audit.spec.ts` 通过 Playwright 访问 `/admin/model-proxy/audits`，验证路由、筛选、详情和 403 门禁；旧代码因三条 API、页面、路由和 E2E 行为不存在而失败。
- 基线：`server/web/src/pages/mcp-proxy-audit.test.tsx` 先通过，作为页面交互基线；现有 RBAC 权限 API 测试先通过，证明复用权限码。
- GREEN：完成 Go admin handlers、前端 API、页面、路由和导航后，Go admin 测试与 React 页面测试通过。
- REFACTOR：复用现有 `formatDateTime`、状态 badge 和详情抽屉模式，不重构 MCP 页面；重跑模型页面与 MCP 页面测试。

**任务完成门**

- 三条 admin API 的 403/空结果/分页/详情/聚合测试和模型审计页面测试通过，对应 `AC-6`。

### TASK-5：完成迁移启用、配置兼容和 MCP 回归 `[BR-3, NFR-1, NFR-2, NFR-3, DEC-2, DEC-4, DEC-5, AC-5, AC-7]`

**交付结果**

- 正常生产 wiring 使用审计 Store 与现有模型 Provider；Provider 未配置时 `/v1/*` 返回明确 503，登录、MCP 和本地工作台继续可用。
- 新 migration 只向前启用；代码回滚操作与数据保留边界有可执行记录。
- 旧 MCP Token、MCP Agent Header、MCP Endpoint、MCP 审计和 Agent Access 兼容测试保持通过。

**文件与符号**

- 修改：`server/internal/app/app.go` - 生产/内存 Store wiring、模型路由启用条件和 Provider 缺失行为。
- 修改：`server/internal/server/http.go`、`server/internal/server/route_foundation_test.go` - 路由无 Proxy/Provider 时的服务不可用和旧路由基线。
- 修改：`server/internal/server/mcp_endpoint_http_test.go`、`server/internal/mcpauth/auth_test.go`、`server/internal/server/agent_http_test.go`、`server/web/src/pages/mcp-proxy-audit.test.tsx`（仅在新增行为破坏既有断言时更新最小夹具）。
- 运行：`server/db/migrations/00081_model_proxy_audit.sql` 的隔离 migration 测试与现有 `server/scripts/test.sh`。

**实施步骤**

1. 在 `app.New` 中让 DB Store 和 Memory Store 都实现模型审计接口；不为模型 Key 新增环境变量或第二个数据库。
2. 验证 Provider 未配置、上游配置不可用、审计 Store 失败时只影响模型请求，不阻断 `/healthz`、登录、MCP 和现有管理台。
3. 在隔离数据库执行 `pnpm db:migrate` 或等价测试 migration Up，查询 Goose 版本表与 `to_regclass('model_proxy_audit_records')`，再重复 Up 验证幂等；生产发布记录只向前执行，不运行 Down。
4. 使用基线 SHA `2a0a8fbb7086f2cb63dd876108a5369499d3d74a` 作为旧版本回滚参照，在仓库外临时目录用 `git archive` 取出基线代码并运行其现有 `server/scripts/test.sh` 的 Go/MCP 子集；确认该版本不挂 `/v1` 但可读取同一隔离数据库、登录和 `/mcp` 可用，且 `model_proxy_audit_records` 仍存在。生产演练沿用 `server/scripts/rollback-release.sh` 的“停止服务、恢复备份、数据库迁移不回滚”流程；禁止在生产删除审计表。
5. 运行现有 MCP 鉴权、Endpoint、Audit、Agent Access、MCP 管理台审计回归，不降低任何既有断言。

**TDD**

- 策略：必须先 RED/基线分层。
- RED：新增 `TestModelProxyUnavailableDoesNotDisableMCP`，Provider nil 时调用 `/v1/models` 期望 `503 model_configuration_unavailable`，随后调用 `/mcp` 仍得到既有行为；新增 migration rerun 与 baseline rollback smoke 操作；旧代码因 `/v1` 路由、表和兼容 wiring 不存在而失败。
- 基线：现有 MCP/Auth/Agent Access 测试首次通过记录为 characterization；这些测试不能被改名为模型功能测试。
- GREEN：完成 app wiring、migration 验证、Provider 缺失边界和回归后，目标集与现有脚本通过。
- REFACTOR：只清理本轮造成的未使用 wiring/测试夹具，不改无关历史问题；重跑受影响目标测试。

**任务完成门**

- 迁移、Provider 缺失边界和旧 MCP/Agent 回归通过；对应 `AC-5`、`AC-7` 的兼容前置满足。

### TASK-6：执行完整功能验收

**交付结果**

- 在最后一次业务代码/测试修改后，完成差异自审、公开边界验收和新鲜证据记录；所有 P0 `AC-1`、`AC-2`、`AC-3`、`AC-4`、`AC-5`、`AC-7` 必须 `PASS`，否则不得宣布完成或可发布。

**文件与符号**

- 检查：本 Plan 所列全部后端、迁移、前端文件和 `git diff`；不创建额外实施报告文件。
- 证据：命令输出保留在当前会话；最终回复包含命令、运行目录、时间、退出状态和关键输出摘要。

**实施步骤**

1. 先做本地实现差异自审：`git diff --stat`、相关 `git diff`、契约/追踪/TASK 对照，检查范围外修改、过度抽象、凭据泄露、权限绕过、重复重试、状态漂移和测试是否真正观察公开行为。
2. 若自审发现本轮相关问题，按对应 TASK 的 RED/GREEN 修复并重跑受影响测试；任何相关修复都会使旧验收证据失效。
3. 创建仓库外证据目录 `EVIDENCE_DIR="${TMPDIR:-/tmp}/clawee-gateway-model-proxy-<run-id>"`；每条命令记录 Asia/Shanghai 时间、运行目录、退出状态和关键输出，浏览器测试使用 Playwright 的 `testInfo.outputPath(...)` 保存截图/trace，不在仓库新增报告文件。
4. 公开验收使用隔离 PostgreSQL 和现有测试数据机制：后端 API/迁移用 `CLAW_GATEWAY_TEST_DATABASE_URL`；模型上游用 `httptest.Server`；管理台页面用现有 Playwright `server/web/playwright.config.ts` 的 route fixture，管理员/普通账号和 `console:mcp:audit:read` 由 `/api/v1/auth/me` fixture 明确返回。
5. 运行 `cd server/web && pnpm e2e -- e2e/model-proxy-audit.spec.ts` 验证真实浏览器路由、筛选、详情和 403；运行 `cd server && go test ./internal/server -run 'TestModelProxyAdmin|TestModelProxy' -count=1` 验证真实 admin API。若 Playwright 浏览器依赖或 Gateway 无法启动，AC-6 的浏览器证据标记 `BLOCKED`，仍必须保留 API/React 证据并在最终报告披露，不得把单元测试改写为浏览器 PASS。
6. 从真实 HTTP API、真实管理台页面或最高可行公开边界执行下表；单元测试只能作为补充证据，不能替代功能验收。

**TDD**

- 策略：不新增行为代码；执行最后一次目标测试、回归、构建和功能验收。
- GREEN/回归命令：依次执行 `cd server && go test ./internal/mcpgateway ./internal/mcpauth ./internal/server ./internal/store -count=1`、`cd server/web && pnpm test`、`cd server/web && pnpm build`，最后按验收矩阵执行公开边界。

**任务完成门**

- 差异自审通过、P0 AC 全部 PASS、P1 `AC-6` PASS 或明确 BLOCKED 且已向用户披露；发布/回滚状态和遗留风险写入最终回复。若任一 P0 FAIL/BLOCKED，不得声称交付完成。

## 6. 最终功能验收矩阵

证据必须来自本次运行，写明实际运行时间（Asia/Shanghai）、命令/HTTP 操作、运行目录、退出状态和可追溯输出摘要。验收发生在最后一次相关业务代码或测试修改之后。

| AC ID | 优先级 | 场景 | 前置条件 | 操作 | 预期结果 | 验证方式 | 证据 |
|---|---:|---|---|---|---|---|---|
| `AC-1` | P0 | OpenAI 兼容主流程、默认模型、多模态和 SSE | 隔离 Gateway 有 active 双 scope Key；Provider 返回 `https://model.example/v1`；`httptest` 上游可记录请求 | 真实调用 `/v1/models`、`/v1/chat/completions`、`/v1/responses`；分别测试非流式、`stream=true`、图片/data URL/音频/未知字段和无 model | 最终 URL 正确；models 固定结构；缺 model 补默认值；多模态/未知字段保持 JSON；SSE 帧、`[DONE]`/responses 结束事件或 EOF 原样可见 | Go 真实 `httptest` HTTP 链路；必要时用 curl/OpenAI 兼容客户端 | 记录三条请求的状态、上游收到的 path/body/header、客户端响应和审计 ID |
| `AC-2` | P0 | Key、账号状态、scope 和鉴权边界 | 有效、未知、过期、撤销、只有 `mcp:call`、禁用账号 Key；准备 Cookie、Query 和 `X-Claw-Agent-ID` 变体 | 仅带 Bearer 或分别放入 Query/Cookie；带/不带 Agent Header 调用 `/v1/models`；调用旧 `/mcp` | 只有 active 双 scope Key 成功；模型不要求 Agent Header；Query/Cookie 不生效；未知 Key 不入模型审计表；MCP 旧鉴权仍要求 Agent 绑定 | 真实 Gateway HTTP API + PostgreSQL 审计查询 + MCP 回归 | 记录 HTTP 状态/错误码、审计行数和旧 MCP 测试结果 |
| `AC-3` | P0 | 用户生成、固定 scope、用户名、轮换、撤销和并发 | 登录账号分别有非空/空用户名；已有 active Key；有 app/admin rotate 权限 | 在 Agent Access 页面生成/轮换/撤销；直接提交空、非法、自定义 scopes；并发两次 rotate | 空用户名 `username_required`；成功 Key 恰有两个固定 scope；旧 Key 立即失效；只保留一个 active；撤销立即拒绝；明文仅在生成/轮换响应展示 | 真实管理台交互 + app/admin HTTP API + 数据库唯一约束查询 | 记录页面状态、响应 scope/指纹、旧新 Key 结果和数据库 active 数 |
| `AC-4` | P0 | 上游错误、429/5xx、超时、非法响应、SSE 断开和不重试 | 可控上游可按请求返回各类结果；客户端可中断连接 | 逐项调用代理，检查上游请求计数；中途关闭流式客户端；测试合法 OpenAI error 和不支持 endpoint | 不重试；合法错误状态/body 透传；非解析错误稳定包装；断开停止写客户端并终态 `client_disconnected`；上游失败终态 `failed` | 真实 Gateway API + 可控 `httptest` 上游 + 审计查询 | 记录上游计数、HTTP 状态、响应 JSON/SSE、audit status 和 finalize 日志 |
| `AC-5` | P0 | 审计一对一、拒绝终态、脱敏、用量、fail-closed 和幂等 | 隔离 PostgreSQL 完成 migration；准备普通、流式、多模态、scope 拒绝、禁用账号、无配置、上游失败、审计 Store 失败 | 发起上述请求并查询 `model_proxy_audit_records`；重复 finalize；检查结构化日志和快照 | 每个已识别请求一条记录；未知 Key 不入表；状态符合状态机；敏感字段不出现；媒体只有元数据；审计插入失败不上游；终态更新条件幂等；usage 缺失不伪造 0 | 真实 HTTP 链路 + 隔离 PostgreSQL + 结构化日志采集 | 记录 SQL 查询结果、快照字段、status/duration/usage、上游计数和错误日志 |
| `AC-6` | P1 | 管理台列表、详情、summary、过滤、分页和权限 | 管理员有 `console:mcp:audit:read`；普通账号无；已写入多用户/模型/状态审计数据；浏览器运行使用现有 Playwright route fixture | 先调用三条 admin API，测试空结果、cursor、用户/模型分组、时间/status/error 过滤和详情 400/404；再运行 `cd server/web && pnpm e2e -- e2e/model-proxy-audit.spec.ts` 打开 `/admin/model-proxy/audits` 筛选并查看详情 | 返回规定分页/summary 结构；详情脱敏；管理员可读；无权限 `403 forbidden`；页面字段与 API 一致；浏览器依赖不可用时只将浏览器子证据标 `BLOCKED` | 真实 Go API + 真实 Playwright 浏览器；API 是最低必须证据，React 页面测试为补充 | `EVIDENCE_DIR` 中记录 API status/body、筛选结果、权限响应；Playwright `testInfo.outputPath` 记录截图/trace；缺浏览器只记录 `BLOCKED` 原因 |
| `AC-7` | P0 | 旧 MCP 兼容回归 | 现有 MCP Token、Agent Header、MCP fixtures 和管理台权限数据 | 运行 MCP Auth、Endpoint、Audit、Agent Access 和 MCP 审计页面回归；验证模型路由开关关闭时旧入口可用 | MCP Agent 绑定、scope、审计、错误和旧页面行为不变；模型功能不可用不阻断登录/MCP | Go 全量相关回归 + 前端既有测试 + 真实 `/mcp` 健康请求 | 记录命令退出状态和关键回归摘要 |

## 7. 失败熔断与偏差规则

- 预期中的 RED 不计失败；进入 GREEN 后，每次修复前记录失败测试、根因假设和最小改动。
- 同一根因经过两次有实质差异的修复仍失败，立即停止当前 TASK，标记 `BLOCKED`，说明属于实现、测试夹具、环境还是契约问题；不得继续盲试、放宽断言或静默改设计。
- 发现 `FR`、`BR`、`NFR`、`DEC`、API 路径、数据字段、权限边界、迁移回滚语义或 AC 改变时，停止执行并先更新方案与 Plan。
- 只改变文件位置、局部命名或实现细节时，在最终回复记录偏差及其不改变契约的理由；不顺手修复无关历史问题。
- 生产迁移失败时停止发布，修复代码/迁移或恢复代码；不运行 Down 删除审计数据。

## 8. 最终报告格式

最终回复必须包含：

1. 实施结果、未完成项和是否可发布。
2. Plan 偏差及是否改变契约；本地实现差异自审结论和修复项。
3. RED、GREEN、回归、构建命令及退出状态。
4. `AC-1` 至 `AC-7` 的 `PASS | FAIL | BLOCKED`、实际结果和本次运行证据。
5. 迁移启用、代码回滚和数据保留状态。
6. 遗留风险：上游 OpenAI 兼容程度、审计快照敏感内容风险、长期增长/保留周期和流式 usage 缺失只能按已定义语义记录。

## 9. Plan 审核记录

第一版 Plan 提交一次独立 `zhiyu-reviewer` 审核；Reviewer 只读本 Plan、已批准方案、当前代码证据和本轮具体任务范围，不修改代码、不运行 `codex` CLI、不扩展为全库质量审查。

审核包：

- 方案：`docs/specs/clawee-gateway-模型中转-方案-2026-10-31.md`，方案流程结论 `PASS`，Reviewer 原始结论 `REVISE`，R-01 至 R-05 已关闭，用户批准日期为 2026-10-31。
- Plan：`docs/plans/clawee-gateway-模型中转-实施计划-2026-10-31.md`。
- 项目根目录：`/Users/example/develop/clawee/Clawee`；规则文件：当前用户提供的根 `AGENTS.md` 内容。
- 审核范围：`TASK-0` 至 `TASK-6`；`FR-1` 至 `FR-6`、`BR-1` 至 `BR-5`、`NFR-1` 至 `NFR-3`、`DEC-1` 至 `DEC-5`、`AC-1` 至 `AC-7`；路径/符号包括 `server/internal/server/http.go:Options/NewRouter`、`agent_http.go` Token handlers、`mcp_admin_http.go:validateAdminAccountTokenTarget`、`mcpgateway/service.go` Token lifecycle、`mcpgateway/store.go`、`store/mcp_gateway_store.go`、`app/app.go:New`、`clawadmin/client.go:EnsureModelConfiguration`、`rbac/catalog.go:PermissionMCPAuditRead`、前端 Agent Access/MCP Audit 路由和页面，以及 `00081_model_proxy_audit.sql`。
- 审核重点：方案一致性、任务依赖、固定 scope/用户名约束、模型与 MCP 鉴权边界、审计状态机/幂等/fail-closed、SSE/多模态协议、迁移回滚、TDD RED/GREEN、公开边界验收证据和最小方案范围。
- 明确排除：方案外的计费/配额/供应商路由/数仓/对象存储；未改变的客户端 daemon、Electron、MCP 上游业务实现和与本轮一致性无关的历史问题。

| 问题 ID | 严重程度 | 处理决定 | 修改位置 | 关闭证据或不采纳理由 | 遗留风险 |
|---|---|---|---|---|---|
| `R-01` | Major | 采纳并关闭 | `TASK-1` 两阶段鉴权步骤/TDD；`TASK-3` 文件说明、步骤 2、TDD；`AC-2`、`AC-5` | `resolveModelBearer` 只解析并保留已知 Token 快照；已知 Key 先创建唯一 `started` 审计，再由 `evaluateModelPolicy` 映射 `rejected_scope`/`rejected_account`/`rejected_configuration`。新增 RED 覆盖 revoked、expired、缺 scope、disabled account、上游零调用和一条审计记录。 | 终态更新失败仍只能依靠结构化 `model_audit_finalize_failed` 暴露。 |
| `R-02` | Major | 采纳并关闭 | `TASK-3` TDD；`TASK-4` TDD；`AC-1`、`AC-2`、`AC-4`、`AC-5`、`AC-6` | RED 明确覆盖 models 固定响应、responses/direct EOF、缺失/错误/Query/Cookie Bearer、拒绝终态、合法 error/429/5xx/连接/超时/非法响应、断开/不重试、管理台 400/404/过滤/空结果和 Playwright 页面；完成门引用对应公开结果。 | 流式 usage 仍可能不可用，按 `usage_available=false` 记录。 |
| `R-03` | Major | 采纳并关闭 | `TASK-4` 文件/步骤/TDD；`TASK-5` 步骤/TDD；`TASK-6` 验收协议与 `AC-6` 行 | 明确 `EVIDENCE_DIR`、隔离 DB、`httptest` 上游、Playwright 命令与 route fixture、API 最低证据、浏览器不可用时 `BLOCKED` 规则；回滚固定基线 SHA `2a0a8fbb...`，并引用 `server/scripts/rollback-release.sh` 的不回滚迁移流程和审计表保留验证。 | 浏览器依赖或真实 Gateway 启动条件不足时，AC-6 浏览器子证据必须披露为 `BLOCKED`，不能伪造 PASS。 |
