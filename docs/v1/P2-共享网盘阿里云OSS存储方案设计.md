# 共享网盘阿里云 OSS 存储方案设计

> 状态：已确认，待开发
>
> 优先级：P2
>
> 适用范围：server、server/web 中的共享网盘能力
>
> 不适用范围：本地任务工作区、附件、知识库文档、Skill 包和 Collector 文件
>
> 方案结论：默认使用服务器本地磁盘，管理员可在后台配置并切换为阿里云 OSS；切换只改变后续写入位置，已有文件按文件级存储归属继续读取，存量文件通过独立迁移任务搬运。

## 1. 背景与现状

共享网盘的文件元数据保存在 PostgreSQL，文件内容保存在 Gateway 服务器本地目录。当前实现具有以下基础：

- server/internal/sharedfiles/storage.go 已定义 Storage 接口，并提供 FileSystemStorage。
- server/internal/sharedfiles/service.go 通过 Storage 完成上传、下载和上传失败补偿。
- shared_files.storage_key 已将业务逻辑路径与实际存储键解耦，但没有记录存储介质。
- Gateway 在 server/internal/app/app.go 启动时固定创建 FileSystemStorage。
- 管理端和 Clawee 客户端均通过 Gateway 上传和下载，单文件上限为 1 GiB。

如果只将全局 Storage 从本地盘替换为 OSS，切换后所有旧 storage_key 都会被错误地发往 OSS，导致存量文件不可读。因此必须同时引入文件级存储归属。

## 2. 目标与非目标

### 2.1 目标

1. 新部署和未配置 OSS 的现有部署继续默认使用本地磁盘。
2. 具备专用权限的管理员可在管理台完成 OSS 配置、连通性测试和存储切换，无需重启 Gateway。
3. 切换后新文件和新版本写入当前激活存储，旧文件仍可从原存储读取。
4. 存量文件可在后台发起迁移，支持断点恢复、失败重试和结果审计。
5. 保持现有客户端共享网盘 HTTP 契约、账号授权、文件 revision 和 SHA-256 校验语义不变。
6. OSS 凭据不以明文进入数据库、日志、审计数据或管理 API 响应。

### 2.2 非目标

- 本期不把浏览器或桌面端改为直传 OSS，不向客户端发放永久 OSS URL。
- 本期不支持 S3、COS、MinIO 等其他对象存储，但服务端边界不应阻止后续新增实现。
- 本期不改造知识库、Skill Hub、本地附件或桌面端项目文件的存储。
- 本期不将 OSS 作为 CDN 或公网静态文件服务。
- 不在切换存储时隐式自动搬迁全部存量文件。

## 3. 核心设计决策

### 3.1 切换与迁移分离

“切换存储”只修改后续写入目标，不修改已有文件记录。“迁移存量文件”是独立任务。

这保证：

- 切换可以在数秒内完成，不受存量容量影响。
- 迁移失败不影响未迁移文件的正常读取。
- 迁移期间共享网盘可以继续使用。

### 3.2 文件绑定存储 Profile

每条 shared_files 记录必须同时保存 storage_profile_id 和 storage_key。读取、替换、删除和迁移都使用该组合定位对象。

使用 Profile 而不只记录 local/aliyun_oss，是因为 Endpoint、Bucket 或 Prefix 变更后，旧文件仍需要使用原配置定位。已被文件引用的 Profile 不得物理删除。

### 3.3 禁止静默回退

当前激活存储为 OSS 且 OSS 不可用时，新写入必须失败并返回明确错误，不得静默回退到本地盘。静默回退会导致数据分散且实际行为与管理员配置不一致。

### 3.4 Gateway 继续代理文件流量

~~~text
Clawee Web/Desktop
        |
        | 现有共享文件 HTTP API
        v
Gateway SharedFiles Service
        |
        v
StorageRegistry / StorageRouter
        |-------------------|
        v                   v
FileSystemStorage      AliyunOSSStorage
~~~

Bucket 必须为私有读写。客户端不感知 OSS 凭据、Bucket 地址和对象键，现有权限与审计边界保持不变。

## 4. 数据模型

新增迁移文件：server/db/migrations/00049_shared_file_storage_profiles.sql。

### 4.1 shared_file_storage_profiles

| 字段 | 类型 | 约束/说明 |
| --- | --- | --- |
| profile_id | TEXT | 主键，系统生成 |
| name | TEXT | 管理台展示名称 |
| provider | TEXT | 仅允许 local、aliyun_oss |
| endpoint | TEXT | OSS Endpoint，本地 Profile 为空 |
| region | TEXT | OSS Region，本地 Profile 为空 |
| bucket | TEXT | OSS Bucket，本地 Profile 为空 |
| object_prefix | TEXT | OSS 对象前缀，默认 clawee/shared-files |
| credential_mode | TEXT | ecs_ram_role 或 access_key |
| access_key_id_ciphertext | BYTEA | AccessKey ID 密文，RAM Role 模式为空 |
| access_key_secret_ciphertext | BYTEA | AccessKey Secret 密文，RAM Role 模式为空 |
| access_key_id_hint | TEXT | 只保存脱敏后的末四位提示，不可用于认证 |
| status | TEXT | enabled、retired |
| last_probe_status | TEXT | unknown、success、failed |
| last_probe_at | TIMESTAMPTZ | 最近探测时间 |
| created_by / updated_by | TEXT | 创建人和最后更新人 |
| created_at / updated_at | TIMESTAMPTZ | 创建和更新时间 |

数据库约束：

- provider=local 时 OSS 字段必须为空。
- provider=aliyun_oss 时 Endpoint、Region、Bucket 和 Credential Mode 必须完整。
- credential_mode=access_key 时两个凭据密文必须存在。
- 固定创建 profile_id=shared_files_local_default 的本地 Profile，不允许删除或修改 Provider。
- 已被文件引用的 Profile 只能标记为 retired，不能物理删除。
- 当前 active_profile_id 指向的 Profile 不允许退役；必须先切换到其他 enabled Profile。
- 已被文件引用的 OSS Profile 不允许就地修改 Endpoint、Region、Bucket 或 Prefix。需要变更时创建新 Profile 并迁移数据；凭据允许原 Profile 就地轮换。

### 4.2 shared_file_storage_settings

该表只保存一行：

| 字段 | 类型 | 约束/说明 |
| --- | --- | --- |
| id | TEXT | 固定为 default |
| active_profile_id | TEXT | 新写入使用的 Profile |
| revision | BIGINT | 配置乐观锁，从 1 开始 |
| updated_by | TEXT | 操作人 |
| created_at / updated_at | TIMESTAMPTZ | 创建和更新时间 |

数据迁移时插入默认记录，active_profile_id 指向本地 Profile。

### 4.3 shared_files 调整

新增字段：

~~~sql
storage_profile_id TEXT NOT NULL
    REFERENCES shared_file_storage_profiles(profile_id)
~~~

对现有数据统一回填 shared_files_local_default。storage_key 字段及原唯一约束保留。

sharedfiles.File 增加不对客户端序列化的 StorageProfileID 字段。所有查询和写入 SQL 必须同步读写该字段。

### 4.4 存量迁移表

新增 shared_file_storage_migrations：

- migration_id、source_profile_id、target_profile_id。
- status：pending、running、completed、completed_with_failures、completed_with_cleanup_pending、cancelled。
- total_count、success_count、failed_count、skipped_count、cleanup_pending_count。
- created_by、created_at、started_at、finished_at。

新增 shared_file_storage_migration_items：

- migration_id、file_id，两者组成联合主键。
- source_profile_id、source_storage_key、source_revision。
- target_storage_key。
- status：pending、running、succeeded、failed、skipped。
- attempt_count、error_code、error_message、heartbeat_at、started_at、finished_at。

error_message 必须是脱敏信息，不保存 OSS 签名、AccessKey、请求头或 SDK 原始响应体。

新增 shared_file_storage_cleanup_tasks，统一持久化需要重试的对象删除：

- cleanup_id、storage_profile_id、storage_key。
- source：upload_compensation、replace_old_object、migration_source。
- file_id、migration_id，可为空。
- status：pending、running、succeeded、failed。
- attempt_count、next_attempt_at、last_error_code、last_error_message、created_at、finished_at。
- 对尚未成功的 storage_profile_id + storage_key 建立唯一约束，避免重复清理任务。

清理任务的错误字段同样必须脱敏。对象已经不存在时直接标记 succeeded。

## 5. 服务端设计

### 5.1 存储接口

将现有仅返回尺寸和摘要的 Put 结果改为结构体，并显式传入声明大小：

~~~go
type PutOptions struct {
    DeclaredSize int64
    MaxBytes     int64
    ContentType  string
    FileID       string
    ProfileID    string
}

type ObjectMetadata struct {
    SizeBytes int64
    SHA256    string
}

type Storage interface {
    Put(ctx context.Context, key string, src io.Reader, opts PutOptions) (ObjectMetadata, error)
    Open(ctx context.Context, key string) (io.ReadCloser, error)
    Delete(ctx context.Context, key string) error
    Probe(ctx context.Context) error
}
~~~

DeclaredSize 用于 OSS 上传和上传前校验，MaxBytes 仍是服务端硬限制。本地实现保持现有临时文件、SHA-256 计算、原子 rename 和路径穿越防护语义。

### 5.2 StorageRegistry

新增 StorageRegistry，负责选择当前写入存储和解析文件所属存储：

~~~go
type StorageTarget struct {
    ProfileID string
    Storage   Storage
}

type StorageRegistry interface {
    Active(ctx context.Context) (StorageTarget, error)
    Resolve(ctx context.Context, profileID string) (StorageTarget, error)
}
~~~

- Active 在每次开始写入时读取数据库中的当前 Profile，保证后台切换无须重启，且不受多 Gateway 实例本地缓存延迟影响。
- Resolve 根据文件中的 storage_profile_id 创建或复用存储客户端。
- OSS SDK 客户端可按 profile_id + updated_at 缓存；凭据轮换后必须失效旧客户端。
- Profile 配置错误或 OSS 不可达不得阻止整个 Gateway 启动，共享文件相关请求按需返回存储不可用。

### 5.3 SharedFiles Service 调整

上传流程：

1. 完成现有路径、权限、长度、SHA-256 和 revision 前置校验。
2. 调用 registry.Active 获取本次写入目标；本次请求后续不再跟随配置变化。
3. 使用现有格式生成 storage_key：{space_id}/{file_id}/{blob_id}。OSS 最终 Object Key 由 Profile Prefix 与该 Key 组合。
4. 向目标存储写入并校验大小和摘要。
5. 向数据库写入 storage_profile_id + storage_key。
6. 数据库写入失败时，从本次目标 Profile 删除新对象。
7. 替换文件成功时，Store 返回数据库中实际被替换的旧 profile_id + storage_key，Service 再从旧 Profile 删除旧对象。

将 Store 的替换结果从单个 oldKey string 改为：

~~~go
type ObjectRef struct {
    StorageProfileID string
    StorageKey       string
}
~~~

下载流程的授权、响应头和内容流语义不变，但 OpenFile 和 OpenAdminFile 必须先按文件 Profile 调用 registry.Resolve，再打开对象。

### 5.4 OSS 实现要求

新增 server/internal/sharedfiles/oss_storage.go，使用阿里云官方 OSS Go SDK。

- 只通过 HTTPS 访问 OSS。
- 小文件可使用单次 PutObject。
- 大文件使用 Multipart Upload，分片大小作为服务端常量，初始建议 16 MiB，本期不在后台开放调节。
- 读取请求体时同步计算 SHA-256，不得将完整文件读入内存。
- Multipart 失败、请求取消或大小/摘要不一致时必须 Abort，不留存未完成分片。
- 对象元数据写入 clawee-sha256、clawee-file-id 和 clawee-storage-profile-id，用于运维核查；数据库仍是业务元数据唯一权威来源。
- Delete 必须幂等，对象不存在视为成功。
- SDK 错误必须转换为有限的内部错误码，禁止将原始签名、请求头和响应体返回客户端。
- 上传、下载、删除和连通性测试均必须传递 context.Context。

### 5.5 连通性测试

仅执行 HeadBucket 不能证明实际对象读写权限。Probe 必须在配置 Prefix 下完成：

1. 生成小型随机内容和 _probe/{uuid} 对象键。
2. 上传测试对象。
3. 读回并校验大小和 SHA-256。
4. 删除测试对象。

任一步失败都不允许激活该 Profile。删除测试对象失败时，应明确提示缺少删除权限，并记录脱敏错误。

## 6. 配置、凭据与安全

### 6.1 本地存储配置

保留现有部署配置：

~~~yaml
shared_files:
  storage_root: "data/shared-files"
  oss:
    allowed_endpoint_hosts: []
~~~

本地目录属于部署级配置，不在管理台中修改，防止管理员通过路径配置访问 Gateway 主机上的其他文件。管理台只显示“服务器本地存储”及健康状态，不向普通管理员返回绝对路径。

allowed_endpoint_hosts 仅用于部署者额外放行客户自定义 OSS CNAME；阿里云官方 OSS Endpoint 由代码按严格规则识别，无须逐个配置。

### 6.2 OSS 凭据方式

优先级：

1. ecs_ram_role：Gateway 部署在阿里云 ECS 时优先使用实例 RAM Role，数据库不保存长期 AccessKey。
2. access_key：非 ECS 部署可在管理台输入 AccessKey ID/Secret。

AccessKey ID 和 Secret 都使用项目现有 AES-GCM TokenCipher 机制加密。密钥继续来自仓库外的 security.agent_token_encryption_key 配置；该配置名为历史命名，目前已被其他企业凭据复用。不新建第二套加密实现。

管理 API 只返回：

- credential_mode。
- credentials_configured。
- 可选的 AccessKey ID 末四位脱敏展示值。

不得返回密文或可恢复的凭据内容。更新凭据采用 keep/replace 语义，不使用空字符串猜测管理员意图。

### 6.3 Endpoint 防护

OSS Endpoint 是 Gateway 主动访问且携带凭据的地址，必须防止 SSRF 和凭据外送：

- 只允许 https Scheme，禁止 URL UserInfo、Query 和 Fragment。
- 默认只允许阿里云 OSS 官方 Endpoint 域名，包括合法的内网 Endpoint。
- 使用 OSS CNAME 时，必须由部署管理者通过仓库外 allowed_endpoint_hosts 明确放行，不能仅通过管理台解锁任意域名。
- 禁止跟随将请求导向未授权 Host 的重定向。
- 日志不记录 Authorization、Signature、AccessKey 或完整 SDK 请求对象。

### 6.4 RAM 最小权限

凭据只能访问指定 Bucket 下的 Profile Prefix，至少满足：

- 对象上传、读取和删除。
- Multipart Upload 创建、上传分片、列出分片、完成和终止。
- 如果 SDK 的 Bucket 校验需要额外读取权限，只授予必需的 Bucket 元数据读取权限。

不授予 Bucket 创建、删除、ACL 修改或全账号 OSS 管理权限。

### 6.5 Bucket 与加密要求

- Bucket 必须为私有，禁止公共读或公共读写。
- 同地域部署优先使用 OSS 内网 Endpoint。
- 传输必须使用 TLS。
- 服务端加密由客户在 Bucket 侧配置 AES256 或 KMS，本期 Clawee 不覆盖 Bucket 默认加密策略。
- 生命周期规则不得自动删除 Profile Prefix 下仍被数据库引用的正式对象；只允许清理已确认过期的未完成 Multipart。

## 7. 管理 API 设计

所有路由位于 /api/v1/admin，响应继续使用现有 data 包装格式。

### 7.1 读取存储状态

GET /shared-file-storage

权限：console:shared_files:storage_read

响应示例：

~~~json
{
  "data": {
    "active_profile_id": "shared_files_local_default",
    "revision": 3,
    "profiles": [
      {
        "profile_id": "shared_files_local_default",
        "name": "服务器本地存储",
        "provider": "local",
        "status": "enabled",
        "health": "available",
        "file_count": 128,
        "size_bytes": 482344960
      },
      {
        "profile_id": "storage_profile_01",
        "name": "生产 OSS",
        "provider": "aliyun_oss",
        "endpoint": "https://oss-cn-hangzhou.aliyuncs.com",
        "region": "cn-hangzhou",
        "bucket": "customer-clawee",
        "object_prefix": "clawee/shared-files",
        "credential_mode": "ecs_ram_role",
        "credentials_configured": true,
        "status": "enabled",
        "health": "unknown",
        "file_count": 0,
        "size_bytes": 0
      }
    ]
  }
}
~~~

health 只表示最近一次测试或请求结果。读取列表时不得同步向 OSS 发起探测。

### 7.2 测试 OSS 配置

POST /shared-file-storage/oss/test

权限：console:shared_files:storage_manage

请求包含 Endpoint、Region、Bucket、Prefix、Credential Mode 和本次待测凭据。测试凭据只存在于本次请求内存，不持久化。

成功响应：

~~~json
{
  "data": {
    "result": "success",
    "tested_at": "2026-09-12T08:00:00Z"
  }
}
~~~

### 7.3 创建或更新 OSS Profile

- POST /shared-file-storage/oss-profiles
- PATCH /shared-file-storage/oss-profiles/:profile_id

权限：console:shared_files:storage_manage

创建或修改目标位置前必须完成连通性测试。后端不信任前端测试状态，保存前自行重新 Probe。

凭据更新示例：

~~~json
{
  "credential_action": "replace",
  "access_key_id": "LTAI...",
  "access_key_secret": "..."
}
~~~

保留旧凭据时使用 credential_action: keep。

### 7.4 激活存储

POST /shared-file-storage/activate

权限：console:shared_files:storage_manage

请求：

~~~json
{
  "profile_id": "storage_profile_01",
  "expected_revision": 3
}
~~~

激活 OSS 前后端必须重新执行 Probe。更新语句以 expected_revision 作为乐观锁，冲突时返回 409 storage_configuration_conflict。激活本地 Profile 前必须验证本地目录可写。

### 7.5 存量迁移

- POST /shared-file-storage/migrations
- GET /shared-file-storage/migrations/:migration_id
- POST /shared-file-storage/migrations/:migration_id/retry-failed
- POST /shared-file-storage/migrations/:migration_id/cancel

权限：console:shared_files:storage_migrate

创建请求：

~~~json
{
  "source_profile_id": "shared_files_local_default",
  "target_profile_id": "storage_profile_01"
}
~~~

同一源 Profile 同一时间只允许一个未结束迁移任务。初版支持本地与 OSS 双向迁移，不允许源和目标相同。

### 7.6 错误码

| HTTP | 错误码 | 语义 |
| --- | --- | --- |
| 400 | invalid_storage_configuration | Endpoint、Bucket、Prefix 或凭据字段不合法 |
| 403 | storage_operation_forbidden | 当前账号没有存储管理权限 |
| 409 | storage_configuration_conflict | 配置 revision 冲突 |
| 409 | storage_profile_in_use | 尝试修改已有文件引用的定位字段 |
| 409 | storage_migration_running | 已存在冲突的迁移任务 |
| 502 | storage_probe_failed | OSS 可达但读写或权限测试失败 |
| 503 | storage_unavailable | 文件所在存储或激活存储不可用 |

现有文件接口继续使用现有 storage_unavailable 对外语义，不向客户端暴露 OSS 供应商错误细节。

## 8. RBAC 与审计

在 server/internal/rbac/catalog.go 和 server/web/src/lib/rbac-api.ts 新增：

- console:shared_files:storage_read：查看存储类型、脱敏配置、容量和健康状态。
- console:shared_files:storage_manage：测试、创建、修改、退役和激活存储 Profile。
- console:shared_files:storage_migrate：发起、取消和重试存量迁移。

新权限默认只赋予内置超级管理员角色，不随现有 console:shared_files:manage 自动下放。

以下操作必须记录操作人、请求 ID、对象 ID、结果和时间：

- OSS 配置测试。
- Profile 创建、修改、凭据轮换和退役。
- 激活存储变更，并记录变更前后 Profile ID。
- 迁移任务创建、取消、重试和最终统计。

审计数据不记录 AccessKey、密文、OSS 签名、完整对象键或文件内容。

## 9. 管理台设计

在现有 /admin/shared-files 页面头部增加“存储配置”入口，仅对具备 storage_read 权限的管理员显示。新页面路由为 /admin/shared-files/storage。

页面包含：

1. 当前激活存储：类型、名称、健康状态、文件数和容量。
2. 本地存储：只读展示，提供连通性检查和激活操作。
3. OSS Profile：Endpoint、Region、Bucket、Prefix、凭据方式、脱敏凭据状态。
4. 操作：测试连接、保存配置、激活、轮换凭据、退役。
5. 存量迁移：源、目标、进度、成功/失败/跳过数、取消和重试失败项。

交互约束：

- 激活存储必须二次确认，文案明确说明“仅影响后续上传和替换，不自动迁移已有文件”。
- 连通性测试未通过时不提供可执行的激活操作。
- 凭据输入默认不回显，不提供“查看原凭据”功能。
- 页面轮询迁移状态，离开页面不影响后台任务。
- 不在文件列表向普通用户展示存储 Provider，该信息只属于运维与管理面。
- Endpoint、Bucket 或 Prefix 已锁定时，表单应只读展示并引导创建新 Profile。

## 10. 存量迁移执行流程

### 10.1 任务初始化

1. 验证源和目标 Profile 存在且未退役。
2. 对目标 Profile 执行 Probe。
3. 快照源 Profile 当前文件的 file_id、storage_key、revision、size_bytes、sha256，写入迁移明细。
4. 提交任务后返回 migration_id，文件搬运异步执行。

### 10.2 单文件迁移

~~~text
锁定待执行明细
  -> 从源 Profile 打开文件
  -> 以新 Object Key 写入目标 Profile
  -> 验证 size + SHA-256
  -> 条件更新 shared_files 存储引用
  -> 删除源对象
  -> 标记明细成功
~~~

条件更新必须同时匹配：

- file_id。
- source_profile_id。
- source_storage_key。
- source_revision。

如果不匹配，表示文件在迁移期间被用户替换或已被其他任务处理。此时删除本次新写入的目标对象，并将明细标记为 skipped，不得覆盖新版本。

迁移只修改物理存储引用，不增加文件 revision，不修改 updated_by_* 和业务 updated_at。

数据库更新成功后源对象删除失败时，文件仍视为迁移成功，迁移明细标记为 succeeded，同时创建 cleanup task 由补偿 Worker 重试删除；不能将数据库指针切回源存储。

### 10.3 任务调度

- Worker 使用 PostgreSQL FOR UPDATE SKIP LOCKED 领取明细，支持多 Gateway 实例且避免重复搬运。
- 初始并发数为 2，作为代码常量；本期不在后台开放任意调节。
- running 明细保存心跳时间，超过租约时间未更新时可被重新领取。
- 单文件自动重试最多 3 次，使用有上限的退避；鉴权、配置、摘要不一致等非暂时错误不自动重试。
- Gateway 重启后恢复未完成任务。
- 取消只阻止领取新明细，已在执行的单文件完成当前原子流程后停止。
- 重试失败项时复用原 migration_id，并为失败明细增加 attempt_count，不重新创建已成功项。

## 11. 并发与一致性

### 11.1 配置切换

- 每次上传在写入前读取一次 active_profile_id，并固定为该请求的目标。
- 上传进行期间即使管理员切换配置，本次上传仍提交到开始时选定的 Profile。
- active_profile_id 使用 settings.revision 乐观锁更新，两个管理员并发切换时只有一个成功。

### 11.2 文件替换

- 保持当前 expected_revision 乐观锁。
- 数据库替换成功后返回事务中实际读取到的旧 ObjectRef，不能使用事务外的旧文件快照做删除依据。
- 新对象在数据库提交前不得替换或删除旧对象。

### 11.3 迁移与正常写入

- 迁移通过 file_id + Profile + storage_key + revision 条件更新，避免覆盖并发上传的新版本。
- 迁移目标 Object Key 使用新的 blob_id，不复用源 Key，便于失败补偿和审计。
- 迁移跳过的文件可在后续新任务中再次纳入，但当前任务不循环追赶新版本。

## 12. 失败语义与可观测性

### 12.1 失败语义

- 新对象写入失败：不写数据库。
- 新对象写入成功、数据库失败：同步删除新对象；删除再次失败时创建 cleanup task。若此时数据库同时不可用导致任务无法写入，必须记录 critical 日志和指标，供运维按 profile_id、file_id 和请求 ID 核查。
- 替换成功、删除旧对象失败：新版本仍成功，旧对象进入持久化 cleanup task。
- 读取文件时对应 Profile 不可用：返回 503 storage_unavailable，不到其他 Profile 猜测查找。
- OSS 激活后故障：管理员可切回本地恢复新写入；已在 OSS 的文件仍需 OSS 恢复后才能读取。
- Profile 凭据解密失败：返回存储不可用并产生安全级别告警，不把加密错误返回客户端。

Cleanup Worker 与迁移 Worker 使用相同的数据库租约模式，重试有上限退避。达到自动重试上限后保留 failed 记录并产生告警，管理员或运维任务可再次触发重试。

### 12.2 日志和指标

结构化日志字段：

- request_id、operation、provider、profile_id。
- file_id、space_id；不记录完整对象键。
- duration_ms、size_bytes、result、error_code。
- 迁移日志增加 migration_id、migration_item_status。

建议指标：

- 按 Provider 区分的上传、下载、删除次数、字节数、延迟和失败数。
- OSS Probe 最后成功时间与连续失败次数。
- 迁移待处理、成功、失败、跳过和待清理数。
- 各 Profile 文件数和总容量。

日志与指标失败不得影响文件主流程。

## 13. 兼容性与发布策略

### 13.1 向后兼容

- 数据库迁移将现有文件全部绑定本地 Profile，不搬运或重命名本地文件。
- 未创建 OSS Profile 时，行为与当前版本一致。
- App 端和管理端现有文件列表、上传、替换、下载 API 不新增必填字段。
- storage_profile_id、OSS Endpoint、Bucket 和 Object Key 不进入 App 端文件响应。
- client/apps/web、client/apps/daemon、client/apps/desktop 和 client/packages/protocol 预计无需改动。

### 13.2 分阶段交付

第一阶段：存储基础与 OSS 切换

- 数据库 Profile 和文件归属迁移。
- StorageRegistry、本地兼容实现和 AliyunOSSStorage。
- 存储配置、Probe、激活 API 与管理台页面。
- RBAC、审计和脱敏日志。

第二阶段：存量迁移

- 迁移任务表、后台 Worker、CAS 切换和垃圾清理。
- 迁移进度页面、取消和失败重试。
- 运维验证与本地持久卷下线流程。

第一阶段上线后已经可以安全地将新写入切换到 OSS，但在第二阶段完成前不得下线存放旧文件的本地持久卷。

### 13.3 回滚

- 业务回退：将激活 Profile 切回本地，只影响新写入。
- 数据回退：通过反向迁移任务将 OSS 文件迁回本地，不手工修改数据库 Profile ID。
- 版本回退：一旦有文件写入 OSS，不得直接回退到不识别 storage_profile_id 的旧版本。必须先完成反向迁移并确认所有文件均在本地 Profile。

### 13.4 备份与恢复

- 本地模式：继续同时备份 PostgreSQL、共享文件目录和配置加密密钥。
- OSS 模式：同时备份 PostgreSQL、OSS Bucket 数据及配置加密密钥。
- 恢复时必须保持数据库快照、对象数据和加密密钥来自一致的备份点。
- 建议客户启用 OSS 版本控制或跨区域复制，但这属于部署能力，不由 Clawee 自动开启。
- 任何情况下都不能只恢复数据库而忽略文件对象，也不能只恢复对象而丢失 Profile 配置。

## 14. 代码改动范围

### 14.1 Gateway

预计新增或调整：

- server/internal/sharedfiles/storage.go：调整存储接口，保留本地实现。
- server/internal/sharedfiles/oss_storage.go：OSS 实现。
- server/internal/sharedfiles/storage_registry.go：Profile 解析和存储客户端管理。
- server/internal/sharedfiles/storage_config_service.go：配置校验、探测、激活和凭据加解密。
- server/internal/sharedfiles/storage_migration.go：存量迁移 Worker。
- server/internal/sharedfiles/storage_cleanup.go：对象删除补偿 Worker。
- server/internal/sharedfiles/store.go 和 postgres_store.go：增加 Profile、Settings、迁移任务和 ObjectRef 存取。
- server/internal/sharedfiles/types.go：增加 Profile、配置、迁移和错误类型。
- server/internal/sharedfiles/service.go：改为通过 Registry 选择存储。
- server/internal/server/shared_file_storage_http.go：管理 API。
- server/internal/server/shared_files_http.go：调整 Service 注入和错误映射，保持现有客户端契约。
- server/internal/app/app.go：组装 Storage Store、Registry、OSS Client Factory 和迁移 Worker。
- server/internal/config/config.go：增加 allowed_endpoint_hosts 配置与校验。
- server/internal/rbac/catalog.go：新增存储管理权限。
- server/db/migrations/00049_shared_file_storage_profiles.sql：数据库调整。
- server/configs/config.example.yaml 及部署文档：补充 Endpoint 允许列表、RAM 权限和备份恢复说明。
- server/go.mod 和 server/go.sum：只增加选定的阿里云官方 OSS Go SDK 及其必要间接依赖。

Storage Profile、迁移 Job 和文件 Store 可以继续位于 sharedfiles 包内，不为本需求拆分新服务。OSS SDK 应隔离在 oss_storage.go 和客户端工厂中，不能渗透到 Service、HTTP 或数据库层。

### 14.2 管理台

- server/web/src/lib/shared-file-storage-api.ts：存储配置和迁移 API。
- server/web/src/pages/shared-file-storage.tsx：存储配置页面。
- server/web/src/pages/shared-files.tsx：新增存储配置入口。
- server/web/src/app.tsx：新增路由和权限门禁。
- server/web/src/lib/rbac-api.ts：新增权限常量。
- 对应的 API、页面和交互测试文件。

### 14.3 不应改动

以下组件的现有协议能够覆盖本方案，不应为暴露存储实现细节而修改：

- client/apps/web。
- client/apps/daemon。
- client/apps/desktop。
- client/packages/protocol。

只有在实施时发现现有 Gateway 文件 API 契约无法保持时，才重新评审客户端改动，不能预先把 Provider、Bucket 或 Object Key 下放到客户端。

## 15. 测试计划

### 15.1 Storage Contract 单元测试

本地和 OSS 实现复用同一套行为测试：

- 上传、打开、删除和重复删除。
- 空文件、单分片、多分片、1 GiB 上限边界和超限拒绝。
- 声明大小不一致、SHA-256 计算和请求取消。
- Multipart 任一分片失败时 Abort。
- 对象不存在、超时、权限不足、限流和服务端错误的错误映射。
- Probe 成功、写失败、读失败、校验失败和删失败。
- OSS SDK 请求不携带未声明的自定义 Host。

OSS 单元测试使用可注入的 SDK Client 接口或受控 HTTP 测试服务，不直接依赖公网。

### 15.2 Service 和 Store 测试

- 默认使用本地 Profile。
- 切换 OSS 后新文件写入 OSS，旧本地文件仍可读。
- 切换后替换本地旧文件，新版本在 OSS，旧对象从本地删除。
- OSS 写入成功但数据库创建或替换失败时清理 OSS 对象。
- 清理失败时产生持久化 cleanup task。
- 配置乐观锁冲突。
- 目标字段锁定与凭据就地轮换。
- 文件正在被替换时迁移 CAS 失败并安全跳过。
- Worker 重启恢复、多 Worker 互斥、失败重试和取消。
- 迁移不修改文件 revision、更新时间和业务更新人。
- Profile 退役后已有文件仍可读，但不能再作为新写入或新迁移目标。

PostgreSQL 集成测试必须使用隔离测试数据库。

### 15.3 HTTP 和管理台测试

- 三个新权限的允许与拒绝路径。
- API 响应不包含凭据密文或明文。
- 通用请求日志和错误日志不记录测试/保存接口的请求体。
- 非 HTTPS、未授权 Host、带 UserInfo、Query 或 Fragment 的 Endpoint 被拒绝。
- Probe 失败时不能保存为可用 Profile 或激活。
- 激活 expected_revision 冲突返回 409。
- 激活确认文案和凭据 keep/replace 交互。
- Endpoint、Bucket 和 Prefix 锁定后的只读状态。
- 迁移进度、失败重试和取消状态展示。
- 现有客户端共享网盘 API 回归测试全部通过。

### 15.4 OSS 集成验证

在独立测试 Bucket 和每次测试的随机 Prefix 中验证：

- 小文件与 Multipart 上传。
- 上传、下载、删除及 SHA-256 一致。
- 中断上传后不留未完成 Multipart。
- RAM Role 与 AccessKey 两种模式。
- 内网 Endpoint，如测试环境支持。
- AccessKey 轮换后旧客户端缓存失效。

凭据通过仓库外环境变量注入，不写入测试代码、快照和 CI 日志。测试结束后只删除本次随机 Prefix，不对 Bucket 执行宽范围删除。

## 16. 验收标准

### 16.1 默认本地存储

- 全新部署不配置 OSS 时，可正常上传、替换和下载共享文件。
- 升级前已有文件在升级后内容、大小、SHA-256 和 revision 不变。
- 未配置 OSS 不产生 OSS 网络请求，不影响 Gateway 其他能力。
- 当前 shared_files.storage_root 配置继续生效。

### 16.2 OSS 配置与切换

- 管理员可完成 OSS 配置、Probe 和激活，全过程不重启 Gateway。
- 无存储管理权限的管理员不能读取脱敏配置或执行切换。
- 激活 OSS 后上传的新文件实际存在于指定 Bucket/Prefix，且数据库记录对应 Profile。
- 激活 OSS 前上传的本地文件仍可正常下载。
- 切回本地后新写入回到本地，OSS 已有文件仍可读取。
- OSS 不可用时新写入明确失败，不在本地产生静默副本。
- 多 Gateway 实例同时运行时，切换后的下一次新上传使用新 Profile。

### 16.3 存量迁移

- 迁移完成后，目标 Profile 中的文件数、总字节数及每个文件的 SHA-256 与源数据一致。
- 迁移中断并重启 Gateway 后可继续执行，不重复覆盖已完成文件。
- 迁移期间用户替换文件不会被迁移任务覆盖或删除。
- 所有失败项都可在管理台查看脱敏原因并重试。
- 数据库可用时的清理失败有持久化记录且可自动重试，不只存在于日志；数据库与存储同时失败时有 critical 日志和指标告警。
- 源 Profile 文件数为零、失败数和待清理数均为零并完成备份验证后，才允许运维人员下线原本地持久卷或退役 OSS Profile。

### 16.4 安全与运维

- 源码、配置响应、浏览器网络响应、日志和审计中均不出现 OSS 凭据明文或密文。
- 未授权 Endpoint 和非 HTTPS Endpoint 无法保存或测试。
- Bucket 保持私有，未经 Gateway 授权不能访问文件。
- RAM 权限限定到目标 Bucket/Prefix，不具备 Bucket 管理权限。
- 数据库、存储对象和加密密钥的备份/恢复流程通过演练。

## 17. 开发任务拆分与完成定义

### 17.1 第一阶段：新写入切换 OSS

1. 数据库与领域模型：完成 00049 迁移、Profile/Settings Store、shared_files.storage_profile_id 和迁移测试。
2. 存储契约：调整 Storage 接口，使现有本地存储通过共享 Contract 测试。
3. OSS 存储：实现凭据模式、Endpoint 校验、Put/Open/Delete/Probe 和 Multipart 清理。
4. 路由与文件服务：实现 StorageRegistry，改造上传、替换、下载和持久化补偿逻辑。
5. 配置管理：实现 Profile 校验、Probe、凭据加密、乐观锁激活和审计。
6. RBAC 与管理 API：新增三个存储权限及 HTTP 契约测试。
7. 管理台：完成存储状态、OSS 配置、测试、激活和凭据轮换流程。
8. 文档与回归：补充部署文档、RAM 权限示例、升级和回退限制。

第一阶段完成定义：

- 默认本地和混合存储读写测试通过。
- 实际测试 OSS Bucket 的上传、下载、删除和故障路径通过。
- 管理台可在不重启 Gateway 的情况下完成切换。
- 运行根目录 pnpm server:test 通过。
- 运行根目录 pnpm server:build 通过。
- 完成凭据、日志和构建产物的脱敏扫描。

### 17.2 第二阶段：存量迁移

1. 完成迁移任务和明细表。
2. 完成 Worker、租约、重试、取消和重启恢复。
3. 完成文件存储引用 CAS 切换和持久化 cleanup task 补偿。
4. 完成迁移 API、管理台进度与失败重试。
5. 完成本地到 OSS、OSS 到本地及并发替换集成测试。
6. 完成备份恢复、反向迁移和本地持久卷下线演练。

第二阶段完成定义：

- 第 16.3 节所有验收项通过。
- 迁移过程不阻塞正常文件上传和下载。
- 迁移中断、Gateway 重启和 OSS 短暂故障后可恢复。
- 源对象清理失败不会造成文件不可读或丢失追踪记录。
- pnpm server:test 和 pnpm server:build 通过。

任务 1 至 8 完成后可交付“新写入切换 OSS”；第二阶段完成后才可交付“存量文件全量迁移并下线原存储”。
