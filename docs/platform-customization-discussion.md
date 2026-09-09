# 客户端侧栏 Logo 定制一期方案

> 状态：一期范围已收敛，可以进入实现。

## 1. 背景

Clawee 面向私有化部署场景。不同部署方希望在不修改源码、不维护客户专属分支的前提下，替换客户端左侧顶部的品牌 Logo。

一期只解决客户端侧栏展开态 Logo 和折叠态小 Logo 的配置、预览和展示问题。平台名称、主题颜色以及其他品牌定制能力不作为本期前置条件。

本文默认每家客户使用独立的 Gateway 和数据库，即“单部署单配置”。同一 Gateway 下的多组织、多品牌不在本期范围内。

## 2. 一期目标

- 管理员可以在 Gateway 管理后台分别设置展开态 Logo 和折叠态小 Logo。
- 管理员保存前可以按客户端实际展示尺寸预览两个 Logo。
- 客户端登录 Gateway 后读取配置，并在侧栏展开和折叠状态下显示对应 Logo。
- 任一 Logo 未配置、被恢复默认或读取失败时，只对该位置使用安装包内置的默认 Logo。
- 修改配置不需要重新构建客户端安装包。

## 3. 明确边界

### 3.1 替换位置

当前客户端侧栏展开态顶部由以下内容组成：

1. `krillinai-wordmark-*.png` 横向 Logo。
2. `Clawee` 产品名称。
3. 客户端版本号。

一期配置的展开态 Logo 只替换第 1 项，保留 `Clawee` 和版本号。折叠态小 Logo 只替换当前的 `krillinai-mark-*.png`。

内置默认资源继续按客户端当前主题选择黑色版或白色版。管理员上传的自定义 Logo 不区分主题，同一张图片用于浅色和深色背景。

### 3.2 非目标

- 不配置平台名称、简称、页面标题或面向用户的其他文本。
- 不配置主色、强调色或其他主题令牌。
- 不替换 Gateway 管理台、登录页、初始化页、对话头像或系统级应用图标。
- 不支持浅色和深色主题专用 Logo。
- 不支持 SVG、WebP、外部图片 URL、本地文件路径或任意 CSS。
- 不提供实时推送、轮询、配置导入导出或多租户品牌配置。
- 不修改 Electron `appId`、安装包名称、Dock 或任务栏图标、深链协议、签名、公证和更新源。

## 4. 总体方案

Gateway 保存两个 Logo。管理后台通过受权限保护的管理接口读取和修改配置；客户端登录 Gateway 后，通过本地 daemon 读取配置和图片内容。

```text
Gateway 管理后台
        |
        | 管理接口
        v
platform_branding（单行配置，包含两个小体积图片）
        ^
        | 已登录客户端接口
        |
本地 daemon -----> 客户端共享 Web -----> ClaweeSidebar
```

一期不提供未登录公开接口。客户端侧栏只在企业登录完成后展示；Gateway 未配置、尚未登录或读取失败时，客户端直接使用内置默认 Logo。

## 5. 数据模型

新增 `platform_branding` 表。最多保存一条 `id = 'default'` 的记录；没有记录等同于两个 Logo 均使用默认值。

| 字段 | 说明 |
| --- | --- |
| `id` | 固定为 `default` |
| `sidebar_logo` | 展开态 Logo 二进制，可为空 |
| `sidebar_logo_content_type` | 展开态 Logo 的真实 MIME，可为空 |
| `sidebar_compact_logo` | 折叠态小 Logo 二进制，可为空 |
| `sidebar_compact_logo_content_type` | 折叠态小 Logo 的真实 MIME，可为空 |
| `updated_by` | 最后修改人 |
| `created_at` | 创建时间 |
| `updated_at` | 修改时间 |

图片和对应 MIME 必须同时为空或同时有值。

一期每个文件最多 1 MiB，整套配置最多包含两个固定图片。直接存入 PostgreSQL 可以避免引入资产表、文件生命周期、孤立文件清理和额外存储配置。后续如果品牌资源数量或体积明显增长，再迁移到独立对象存储。

## 6. Gateway 接口

### 6.1 管理接口

```http
GET /api/v1/admin/platform-branding
PUT /api/v1/admin/platform-branding
GET /api/v1/admin/platform-branding/sidebar-logo
GET /api/v1/admin/platform-branding/sidebar-compact-logo
```

管理详情响应只需要说明两个 Logo 是否已配置，并在已配置时返回对应的管理端预览 URL，不返回图片 Base64。

```json
{
  "data": {
    "sidebar_logo_configured": true,
    "sidebar_logo_url": "/api/v1/admin/platform-branding/sidebar-logo",
    "sidebar_compact_logo_configured": false,
    "sidebar_compact_logo_url": null
  }
}
```

`PUT` 使用 `multipart/form-data`，一次原子提交两个 Logo 的处理动作：

| 表单字段 | 可选值 | 说明 |
| --- | --- | --- |
| `sidebar_logo_action` | `keep`、`replace`、`reset` | 保留、替换或恢复展开态默认 Logo |
| `sidebar_logo` | 文件 | `sidebar_logo_action=replace` 时必填 |
| `sidebar_compact_logo_action` | `keep`、`replace`、`reset` | 保留、替换或恢复折叠态默认 Logo |
| `sidebar_compact_logo` | 文件 | `sidebar_compact_logo_action=replace` 时必填 |

两个动作字段必填。`replace` 缺少对应文件、`keep` 或 `reset` 携带对应文件时返回 `400`。服务端完成全部校验后，在一个数据库事务内更新；任一图片不合规时均不修改现有配置。

`reset` 将对应图片及 MIME 清空。两个位置都恢复默认后保留全空记录，不额外增加删除分支。

### 6.2 客户端接口

```http
GET /api/v1/app/platform-branding
GET /api/v1/app/platform-branding/sidebar-logo
GET /api/v1/app/platform-branding/sidebar-compact-logo
```

配置响应示例：

```json
{
  "data": {
    "sidebar_logo_configured": true,
    "sidebar_compact_logo_configured": false
  }
}
```

图片未配置时，对应图片接口返回 `404`；已配置时返回经过校验后保存的 MIME 和图片内容。配置及图片响应一期统一使用 `Cache-Control: no-store`，不引入 `ETag`、版本化 URL 或额外缓存失效机制。

客户端接口沿用现有已登录客户端认证，管理接口沿用管理后台认证。

## 7. 图片校验

服务端是最终校验边界，按以下固定规则处理：

- 只接受 PNG 和 JPEG。
- 单个文件不超过 1 MiB。
- 图片宽度和高度都不得超过 4096 像素。
- 使用图片解码结果判断真实格式和尺寸，不信任扩展名或上传声明的 MIME。
- 解码失败、格式不符、尺寸超限或内容为空时拒绝整个保存请求。
- 不限制长宽比例，不设置最低分辨率；管理员通过实际尺寸预览判断图片是否适用。

前端的文件类型和大小检查只用于尽早提示，不能替代服务端校验。

## 8. Gateway 管理后台

在“系统管理”下增加“平台外观”页面。页面一期只包含：

- 展开态 Logo 文件选择和恢复默认操作。
- 折叠态小 Logo 文件选择和恢复默认操作。
- 浅色、深色背景切换。
- 展开态、折叠态预览。
- 保存按钮和保存结果提示。

选择文件后通过浏览器 Object URL 立即更新本地预览，不提前上传。关闭页面或重新选择文件时释放旧 Object URL。只有点击保存并且服务端返回成功后，配置才生效。

恢复默认操作先更新本地待保存状态和预览，点击保存后再提交 `reset`。未改动的位置提交 `keep`。

预览不复用客户端组件或建立跨前端共享 UI 包，只按明确规则模拟实际展示：

- 展开态展示区域固定为 `72 × 17`，`object-fit: contain`，左对齐。
- 折叠态展示区域固定为 `28 × 28`，`object-fit: contain`，居中。
- 预览包含客户端侧栏相近的背景、内边距和 Logo 周边空间。
- 浅色和深色背景使用同一张待保存自定义图片；预览默认资源时按主题显示当前内置黑白版本。

管理台自身的 Logo 和名称不随本配置变化。

## 9. daemon 与客户端共享 Web

### 9.1 本地 daemon

daemon 增加以下本地接口：

```http
GET /enterprise/platform-branding
GET /enterprise/platform-branding/sidebar-logo
GET /enterprise/platform-branding/sidebar-compact-logo
```

daemon 使用当前企业会话访问 Gateway 对应接口，校验配置响应结构，并透传经过 Gateway 校验的图片内容类型和内容。daemon 不增加数据库表、磁盘缓存、按 Gateway 缓存或定时刷新。

Gateway 未配置、企业会话未登录、请求失败或响应不合法时，配置读取视为不可用，由客户端使用内置默认 Logo。

### 9.2 客户端共享 Web

客户端在企业登录完成后读取一次 `/enterprise/platform-branding`。对于已配置的位置，通过现有带 Runtime Token 的 `RuntimeClient.rawGet` 获取图片 Blob，创建 Object URL，并把两个可选 URL 作为属性传给 `ClaweeSidebar`。

不新增全局 `PlatformSettingsProvider`。配置状态放在现有应用控制层；`ClaweeSidebar` 只负责以下选择逻辑：

1. 有有效自定义 Object URL 时显示自定义 Logo。
2. 否则按当前主题显示对应的内置默认 Logo。

重新登录、切换 Gateway 或组件卸载时释放已有 Object URL 并重新读取。读取过程中继续显示默认 Logo，不阻塞客户端启动和侧栏渲染。

一期不要求已打开的客户端自动感知后台修改。新配置在客户端下次启动、重新登录或切换 Gateway 后生效。

## 10. 权限与操作记录

一期新增一个权限：

```text
console:platform_branding:manage
```

管理详情、图片预览和更新接口都要求该权限；管理后台导航和页面路由使用同一权限控制。数据库迁移或现有种子机制应确保内置最高管理角色获得该权限。

每次成功更新记录结构化操作日志，至少包含操作人、操作时间、两个位置的动作以及新图片摘要，不记录图片二进制。除非发布或合规要求另行提出，一期不新增独立持久化审计表。

## 11. 实施顺序

1. 增加数据库迁移、模型、存储读写和图片校验。
2. 增加单一管理权限、Gateway 管理接口和客户端接口。
3. 增加管理后台“平台外观”页面、文件选择和双状态预览。
4. 增加 daemon 代理接口以及响应校验。
5. 在应用控制层加载图片，并将两个可选 URL 接入 `ClaweeSidebar`。
6. 补充测试并运行客户端 `desktop:preflight:local`。

## 12. 测试要求

### 12.1 Gateway

- 无配置记录时返回两个未配置状态，图片接口返回 `404`。
- 两个 Logo 可以独立替换、保留和恢复默认。
- multipart 请求任一字段或文件不合法时，两个 Logo 均不改变。
- PNG、JPEG 可以保存并按真实 MIME 读取。
- 超过大小或尺寸限制、伪造 MIME、解码失败及不支持格式会被拒绝。
- 普通客户端可以读取配置和图片，但不能调用管理接口。
- 没有管理权限的后台账号看不到页面且不能读取或修改配置。

### 12.2 管理后台

- 选择两个文件后无需上传即可预览。
- 展开态和折叠态预览尺寸、对齐和 `object-fit` 符合约定。
- 浅色和深色背景切换不会丢失待保存文件。
- 恢复默认只影响对应位置。
- 保存成功、校验失败和请求失败均有明确状态，失败时保留待修改内容。

### 12.3 daemon 与客户端

- daemon 正确代理配置和两种图片内容。
- Gateway 不可用或响应不合法时客户端显示内置默认 Logo。
- 只配置其中一个 Logo 时，另一个位置继续显示对应默认 Logo。
- 侧栏展开和折叠后分别显示正确图片，且不引起布局位移。
- 浅色和深色主题下默认资源选择保持当前行为，自定义资源保持不变。
- 重新登录和切换 Gateway 后释放旧 Object URL，不显示原 Gateway 的 Logo。

## 13. 验收标准

- 现有部署升级后，在没有配置时保持当前侧栏显示和行为不变。
- 管理员可以分别选择、预览、保存或恢复两个 Logo。
- 保存前可以在 `72 × 17` 和 `28 × 28` 的真实展示区域中切换浅色、深色背景预览。
- 自定义图片保持比例、不拉伸、不改变侧栏布局。
- 任一 Logo 未配置或读取失败时，仅该位置回退到对应的内置默认 Logo。
- 未登录界面、Gateway 管理台品牌、`Clawee` 名称和客户端版本号不受配置影响。
- 非授权账号不能进入设置页面或调用管理接口。
- 非法图片不能保存，包含任一非法图片的请求不会产生部分更新。
- 客户端下次启动、重新登录或切换 Gateway 后可以获取当前配置。

## 14. 后续范围

平台名称、主题色、浅色与深色专用 Logo、Gateway 管理台品牌、登录页、Favicon、帮助链接、页脚文本、公告、配置导入导出、持久缓存、实时刷新和多租户品牌配置，均在出现明确需求后单独设计，不预先纳入一期实现。
