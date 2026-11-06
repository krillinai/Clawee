# 服务端 Agent 的 Skill 使用前权限检查方案

> 日期：2026-10-14。
>
> 本次范围：实现 Gateway 权限查询接口与调用者 RBAC 权限，补接口测试。本文同时定义后续 daemon 内部工具及 Skill 指令的开发、部署和验收要求；后两者本次尚未实现。
>
> 本地验证：Go 1.25.0 下，`internal/server`、`internal/rbac`、`internal/skillhub` 包测试通过；未运行 PostgreSQL 集成测试，不代表已部署或完成 Agent 联调。
>
> 方案定位：低成本软约束。Gateway 负责可靠查询权限，Agent 按 Skill 指令决定是否继续。本文不承诺防绕过、逐次强制拦截或任务执行期间撤权立即生效。

## 1. 目标和范围

本地 Agent 经 Gateway 向服务端 Agent 提交任务。服务端 Agent 准备使用受管理 Skill 时，查询任务发起者是否有该 Skill 的读取权限；只有明确允许才继续使用。

第一版固定采用以下口径：

- 目标账户处于 active 状态，且现有 `CheckSkillRead(user_id, skill_id)` 成功，即允许使用。
- 目标账户缺失或停用、Skill 缺失或无读取权限，返回明确拒绝。
- 权限查询故障、身份缺失、工具不可用，Agent 应停止使用该 Skill，不把“无法判断”解释成允许。
- 同一个 Run 内，同一个 Skill 由指令要求首次使用前检查一次；新的 Run 重新检查。第一版不实现服务端结果缓存或去重。
- 沿用现有 Skill 空间权限判定，包括已有的账户、角色授权及默认空间兼容规则，不再要求目标账户持有 `console:skill:read`。
- 不额外检查当前发布版本、版本摘要或本地安装包完整性。取消发布不等于撤销空间读取权限，不能依赖本接口阻止已安装 Skill 的使用。

本期不做：独立 execute 授权模型、Runtime 修改、沙箱隔离、按用户复制 Skill 目录、统一 Skill 执行器、授权后台新页面、权限检查统计和审计专表。

## 2. 调用链和身份边界

```text
本地 Agent
  -> Gateway 认证账户和 Agent 归属
  -> 提交服务端 Agent 任务，传入可信调用者身份
  -> daemon 保存 initiatorUserId / initiatorAgentId
  -> 模型读取 Skill 前置要求
  -> 调用 check_skill_permission(skill_id)
  -> daemon 从内部能力 Token 确定当前 runId
  -> daemon 从运行记录读取 initiatorUserId
  -> daemon 使用自身 Gateway 会话查询权限
  -> 模型仅在 allowed=true 时继续使用 Skill
```

必须区分两个账户：

| 身份 | 来源 | 用途 |
| --- | --- | --- |
| 查询调用者 | 服务端 Agent 自身的 Gateway 会话 | 证明有权调用代查接口 |
| 被检查用户 | 当前 Run 的 `initiatorUserId` | 判定是否有指定 Skill 的读取权限 |

Gateway 不接收也不验证 daemon 本地 `run_id`，不会自动知道某个 user_id 是哪条任务的发起者。具备代查权限的调用者可查询指定用户；保证 user_id 来自当前任务记录，是 daemon 的责任。

现有任务接收端从 `X-Claw-User-ID` / `X-Claw-Agent-ID` 取身份，外层验证 daemon Bearer Token。部署必须保证提交身份的上游可信，普通客户端不能凭持有该 Token 直接伪造这些头。本接口不补建任务身份签名机制，也不替代该部署边界。

## 3. Gateway 接口契约（本次实现）

### 3.1 路由与认证

```http
POST /api/v1/app/skills/permission-check
Authorization: Bearer <服务端 Agent 的 Gateway frontend 会话 JWT>
Content-Type: application/json
```

接口挂载在现有 app API 下，复用 frontend 会话认证和 Clawee Agent 绑定检查；也沿用该路由组已有的 frontend 会话 Cookie 支持。daemon 接入使用自身登录会话，不新增共享服务密钥。

这里需要的是 frontend audience 的会话 JWT，不是 `/mcp` 使用的账户 MCP Token，也不是 daemon 接收任务用的本地 Token。凭据继续由 daemon 现有企业会话管理保管，不写入 Skill，不让模型通过 Shell 拼接请求。

调用者必须持有新增 RBAC 权限：

```text
console:skill:permission_check
```

权限目录展示名称为“代查技能使用权限”。普通 Skill 读取权限不包含代查权限；调用者即使查询自己，也需要该代查权限。现有 `console:skill:manage` 依照模块 manage 展开规则包含此权限，系统管理员同样具有此权限。部署时建议为服务端 Agent 账户分配仅包含代查权限的专用角色，不为此授予全部 Skill 管理权限。

新增权限只控制“谁能查别人的权限”，不授予被检查用户任何 Skill 权限。无需新增数据库表或迁移，也不会自动给普通账户分配该权限。

### 3.2 请求

```json
{
  "user_id": "usr_example",
  "skill_id": "skill_example"
}
```

| 字段 | 要求 | 来源 |
| --- | --- | --- |
| `user_id` | 必填字符串，去除首尾空白后 1～128 字节 | daemon 当前 Run 的发起者 |
| `skill_id` | 必填字符串，去除首尾空白后 1～128 字节 | Gateway Skill 的稳定 ID |

请求体最多 16 KiB。拒绝未知字段、错误类型、空值、缺失字段、超长字段、无效 JSON 和多个连续 JSON 值。没有 action、version_id、agent_id 或 run_id 字段；第一版不提供批量查询。

### 3.3 正常响应

HTTP 200 表示检查完成，不表示允许。必须读取 `data.allowed`。

```json
{
  "data": {
    "user_id": "usr_example",
    "skill_id": "skill_example",
    "allowed": true,
    "reason": "allowed"
  }
}
```

| `allowed` | `reason` | 含义 |
| --- | --- | --- |
| true | `allowed` | 目标账户有效，Skill 读取检查通过 |
| false | `account_unavailable` | 目标账户不存在或非 active |
| false | `skill_read_denied` | Skill 不存在或目标账户无读取权限 |

未知 Skill 与未授权 Skill 不通过 reason 区分；不存在与停用账户也不区分。返回值不包含姓名、角色清单、空间成员、Skill 内容或脚本路径。进入检查处理函数后的响应设置 `Cache-Control: no-store`。

### 3.4 错误响应

沿用现有 Gateway 统一错误格式：

```json
{
  "error": {
    "code": "forbidden",
    "message": "无权执行该操作",
    "details": []
  }
}
```

| HTTP 状态 | 错误码 | 处理要求 |
| --- | --- | --- |
| 400 | `invalid_request` | 修正请求，不按权限拒绝或允许解释 |
| 401 | `unauthorized` | 调用者会话无效，沿用已有重新登录流程 |
| 403 | `forbidden` | 调用者没有代查权限，不是目标用户的 Skill 判断结果 |
| 403 | `agent_forbidden` | 调用者 Clawee Agent 绑定或状态无效 |
| 503 | `authorization_unavailable` | RBAC 服务未配置，不能完成代查鉴权 |
| 500 | `internal_error` 等现有错误码 | 认证、权限或账户查询故障，不允许继续使用 Skill |

缺少 Skill Hub 或账户服务时，沿用 Skill 路由不挂载的行为，可能返回 404；工具应将此视为检查不可用。网络超时、非 2xx、响应不符合契约均为检查失败。只接受 HTTP 200 且 `data.allowed` 严格为布尔 true，不做字符串或数字真值转换。

### 3.5 代码落点

| 文件 | 职责 |
| --- | --- |
| `server/internal/rbac/catalog.go` | 注册代查权限 |
| `server/internal/server/skillhub_http.go` | 挂载路由及权限中间件 |
| `server/internal/server/skill_permission_http.go` | 请求校验、目标账户检查、调用 `CheckSkillRead`、返回结果 |
| `server/internal/server/skill_permission_http_test.go` | HTTP 契约与权限边界测试 |
| `server/internal/skillhub/spaces.go` | 复用原有读取权限判定，不新增执行授权实现 |

## 4. daemon 内部工具（后续开发）

新增工具：

```text
check_skill_permission(skill_id: string)
```

工具参数只包含 skill_id，不接受 user_id、run_id 或 Gateway Token。服务端处理按以下顺序执行：

1. 复用内部能力 Token 机制，确定当前授权运行的 runId；添加专用于该工具的 scope，并在该运行的工具清单中暴露它。
2. 查询当前 Run 记录，读取 `initiatorUserId`。缺失时返回 `SKILL_PERMISSION_CHECK_UNAVAILABLE`，不退回服务端 Agent 自身账户。
3. 使用现有企业会话及 HTTP 客户端调用第 3 节接口，设置有限超时，例如 5 秒。第一版不添加自动重试、检查结果缓存或后台去重。
4. 检查响应状态、allowed 的布尔类型和回传 user_id / skill_id 是否匹配。只把正常检查结果转成工具结果；故障返回检查不可用。
5. 工具正常结果只向模型暴露 `skill_id`、`allowed`、`reason`，不必暴露 user_id。错误说明使用简短中文，不输出 Token、底层数据库错误或响应中的敏感字段。

可复用的现有边界：

| 文件 | 后续接入点 |
| --- | --- |
| `client/apps/daemon/src/agent-tools/capability-token.ts` | 能力 scope 和 runId 绑定；持久进程激活、失活机制 |
| `client/apps/daemon/src/agent-tools/run-injection.ts` | 内部 MCP 工具注入、当前运行能力分配 |
| `client/apps/daemon/src/agent-tools/mcp-routes.ts` | 现有内部 MCP 路由模式 |
| `client/apps/daemon/src/agent-tools/stdio-server.ts` | 现有内部 MCP 工具注册模式 |
| `client/apps/daemon/src/api/server.ts` | 组装运行记录、会话、HTTP 客户端和工具依赖 |
| `client/apps/daemon/src/storage/repositories.ts` | 查询运行身份字段 |

优先扩展现有内部工具通道，不新增一个仅为查询权限存在的常驻 MCP 服务。持久 Runtime 复用时，必须通过当前激活的能力授权定位 runId，不用进程启动时固定的 user_id 或共享环境变量保存本次发起者身份。

## 5. Skill 前置指令（后续开发）

受管理 Skill 开头增加以下约定：

```markdown
## 使用前检查

本任务首次使用本技能前，必须调用
check_skill_permission(skill_id="实际的稳定技能ID")。
仅当返回 allowed=true 时才能继续使用本技能。
若权限被拒绝、检查失败或工具不可用，停止使用本技能，
向用户说明原因，不得把检查失败当作授权通过。
```

skill_id 必须对应 Gateway 记录，不能使用显示名称、目录名或版本号替代。已有 Skill 由维护者按实际 ID 更新指令并正常发布、更新安装；第一版不在所有安装包上自动重写 SKILL.md，以免改变既有摘要、审批和包完整性语义。

该指令适用于服务端 Agent 中需要本方案约束的 Skill，不自动要求所有用户设备上的本地 Skill 联网鉴权。工具未接入前不要将含此指令的版本投入服务端业务执行，否则按约定应停止使用。

模型可能遗漏或跳过指令，也可能直接读取其他文件或复用已获取内容。本方案接受这种局限，不增加目录隔离或 Shell 拦截。发生 allowed=false 时，期望停止该 Skill，不要求无条件终止整个任务；其他允许的处理路径仍可继续。

## 6. 开发和部署顺序

1. Gateway 接口、权限目录与接口测试：本次实现；先部署服务端，不影响尚未调用接口的现有任务。
2. 创建专用角色，将 `console:skill:permission_check` 授予服务端 Agent 的 Gateway 账户。目标员工的 Skill 读取权限仍通过现有空间授权配置。
3. 实现内部工具、runId 到发起者身份的解析及工具测试，覆盖单次进程和持久 Runtime。修改客户端执行代码后运行 `desktop:preflight:local`。
4. 选一个 Skill，增加真实 skill_id 的前置指令，正常发布并更新服务端安装版本。
5. 完成一次授权允许、一次授权拒绝、一次 Gateway 不可用的真实 Agent 联调，再逐个接入其他受管理 Skill。

回退时先恢复不含前置指令的 Skill 版本，再移除工具；查询接口与专用权限可暂时保留，它们不主动影响现有任务。整个过程无需新增或手改运行数据库结构。

## 7. 验收要求

### 7.1 Gateway 自动化测试

- 未登录或无效 Token 返回 401；普通账户和只有 `console:skill:read` 的账户返回 403。
- 只有代查权限的调用者可以完成查询，不要求其拥有目标 Skill 的空间权限。
- 调用者自己可读 Skill，不会使无权限的目标用户得到 allowed=true。
- 目标用户拥有读取权限时允许；移除授权后的下一次查询拒绝。
- 目标账户缺失或停用、Skill 缺失或读取未授权时返回明确拒绝。
- 未发布 Skill 的判断仍只遵循读取权限，不意外加入发布状态门禁。
- 未知字段、错误类型、空白 ID、超长 ID、超大请求体和连续 JSON 被拒绝。
- 账户或 Skill 权限查询故障返回 5xx，不泄露原始错误，不伪造正常检查结果。

测试使用内存账户、RBAC 和 Skill Store，不连接生产数据库。定向命令：

```sh
cd server
GOTOOLCHAIN=go1.25.0 go test ./internal/server -run '^TestSkillPermissionCheck' -count=1
env -u CLAW_GATEWAY_TEST_DATABASE_URL GOTOOLCHAIN=go1.25.0 go test ./internal/server ./internal/rbac ./internal/skillhub -count=1
```

### 7.2 daemon 和 Agent 后续验收

- 工具无 user_id 参数；并发任务和持久进程复用不会串用发起者。
- 缺失发起者、未登录、无代查权限、超时、响应异常均返回检查不可用，不执行身份回退。
- Agent 正常遵循指令，明确允许后继续，拒绝或故障后停止该 Skill。
- 新任务重新检查；不承诺同一任务中途撤权立即拦截。
- 不把“观测到一次检查”或“未观测到使用”作为已经实现强制授权的证明。
