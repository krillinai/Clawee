# 客户端本地插件连接器与 DWS 首个适配方案

> 状态：方向已收敛；完成第 5.2 节的制品与命令核验后进入开发拆分。
>
> 范围：优先服务个人用户，先完成受管 DWS 的本地安装、授权和使用闭环。飞书、企业微信、Gateway 集中治理和开放式第三方插件市场不在本期范围。

## 1. 背景与目标

DWS 由本地 CLI、配套 Agent Skills 和钉钉账号授权共同构成。它不是 MCP Server，也不应当作单个 Skill 处理。

后续 Clawee 可能接入其他本地 CLI。本期以 DWS 验证必要的本地安装共性：

- 受控目录和锁定版本。
- 按平台下载、校验、解压、安装、回滚和卸载。
- DWS CLI 与官方 Skills 的组合安装和状态检测。
- 向 Clawee 管理的 Codex Runtime 暴露命令和 Skills。
- 插件文件和 Skill 的所有权与冲突保护。

DWS 的版本检测、OAuth 登录和 Profile 解析留在 DWS 适配代码中；第二个本地插件出现时再提取通用驱动接口。

本期目标是：用户在一级“连接器”页面按需安装并授权 DWS，然后可直接在 Clawee 中用自然语言使用钉钉能力，不需记忆 DWS 命令或手工处理 Skill 目录。

## 2. 非目标

- 不把 DWS 二进制或 Skills 打包进 Clawee 安装包。
- 不重新实现钉钉 API，不将 DWS 封装成 Clawee 专用 MCP Server。
- 不读取、复制或同步 DWS Token，不将其上传 Gateway。
- 不允许用户添加任意远程插件清单或执行任意安装脚本。
- 不建设第三方插件市场、通用 SDK 或动态驱动加载机制。
- 不做静默后台安装、静默自动升级或未经用户确认的 Skill 覆盖。
- 不做插件更新、启用/禁用、自动修复、现有 DWS 安装接管或多账号管理；后续按需求单独设计。
- 不将 DWS 写操作的 Skill 交互约定宣称为“不可绕过的强制门禁”。
- 不在本期实现飞书、企业微信或跨平台统一账号。

## 3. 产品概念与边界

### 3.1 连接器是用户概念

“连接器”是用户看到的统一外部能力入口，底层分为两类：

```text
连接器
├── MCP 连接器
│   ├── Codex 原生 MCP
│   └── Gateway 企业 MCP
└── 本地插件连接器
    ├── DWS
    └── 后续的本地 CLI 或 Runtime 扩展
```

连接器页可共用搜索、筛选、卡片、详情面板和操作反馈，但 MCP 和本地插件不共用同一个安装与授权状态机。

### 3.2 本期受管组件

本地插件由 Clawee 审核过的声明组成。本期 DWS 固定安装两种组件：

- `executable`：按平台下载的可执行文件。
- `skills`：需安装到 Clawee `CODEX_HOME/skills` 的 Skill 集合。

不接受未识别组件，不使用“脚本”作为通用逃生舱；其他插件和组件类型待有具体需求时再设计。

### 3.3 受管安装与 DWS 适配

本地安装代码只负责本期必需的文件生命周期：

- 读取内置目录并选择当前平台的锁定制品。
- 安装计划、冲突检测、下载校验、安全解压、安装、回滚和卸载。
- Skill 所有权、操作互斥及中断后的核对。
- 将受管命令和 Skills 暴露给 Codex Runtime。

DWS 适配代码负责版本、只读授权状态、Profile 数量和登录进程。不从远程清单下载 JavaScript 或动态代码，也不预设 `LocalPluginDriver` 接口或驱动注册表。

## 4. 总体架构

```text
ConnectionsPage
      |
      | HTTP
      v
daemon /local-plugins API
      |
      v
受管 DWS 安装与状态服务
  |       |         |
  |       |         +--> DWS probe / 登录
  |       +------------> SkillManager
  +--------------------> 下载 / 安全解压 / SQLite 记录
      |
      +--> <CLAWEE_DATA_DIR>/local-plugins
      |
      +--> Runtime environment contribution (PATH)
```

边界要求：

- Web 只消费 daemon 的脱敏状态和发起用户操作，不下载制品、不执行 CLI。
- daemon 负责文件、进程、数据库和 Runtime 环境，不将平台凭据传给 Web。
- Desktop 仅当必须使用系统原生能力时增加 Bridge/IPC。常规下载、解压和启动 DWS 由 daemon 负责，本期不新增专用 Desktop IPC。
- Gateway 不参与本地插件的安装、账号或运行。

## 5. 目录与发布清单

### 5.1 代码位置

初版插件目录随 Clawee 版本发布，只包含经验证的元数据和制品哈希，不包含 DWS 二进制和 Skills。

```text
client/apps/daemon/src/local-plugins/
  catalog.ts
  catalog.json
  manager.ts
  repository.ts
  downloader.ts
  extractor.ts
  dws.ts
```

初版不必抽成新 workspace package：目录只由 daemon 解析并执行，Web 使用 `@clawee/protocol` 中的运行时响应类型。等第二个消费者出现后再评估抽包。

### 5.2 清单结构

`catalog.json` 的结构示意（以下占位数据不可直接用于安装）：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-24T00:00:00.000Z",
  "plugins": [
    {
      "id": "dingtalk-dws",
      "kind": "local_cli",
      "displayName": "钉钉 DWS",
      "description": "在 Clawee 中使用钉钉通讯录、日程、文档、待办等能力。",
      "publisher": "DingTalk-Real-AI",
      "homepage": "https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli",
      "recommendedVersion": "<核验后填写>",
      "releases": []
    }
  ]
}
```

开发安装器前，先锁定一个实际 Release 并完成一次制品核验：填写版本、各已验证目标平台的下载地址、SHA-256、大小上限、归档入口及同 Release 的 Skills 制品；核对 Skill 目录与 ID、CLI 的 version/auth/profile 命令及登录方式，并在目标平台验证 macOS 可执行状态和 Linux libc 要求。未核验的平台不写入目录，安装前报告不支持。内置目录不得保留占位值或空 `releases` 进入可安装构建；客户端不得直接跟随 GitHub `latest`。

每个 Release 必须明确列出：

- DWS 版本和当前 Clawee 版本的兼容性。
- 已验证的目标平台制品；其余平台明确不支持。
- 压缩格式、期望入口文件、制品大小上限和 SHA-256。
- 已核验的 HTTPS 下载源。
- `dws-skills.zip` 的版本、SHA-256、大小上限、下载源和核验过的 Skill ID 列表，供安装计划展示和解压后比对。
- 暴露命令名，DWS 为 `dws`。
- Skill 模式，DWS 初版固定为 `multi`。

### 5.3 远程目录演进

初版目录随客户端发布，更换推荐插件版本需要新的 Clawee 版本。这是有意的安全约束。

后续需要独立更新目录时，再增加 Clawee 托管的稳定目录地址。远程目录必须带可由客户端内置公钥验证的签名，未验证、过期、降级或 `schemaVersion` 不兼容时回退到内置目录。

## 6. 下载源与供应链

### 6.1 下载策略

初版 DWS 使用同一 Release 的两类制品：当前平台对应的 CLI 压缩包和 `dws-skills.zip`。

候选下载源顺序（仅将实际存在且核验过的地址写入目录）：

1. DWS 官方 GitHub Release。
2. 若同一制品确有官方 Gitee 镜像，则作为备用。

Clawee 初版不自建 DWS 二进制下载服务；没有经核验的镜像时只使用主源，不能为满足备用源要求而填入未经验证的地址。

### 6.2 安全要求

- 不执行 `curl | sh`、PowerShell 远程脚本或 DWS 官方安装器。
- 下载使用流式写入临时文件，设置连接、首字节、总时间和最大字节限制。
- 只允许清单声明的 HTTPS 源和明确列入的 HTTPS 重定向。
- 下载完成后必须与 Clawee 内置目录的 SHA-256 比对；DWS `checksums.txt` 只作为生成目录的证据，不作为客户端唯一信任根。
- 解压限制条目数、单文件大小和总展开大小，拒绝绝对路径、`..`、路径冲突、设备文件和越界链接。
- ZIP 可复用 `yauzl` 和现有企业 Skill 压缩包校验思路；Unix `tar.gz` 在 daemon 工作区使用锁定的 `tar` 依赖，不调用系统 `tar`。
- 解压后校验入口文件、文件类型和可执行权限，再进入安装阶段。
- 不在日志、API 或诊断包中输出完整进程环境、Token、Client Secret 或 DWS 凭据文件。

### 6.3 平台限制

- macOS：实施时必须检查锁定 DWS 制品的签名和可执行状态。Clawee 不得静默移除 quarantine 或绕过 Gatekeeper。
- Windows：使用 `windowsHide` 启动，不写系统 `PATH`。
- Linux：DWS 官方产物依赖 glibc。安装计划在下载前检测 libc，musl/Alpine 显示不支持自动安装。

## 7. 本地存储与数据模型

### 7.1 文件目录

使用 Clawee `dataDir`，不写入 `/usr/local/bin`、Homebrew、用户 npm 全局目录或 Shell 启动文件。

```text
<CLAWEE_DATA_DIR>/local-plugins/
  staging/<operation-id>/
  plugins/<plugin-id>/versions/<version>/
```

不使用 `current` 符号链接表示当前版本。当前版本记录在 SQLite，运行时从受控版本目录解析绝对路径。

### 7.2 SQLite 记录

在 daemon 本地库增加以下表，表名可按现有数据库风格调整：

- `local_plugin_installations`：`plugin_id`、`installed_version`、`install_path`、状态和时间字段。
- `local_plugin_skill_records`：`plugin_id`、`skill_id`、`release_version`、`installed_content_sha256`、时间字段。
- `local_plugin_operations`：`operation_id`、`plugin_id`、操作类型、状态、阶段，以及写入前持久化的 CLI/Skill 目标路径、预期摘要和原有文件状态；用作进度查询和中断核对记录，不存原始 CLI 输出。

不持久化 DWS token、app secret、凭据密文、完整 DWS 输出或完整进程环境。

首次安装遇到已有同名 Skill 一律拒绝，不覆盖。在 CLI 目录移入受管位置前持久化其目标路径和原有状态；对每个即将写入的 Skill，先在操作记录中持久化目标和预期摘要，再通过 `SkillManager` 写入；安装记录只在全部验证通过后提交。daemon 重启发现未完成操作时，先依据记录检查目标：仅删除与本次预期状态一致、且安装前不存在的 Skill 和 CLI 目录；任何不匹配或无法确认的文件一律保留，标记为 `broken` 并提示人工处理。核对完成后才清理 staging，不能先删目录再 probe。卸载中断也先保留记录并核对磁盘状态，不自动删除归属不明或已修改的文件。

## 8. 协议与状态模型

### 8.1 通用状态

`client/packages/protocol/src/api.ts` 只增加本期使用的类型，不预留其他插件的驱动、组件或更新状态：

```ts
export type LocalPluginInstallationStatus =
  | 'missing'
  | 'installing'
  | 'installed'
  | 'broken';

export type LocalPluginAuthenticationStatus =
  | 'signed_out'
  | 'signed_in'
  | 'multiple_profiles'
  | 'unknown';

export type LocalPluginOperationResponse = {
  id: string;
  kind: 'install' | 'login' | 'uninstall';
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  stage: string;
};

export type LocalPluginResponse = {
  id: 'dingtalk-dws';
  kind: 'local_plugin';
  displayName: string;
  description: string;
  publisher: string;
  installation: LocalPluginInstallationStatus;
  authentication: LocalPluginAuthenticationStatus;
  installedVersion?: string;
  identity?: { tenantName?: string; userName?: string };
  components: { cli: 'missing' | 'ready' | 'invalid'; skills: 'missing' | 'ready' | 'invalid' };
  operation?: LocalPluginOperationResponse;
  diagnostic?: { code: string; message: string };
};
```

单 Profile 时仅返回界面必需的非敏感摘要；多 Profile 只返回 `multiple_profiles`，不自动选择账号或返回完整列表。不返回 token、secret、凭据路径或 DWS 原始 JSON。

### 8.2 卡片综合状态

Web 按以下优先级计算展示状态：

1. 正在操作。
2. 安装损坏或必需组件无效：“需处理”。
3. 未安装：“可安装”。
4. 检测到多个 Profile：“多账号暂不支持”。
5. 未授权：“待授权”。
6. 授权无法确认：“需检查”。
7. 其余：“已就绪”。

多 Profile 时不展示“开始使用”，明确告知用户本期只验证单 Profile 使用；已安装的 CLI/Skills 仍可能被 Runtime 调用，不能宣称界面限制是账号安全门禁。若要保证多账号不误用，后续需在任务中明确绑定目标 Profile 并验证官方 Skills 的每条命令均传入该值。

### 8.3 错误码

至少定义：

- `LOCAL_PLUGIN_NOT_FOUND`
- `LOCAL_PLUGIN_UNSUPPORTED_PLATFORM`
- `LOCAL_PLUGIN_OPERATION_BUSY`
- `LOCAL_PLUGIN_DOWNLOAD_FAILED`
- `LOCAL_PLUGIN_ARTIFACT_HASH_MISMATCH`
- `LOCAL_PLUGIN_ARCHIVE_INVALID`
- `LOCAL_PLUGIN_SKILL_CONFLICT`
- `LOCAL_PLUGIN_WRITE_CONFIRMATION_REQUIRED`
- `LOCAL_PLUGIN_INSTALL_FAILED`
- `LOCAL_PLUGIN_AUTH_FAILED`
- `LOCAL_PLUGIN_STATE_REQUIRES_ATTENTION`

API 只返回稳定错误码、用户可读消息和脱敏结构化详情，不直接传回子进程原始 stderr。

## 9. daemon API

在 `client/apps/daemon/src/api/routes.local-plugins.ts` 增加：

```text
GET    /local-plugins
POST   /local-plugins/:id/refresh
POST   /local-plugins/:id/install/plan
POST   /local-plugins/:id/install
DELETE /local-plugins/:id
POST   /local-plugins/:id/auth/login
GET    /local-plugins/:id/operations/:operationId
```

`GET /local-plugins` 不执行长耗时网络检查，返回目录、本地记录和最近 probe 的聚合结果。`refresh` 触发可执行文件、组件、版本、健康和授权检测。

### 9.1 安装计划

`install/plan` 返回：

- 将安装的版本、组件、大小、来源和发布者。
- 将暴露给 Runtime 的命令。
- 将写入的 Skill 名称。
- 同名 Skill 冲突；受管命令通过仅作用于 Clawee Runtime 的 PATH 优先级暴露，不覆盖宿主文件。
- 是否需要全局 `CODEX_HOME` 写入确认。

前端展示计划并获得用户确认后，只传 `confirmWriteToCodexHome`。安装接口重新检查锁定版本、目标路径和所有 Skill 冲突；有变化即拒绝并要求重新查看计划。首期没有覆盖非本插件 Skill 的参数，也不需要 `planDigest`。

安装与登录返回 `202 + operationId`，Web 轮询展示阶段和结果；卸载完成后直接返回状态。同一 DWS 同时最多有一个写操作。安装与登录设置总超时，首期不提供操作取消按钮。

## 10. 安装、卸载与中断处理

### 10.1 安装流程

1. 校验插件 ID、锁定版本和制品声明。
2. 解析平台、架构和兼容性，生成安装计划。
3. 检查 Skill 路径冲突，确认受管 PATH 中的 `dws` 优先于宿主同名命令。
4. 等待用户确认安装计划。
5. 在 staging 目录下下载全部必需制品。
6. 校验制品大小和 SHA-256。
7. 安全解压，检查入口文件、Skill 结构和版本一致性。
8. 持久化 CLI 目标与原有状态，再将 CLI 版本目录原子移入 `plugins/<id>/versions/<version>`，暂不标记安装完成。
9. 持久化待写 Skill 的目标、预期摘要和原有文件状态，再逐个通过 `SkillManager` 安装；发现同名文件即停止，不覆盖。
10. 验证安装后的 CLI 和每个 Skill 内容摘要。
11. 在 SQLite 事务中写入安装和 Skill 所有权记录，标记为已安装。
12. 通知 Runtime 配置变更，使新命令和 Skills 在后续任务中生效。
13. 核对完成后删除 staging；首期不维护跨操作的制品缓存。

任一必需组件失败时，只回滚能凭操作记录确认归属且内容未改的本次文件，不能删除不匹配的用户文件。回滚失败或状态无法确认时标记为 `broken`，保留现场并引导用户处理。Runtime 刷新失败不视为文件安装失败：状态提示“已安装，需重新加载”，下次任务重试刷新。

### 10.2 Skill 所有权

卸载器只能删除同时满足以下条件的 Skill：

- 存在该 `plugin_id + skill_id` 所有权记录。
- 当前路径与 Clawee 管理的 `CODEX_HOME/skills` 一致。
- 当前内容摘要与记录的 `installed_content_sha256` 一致。

仅有 `dingtalk-*` 前缀不构成删除或覆盖授权。用户修改过、Skill 市场安装、企业 Skill 安装或来源不明的同名 Skill 都必须报告冲突；首期不提供覆盖选项。卸载时如果任一目标被修改，保留文件与记录，停止卸载并明确提示，不宣称已卸载。

### 10.3 卸载与后续能力

- 卸载先核对所有受管 Skill 的摘要和路径，全部匹配后删除受管 CLI 与 Skills，保留 DWS 自己管理的账号凭据；失败时保留操作记录以供核对。
- 再次安装只允许从“未安装”状态开始；`broken` 状态先由用户处理提示的残留文件，刷新核对确认无受管文件后恢复为“未安装”，不把重新安装伪装为自动修复。
- 更新、禁用/启用、接管用户自装 DWS 与清除第三方凭据都不在本期。将来设计更新时再处理原版本保留和所有权迁移。

## 11. Runtime 暴露与刷新

受管 DWS 安装记录提供：

```ts
type LocalPluginRuntimeContribution = {
  pathEntry?: string;
};
```

只有“已安装 + CLI 与 Skills 均有效”的 DWS 才贡献受管 CLI 的目录；把该目录放在 Clawee Runtime 的 `PATH` 前面并去重，保证解析到受管版本，不修改系统 `PATH`。Skills 从已有的 `CODEX_HOME/skills` 路径被发现，不需要第二份 `skillIds` 环境贡献。

环境注入必须覆盖当前的三条执行路径：`runs/manager.ts` 中的非持久 App Server 和 `exec`，以及 `api/server.ts` 创建的持久 App Server 执行器。可复用现有 run/runtime injector 的 `env` 和配置指纹，让持久执行器每次创建进程时读取当前 PATH 贡献；仅修改 `runs/manager.ts` 不会影响持久执行器。合并时保留已有环境变量与原始 PATH，不能仅用插件目录替换 PATH；不需要 Desktop 修改全局环境。

daemon 自身的 probe、授权和账号命令必须使用数据库记录的绝对可执行文件路径，不依赖 `PATH`。

插件配置变更后：

- 不终止正在运行的任务。
- 通过现有持久执行器的失效接口在空闲时回收旧进程，运行中则待本轮结束后回收。
- 下一次任务使用重新计算的 `PATH` 和 `CODEX_HOME/skills`；卸载后新任务不得再调用受管 DWS。
- 如无法立即刷新，返回“已安装/已卸载，需要重新加载”，不回滚已验证的文件操作。

## 12. 连接器页改造

### 12.1 数据模型

`ConnectionsPage.tsx` 当前的 `UnifiedConnection` 只能表达 MCP，改为可辨识联合：

```ts
type ConnectorViewItem =
  | {
      kind: 'mcp';
      key: string;
      /* 现有 MCP 字段 */
    }
  | {
      kind: 'local_plugin';
      key: string;
      plugin: LocalPluginResponse;
    };
```

MCP 的安装、登录、启用和删除保持在 MCP 分支。DWS 的计划、安装、授权和卸载走 `LocalPluginService`。不将 DWS 伪装成 `CodexMcpServerResponse`。

### 12.2 页面结构

页面说明改为：

> 管理 Clawee 可使用的外部服务和本地扩展能力

页面并行读取现有 Codex MCP、Gateway MCP 目录和 daemon 本地插件。任一来源失败不阻断其他来源。DWS 不依赖 Clawee 企业账户登录。

沿用现有搜索和筛选方式，加入 DWS 的名称与状态；不为单个新连接器增加筛选维度。

### 12.3 本地插件卡片与详情

DWS 卡片显示：

- 名称、图标、发布者和“本地插件”标识。
- 综合状态。
- 已安装版本。
- 单账号时显示组织与用户摘要；多 Profile 时提示本期不支持多账号使用。
- CLI 和 Skills 的组件摘要。
- 根据状态选择唯一主操作：安装、继续授权或开始使用；异常时显示诊断与刷新。

卡片不堆叠所有操作。详情面板包含：

- 概览：能力、版本、安装来源和组件。
- 账号：授权状态和单 Profile 摘要；多 Profile 仅显示不支持提示。
- 维护：刷新和卸载。
- 操作进度和经脱敏的错误诊断。

“开始使用”返回会话页，可将示例填入输入框，但不自动提交外部写操作。

### 12.4 设置页

DWS 不再放在“设置 -> 插件”。现有“插件”设置如仍保留，只展示 Runtime/Skill/MCP 技术诊断或改名为“运行环境”；外部能力安装和管理全部进入一级“连接器”。

## 13. DWS 适配设计

### 13.1 组件映射

| 组件 | 来源 | 安装位置 | 本期策略 |
| --- | --- | --- | --- |
| DWS CLI | 同一 DWS Release 的平台制品 | Clawee `dataDir/local-plugins` | 按需下载，用绝对路径检测，通过受控 `PATH` 暴露给 Runtime |
| DWS multi Skills | 同一 Release 的 `dws-skills.zip` | Clawee `CODEX_HOME/skills` | 默认安装完整 `skills/multi/dingtalk-*` 集合 |

CLI 和 Skills 必须来自同一 Release。任一必需组件缺失、部分安装或版本不匹配时，DWS 不显示为“已就绪”。

### 13.2 用户自行安装的 DWS

本期只安装和管理 Clawee 受管版本，不检测或接管宿主 `PATH` 中的其他 `dws`，不得覆盖或删除其文件。运行时仅在 Clawee 子进程中把受管目录置于 PATH 前面。接管已有安装留待后续按实际需求设计。

### 13.3 probe 命令

DWS 适配代码使用参数数组和 `shell: false`，对命令设置超时和输出大小限制：

- 版本、只读授权状态和 Profile 列表：在第 5.2 节核验锁定版本的 `--help` 与实际输出后，将精确参数和解析规则写入 DWS 适配代码；不得直接把本文示例当作已验证命令。

`auth status --readonly` 返回非空 `reason` 时表示无法确定，不得简化为“未登录”。`local_state_requires_repair` 和 `local_state_unreadable` 需作为可诊断的降级状态。

### 13.4 授权流程

1. 用户在 DWS 详情面板点击“登录钉钉”。
2. daemon 使用受管 DWS 绝对路径启动经第 5.2 节核验的登录命令（下文以 `dws auth login` 为例）。
3. DWS 打开系统浏览器完成 OAuth；Clawee 不截获授权码和 Token。
4. 授权操作超时默认 10 分钟；超时终止授权子进程树并报告失败，首期不提供页面取消。
5. 子进程成功结束后，运行只读 auth probe 和 profile list。
6. 只有一个 Profile 时显示组织和用户摘要；多个 Profile 时提示本期不支持多账号使用。

“钉钉登录 Clawee”和“DWS 业务授权”是两套独立能力，页面文案和状态不得合并。

### 13.5 Profile 使用规则

- 不在 Clawee 中复制 DWS Profile 存储。
- 本期真实任务仅以单 Profile 验收。检测到多个 Profile 不自动选第一个或最近使用项，界面提示不支持多账号使用。
- 官方 Skills 是否能对每条业务命令传入明确 `--profile` 需在后续多账号方案中验证；本期不承诺对所有命令强制绑定账号。

### 13.6 Skills

- 使用 DWS 官方 `dws-skills.zip` 中的完整 multi Skill 集合，包含官方声明的共享依赖。
- 不重写、摄取或复制 DWS Schema 到 Clawee 代码。
- 解压后校验目录层级、`SKILL.md` frontmatter、Skill ID 和官方清单，再调用现有 `SkillManager`。
- 安装记录关联 DWS Release，不写成普通 Skill 市场来源；这些 Skills 在 DWS 卡片中统一维护。

## 14. DWS 任务路由与写操作

### 14.1 路由

保留现有 Runtime 规则：只有用户明确提到钉钉/DingTalk、提供钉钉链接，或通过“开始使用”明确选择 DWS 时，才使用 DWS Skills。

用户只说“企业知识库”或“公司知识库”时，仍优先使用 Clawee Gateway 企业知识库，不静默改走 DWS。

### 14.2 真实任务范围

- 查找钉钉联系人。
- 查看今天的钉钉日程。
- 搜索并读取钉钉文档。
- 查看我的钉钉待办。
- 创建一条待办作为写操作验收。

### 14.3 写操作边界

初版复用 DWS 官方 Skills 的风险、`--dry-run` 和确认规则，以及 Clawee Runtime 审批交互，不新增 DWS 业务命令代理层。

但必须明确：

- Runtime 使用 `danger-full-access` 时，本地命令审批可能自动通过。
- Skill 的“执行前确认”是 Agent 交互约定，不是安全边界。
- 本期不得宣称发送消息、创建待办、审批等操作具有不可绕过的 Clawee 强制门禁。
- 后续如需强制保护，必须同时引入受控命令执行入口和限制 Runtime 直接通过 shell 调用 DWS。

## 15. 具体代码改造点

### 15.1 `client/apps/daemon`

新增：

- `src/local-plugins/catalog.ts` 及内置目录：校验锁定版本、已验证平台和制品。
- `src/local-plugins/repository.ts`：SQLite 安装、Skill 所有权和中断核对记录。
- `src/local-plugins/downloader.ts`：受控源、流式下载、超时、限长与哈希。
- `src/local-plugins/extractor.ts`：ZIP/tar.gz 安全解压和结构校验。
- `src/local-plugins/manager.ts`：计划、安装、回滚、卸载、操作互斥与中断核对。
- `src/local-plugins/dws.ts`：受管 DWS 的 probe 与授权。
- `src/api/routes.local-plugins.ts`：脱敏 API。

修改：

- `src/api/server.ts`：注册受管 DWS API，复用 `SkillManager`、SQLite、`dataDir` 和 Runtime 失效接口；为持久执行器提供最新 PATH 贡献。
- `src/runs/manager.ts`：为非持久 App Server 和 `exec` 合并受管 PATH。
- `src/runs/persistent-app-server-executor-2026-07-28.ts`：通过已有 runtime injector 的环境与配置指纹让新进程获得最新 PATH，失效时轮换旧进程。
- daemon 数据库初始化：增加本地插件表。

### 15.2 `client/packages/protocol`

只新增本期 API 实际返回的 DWS 状态、单账号摘要、安装计划、操作状态和变更请求类型。

### 15.3 `client/apps/web`

新增：

- `src/services/local-plugin-service.ts`：daemon API 封装。
- `src/features/connections/LocalPluginCard.tsx`：本地插件卡片。
- `src/features/connections/LocalPluginDetail.tsx`：安装计划、授权状态、卸载和操作进度。

修改：

- `ConnectionsPage.tsx`：同时加载 MCP 和 DWS，使用可辨识联合渲染，沿用现有搜索与筛选。
- `AppController.tsx`：创建 `LocalPluginService`、维护列表状态并注入连接器页。
- `connections.css`：扩展卡片和详情面板样式。
- `ClaweeSettingsView.tsx`：仅当已有 DWS 入口时移至连接器页，不为本期重命名整个设置页。

### 15.4 `client/apps/desktop`

初版无必须修改。先在受支持的 Desktop 平台实际验证 daemon 发起授权能打开系统浏览器；若不行，将该平台列为暂不支持，另行决定是否需要 Bridge/IPC，不默认扩大本期范围。

## 16. 开发批次与验收

### 前置核验：锁定可实现的版本与平台

完成第 5.2 节的制品与 CLI 命令核验；形成可安装的非占位内置目录。未通过的平台不进入本期支持列表。

### 批次 A：受管安装闭环

实现内置目录、SQLite 记录、安装计划、下载校验、安全解压、CLI/Skills 安装与卸载，以及三条 Runtime 路径的环境注入。

验证：

- 已验证平台按架构选择正确制品，未验证平台在下载前失败。
- 仅当有核验过的备用源时测试主源失败后的切换。
- 哈希错误、超限、路径穿越和解压异常不改变现有安装。
- CLI 或任意 Skill 安装失败时清理可确认的本次写入；模拟重启后不删除已修改或归属不明的文件，显示 `broken`。
- 安装后非持久 App Server、持久 App Server 和 `exec` 的新任务均可执行受管 `dws` 并发现官方 Skills；卸载后新任务均不可执行受管 `dws`。

### 批次 B：连接器 UI 与 DWS 授权

实现连接器模型扩展、DWS 卡片与详情、计划确认、操作进度、只读授权检测、OAuth、单 Profile 摘要和卸载。

验证：

- 未登录 Clawee 企业账户时仍可管理 DWS。
- 未安装、安装中、待授权、授权未知、多 Profile、Skill 冲突和中断待处理有明确状态。
- 登录过程中 Clawee 不读取和存储 DWS Token。
- MCP 加载失败不影响 DWS，DWS probe 失败不影响 MCP。

### 批次 C：真实能力验收

在真实钉钉组织和 DWS 授权下验证：

1. 查找钉钉联系人。
2. 查看今天的钉钉日程。
3. 搜索钉钉文档并摘要。
4. 查看未完成的钉钉待办。
5. 创建一条待办，确认执行前展示单 Profile 的组织/用户和关键参数；该确认是 Agent 交互约定，不是强制门禁。

五个用例以单 Profile 完成真实验收；另单独检查多 Profile 提示、Token 过期、授权不足、DWS 非零退出和网络不可用。不要求每个用例覆盖所有异常组合。

### 自动化测试

至少新增：

- catalog schema、版本兼容、目标平台和 Linux libc 检测测试。
- 下载重定向、超时、限长、已配置备用源和哈希校验测试。
- ZIP/tar.gz 路径穿越、链接、压缩炸弹和结构校验测试。
- 安装前冲突重新检查、宿主同名命令 PATH 优先级和 Skill 冲突拒绝测试。
- CLI/Skill/SQLite 失败后的清理、无法确认归属时保留文件，以及 Runtime 刷新失败后重试测试。
- daemon 重启后按持久记录核对中断操作的测试。
- DWS 版本、auth status 各类 `reason`、profile 和脱敏测试。
- API 参数校验、操作互斥、超时和错误码测试。
- `ConnectionsPage` 同时显示 MCP 与本地插件、筛选、状态、计划确认和授权测试。
- 桌面端至少覆盖一个受管安装、授权浏览器打开、Runtime 新任务调用和卸载 E2E。

修改客户端可执行代码、依赖、构建或发布配置后，最终必须运行 `desktop:preflight:local`。

## 17. 本期范围决策

本方案建议默认确认：

1. **入口**：DWS 作为“本地插件连接器”放在一级“连接器”，不放在“设置 -> 插件”。
2. **安装方式**：DWS 不进入 Clawee 安装包，首次使用时由 daemon 按需下载。
3. **目录信任**：初版使用随 Clawee 发布的内置目录，不直接跟随 GitHub `latest`。
4. **下载源**：优先 DWS 官方 GitHub Release；同一制品存在经核验的官方镜像时才配置备用源。
5. **安装组合**：CLI 和同 Release 的完整 multi Skills 对用户是一次安装，实现上分制品校验；失败时仅清理能确认归属且未修改的本次文件。
6. **文件归属**：受管 CLI 写入 Clawee `dataDir`，Skills 写入 Clawee `CODEX_HOME/skills`，不修改系统 `PATH`。
7. **凭据边界**：DWS 凭据始终由 DWS 管理，Clawee 只读取脱敏授权状态和单 Profile 摘要，多 Profile 只返回状态。
8. **更新策略**：初版不提供插件更新；新版本通过后续需求单独设计和验收。
9. **写操作**：接受初版确认是 Agent 交互约定，不宣称具有 Clawee 强制门禁。
10. **框架范围**：只实现受管 DWS 所需的文件生命周期，第二个插件出现时再抽取驱动接口。
11. **账号范围**：真实任务只验收单 Profile；多 Profile 明确提示不支持，不能宣称已提供防误用的强制门禁。

## 18. 完成定义

- 连接器页在不影响现有 MCP 的前提下展示并管理本地插件。
- 锁定 Release 和已验证平台的制品、哈希、Skills 结构与 CLI 命令；占位目录不可发布。
- DWS CLI 和同版本完整 multi Skills 可按需安装、校验、卸载；失败或中断仅清理可确认归属的本次文件。
- 安装后持久 App Server、非持久 App Server 和 `exec` 的新任务均可发现受管 `dws` 和官方 Skills，卸载后不再发现受管版本。
- 用户可从 DWS 卡片发起钉钉授权，Clawee 不接触 Token。
- 单 Profile 下五个真实钉钉任务完成验收；多 Profile 明确提示本期不支持，不自动选账号。
- 下载、解压、Skill 冲突、中断恢复和敏感信息边界有自动化测试。
- 客户端 `desktop:preflight:local` 通过。
