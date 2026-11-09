# 客户级 Agent 提示词管理方案

> 日期：2026-10-30。  
> 状态：方向已确认，作为首版开发与验收依据；本文不代表功能已经实现。  
> 原则：每套 Gateway 对应一个客户部署，不引入 `tenant_id`、客户选择器或第二套提示词系统。

## 1. 目标

让私有化部署可以由 Gateway 统一维护两段客户补充提示词：

1. **服务端 Agent 提示词**：控制服务端 Agent 的业务默认行为。
2. **Clawee Agent 提示词**：下发给本地 Clawee Agent，承担客户专用 `AGENTS.md` 的作用。

提示词更新后，新建 Agent 会话即可使用新内容；现有会话继续使用创建时加载的内容。

## 2. 范围与明确不做

本期只支持一套 Gateway 配置中的两个目标：`server_agent` 和 `clawee_agent`。

不做以下能力：

- `tenant_id`、客户列表或多客户切换；
- 用户级、单个 Agent 级覆盖；
- 条件规则、规则编排、优先级 DSL；
- 每轮任务请求 Gateway；
- 推送、长轮询或 WebSocket 配置同步；
- 将提示词写入用户项目目录中的真实 `AGENTS.md`。

空提示词表示该目标不启用客户补充规则。没有客户配置时，现有行为保持不变。

## 3. 现有代码落点

当前 Runtime 已在 `client/apps/daemon/src/codex/app-server-host-2026-07-28.ts` 的 `claweeDeveloperInstructions` 统一生成开发者指令：

- 服务端模式会加载 `client/apps/daemon/resources/server-agent/AGENTS.md`；
- 普通 Clawee Agent 使用同一个入口注入 Clawee 基础规则；
- Codex `thread/start` 和 `thread/resume` 都在这里传入 `developerInstructions`。

本方案沿用这条链路，不新增独立的 Prompt Runtime。Gateway 侧沿用现有企业会话、Agent 身份和管理台权限。

## 4. Gateway 配置

### 4.1 数据表

新增一张单例表，例如 `agent_prompt_policy`，通过 Gateway 数据库迁移创建：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `text` | 固定为 `default`，保证整套部署只有一行 |
| `version` | `bigint` | 任一提示词修改后递增 |
| `server_agent_prompt` | `text` | 服务端 Agent 补充提示词，默认空字符串 |
| `clawee_agent_prompt` | `text` | Clawee Agent 补充提示词，默认空字符串 |
| `updated_by_user_id` | `text` | 最后修改人，可为空 |
| `created_at`、`updated_at` | 时间戳 | 标准时间字段 |

保存时同时更新两段文本；只修改一段时，另一段也按完整请求写回。服务端限制单段文本长度，拒绝明显超限输入。提示词内容不能包含凭据、Token 或其他秘密。

### 4.2 管理接口

沿用现有管理端 API 约定：

```text
GET /api/v1/admin/agent-prompt-policy
PUT /api/v1/admin/agent-prompt-policy
```

`GET` 返回当前两段文本、`version` 和 `updated_at`。

`PUT` 请求体：

```json
{
  "server_agent_prompt": "...",
  "clawee_agent_prompt": "..."
}
```

成功保存后 `version` 加一并返回最新配置。接口使用现有 `agent_management` 功能开关和 `console:agent:manage` 权限，写入沿用现有管理审计能力。

### 4.3 Agent 读取接口

新增一个应用侧读取接口：

```text
GET /api/v1/app/agent-prompt-policy
```

沿用现有企业 Agent 会话认证。返回两段提示词及版本：

```json
{
  "data": {
    "version": 3,
    "server_agent_prompt": "...",
    "clawee_agent_prompt": "...",
    "updated_at": "2026-10-30T10:00:00Z"
  }
}
```

Daemon 一次读取并缓存两段内容，实际注入时根据 `serverDeployment` 选择对应字段。读取失败返回明确错误，但不影响使用本地缓存或内置规则。

建议的服务端落点：新增 `server/internal/agentprompt/` 保存模型和存储逻辑，在 `server/internal/server/` 挂载管理与应用路由；不要把配置读取逻辑放进 MCP 代理或管理台前端。

## 5. Daemon 本地缓存与会话边界

### 5.1 Gateway 实例缓存

Daemon 按规范化后的 `enterpriseOrigin` 保存缓存，缓存对象包含：

```ts
type AgentPromptPolicyCache = {
  gatewayOrigin: string;
  version: number;
  serverAgentPrompt: string;
  claweeAgentPrompt: string;
  fetchedAt: string;
};
```

缓存应复用 daemon 现有本地持久化状态，按 Gateway 地址隔离。写入必须在完整响应校验通过后进行，不能用半截或格式错误的响应覆盖最近一次成功缓存。

首期可以在现有 daemon SQLite 中增加按 `gateway_origin` 唯一的小表，并通过现有迁移机制创建；不新增远程同步服务。

### 5.2 触发拉取

在以下事件拉取一次最新配置：

1. 用户登录成功；
2. Gateway 会话重新建立；
3. 创建新的 Codex Agent 会话，即即将发送 `thread/start`。

`thread/resume` 不拉取 Gateway，也不读取可能已经更新的全局配置。

拉取失败时沿用最近一次成功缓存；没有缓存时对应字段使用空字符串，最终只注入内置规则。网络失败不能阻断普通任务启动。

企业会话生命周期的触发可接在 `client/apps/daemon/src/enterprise/session-manager-2026-07-30.ts` 的认证成功/重建回调；HTTP 方法放入 `client/apps/daemon/src/enterprise/http-client-2026-07-30.ts`。

### 5.3 当前会话固定提示词

创建新 Agent 会话时，从当前缓存生成一份不可变的 `AgentPromptPolicySnapshot`，绑定到本地 Runtime thread：

```ts
type AgentPromptPolicySnapshot = {
  version?: number;
  serverAgentPrompt: string;
  claweeAgentPrompt: string;
};
```

- `thread/start`：拉取一次、生成快照、保存快照并传入 Runtime；
- `thread/resume`：读取该 thread 已保存的快照，始终复用；
- Gateway 后续更新只影响新建 thread，不改变已有会话。

为满足 daemon 重启后的 thread 恢复，建议在现有 `threads` 表增加一个可空的 `agent_prompt_policy_json` 字段，保存创建该 thread 时的快照；不保存多个历史版本，也不另建版本服务。旧 thread 没有快照时，使用当前 Gateway 缓存补齐一次。

涉及位置包括：

- `client/apps/daemon/src/storage/migrations.ts`；
- `client/apps/daemon/src/storage/repositories.ts`；
- `client/apps/daemon/src/threads/types.ts` 与 `threads/manager.ts`；
- `client/apps/daemon/src/codex/app-server-host-2026-07-28.ts`。

## 6. 提示词注入规则

### 6.1 服务端 Agent

保留现有服务端基础资源，并追加 Gateway 的 `server_agent_prompt`：

```text
Clawee 固定基础规则
+ 客户 server_agent_prompt
+ 服务端 Skill 保密规则
+ 内置 server-agent/AGENTS.md
+ 用户任务
```

客户文本只能补充业务行为，不能覆盖 Clawee 的安全规则、权限校验、Skill 保密规则或工具可见性规则。服务端固定安全规则应在组合结果中保持最高优先级。

### 6.2 Clawee Agent

在现有 Clawee 基础规则后追加 `clawee_agent_prompt`：

```text
Clawee 固定基础规则
+ 客户 clawee_agent_prompt
+ 用户任务
```

提示词只作为开发者指令注入，不创建或修改用户工作区文件。

## 7. 企业配置示例

### 7.1 服务端 Agent

```md
## 生图规则

用户提出生图、图片创作、商品图等需求时，优先使用 `$image-generator` Skill。
如果当前会话没有该 Skill，应明确说明。
```

### 7.2 Clawee Agent

```md
## 企业助手

用户称呼“企业助手”时，优先调用 `enterprise_assistant` MCP。
如果该 MCP 未在当前会话暴露，应明确说明，不要静默改用其他 MCP。
```

Skill 是否安装、MCP 是否授权以及工具是否实际暴露，仍以当前 Runtime 能力为准；提示词不代替这些权限和配置。

## 8. 管理台实现

在现有 Agent 管理区域增加“Agent 提示词”配置入口，不新增客户选择器：

- 展示当前 `version` 和最后更新时间；
- 使用两个独立文本框，分别编辑服务端 Agent、Clawee Agent；
- 保存按钮一次提交两段文本；
- 保存中禁止重复提交，成功后显示新版本；
- 加载失败、保存失败显示明确错误，不清空已编辑内容；
- 没有 `console:agent:manage` 权限时隐藏入口并由服务端继续拒绝接口。

页面使用现有 `server/web` API 客户端、TanStack Query、治理布局和组件，不新增状态管理方案。

建议落点：

- `server/web/src/lib/agent-prompt-policy-api.ts`；
- `server/web/src/pages/agent-prompt-policy.tsx`；
- `server/web/src/app.tsx`、管理台导航和权限测试。

## 9. Clawee Agent 客户端更新提示

提示展示在 `client/apps/web` 的 Agent 工作台右下角。它表示“Daemon 已检测到 Gateway 的新版本”，不表示当前会话已经切换提示词。

### 9.1 最小实现

1. Daemon 拉取配置后比较远端 `version` 与本地缓存版本。只有远端版本更大且完整缓存写入成功时，才记为一次“提示词已更新”。拉取失败或版本未变化不产生提示。
2. Daemon 增加一个本地状态读取接口，例如 `GET /agent-prompt-policy/status`，只返回当前已成功加载的版本和可选的 `updated` 标记。该接口不再次请求 Gateway。
3. Web 在已有的登录成功、Gateway 会话重建、新建 Agent 会话请求完成后调用该接口；不增加定时轮询，也不建立 WebSocket/SSE 推送通道。由于提示词本身按这些边界更新，这样可以保持通知时机与实际生效时机一致。
4. `AppController` 保存待展示的版本号，发现新版本后渲染 `AgentPromptPolicyUpdateNotice`。同一 Web 运行周期内，同一 Gateway 的同一 `version` 只提示一次；关闭只影响显示，不影响缓存和会话行为。

### 9.2 复用现有 UI

- 复用 `client/apps/web/src/features/settings/DesktopUpdates.tsx` 使用的 `.desktop-update-notice`，因此直接获得右下角定位、背景、边框、阴影、移动端宽度和关闭按钮样式。
- 组件可以放在 `client/apps/web/src/features/settings/AgentPromptPolicyUpdateNotice.tsx`，由 `AppController` 与 `DesktopUpdateNotice` 一起挂载。
- 首期文案固定为：标题“Agent 提示词已更新”，正文“新建会话后生效。”，提供一个关闭按钮。
- 使用 `role="status"` 和 `aria-live="polite"`；不自动消失，不增加通知队列、系统通知或声音提醒。

### 9.3 客户端验收

- Gateway 版本变大且 Daemon 成功缓存后，Agent 客户端右下角出现一次提示。
- 同一版本重复检查不重复提示；关闭后不再遮挡工作区。
- 当前会话继续使用创建时的旧提示词；新建 Agent 会话使用新版本。
- Gateway 拉取失败、响应版本未变或只命中旧缓存时不显示“已更新”。
- 未登录页、普通浏览器端和 Electron 桌面端都复用同一 Web 实现；不引入新的通知依赖。

## 10. 开发顺序

1. **Gateway 存储与接口**：迁移、单例读写、应用读取、权限和审计测试。
2. **管理台**：两个文本框、保存状态、错误状态、权限门禁和页面测试。
3. **Daemon 读取与缓存**：协议类型、HTTP 客户端、本地缓存、登录/会话重建触发和失败回退。
4. **Thread 快照与 Runtime 注入**：`thread/start` 拉取并绑定快照，`thread/resume` 复用快照，补齐旧 thread 兼容逻辑。
5. **企业配置验证**：验证 `$image-generator` 默认选择和 `enterprise_assistant` MCP 路由。

## 11. 验收标准

- Gateway 只存在一套配置，不出现 `tenant_id` 或客户选择入口。
- 服务端和 Clawee Agent 可以独立保存、读取和生效两段提示词。
- 用户登录、Gateway 会话重建、新建 `thread/start` 会拉取一次；同一 thread 的多次 `thread/resume` 不请求 Gateway。
- Gateway 更新配置后，已有 thread 继续使用旧快照，新 thread 使用新版本。
- 拉取失败时有缓存用缓存，无缓存用内置规则，任务仍可启动。
- `serverDeployment=true` 只注入 `server_agent_prompt`；普通 Clawee Agent 只注入 `clawee_agent_prompt`。
- 提示词不会写入用户项目目录。
- 企业配置中，生图任务默认选择 `$image-generator`，称呼“企业助手”时优先调用 `enterprise_assistant`。
- Gateway 版本更新并被 Daemon 成功加载后，Clawee Agent 客户端右下角出现“Agent 提示词已更新，新建会话后生效。”提示；同一版本只提示一次。
- 空配置下现有测试和运行行为不变。

服务端实现后运行相关 Go 测试和隔离数据库集成测试；管理台运行相关测试与构建；Daemon 修改完成后按仓库要求运行 `desktop:preflight:local`。
