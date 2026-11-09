# Clawee Gateway 模型中转方案

> 状态：草案
> 体量判断：复杂。方案同时涉及外部兼容接口、API Key 身份、数据库迁移、模型上游、流式请求、审计分析和管理台权限；这些契约共享同一条请求链路，拆分后无法独立确定身份和日志边界，因此保持为一份内聚方案。
> 设计确认：已完成（D-1 至 D-3）
> Reviewer 原始结论：REVISE（已按审核意见关闭全部 Major/Minor）
> 流程结论：PASS
> 用户批准：已批准（2026-10-31）

## 背景、目标与非目标

Clawee Gateway 已有账号登录、账号级 Token、MCP Gateway 和管理台能力，但当前外部调用主要围绕 MCP 和 Clawee Agent 上下文。模型配置接口只向可信的 Clawee Agent 返回模型服务配置，没有面向 Codex CLI、Kimi Code 或其他 OpenAI 兼容客户端的统一模型转发入口。

本方案的目标是让一个已有 Gateway 账号可以生成 API Key，并把 Gateway 的 `base_url` 和 API Key 配置到任意支持 OpenAI 兼容协议的 Agent 中，由 Gateway 识别用户、取得该用户的模型配置、转发多模态请求并保存可分析的请求/响应审计记录。

第一版只解决标准 OpenAI 兼容接入、账号级身份、一次调用一条日志和最小管理分析。模型目录编排、复杂计费、按 Key 配额、消息队列、数仓、音视频对象存储和多 Key 并行管理属于后续范围。

## 用户需求原文

用户本轮明确提出：

1. “实现Agent(不管是Clawee Agent,还是codex cli,或者是Kimi code等)都能够接入clawee gateway,只要把gateway的api_key和base_url提供给使用者,使用者就可以接入gateway,然后开始使用,需要提供多模态的模型,简单说就是实现中转站的逻辑.”
2. “日志采集,日志分析非常重要,需要能够分析出来每一个用户的请求和响应日志,做数据分析使用,所以要设计好存储.”
3. “用户的唯一标识就是api_key,所以需要有一个生成api_key的地方,而且必须要求api_key对应的有用户名.”
4. “现在Clawee gateway已经有用户登录的能力,所以需要有一个生成api_key的能力.”
5. “参考:open-creator-gateway已经实现了接入各种模态的方法,可以看下是否有参考价值. sub2api的api_key生成和管理可以参考下.”
6. “要求:实现要用最小方案,不要过度设计”.

## 事实基线与假设

| 证据 | 已确认事实 | 对本方案的影响 |
|---|---|---|
| `server/internal/server/http.go` 的 `NewRouter`、`Options` | Gateway 使用 Gin，在 `/api/v1` 下区分 `/auth`、`/app` 和 `/admin`；MCP 端点独立挂在 `/mcp`。 | 模型中转入口使用独立的 `/v1` 根路径，不混入登录会话 API。 |
| `server/internal/accounts/types.go`、`server/internal/accounts/service.go` | 账号已有 `UserID`、`Name`、状态和会话；账号 Token 通过哈希校验并可按账号轮换。 | API Key 的最终身份使用现有 `user_id`，用户名取账号 `Name`，不再增加第二套用户体系。 |
| `server/internal/mcpgateway/types.go`、`service.go`、`store.go` | 已有 `AccountToken`、Token 哈希、加密密文、指纹、状态、过期时间、用途 scopes、最近使用时间，以及每账号一个 active Token 的数据库约束。 | 第一版复用现有账号级 Token 管理和存储能力；新增模型用途 scope 和独立模型鉴权路径。 |
| `server/internal/server/agent_http.go`、`server/web/src/pages/agent-access.tsx`、`server/web/src/lib/agent-api.ts` | 已有登录后 Agent Access 页面和 `/api/v1/app/mcp/token` 的查询、揭示、轮换、撤销接口。 | API Key 管理沿用现有页面和接口能力，页面文案补充 Gateway API Key 与 `base_url`。 |
| `server/internal/mcpauth/auth.go` | 当前 MCP 账号 Token 验证要求 active Token、账号 active、`X-Claw-Agent-ID` 和 Agent 所属关系。 | 不修改 MCP 鉴权；模型接口使用不要求 Agent Header 的独立验证器。 |
| `server/internal/server/http_middleware.go` | 全局已有 `X-Request-ID`、请求耗时 access log 和错误日志。 | 模型审计记录复用同一 `request_id`，但数据库审计记录作为模型日志权威来源。 |
| `server/db/migrations/00002_mcp_gateway_proxy.sql`、`00047_mcp_account_authorization.sql` | 已有 MCP 代理审计表和账号 Token 表，但字段围绕 MCP 工具调用设计。 | 不复用 MCP 审计表承载模型调用；新增模型中转审计表。 |
| `server/internal/server/model_configuration_http.go`、`server/internal/clawadmin/client.go` | 已有 `ModelConfigurationProvider`，按账号返回上游 `base_url`、上游凭据、默认模型和凭据版本。 | 第一版使用现有 Provider 作为上游配置来源，不新增模型供应商管理页面。 |
| `server/web/src/pages/mcp-proxy-audit.tsx`、`server/web/src/lib/mcp-admin-api.ts`、`server/internal/rbac/catalog.go` | 管理台已有审计列表、筛选和 `console:mcp:audit:read` 权限。 | 模型中转日志沿用管理台审计交互和读取权限。 |
| 当前工作区搜索 | 未发现 `open-creator-gateway` 源码；`sub2api` 在仓库中作为模型管理/用量集成存在，但不是 Gateway 的 OpenAI 兼容转发实现。 | 外部项目只作为设计参考，不把其内部接口或完整路由体系作为 Clawee 契约。 |

假设上游模型服务提供 OpenAI 兼容的 `/chat/completions` 和 `/responses`，并能接收标准 JSON 多模态内容。Gateway 只负责身份、配置、转发和审计；上游是否支持某个具体模型或模态由上游返回结果决定。

## 设计确认记录

| 设计部分 | 核心决定 | 用户确认原话 |
|---|---|---|
| D-1 外部接入、身份与模型转发 | 采用 `/v1` OpenAI 兼容入口；仅使用 Bearer API Key 识别账号；复用账号级 Token 管理；支持 `models`、`chat/completions`、`responses` 和 SSE；多模态 JSON 透明转发。 | “没问题,继续” |
| D-2 请求、响应与分析日志 | 新增模型中转专用审计表；每次调用一条记录；保存脱敏 JSON 快照；二进制只保存媒体元数据；按用户、模型、状态和时间查询分析。 | “没问题,继续” |
| D-3 Key 管理、兼容边界与验收 | 沿用 Agent Access 管理入口和现有权限；轮换/撤销立即生效；不接受 URL Key；错误采用 OpenAI 兼容结构；第一版不做多 Key、配额、数仓和复杂编排。 | “没问题,继续” |

## 需求与业务规则

| ID | 类型 | 优先级 | 描述 | 验收 |
|---|---|---:|---|---|
| FR-1 | 功能需求 | P0 | Gateway 提供 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`，支持非流式和 SSE 流式响应。 | AC-1 |
| FR-2 | 功能需求 | P0 | 外部请求使用 `Authorization: Bearer <api_key>`，API Key 唯一映射到一个 active 账号；模型接口不要求登录 Cookie 或 `X-Claw-Agent-ID`。 | AC-2 |
| FR-3 | 功能需求 | P0 | 已登录用户可以生成、查询元数据、轮换和撤销 API Key；生成 API Key 前必须存在非空用户名。 | AC-3 |
| FR-4 | 功能需求 | P0 | Gateway 使用账号对应的 `ModelConfigurationProvider` 获取上游配置；请求模型为空时使用账号默认模型，请求模型非空时按 OpenAI 兼容协议转发。 | AC-1、AC-4 |
| FR-5 | 功能需求 | P0 | 每个已鉴权模型请求都生成一条持久化审计记录，能关联用户、Key、请求、响应、状态、耗时和 Token 用量。 | AC-5 |
| FR-6 | 功能需求 | P1 | 管理台能按用户名、时间、模型和状态查询明细，并查看单次请求/响应和按用户/模型聚合的数据。 | AC-6 |
| BR-1 | 业务规则 | P0 | 账号必须 active；账号无用户名时不能生成或启用模型 API Key。 | AC-2、AC-3 |
| BR-2 | 业务规则 | P0 | 每个账号最多一个 active Key；轮换使旧 Key 立即失效，撤销后不能继续调用。 | AC-3 |
| BR-3 | 业务规则 | P0 | MCP 原有 Token 验证和 `X-Claw-Agent-ID` 约束保持不变；模型鉴权不绕过 MCP 授权链路。 | AC-2、AC-7 |
| BR-4 | 业务规则 | P0 | 日志不保存明文 API Key、Authorization、Cookie 或上游凭据；图片、音频等二进制只保存类型、大小和哈希。 | AC-5 |
| BR-5 | 业务规则 | P0 | Gateway 不自动重试模型请求，避免重复计费和重复生成；上游错误和客户端断开都必须记录终态。 | AC-4、AC-5 |
| NFR-1 | 安全约束 | P0 | Key 仅通过 Bearer Header 接收，不接受 Query 参数或 Cookie；日志和错误响应不能回显上游凭据。 | AC-2、AC-5 |
| NFR-2 | 可观测性约束 | P0 | 日志使用现有 `X-Request-ID`，并保存 Gateway 状态、上游状态、耗时和错误码。 | AC-5 |
| NFR-3 | 兼容约束 | P1 | 保持 OpenAI 兼容 JSON 错误结构、SSE 流式格式和客户端未识别字段的透明转发。 | AC-1、AC-4 |

## 方案比较与推荐

| 方案 | 做法 | 优点 | 代价与风险 | 结论 |
|---|---|---|---|---|
| A：OpenAI 兼容薄中转 | `/v1` 接口只做 API Key 鉴权、账号配置解析、请求转发和审计；复用现有账号 Token 和模型配置 Provider。 | 改动面最小；Codex CLI、Kimi Code、Clawee Agent 可共用一套接入方式；多模态由标准 JSON 透明传递。 | 复杂模型路由和统一计费暂不在 Gateway 内完成；依赖上游兼容协议。 | **推荐** |
| B：Gateway 内建多供应商路由 | 新增供应商、模型目录、路由规则、计费和配额层，再由 Gateway 选择上游。 | 统一治理能力更强。 | 新增配置、状态、失败和数据模型，超出当前“最小方案”；会把现有 Provider 逻辑重复一遍。 | 不采用 |
| C：仅复用 MCP 端点 | 让外部 Agent 通过 MCP Token 调用已有 `/mcp`。 | 几乎不增加新转发逻辑。 | 不满足 OpenAI 兼容 Agent 的 `base_url + api_key` 需求，也不能自然承载模型请求和响应日志。 | 不采用 |

## 关键设计决策

| DEC ID | 决策 | 理由 | 约束范围 |
|---|---|---|---|
| DEC-1 | 外部协议固定为 `/v1/models`、`/v1/chat/completions`、`/v1/responses`；仅接受 Bearer API Key。 | 覆盖目标 Agent 的共同 OpenAI 兼容入口，避免为每个 Agent 做适配器。 | Gateway HTTP 路由、鉴权中间件、客户端配置文案。 |
| DEC-2 | 复用 `mcp_account_tokens` 的账号归属、哈希、密文、指纹、轮换和撤销能力；所有面向用户的模型 Key 生成和轮换都由服务端强制签发固定 scopes `mcp:call` 与 `model:call`，调用方不能自选、删除或增加 scope。 | 避免重复建设第二套 Key 生命周期，同时保证任意生成入口都能获得模型能力，并拒绝通过客户端参数绕过用途约束。 | Token 服务、Token 管理接口、模型验证器、数据库兼容。 |
| DEC-3 | 模型鉴权使用独立验证路径：按 Key Hash 查账号、检查 active/过期/`model:call`/账号状态，然后写入最近使用时间；不检查 Agent Header。 | 满足外部 Agent 接入，同时保留 MCP 的 Agent 绑定安全边界。 | `/v1/*` 全部模型路由；不得直接复用当前 `mcpauth.verifyAccountToken` 的 Agent 校验。 |
| DEC-4 | 上游配置来自现有 `ModelConfigurationProvider`；无模型时注入账号默认模型，有模型时原样传递；`/v1/models` 返回当前账号默认模型。 | 第一版不增加供应商管理和模型编排；保留后续扩展多个模型的接口形状。 | 上游请求构造、模型列表、错误映射。 |
| DEC-5 | 新增模型中转审计表；能识别到账号的模型请求在策略判定前创建一条记录，入口写开始或拒绝状态，结束时只允许一次终态更新；未知/格式错误 Key 没有可关联用户时不写该表，只进入现有结构化访问日志。 | 直接支持按用户和调用分析，同时定义认证失败边界、记录唯一性和流式终态。 | 数据库迁移、代理生命周期、管理台日志接口和分析查询。 |

## 详细设计

### 外部模型接口

Gateway 在根路由挂载 `/v1`，不经过 `/api/v1` 的登录 Cookie 中间件。所有接口先执行模型 API Key 验证，再把认证结果放入请求上下文：`user_id`、用户名、Key ID、Key 指纹和 scopes。

`GET /v1/models` 从账号模型配置中读取默认模型，返回 OpenAI 风格的模型列表。返回内容只包含模型标识、对象类型、创建时间和所有者等非敏感元数据，不返回上游 `base_url` 或上游 API Key。

`POST /v1/chat/completions` 和 `POST /v1/responses` 读取 JSON 请求，要求上游配置可用。请求缺少 `model` 时补入 Provider 返回的默认模型；请求已有 `model` 时保持其值。其余字段，包括文本、图片、音频等标准 content part，按 JSON 原样传给上游。Gateway 不把图片、音频转存为本地文件，也不在网关内解析模型模态。

Provider 的 `BaseURL` 被定义为上游 OpenAI 兼容 API 根地址，包含上游所需的版本前缀；Gateway 只去掉末尾斜杠并追加 `models`、`chat/completions` 或 `responses`，不会自行插入或删除 `/v1`。例如 `https://model.example/v1` 依次得到 `https://model.example/v1/models`、`https://model.example/v1/chat/completions` 和 `https://model.example/v1/responses`。Gateway 使用 Provider 的 API Key 调用上游，禁止把该凭据传入客户端响应或审计快照。

`/v1/models` 的成功响应固定为 `{ "object": "list", "data": [{ "id": "<configured-model>", "object": "model", "created": 0, "owned_by": "clawee" }] }`；第一版不向上游拉取模型列表。两个代理 endpoint 转发客户端的 `Content-Type`、请求 JSON 和必要的 `Accept`，覆盖上游 `Authorization`，不转发客户端 Cookie。上游返回合法 OpenAI `error` JSON 时保留其非敏感字段和 HTTP 状态；返回不可解析错误时包装为稳定网关错误码。

对于 `stream=true`，Gateway 保持上游 `Content-Type`、SSE 数据格式和结束标记，同时使用受限的 tee 采集器记录响应快照、已发送字节数、chunk 数和最终状态。客户端连接断开时停止向客户端写入并把审计记录标记为 `client_disconnected`；上游错误或响应格式异常标记为对应错误终态。

SSE 按字节转发，不改写事件名或数据字段；`chat/completions` 的 `[DONE]` 和 `responses` 的正常结束事件原样传递，Gateway 也接受上游直接 EOF 作为连接结束。可识别的 `usage` 字段写入 Token 用量，无法从流中取得时将 `usage_available` 设为 false，不把缺失值伪造为零。`image_url`、data URL、`input_image`、音频字段和未知 JSON 字段只做脱敏采集，不由 Gateway 下载、转换或重写。

Gateway 不自动重试请求。上游返回的非成功响应按统一错误包装返回；无法建立连接、超时或响应无法解析时返回网关错误，并保留原始上游状态和脱敏错误摘要到审计记录。

### API Key 生命周期

现有 Agent Access 页面继续作为用户生成凭据的入口，页面显示：Gateway `base_url`、Key 指纹、用户名、状态、最近使用时间以及生成/轮换/撤销操作。页面不在普通查询中显示明文 Key；生成和轮换成功响应中返回明文，供用户复制到 Agent 配置中。

模型 Key 的服务端权威入口仍使用现有 app/admin Token rotate 路由以保持客户端和权限兼容，但这些路由在服务层统一执行以下规则：目标账号必须 active 且 `Name` 非空；请求体中的 `scopes` 字段被忽略并记录为兼容字段，服务端固定生成 `mcp:call` 与 `model:call`，任何其他 scope 不被写入；缺少用户名返回 `username_required`。生成、轮换和管理员代办入口都调用同一服务规则，页面检查不是安全边界。账号被禁用、Key 过期或被撤销时，模型接口均拒绝请求。

自动创建的旧 MCP Token 仍可保持只有 `mcp:call`，不自动获得模型调用能力；旧 active Token 如果没有 `model:call`，继续按原规则用于 MCP，但不能调用 `/v1/*`，用户通过一次轮换获得固定双 scope。现有 MCP 显式 reveal 能力保留，以避免破坏既有客户端和管理台行为；模型 API Key 的普通查询仍只返回元数据。

Key 轮换使用现有每账号 active 唯一约束。成功写入新 Key 后旧 Key 进入 revoked，两个请求并发轮换时以数据库唯一约束和服务层错误映射保证只有一个 active Key。撤销操作不删除历史审计记录，历史记录只保留 Key ID 和指纹。

### 模型中转审计数据

新增 `model_proxy_audit_records` 表，每行代表一次能关联到账号或账号 Key 的模型接口请求。未知或格式错误的 Bearer Key 没有可安全关联的用户，因此只进入现有结构化访问日志，不写入该表。建议字段如下：

| 字段组 | 字段 |
|---|---|
| 身份关联 | `audit_id`、`request_id`、`user_id`、`user_name_snapshot`、`api_key_id`、`api_key_fingerprint` |
| 调用定位 | `endpoint`、HTTP method、`model`、`created_at`、`completed_at`、`duration_ms` |
| 结果状态 | `status`、Gateway status、upstream status、`error_code`、脱敏错误摘要 |
| 用量 | `input_tokens`、`output_tokens`、`total_tokens`、`usage_available` |
| 快照 | `request_body`、`response_body`、请求/响应头的脱敏 JSON、`request_bytes`、`response_bytes`、`truncated` |

审计状态只允许沿以下方向变化：

| 当前状态 | 允许的终态 | 说明 |
|---|---|---|
| `started` | `succeeded`、`failed`、`client_disconnected` | 已通过 Key Hash 关联并准备调用上游。 |
| `rejected_scope`、`rejected_account`、`rejected_configuration` | 同名状态保持终态 | 已识别 Key/账号但策略、账号或配置不允许调用。 |
| 任意终态 | 无 | 终态更新使用 `WHERE status` 仍为非终态，重复 finalize 不改变记录。 |

`audit_id` 是主键，`request_id` 只做索引和链路关联，不要求客户端提供且不设唯一约束；一个 Gateway 请求只创建一条 audit row。认证流程先解析 Bearer 并按 Hash 查 Key：查到 Key 后立即创建记录，再执行 scope、账号和配置判定；查不到 Key 或 Bearer 格式错误则不创建模型审计记录。审计插入失败时 Gateway 不调用上游并返回 `503 model_audit_unavailable`，保证被接受的模型请求都有起始记录；终态更新失败时保留原请求结果，并以 `audit_id/request_id` 写入结构化应用日志 `model_audit_finalize_failed`，不重试模型请求。

写入流程为：

1. 解析 Bearer 并按 Hash 查到 Key 后创建 `started` 记录；如果 scope、账号状态或配置检查失败，则把记录直接置为 `rejected_scope`、`rejected_account` 或 `rejected_configuration`。
2. 读取请求体并完成脱敏快照；若请求体超出采集上限，保存结构化字段和截断标志后继续转发或按请求体限制返回错误。
3. 上游返回或连接失败后更新响应状态、用量、耗时、响应快照和完成时间。
4. 流式转发结束、上游异常或客户端断开都必须完成更新；终态更新按状态条件幂等执行，更新失败按前述结构化日志降级，不能用重试模型请求来补写。

脱敏规则至少覆盖 `Authorization`、`Cookie`、`Set-Cookie`、上游 API Key 和常见 secret 字段。多模态 JSON 中的 base64、data URL 或大块二进制字段替换为包含媒体类型、字节数和 SHA-256 的元数据对象；文本、模型名、请求参数和可分析的响应 JSON 保留。快照超过上限时保留前缀和截断标志，不影响状态、耗时和 Token 统计。

数据库索引至少包括 `(user_id, created_at DESC)`、`(model, created_at DESC)`、`(status, created_at DESC)` 和 `request_id` 普通索引。第一版分析直接基于 PostgreSQL 聚合，不建日报表；聚合接口返回请求数、成功率、Token 汇总、平均耗时和错误分布。

### 管理台接口与权限

管理台新增以下模型中转日志接口，沿用现有 `/api/v1/admin`、统一响应包装和 `console:mcp:audit:read` 读取权限；复用的是授权标识，不复用 MCP 审计表或 MCP 审计字段：

- `GET /api/v1/admin/model-proxy/audits`：支持 `limit`（1-100）、`cursor`、`user_id`、`model`、`endpoint`、`status`、`error_only`、`created_from`、`created_to`；按 `created_at DESC, audit_id DESC` 排序，返回 `{items, next_cursor}`。
- `GET /api/v1/admin/model-proxy/audits/detail?audit_id=...`：返回指定记录的身份快照、调用定位、状态、用量和已脱敏请求/响应快照，不返回任何明文凭据。
- `GET /api/v1/admin/model-proxy/audits/summary`：支持时间范围和 `group_by=user|model`，返回请求数、成功数、失败数、成功率、Token 汇总、平均耗时和错误分布。

列表、详情和聚合都直接查询 `model_proxy_audit_records`。管理员拥有该权限时可查询空结果和分页结果；普通账号没有该权限时返回统一 `403 forbidden`。管理台新增独立模型中转日志页面，沿用 MCP 审计页面的表格、筛选和详情交互，但使用模型审计专用字段。

API Key 的用户自助管理沿用 `/api/v1/app/mcp/token` 现有接口和 `AgentAccessPage`，仅补充 `model:call` 能力状态、Gateway `base_url` 和文案。管理员已有 Token reveal/rotate/revoke 路由和权限，继续作为运维兜底，不新增第二套管理员 Key 管理路径。

### 错误、兼容与失败语义

| 场景 | HTTP | 稳定错误码 | 处理 |
|---|---:|---|---|
| 缺少/格式错误 Bearer Key | 401 | `invalid_api_key` | 不调用上游；没有可关联用户时不写模型审计表，只写现有结构化访问日志。 |
| Key 不存在、过期或撤销 | 401 | `invalid_api_key` | 已查到 Key 时写入 `rejected_scope` 或对应拒绝终态；完全未知 Key 只写访问日志。 |
| 账号禁用 | 403 | `account_disabled` | 不调用上游，已识别账号时写入 `rejected_account`。 |
| 账号无模型配置 | 503 | `model_configuration_unavailable` | 不调用上游，已识别账号时写入 `rejected_configuration`。 |
| 审计记录无法创建 | 503 | `model_audit_unavailable` | 不调用上游，保证进入模型链路的请求都有审计起点。 |
| endpoint 不支持 | 404 | `unsupported_endpoint` | 保持 OpenAI 风格错误 JSON。 |
| 上游限流 | 429 | `upstream_rate_limited` | 不重试，保留上游状态。 |
| 上游连接/超时/5xx | 502/503 | `upstream_error` | 保留脱敏错误摘要和上游状态。 |
| 客户端流式连接断开 | 请求已开始 | `client_disconnected` | 停止向客户端写入并完成审计终态。 |

客户端传来的未知 JSON 字段原样透传；Gateway 只补默认 `model`、覆盖上游认证 Header 和必要的请求头。Gateway 不接受 Query 参数 API Key，不把请求体中的客户端凭据转发到审计快照。

## 异常、兼容、迁移与回滚

### 迁移

数据库新增一条稳定命名的 Goose migration，创建 `model_proxy_audit_records` 和必要索引。现有 `mcp_account_tokens` 不删除、不重命名、不改写历史 scopes；模型能力通过新签发/轮换 Token 的 `model:call` scope 开启。迁移不读取或导出明文 Token。生产迁移只向前执行；迁移失败时停止发布并修复或恢复代码，不通过 Down migration 删除审计数据。

如果模型中转功能未启用或 `ModelConfigurationProvider` 未配置，`/v1/*` 返回服务不可用，登录、MCP 和现有工作台继续工作。Key 管理接口仍按现有服务依赖返回明确的服务不可用错误，不创建无法使用的 Key。

### 回滚

代码回滚前先关闭模型中转路由；已有 API Key 和审计数据不影响登录和 MCP。代码回滚保留 `model_proxy_audit_records` 及其数据，旧版本忽略未知表即可继续运行。只有确认数据已按部署策略备份、且没有任何版本依赖该表时，才允许在隔离环境手工执行删除；生产回滚不删除审计表或现有账号 Token 表，避免丢失调用日志和历史 MCP 凭据。第一版不提供自动数据归档，保留周期由部署运维策略管理。

### 兼容风险

现有账号 Token 可能只有 `mcp:call`，不会自动成为模型 API Key；用户需要轮换一次。现有显式 reveal 接口保留，因此“明文只在生成/轮换响应中出现一次”只能作为新模型页面的交互约束，不能改变既有 MCP reveal 兼容行为。该风险需要在页面文案和安全说明中明确。

## 验收标准

| AC ID | 关联需求 | 前置条件 | 操作 | 可观察结果 | 验证层级 |
|---|---|---|---|---|---|
| AC-1 | FR-1、FR-4、NFR-3 | 账号有 active `model:call` Key，Provider 返回 `https://model.example/v1` 和可用上游。 | 调用 `/v1/models`、`/v1/chat/completions`、`/v1/responses`，分别测试非流式、SSE 和含图片、data URL、未知字段的 JSON。 | 上游最终 URL 分别为 `/v1/models`、`/v1/chat/completions`、`/v1/responses`；models 响应符合固定结构；默认模型正确补入；多模态字段和 SSE 帧按原结构转发，`[DONE]`/正常结束事件可观察。 | Go HTTP 集成测试。 |
| AC-2 | FR-2、BR-1、BR-3、NFR-1 | 准备有效、无效、过期、撤销和无 `model:call` scope 的 Key。 | 仅携带 Bearer Header 调用 `/v1/*`，分别省略 Header、携带错误 Header、携带 `X-Claw-Agent-ID` 或 Cookie。 | 只有有效模型 Key 能通过；不要求 Agent Header；URL/Cookie 鉴权不生效；MCP 原有 Agent 绑定测试保持通过；未知 Key 不写模型审计表。 | Go 鉴权单测和路由测试。 |
| AC-3 | FR-3、BR-1、BR-2 | 已登录用户分别拥有和缺少用户名，且现有 rotate 请求分别提交缺省、非法和自定义 scopes。 | 在 Agent Access 页面生成、轮换、撤销 Key，并并发执行两次轮换；通过服务/API 直接提交 scopes。 | 无用户名返回 `username_required`；所有成功生成的 Key 恰有固定 `mcp:call` 与 `model:call`；非法 scope 不被写入；成功生成返回明文和指纹；轮换旧 Key 立即失效且只保留一个 active；撤销立即拒绝调用。 | Go 服务/HTTP 测试与 React 页面测试。 |
| AC-4 | BR-5、NFR-3 | 上游可控返回 200、合法 OpenAI error、429、5xx、超时、非法响应和不支持 `responses`。 | 调用模型接口并测试客户端中途断开流、SSE `[DONE]`、responses 正常结束事件和直接 EOF。 | Gateway 不重试；最终 URL、请求头、错误状态/JSON、SSE 帧和结束语义符合协议契约；上游/客户端失败均完成审计终态。 | Go 代理集成测试。 |
| AC-5 | FR-5、BR-4、NFR-2 | 开启数据库审计，发送缺少 scope、账号禁用、无模型配置、普通、流式、多模态、上游失败、审计插入失败和客户端断开请求。 | 查询 `model_proxy_audit_records` 并检查结构化日志。 | 可关联 Key 的请求各有一条记录，分别处于拒绝或业务终态；未知 Key 仅有访问日志；审计插入失败时不上游；终态更新使用条件幂等；状态、耗时、Token 和上下游状态正确；敏感凭据不出现，二进制按元数据或截断记录。 | PostgreSQL migration/store/HTTP 集成测试。 |
| AC-6 | FR-6 | 管理员拥有 `console:mcp:audit:read`，普通账号没有该权限。 | 调用 `/api/v1/admin/model-proxy/audits`、`/detail`、`/summary`，测试空结果、cursor 分页、用户/模型分组和无权限访问；使用管理台日志页面筛选。 | 管理员能从 `model_proxy_audit_records` 查询明细、脱敏详情和聚合；返回 `{items,next_cursor}` 及规定统计字段；普通账号返回 `403 forbidden`。 | Go 管理台 API 测试与 React 页面测试。 |
| AC-7 | BR-3 | 已有 MCP Token、MCP Agent Header 和既有 MCP 测试数据。 | 运行现有 MCP Endpoint、MCP Auth、MCP Audit 相关测试。 | MCP 的 Agent 绑定、scope、审计和错误行为没有被模型 API Key 路径改变。 | 现有 Go 回归测试。 |

## 测试策略

测试重点放在身份边界、流式生命周期、上游失败和日志完整性，不为实现细节编写镜像测试。

- **鉴权层**：使用内存 Store 覆盖 Key Hash、状态、过期、固定 scopes、账号状态和最近使用时间；验证模型验证器不读取 Agent Header，MCP 验证器仍读取并校验 Agent Header；验证所有生成入口都强制用户名和固定 scopes。
- **代理层**：使用 `httptest` OpenAI 兼容上游，检查三个最终 URL、认证 Header、固定 models 响应、默认 model、未知字段、多模态 JSON、SSE 帧/结束、合法错误透传和不重试语义。
- **审计层**：优先使用隔离 PostgreSQL 测试数据库，验证 migration、已识别请求一对一记录、拒绝/业务终态、条件幂等更新、未知 Key 边界、插入失败 fail-closed、索引查询、脱敏和聚合。客户端断开通过可控 ResponseWriter/连接模拟验证。
- **管理台**：复用现有 API mock 和页面测试模式，覆盖 Key 状态、`base_url`、错误提示、日志筛选、详情脱敏和权限失败。
- **回归层**：运行现有 MCP 鉴权、MCP Endpoint、Agent Access、管理台 MCP 审计测试，确认新增模型路径没有改变旧接口。

## 风险与未决问题

| 风险 | 处理 |
|---|---|
| 请求/响应快照可能包含个人敏感内容。 | 只保存脱敏 JSON；二进制只保存元数据；管理台详情沿用审计权限；后续可增加保留周期。 |
| 上游模型返回格式不完全兼容。 | 第一版只声明 OpenAI 兼容上游；保留原始上游状态和脱敏错误摘要，不在 Gateway 内做供应商特判。 |
| 流式响应可能在客户端断开前没有最终 usage。 | `usage_available=false` 时仍保存请求数、状态和耗时；Token 统计不伪造为零。 |
| 现有 MCP reveal 与新页面的一次性明文约束不完全一致。 | 保留旧接口以维持兼容，并在新页面按生成/轮换响应提供明文；该兼容风险已在页面和安全说明中公开。 |
| 审计表长期增长。 | 第一版使用 PostgreSQL 索引和快照上限；生产回滚保留表和数据；保留周期/归档作为部署运维项，暂不引入独立数仓。 |

本版本没有需要用户再决定的 P0/P1 未决问题；P2 能力按非目标处理，不改变本方案的接入、身份和日志契约。

## 独立审核记录

Reviewer 原始结论：`REVISE`。审核未发现 Blocker；以下修改关闭全部 Major，并处理 Minor。

| 问题 ID | 严重程度 | 处理决定 | 修改位置 | 关闭证据或不采纳理由 | 遗留风险 |
|---|---|---|---|---|---|
| R-01 | Major | 采纳。锁定服务端固定 scopes 和用户名校验。 | `DEC-2`、`API Key 生命周期`、`AC-3`、`测试策略` | 现有 app/admin rotate 作为兼容入口，但服务层忽略调用方 scopes，统一签发恰有 `mcp:call` 与 `model:call`；`Name` 非空由服务层强制；AC-3 覆盖缺省、非法、自定义 scopes、无用户名、并发轮换和旧 Token。 | 旧 MCP Token 需要轮换才能获得模型能力，已在兼容风险中明确。 |
| R-02 | Major | 采纳。定义审计边界、状态机、唯一性和数据库失败语义。 | `DEC-5`、`模型中转审计数据`、错误表、`AC-2`、`AC-4`、`AC-5` | 可识别 Key 的请求在策略判定前创建一条记录；未知 Key 只写访问日志；状态转移、`audit_id` 主键、条件幂等 finalize、插入失败 fail-closed 和终态更新失败日志均已锁定，AC-5 覆盖拒绝、成功、流式、失败、断开和插入失败。 | 终态更新后的数据库故障只能由结构化应用日志暴露，不能补发模型请求；这是明确的可观测性降级。 |
| R-03 | Major | 采纳。补充 BaseURL、最终 URL、models 响应、Header、错误和 SSE 契约。 | `外部模型接口`、`AC-1`、`AC-4`、`测试策略` | 明确 BaseURL 含上游版本前缀且只追加 endpoint；固定 `/v1/models` 响应；合法 OpenAI error 透传；SSE 按字节转发、结束事件/EOF 和 usage 规则固定；多模态字段不下载、不重写。 | 上游仍必须遵守声明的 OpenAI 兼容协议；不做供应商特判。 |
| R-04 | Major | 采纳。锁定管理台三条接口、查询参数、分页、聚合和权限边界。 | `管理台接口与权限`、`AC-6`、`测试策略` | 明确 `/api/v1/admin/model-proxy/audits`、`/detail`、`/summary`，返回形状、cursor、聚合维度、空结果、403 和直接查询 `model_proxy_audit_records`；权限复用只限授权标识。 | 第一版不增加独立权限码，模型日志和 MCP 审计共用读取权限。 |
| R-05 | Minor | 采纳。调整为生产只向前迁移，代码回滚保留审计表和数据。 | `迁移`、`回滚`、风险表 | 生产回滚不执行 Down、不删除审计表；只有隔离环境且完成备份后才允许手工清理，保留周期归运维策略管理。 | 旧版本忽略新增表的兼容性依赖部署代码，发布前需验证。 |
