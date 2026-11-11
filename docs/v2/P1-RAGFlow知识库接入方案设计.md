# P1：RAGFlow 知识库接入方案设计

> 状态：方案设计，待开发。
>
> 更新日期：2026-11-10。
>
> 适用项目：open-clawee 下独立开源仓库 aigateway；ClaweeAgent 作为兼容性验证对象。
>
> 方案结论：为 aigateway 现有 KnowledgeProvider 增加 RAGFlow 1.0 实现，复用知识库管理、账号授权、MCP 和审计链路。RAGFlow 独立运行，由 Gateway 调用 HTTP API；ClaweeAgent 继续通过 Gateway 使用知识库。

## 1. 已确认条件与实施边界

### 1.1 本次核查基线

| 项目 | 已确认事实 |
| --- | --- |
| aigateway | 版本 1.0.25，核查提交 `2bedb1b18fbe5cd0dd051b95163c5035ead5d033` |
| ClaweeAgent | 版本 1.0.25，核查提交 `0b916873f9e6da8d38d02867d0af9581b6e0e565` |
| RAGFlow | 本机运行镜像 `infiniflow/ragflow:v1.0.0` |
| 访问入口 | 宿主机 `http://127.0.0.1:18080` |
| 健康检查 | `GET /api/v1/system/healthz` 已实测返回 HTTP 200，数据库、队列、存储和检索引擎均为正常 |
| 业务联调 | 用户已完成 RAGFlow 独立部署及跑通；本次文档核查未读取 API Key，未创建、修改或删除其数据集 |

本文件中的新增配置、代码接口和测试脚本均为待实现内容。健康检查成功只证明服务可访问，不能代替使用专用测试 API Key 验证创建、上传、解析和检索。

文中源码路径以 aigateway 仓库根目录为基准。ClaweeAgent 独立维护，开发、构建和 CI 不得引用相邻仓库源码。

### 1.2 P1 交付范围

1. 在 aigateway 管理台创建 RAGFlow 知识库、上传文档、同步状态和删除资源。
2. ClaweeAgent 查看授权知识库、上传文档，刷新列表后获得最新解析状态。
3. 通过现有 `knowledge.search` 检索账号获准使用的知识库，返回片段及来源，由 Agent 组织回答。
4. 保留百炼实现和现有配置默认值；每个 Gateway 部署在 P1 中只启用一个知识库 Provider。
5. 全部示例、测试样例和公开提交使用占位凭据、合成资料及隔离环境。

P1 不包含 RAGFlow 安装、知识图谱、RAPTOR、编排型 ingestion pipeline、RAGFlow Chat、直接开放 RAGFlow MCP、多 RAGFlow 实例、后台 Provider 切换页面、存量知识库自动导入或百炼数据迁移。

现有 RAGFlow 中用于跑通的资料继续保留。验收创建独立测试数据集；P1 的“同步”只更新 Gateway 已登记文档，不会将 RAGFlow 的其他数据集或文档自动导入。

## 2. 当前代码与必须处理的缺口

| 位置 | 当前行为 | P1 改动 |
| --- | --- | --- |
| [provider/provider.go](../../server/internal/knowledge/provider/provider.go) | 已有知识库和文档增删、列表、检索六个方法 | 保持接口，实现新的 RAGFlow Provider |
| [runtime.go](../../server/internal/knowledge/runtime.go) | 只允许 `bailian` | 按配置初始化百炼或 RAGFlow |
| [service.go](../../server/internal/knowledge/service.go) | 创建时写死 `ProviderBailian`，所有外部操作共用一个 Provider | 注入实际类型，创建和操作均使用正确归属 |
| [config.go](../../server/internal/config/config.go) | 只有百炼配置；环境变量前缀为 `CLAW_GATEWAY` | 增加 RAGFlow 配置、默认值、环境变量绑定及校验 |
| [app.go](../../server/internal/app/app.go) | 创建运行时、内置 MCP 和 Service | 传递标准化 Provider 类型并检查存量绑定 |
| [builtin/client.go](../../server/internal/knowledge/builtin/client.go) | `knowledge-adapter` 调用 Provider，按绑定检查类型 | 复用现有授权范围、并发和聚合行为 |
| [knowledge_http.go](../../server/internal/server/knowledge_http.go) | App 文档 GET 只读本地状态；管理员有显式同步接口 | 补上 RAGFlow 处理中状态的按需刷新 |
| [postgres_store.go](../../server/internal/knowledge/postgres_store.go) | 同步只更新已存在、已绑定文档，不导入外部资料 | 沿用；完整获取外部列表后再更新 |
| [管理台文档页](../../server/web/src/pages/knowledge-base-documents.tsx) | 已有上传、同步、删除，页面自动同步仅触发一次 | 保留操作入口，通过刷新/同步完成异步状态验证 |
| [deploy/docker-compose.yml](../../deploy/docker-compose.yml) | 挂载配置文件，但未向 Gateway 传入 RAGFlow Key | 使用可选 Compose 覆盖文件传入 Key 和宿主机访问地址 |

ClaweeAgent 的 `knowledge-manager-2026-08-05.ts` 只调用 Gateway 列表和上传接口，没有 RAGFlow 调用逻辑；知识库会话及路由提示已经指向 Gateway 企业知识库。

**两个容易漏掉的现状：** 文档列表刷新目前不会查询解析服务；MCP 检索范围目前是账号拥有 MCP 权限的知识库集合。选择页面中的某个知识库，不等于服务端已经实现“仅检索这个库/这份文档”。P1 保持当前范围语义，验收不能把界面选择当成数据过滤。

## 3. 核心设计决策

### 3.1 服务边界与数据归属

Gateway 继续管理知识库逻辑 ID、文档逻辑 ID、成员授权、Agent 工具权限、生命周期和审计。RAGFlow 保存上传文件、解析任务、切片、向量索引和自身元数据。原始文件会从用户设备经 Gateway 发往独立 RAGFlow 服务。

Gateway 使用受控服务账号的 API Key 访问 RAGFlow。终端用户不会获得该 Key、RAGFlow 数据集 ID 或管理入口。账号的知识库授权由 Gateway 判断，不能依赖 RAGFlow 中服务账号可访问的全部数据集来推导用户权限。

模型凭据仍分别维护：ClaweeAgent 的模型用于 Agent 回答，RAGFlow 的 Embedding/Reranker 用于索引及检索。P1 不同步两者的模型配置。

### 3.2 一个逻辑知识库对应一个数据集

直接使用已有数据模型，无需数据库迁移：

| Gateway 字段 | RAGFlow 对象 |
| --- | --- |
| `knowledge_bases.provider_type` | 固定保存 `ragflow` |
| `knowledge_bases.external_knowledge_base_id` | 数据集 `data.id` |
| `knowledge_documents.external_document_id` | 上传返回的文档 `id` |
| `knowledge_base_id`、`document_id` | 保持 Gateway 自身 ID，用于 API、授权与关联 |

知识库名称、说明以 Gateway 为展示来源。RAGFlow 1.0 创建接口不接受 `description`，因此 P1 只在 Gateway 保存说明；现有编辑操作继续只修改本地名称和说明。外部对象始终按 ID 定位，不按名称重新查找或绑定。

### 3.3 P1 每个部署启用一个 Provider

`knowledge.provider_type` 决定该部署的知识库实现，允许 `bailian`、`ragflow`，默认仍为 `bailian`。配置 `ragflow` 后只校验 RAGFlow 所需字段，不要求百炼凭据。

启用知识库时，初始化 Store 后检查已有、未删除且具有外部 ID 的知识库绑定。存在与配置类型不同的绑定时，初始化明确报错，输出类型与数量，不发起外部请求。不得将百炼外部 ID 发送给 RAGFlow，也不得批量修改旧记录的 `provider_type` 来绕过检查。

Service 在同步、上传、删除之前仍检查知识库类型，类型不匹配返回冲突，检查必须早于删除状态转换。`knowledge.enabled: false` 时继续禁用知识库，Gateway 其他功能按原有行为运行。

有存量百炼资料且需要继续使用的部署，先保留现有配置；本次接入在隔离 Gateway 数据库中验证。双 Provider 共存需要另行扩展按知识库分发的 Service 和内置 MCP，不能仅增加初始化分支就宣称支持。

### 3.4 通过 HTTP API 接入，复用内置 MCP

保持 `knowledge-adapter`、内部工具名 `search` 和暴露名 `knowledge.search`。无需在管理后台另建一个 RAGFlow MCP 上游。

Gateway 保留当前工具输入 `query`、`top_k`；`top_k` 默认 5，范围 1～20。数据集 ID 来自服务端授权解析结果，模型或客户端不得传入或扩大范围。

## 4. RAGFlow 1.0 API 契约

本节以官方 **v1.0.0 标签中的 API 文档** 为基准，避免将滚动文档中的旧示例直接用于开发。适配器只支持本次确认的 1.0 契约，不增加自动版本探测或旧版参数回退。

### 4.1 创建数据集

`POST /api/v1/datasets`，Bearer 鉴权，JSON 请求：

```json
{
  "name": "P1知识库验收",
  "language": "Chinese",
  "parse_type": 1,
  "parser_id": "general",
  "permission": "me"
}
```

配置了 `embedding_model` 时才加入该字段，值使用 RAGFlow 已注册的完整 `model_name@model_factory`；为空则省略，继承服务账号已配置的默认模型。默认模型缺失时创建/解析应明确失败，不能伪造成功。

关键约束：

- `parse_type: 1` 与 `parser_id: general` 必须同时发送，使用内置通用解析器。
- 不发送旧的 `chunk_method: naive`，也不发送 `description`、`avatar` 或旧版扁平 `parser_config`。
- `permission` 使用 `me`，不是旧示例中的 `only_me`。
- 名称先满足 Gateway 原有约束，再检查 RAGFlow 的 BMP 字符限制；不支持的字符返回受控参数错误。
- 成功须同时满足 HTTP 成功、`code == 0`、`data.id` 非空；保存的是返回 ID。

RAGFlow 可能为重名数据集添加编号，不能按名称判断请求幂等。创建请求不自动重试。

### 4.2 方法与请求映射

| Provider 方法 | 请求 | 成功结果 |
| --- | --- | --- |
| `CreateKnowledgeBase` | `POST /api/v1/datasets`，按 4.1 组装 | `data.id` → `ProviderKnowledgeBase.ExternalID` |
| `DeleteKnowledgeBase` | `DELETE /api/v1/datasets`，`{"ids":["数据集ID"]}` | 检查业务成功，或经过精确查询确认目标已不存在 |
| `UploadDocument` | `POST /api/v1/datasets/{id}/documents`，multipart 字段 `file` | 读取 `data` 数组中的文档 ID，随后启动解析 |
| 启动解析，Provider 内部步骤 | `POST /api/v1/datasets/{id}/chunks`，`{"document_ids":["文档ID"]}` | `code == 0` 后返回 `DocumentProcessing` |
| `ListDocuments` | `GET /api/v1/datasets/{id}/documents?page=N&page_size=100&orderby=create_time&desc=false` | 从 `data.docs` 读取并汇总所有页 |
| `DeleteDocument` | `DELETE /api/v1/datasets/{id}/documents`，`{"ids":["文档ID"]}` | 检查业务成功，或经过精确查询确认目标已不存在 |
| `Search` | `POST /api/v1/retrieval` | `data.chunks` → 现有 `SearchResult` |

所有删除请求在发出前检查 ID 非空，只发送单个明确目标；不使用 `delete_all`，不发送空 `ids`。路径和查询通过标准 URL API 构造，multipart 的 Content-Type 由 writer 生成，不能手工写死 boundary。

文档列表的历史示例使用过 `total_datasets` 等不同计数字段。P1 不依赖这些名称：按页读取，直到空页；按文档 ID 去重。整页没有新增 ID 时返回协议错误以防重复分页。任一页失败则整体失败，不把部分列表当成完整快照写入本地。

### 4.3 检索请求及片段映射

```json
{
  "question": "验收资料中的报销期限是多少天？",
  "dataset_ids": ["服务端授权绑定得到的数据集ID"],
  "page": 1,
  "page_size": 5,
  "highlight": false,
  "use_kg": false,
  "include_knowledge_compilation": false
}
```

一次 Provider 调用只检索 `ExternalKnowledgeBaseID` 指定的数据集。继续由现有 builtin client 对多个授权知识库并发调用、排序和截断，保留最多 5 个并发、总结果最多 `top_k`、部分成功及失败列表语义。

`SearchRequest.TopK` 映射到 `page_size`。RAGFlow 的 `top_k`/`knn_top_k` 表示向量候选数，与返回条数不同；P1 不传旧 `top_k`，候选参数使用 RAGFlow 默认值。配置了 `rerank_id` 时才加入，其他检索权重不增加配置项。

| RAGFlow `data.chunks[]` | Gateway `SearchChunk` | 规则 |
| --- | --- | --- |
| `content` | `text` | 使用原始正文，不使用 HTML `highlight` |
| `document_keyword` | `document_name` | 为空时用同一响应 `doc_aggs` 按 `document_id` 查到的 `doc_name`；仍缺失时用“未命名文档” |
| `id` | `source_id` | 使用片段 ID，不用文档 ID 替代片段 ID |
| `similarity` | `score` | 可选有限数值；缺失保持 nil，不编造分数 |
| 无稳定章节字段 | `section` | 省略，不把坐标数组当成章节 |

空正文或空片段 ID 不进入返回结果。上游返回 `dataset_id` 时必须与请求目标一致，否则整次调用报协议错误。无命中返回 `{"chunks":[]}`；无效 JSON、缺失必需结构与业务失败不能伪装成无命中。

### 4.4 文档状态映射

| RAGFlow `run` 文本 / 数字 | Provider 状态 | Gateway 状态 |
| --- | --- | --- |
| `UNSTART` / `0` | `DocumentProcessing` | `processing` |
| `RUNNING` / `1` | `DocumentProcessing` | `processing` |
| `SCHEDULE` / `5` | `DocumentProcessing` | `processing` |
| `DONE` / `3` | `DocumentReady` | `ready` |
| `FAIL` / `4` | `DocumentFailed` | `failed` |
| `CANCEL` / `2` | `DocumentFailed` | `failed` |
| 其他或缺失 | `DocumentFailed` | `failed`，受控提示“无法识别文档处理状态” |

DTO 解码同时接受文本、数字字符串及 JSON 数字，不使用隐式浮点转换掩盖非法值。`run` 是主要依据，不因 HTTP 200、上传成功或存在 `id` 就标记 ready。

`progress_msg` 在官方示例中既有字符串也有数组，DTO 必须兼容；不将原始内容直接写入公开 API、审计或数据库错误文案。失败与取消分别使用固定中文说明，详细排查由 RAGFlow 运维日志完成。

## 5. 生命周期、同步与失败处理

### 5.1 创建知识库

1. 沿用 Service 的参数校验及本地 `creating` 记录，`ProviderType` 改为注入的实际类型。
2. 调用 RAGFlow 创建数据集，验证 `data.id`。
3. 保存外部 ID 并转换为 `active`；失败沿用 `create_failed`。
4. 外部创建成功、本地持久化失败时，复用现有补偿删除与脱敏日志。

### 5.2 上传与启动解析作为一个 Provider 操作

沿用单文件上限 50 MiB 和现有 `.pdf/.docx/.md/.txt/.xlsx/.csv` 校验。格式支持不因 RAGFlow 支持更多类型而自动放开。

`UploadDocument` 执行以下顺序：上传一个文件 → 验证返回数组与非空文档 ID → 发起该文档解析 → 返回 ID 和 processing。HTTP 请求只等待“解析任务已接受”，不等待 OCR、切片或索引完成，沿用现有 5 分钟上传 deadline。

当前 Service 在 Provider 返回 error 时不会保存同时返回的外部文档 ID。因此，**上传已成功、启动解析失败**必须由 RAGFlow Provider 自己清理该次上传产生的文档，再返回原始受控错误，不能只返回 error 留下无人管理的对象。

补偿使用新的、最多 30 秒的 context，不能复用已取消的上传 context。仅清理本次已确认创建的 ID。补偿失败时记录 `operation`、数据集/文档 ID、受控错误码和 `compensation_failed`，不记录 Key、正文或完整响应；运维按这些 ID 精确核对并清理。该失败对应本地 failed 记录，P1 不宣称支持自动续传或自动恢复。

如果请求超时且没有取得外部 ID，记录“结果待核对”，不按文件名删除任何对象。创建、上传和启动解析均不自动重试，避免重复数据或重复任务。

### 5.3 补齐客户端可见的状态刷新

P1 在 `Service.ListDocuments` 内增加 RAGFlow 专用的按需刷新，保持方法签名及 HTTP 响应结构：

1. 获取逻辑知识库及本地文档列表；HTTP 层必须先通过现有账号/管理员权限校验。
2. 当 Provider 是 RAGFlow、知识库为 active，且本地存在 processing 文档时，调用一次 `SyncDocuments`。
3. `SyncDocuments` 获取完整分页列表后，统一更新本地状态，再返回本地文档列表。它必须直接调用 Store 列表，避免与 `ListDocuments` 相互递归。
4. 没有 processing 文档时继续读本地状态。百炼列表行为保持原状。
5. 同步失败时返回现有 `knowledge_provider_error`，保留数据库中的原状态；客户端使用现有错误提示，后续刷新可重试。不能返回空列表或写成 ready。

管理员现有 `POST /api/v1/admin/knowledge-bases/documents/sync` 保留，可主动校正所有已登记文档。对于完整成功快照中仍找不到的本地 processing 外部 ID，构造 failed 状态和受控“外部文档不存在”说明；不删除本地记录或授权。

ClaweeAgent 普通 JSON 请求的现有超时是 15 秒。因此，列表按需刷新在调用 SyncDocuments 前设置 10 秒总 deadline，分页查询与本地更新共用该预算；显式管理员同步继续使用现有 30 秒上限。新增内部常量 `DocumentListRefreshTimeout = 10 * time.Second`，不增加部署配置。不新建 worker、定时任务、状态表或客户端同步 API。P1 验收要求“用户刷新后状态更新”，不承诺页面无人操作时实时推送。

通过 `read` 权限触发的只是既有文档状态对账，不能创建、重启解析、删除外部资源或导入其他资料。未授权请求不得触发任何 RAGFlow 调用。

### 5.4 删除与缺失目标

保留现有知识库删除前撤销成员授权、阻止上传中删除、逻辑删除及失败重试语义。Provider 的删除只能作用于当前知识库绑定的精确对象。

RAGFlow 业务码 `102` 同时可能表示参数、缺失数据或“不拥有数据集”，不能直接映射为 not_found，更不能视为删除成功。HTTP 404 也需要区分错误路由与真正缺失目标。

删除失败后，只有携带有效鉴权执行精确查询并明确确认目标不存在，才能按幂等删除成功处理。数据集查询使用 `GET /api/v1/datasets?id=目标ID`；文档查询使用当前数据集的文档列表 `id` 过滤。若数据集自身不存在，先精确确认数据集缺失。

当前 `Service.documentDeleteTargetMissing` 对 `ErrorInvalidRequest` 有历史兼容判断。RAGFlow 删除路径不得把未经确认的 101/102/400 错误作为 `ErrorInvalidRequest` 交给该逻辑；保留为 `ErrorInternal`，经确认缺失才使用 not_found/成功。这样无需扩大修改百炼历史行为，也不会把权限错误当作本地删除成功。

## 6. 配置与本机联调方式

### 6.1 新增配置

新增 `RAGFlowConfig` 并挂到 `KnowledgeConfig.RAGFlow`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `base_url` | 空 | 启用 ragflow 时必填，根服务地址，不含 `/api/v1` |
| `api_key_ref` | `RAGFLOW_API_KEY` | 保存环境变量名称，Key 从该环境变量解析 |
| `embedding_model` | 空 | 空时不传，继承 RAGFlow 默认 Embedding |
| `rerank_id` | 空 | 空时不显式指定 Reranker |

P1 不增加明文 `api_key` 配置项；复用 `ResolveCredential`。`base_url` 允许 HTTP/HTTPS，以支持本机部署；拒绝用户信息、查询串、fragment 和额外路径，标准化末尾斜杠。地址仅接受部署者配置，不能由普通请求覆盖。HTTP client 禁止自动跟随重定向，避免携带 Key 转发到其他地址。

在 `setDefaults`、环境变量绑定列表和配置测试中加入上述字段。对应变量为 `CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_BASE_URL`、`CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_API_KEY_REF`、`CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_EMBEDDING_MODEL` 和 `CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_RERANK_ID`。

Provider 构造只校验配置和凭据，不通过启动时网络探测绑定整个 Gateway 可用性。RAGFlow 临时离线时，账号、Skill、共享资源等保持可用，知识库操作按既有上游错误返回。显式配置缺失或 Provider 类型冲突则在初始化时清晰报错。

### 6.2 Gateway 直接运行在宿主机

修改已有仓库外 `$CLAWEE_OPS_DIR/configs/config.yaml` 的知识库段，保留其余配置：

```yaml
knowledge:
  enabled: true
  provider_type: ragflow
  ragflow:
    base_url: http://127.0.0.1:18080
    api_key_ref: RAGFLOW_API_KEY
    embedding_model: ""
    rerank_id: ""
```

在仓库外 `$CLAWEE_OPS_DIR/.env` 填入专用服务账号 Key，并限制文件权限：

```dotenv
RAGFLOW_API_KEY=<仅在仓库外填写真实值>
```

`config.Load` 已加载该目录下的 `.env`。密钥不写入仓库示例、不通过命令输出，也不上传至 CI 日志。

在 aigateway 根目录执行已有命令启动：

```bash
corepack pnpm server:dev
```

前提是已按项目开发指南配置 `CLAWEE_OPS_DIR`、依赖和隔离数据库。该命令调用现有开发脚本，Gateway 无子命令时默认启动服务；RAGFlow 接入本身不需要新增迁移。

### 6.3 Gateway 运行在 Docker 中

| Gateway 运行方式 | `base_url` |
| --- | --- |
| 宿主机原生进程 | `http://127.0.0.1:18080` |
| Docker Desktop 容器访问宿主机入口 | `http://host.docker.internal:18080` |
| Linux Docker 容器访问宿主机 | 使用同一地址，并配置 `host-gateway`；确认 18080 对该网络可达 |
| 与 RAGFlow 加入共同 Docker 网络 | 使用明确配置的服务 DNS 和容器内部 Nginx 端口，例如 `http://ragflow-cpu:80` |

容器中的 127.0.0.1 指向容器自身；宿主机 18080 映射的是 RAGFlow Nginx 的 80，不能将 18080 直接当成容器内部端口。

新增可选 `deploy/docker-compose.ragflow.yml`，不改变未接入 RAGFlow 的默认部署：

```yaml
services:
  gateway:
    environment:
      RAGFLOW_API_KEY: ${RAGFLOW_API_KEY:?请在外部环境配置RAGFlow专用Key}
      CLAW_GATEWAY_KNOWLEDGE_RAGFLOW_BASE_URL: http://host.docker.internal:18080
    extra_hosts:
      - host.docker.internal:host-gateway
```

Compose 的 `--env-file` 用于插值，不会自动把其中所有变量注入容器。现有部署只挂载 config.yaml，因此必须显式传入 Key。Gateway 生产镜像为 distroless，不应使用 `docker exec gateway curl/sh` 作为检查命令。

在 aigateway 根目录执行：

```bash
docker compose --env-file "$CLAWEE_OPS_DIR/.env" \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.ragflow.yml \
  up -d --build gateway
```

若采用共享 Docker 网络，替换 base_url 和网络配置，不需要 host-gateway。部署说明只引入网络连接，不把 RAGFlow 依赖栈复制进 aigateway Compose。

## 7. 代码改动清单

| 文件 | 开发要求 |
| --- | --- |
| 新增 `server/internal/knowledge/provider/ragflow.go` | 实现六个方法、私有解析步骤、DTO、鉴权、错误归一、精确删除确认及补偿；使用标准库 net/http |
| 新增 `server/internal/knowledge/provider/ragflow_test.go` | 使用 httptest 验证真实 1.0 请求和响应，不依赖在线模型 |
| `server/internal/config/config.go`、`config_test.go` | 增加配置结构、默认值、环境变量绑定与分 Provider 校验 |
| `server/internal/knowledge/types.go` | 增加 `ProviderRAGFlow = "ragflow"` 和 10 秒列表刷新常量，复用现有状态及其他超时 |
| `server/internal/knowledge/runtime.go`、`runtime_test.go` | 标准化类型并分支初始化；Runtime 增加实际 `ProviderType`；只解析选中 Provider 的凭据 |
| `server/internal/knowledge/service.go`、`service_test.go` | Service 增加 providerType 字段；创建记录、操作归属检查、按需刷新及缺失文档处理 |
| `server/internal/app/app.go` 及测试 | 先准备 Store；初始化时检查非当前 Provider 绑定；向 Service 和 builtin 传相同实际类型 |
| `server/internal/knowledge/builtin/client_test.go` | 验证 ragflow 绑定、多库聚合、部分失败、空范围和类型不匹配 |
| `server/internal/server/knowledge_http_test.go` | 验证现有响应契约、刷新后状态及权限前置检查 |
| `server/internal/knowledge/store_test.go` | 验证完整同步、失败不写半份状态、已删除文档不恢复 |
| 新增 `server/internal/knowledge/postgres_store_integration_test.go` | 用隔离 PostgreSQL 覆盖 ID 保存、状态同步和删除生命周期 |
| `server/configs/config.example.yaml` | 保留既有默认配置，补充禁用状态下的 ragflow 字段及本机配置说明 |
| 新增 `deploy/docker-compose.ragflow.yml` | 可选覆盖文件，显式注入 Key 和地址 |
| 新增 `scripts/ragflow-smoke.mjs`、根 `package.json` | 增加显式执行的隔离业务联调命令 `ragflow:smoke` |
| `server/docs/getting-started/configuration.md`、`docs/operations/operations-guide.md` | 补充环境变量、宿主机/容器地址、状态同步、回滚和孤立资源核对步骤 |

建议内部构造签名调整为 `NewService(store Store, p provider.KnowledgeProvider, providerType string, loggers ...*zap.Logger)`。批量更新其测试调用点；不为保持内部签名新增默认百炼回退。`KnowledgeProvider` 接口保持不变，百炼 Adapter 和测试 stub 不必增加类型方法。

本期不要求修改 ClaweeAgent 业务代码或依赖。兼容性测试使用双方固定 SHA/版本，通过实际 HTTP/MCP 运行；测试结果必须记录双方提交，不能依赖仓库恰好位于同一目录。

## 8. HTTP、权限和审计兼容性

### 8.1 保留现有入口

| 使用方 | 入口 |
| --- | --- |
| 管理台 | `/api/v1/admin/knowledge-bases` 及 detail、documents、documents/sync、remove 等现有路由 |
| ClaweeAgent | `GET /api/v1/app/knowledge-bases` |
| ClaweeAgent | `GET /api/v1/app/knowledge-bases/documents?knowledge_base_id=...` |
| ClaweeAgent | `POST /api/v1/app/knowledge-bases/documents`，沿用 multipart |
| Agent 检索 | 现有 Gateway MCP 的 `knowledge.search` |

保留现有统一响应中间件和客户端 schema，不从 RAGFlow 透传响应包。App 列表保持现有 `data`、`meta`；管理台 API 继续经统一响应处理。外部 ID 在当前模型中带 `json:"-"`，继续隐藏。

### 8.2 授权按现有链路执行

1. 用户登录并使用既有 Agent 身份调用 Gateway。
2. 工具授权检查 `knowledge.search` 是否可用。
3. `DataAccessService` 解析账号的知识库 `mcp` 授权，获得逻辑知识库集合。
4. Resolver 检查知识库 active 和有效绑定，生成 Provider 类型及外部 ID。
5. builtin client 仅检索这些绑定，无有效范围时不调用 RAGFlow。

查看使用 `read`，上传使用现有 `read + upload`，检索使用工具授权和知识库 `mcp` 授权；不能因为拥有 read 就自动获得检索权。授权撤销后再次调用应立即受限。

保留 MCP 输入 `additionalProperties: false`，不新增客户端可传的 `dataset_ids`。现有 `ProjectProxyAudit` 已对 query 和片段正文脱敏，继续保留逻辑知识库、来源、条数、耗时与决策信息，不记录 RAGFlow Authorization。

### 8.3 上游错误映射

| 上游情况 | ProviderError | 对外处理 |
| --- | --- | --- |
| HTTP 401/403；业务 108/109 | `unauthorized` | Gateway 的上游服务错误，不把终端用户登录状态清除 |
| HTTP 429 | `rate_limited`，Retryable=true | 本次失败，不自动重放写操作 |
| deadline 超时 | `timeout`，Retryable=true | 保留本地生命周期状态；按补偿规则处理已知新对象 |
| HTTP 400；业务 101 | `invalid_request` | 使用现有知识库错误映射；删除路径按 5.4 特别处理 |
| 业务 102、10、103、106 | 默认 `internal` | 不按原始英文消息猜测权限或缺失，不伪装成功 |
| 业务 105、HTTP 5xx、连接故障 | `internal`，Retryable=true | RAGFlow 不可用，其他 Gateway 功能继续服务 |
| 非 JSON、成功包无必要 ID/结构 | `internal` | 协议错误，保留排查所需操作名和状态码 |
| 已通过精确授权查询确认对象缺失 | `not_found` 或删除成功 | 只在生命周期语义明确时使用 |

必须同时检查 HTTP 状态和 JSON `code`。`code` 字段使用可识别“缺失”的类型，避免缺失字段被 Go 零值当成成功。原始 `message` 不进入公开响应、文档错误文案或审计；不得全文打印请求/响应。

## 9. 开发顺序与完成标准

| 顺序 | 任务 | 完成标准 |
| --- | --- | --- |
| 1 | 建立 v1.0 DTO 与 httptest 契约样例 | 创建请求包含 parse_type/parser_id，旧参数缺席；业务失败不当成功 |
| 2 | 完成配置、Runtime、Service 类型归属 | 选择 ragflow 不依赖百炼凭据；创建记录类型正确；旧配置继续通过 |
| 3 | 完成创建、上传、解析触发和补偿 | 正常上传返回 processing；解析触发失败可精确清理，失败有受控记录 |
| 4 | 完成分页同步及读列表按需刷新 | 同一文档刷新后从 processing 变 ready/failed，无客户端协议改动 |
| 5 | 完成 Search、删除及权限回归 | 每次只请求授权绑定，返回来源；上游权限错误不误删本地记录 |
| 6 | 完成可选 Compose 覆盖和隔离 smoke | 宿主机/容器地址均有验证记录，Key 不进入源码或报告 |
| 7 | 运行仓库检查和跨仓库验收 | 记录双方 SHA、RAGFlow 镜像、测试结果及清理情况，再准备发布 |

步骤 1～5 使用合成数据和 httptest 开发，避免消耗真实知识库。涉及数据库验证只使用隔离数据库；本方案无需迁移，不运行或修改任何既有生产库。

## 10. 自动化与手动验收

### 10.1 必须覆盖的自动化用例

| 维度 | 关键用例 |
| --- | --- |
| 配置 | 未启用不读取 Key；ragflow 不要求百炼 Key；缺少 Key、非法 URL、未知类型报错；环境变量可覆盖 |
| 创建 | v1.0 参数精确匹配；不发送 description/chunk_method；空 ID、非零 code、重名响应 ID；本地失败补偿 |
| 上传 | multipart 字段正确；取得 ID 后显式启动解析；解析触发失败清理；取消后补偿 context 仍可执行；不重试写操作 |
| 状态 | 六种 run 文本和数字形式；未知值；progress_msg 字符串/数组；上传不直接 ready |
| 分页 | 至少三页；空页结束；重复页报错；后页失败不写部分结果；不导入外部未登记文档 |
| 刷新 | App/Admin 已授权刷新更新状态；无 processing 不调用；百炼原行为不变；上游失败不改本地状态；10 秒预算先于客户端 15 秒超时 |
| 检索 | page_size 等于 Clawee TopK；不传旧 top_k；score 可空；空结果；跨数据集响应拒绝；多库部分失败 |
| 权限 | 无 read 不发列表请求；无 upload 不上传；无工具授权/无 mcp 数据范围不检索；额外 dataset_ids 输入拒绝 |
| 删除 | 非空精确 IDs；已缺失可幂等完成；108/109/102 不误判缺失；仍有成员授权时阻止删库 |
| 持久化 | RAGFlow 外部 ID 正确保存；处理/失败/删除转换；删除中的记录不被同步恢复；事务失败回滚 |
| 隔离 | 存量百炼绑定与 ragflow 配置冲突时拒绝初始化；禁用知识库后其他功能可用 |

### 10.2 仓库检查命令

先在 aigateway 根目录执行：

```bash
corepack pnpm test
corepack pnpm --dir server/web test
corepack pnpm --dir server/web build
```

再进入 `server`，使用已配置的隔离 `CLAW_GATEWAY_TEST_DATABASE_URL`：

```bash
go test -count=1 ./internal/knowledge/... ./internal/config/... ./internal/app/... ./internal/mcpgateway/... ./internal/server/...
go test -p 1 ./...
go vet ./...
```

后续新增的 PostgreSQL 用例必须沿用该测试数据库变量，不能读取运行环境的生产 `database.url`。上述为开发完成后要求执行的命令，不是本次文档编写已经通过的记录。

### 10.3 RAGFlow 隔离业务 smoke

新增的 `ragflow:smoke` 显式读取仓库外配置路径 `CLAWEE_RAGFLOW_SMOKE_CONFIG`。配置包含 `disposable: true`、`ragflow_base_url`、`api_key_ref`、可选 `embedding_model`；验证目标为专用测试环境/测试服务账号后运行，默认 CI 不访问开发者本机服务。

脚本创建名称带唯一随机后缀的数据集，使用 4.1 的 v1.0 参数；上传脚本生成的 TXT（例如“P1验收：报销期限为37天。”）；启动解析；每 2 秒查询，最长等待 180 秒；ready 后检索，断言命中“37天”及文档来源。超时按失败退出并保留受控状态信息。

仅清理本次返回的数据集 ID，不枚举清理已有数据。失败时仍执行精确清理；删除失败则非零退出并报告待核对的测试对象 ID。报告不输出 Key、账号、真实文档内容或完整响应。该脚本验证 RAGFlow 契约；Gateway 授权链路另按下节端到端验收。

```bash
CLAWEE_RAGFLOW_SMOKE_CONFIG=/仓库外目录/ragflow-smoke.json \
  corepack pnpm ragflow:smoke
```

### 10.4 Gateway 与 ClaweeAgent 手动验收

1. 准备隔离 Gateway 数据库、专用 RAGFlow 测试账号及两个 Gateway 测试账号 A/B，记录双方 SHA 和 RAGFlow 镜像版本。
2. Gateway 使用 ragflow 配置启动；管理台创建“P1企业知识库验收”，确认 provider 为 ragflow。
3. 上传含“报销期限为37天”的合成 TXT，确认初始 processing；解析完成后点击刷新/同步，确认 ready。
4. 给 A 配置 read、upload、mcp 及现有检索工具访问权；给 B 只配置 read。管理台账户字段按已有规则显示名称。
5. 使用 ClaweeAgent 的企业知识库入口验证 A 可以浏览、上传；新上传文档刷新后同步 ready。B 可以浏览但不能检索，未获 read 的其他账号不能看到此库。
6. A 在现有企业知识库对话中要求“搜索企业知识库中的报销期限，并给出来源”。确认实际调用 knowledge.search，答案为37天，来源文档正确。
7. 撤销 A 的 mcp 权限后再次调用，确认无匹配范围时不请求 RAGFlow；恢复授权后继续测试。
8. 在隔离环境暂时阻断 Gateway 到 RAGFlow 的访问，确认知识库显示上游错误，Gateway 健康、账号及其他业务仍正常。恢复连接后刷新可继续同步。
9. 验证解析失败及取消显示 failed；验证上游鉴权失败不导致用户登录失效，也不把删除操作误记为成功。
10. 先撤销测试库成员授权，再删除文档和知识库，确认远端精确删除、本地逻辑删除及审计脱敏。

不要复用 ClaweeAgent 现有 `gateway:smoke` 直接验收本功能：该脚本当前明确断言“隔离环境未启用知识库”，其通过只证明禁用行为，不能证明 RAGFlow 接入成功。P1 保留该回归，另记录以上启用场景。

## 11. 发布与回滚

1. 完成离线测试、隔离 RAGFlow smoke 和跨仓库手动验收，记录实际双方版本/SHA；按 aigateway 自身 Release Preflight 发布。
2. 发布前备份外部运维配置、Gateway 数据库以及 RAGFlow 数据卷/元数据；备份保存在运维边界内，不提交仓库。
3. 在目标环境先部署新 Gateway 代码，再配置 ragflow，并只使用新建验收库验证。不要通过修改现有百炼记录切换数据归属。
4. 若需回滚代码，先设置 `knowledge.enabled: false` 再启动旧版；旧版不认识 ragflow。禁用知识库不删除任何数据库记录或 RAGFlow 对象。
5. 恢复新代码及原 ragflow 配置后重新启用，继续使用原外部 ID。回滚不执行批量删库、删除卷或 Provider 字段重写。

P1 上线条件是“管理台和 ClaweeAgent 均可使用、权限与来源正确、异步状态可刷新、失败可解释并可恢复”。仅 RAGFlow 页面可访问、健康检查正常或单独 curl 检索成功，均不能替代以上条件。

## 12. 开发开始前的输入与参考

需要由部署者在仓库外准备：专用服务账号 API Key、已注册的默认 Embedding（或完整模型名称）、可选 Reranker ID、隔离数据库连接和测试 Gateway 账号。真实值不写入本文件。

参考资料按优先级：

1. [RAGFlow v1.0.0 固定版本 HTTP API，含迁移说明](https://github.com/infiniflow/ragflow/blob/v1.0.0/docs/references/http_api_reference.md)。创建数据集的 parse_type/parser_id、permission 和 description 限制以此为准。
2. [RAGFlow HTTP API 滚动文档](https://ragflow.io/docs/http_api_reference)。只作补充，出现冲突时先核对固定版本。
3. [现有知识库迁移定义](../../server/db/migrations/00012_enterprise_knowledge_base.sql)、[MCP 知识库权限迁移](../../server/db/migrations/00033_account_knowledge_mcp_access.sql)。P1 复用，不修改已发布迁移。
4. [Gateway 工程约束](../../AGENTS.md)、[配置说明](../../server/docs/getting-started/configuration.md)、[前端开发规范](../frontend/frontend-development-guidelines.md)。
5. [ClaweeAgent 当前知识库 HTTP 契约](https://github.com/krillinai/ClaweeAgent/blob/0b916873f9e6da8d38d02867d0af9581b6e0e565/client/apps/daemon/src/enterprise/http-client-2026-07-30.ts)、[企业知识库路由](https://github.com/krillinai/ClaweeAgent/blob/0b916873f9e6da8d38d02867d0af9581b6e0e565/client/apps/daemon/src/codex/enterprise-knowledge-routing.ts)。
