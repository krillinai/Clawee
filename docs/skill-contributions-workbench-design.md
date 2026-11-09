# Skill 贡献入口归入工作台方案设计

> 日期：2026-10-16。
> 状态：导航与模型门禁已实现；自动验证与人工验收结果见文末实施记录，不代表已发布。
> 适用范围：Clawee 共享 Web，桌面端与浏览器端共用。
> 关联文档：[Skill 贡献面板方案设计](skill-contribution-panel-design.md)、[客户端工作台](workbench.md)。本文定义贡献入口的导航调整，贡献数据口径和服务端权限继续遵循原面板方案及现有实现。

## 1. 目标与最终决策

将 Skill 贡献从侧栏一级入口移入「工作台 → 数据洞察」模块目录。本文中的工作台指现有 `#/dashboard`，不指项目目录或文件工作区，不更改现有界面名称和 Gateway 菜单名称配置。

本次实现采用以下决策：

1. 在工作台新增授权可见的 Skill 贡献模块卡片，移除侧栏独立贡献入口。
2. 保留 `#/skill-contributions`、`ActiveView` 和现有独立页面，由工作台卡片通过回调打开；不迁入 `DashboardPage` 的 `detailId`。
3. 贡献页增加「返回工作台」按钮，授权检查、无权限和授权失败页面也必须提供该按钮。
4. 保留贡献页现有侧栏、数据与对话分栏及移动端切换；贡献页打开时侧栏高亮工作台。此项是现有工作台模块全屏约定的明确例外，不改变 Agent 动态和哔哩哔哩的展示行为。
5. 已登录且 daemon 企业接口可用时，工作台目录可在模型未就绪期间进入；贡献数据查询、详情和直接导出沿用现有能力，对话继续受现有模型门禁控制。
6. 保留贡献专用对话，不要求用户选择本地项目，不接入通用工作台对话。

本次不修改统计口径、Gateway API、daemon 路由、数据库、协议包、Electron Bridge 或依赖，不新增模块注册框架、统一页面容器或筛选持久化能力。

## 2. 已核实的代码现状

以下为方案编写时的工作区现状，实施时以符号和当前文件内容定位，不依赖固定行号。

| 位置 | 当前实现 | 对本次开发的约束 |
| --- | --- | --- |
| `client/apps/web/src/features/dashboard/DashboardPage.tsx` | `workbenchModules` 包含 Agent 动态和哔哩哔哩；前者调用 `onOpenActivity` 打开独立页面，后者用 `detailId` 展开内部页面 | 贡献参考 Agent 动态的入口方式；卡片点击与可点击状态也需接入，不能只增加模块配置 |
| `client/apps/web/src/features/shell/ClaweeSidebar.tsx` | `contributionsAllowed` 控制 `globalActions` 中的独立贡献入口；`aria-current` 按 `activeView` 精确比较 | 删除该入口及废弃属性，并单独处理贡献页的工作台高亮 |
| `client/apps/web/src/app/AppController.tsx` | 统一持有 `contributionAccess`、`contributionIdentityKey` 和贡献页运行依赖；独立渲染贡献页和授权提示 | 继续在此完成权限与身份隔离，向工作台传入入口权限及导航回调 |
| 同上，模型配置门禁 | `configuration_required` 外层状态仅允许已登录用户进入工作流和贡献页，工作台会被配置页替换 | 只移动卡片会导致无模型用户无法进入目录，贡献页返回目录也会被拦截 |
| 同上，配置页快捷入口 | 非 `resolving` 时展示无需模型功能；贡献快捷入口由贡献授权控制 | 替换为工作台入口，并保持准备阶段不展示快捷入口的行为 |
| `client/apps/web/src/features/skill-contributions/SkillContributionsPage.tsx` | 已实现概览、筛选、分页、详情、直接导出与 `ContributionConversation`；暂无返回回调 | 在现有标题栏增加返回操作，不拆分业务面板 |
| `client/apps/web/src/features/skill-contributions/use-contribution-access.ts` | 使用身份键隔离权限，定时及窗口聚焦刷新，并提供 `revoke` | 直接复用，不在工作台重复申请权限或建立第二份权限状态 |
| `client/apps/web/src/features/dashboard/use-workbench-conversation.ts` | 对话要求本地项目，通过普通项目会话启动 Run | 替换贡献专用对话会引入项目依赖，不适合此次调整 |
| `client/apps/daemon/src/enterprise/skill-contributions-conversation.ts` | 专用贡献会话按企业身份校验，不绑定项目；执行提示限制贡献工具、查询口径与导出方式 | 保留原会话和受控查询链路 |
| `docs/skill-contribution-panel-design.md` | 原设计明确要求在侧栏工作区导航下增加贡献入口 | 当前代码符合原设计；此次属于新的导航调整，不是修复实现偏差 |

## 3. 入口、路由与页面行为

### 3.1 工作台模块目录

向 `DashboardPage` 增加两个属性：

```ts
contributionsAllowed?: boolean;
onOpenContributions?(): void;
```

由 `AppController` 分别传入 `contributionAccess.allowed` 和调用 `openPrimaryView('skill-contributions')` 的回调。

模块配置固定为：

| 字段 | 值 |
| --- | --- |
| `id` | `skill-contributions` |
| 标题 | Skill 贡献 |
| 说明 | 查看员工 Skill 上传、首次通过与审核评分 |
| 分类 | `data`，显示于「全部」和「数据洞察」 |
| `mode` | `read-only`，表示不修改业务数据，查询和导出仍可使用 |
| 图标 | 复用 Lucide `Blocks` |
| 顺序 | Agent 动态、Skill 贡献、哔哩哔哩运营；权限隐藏后按剩余顺序展示 |

仅当 `contributionsAllowed === true` 时纳入 `availableModules`。分类计数从过滤后的模块计算，权限检查中、未授权或授权接口失败时均不展示贡献卡片。贡献权限不能依赖 `activityAllowed`。

修改现有 `hasDetail` 判断和点击分支，使贡献卡片成为实际按钮，调用 `onOpenContributions`，可访问名称为「打开Skill 贡献模块」。保留 Agent 动态及哔哩哔哩的现有点击路径，不用类型断言把贡献 ID 塞入 `DashboardDetailId`。

打开目录不挂载 `SkillContributionsPage`，不请求贡献概览、明细或历史，不自动调用模型。既有授权检查与哔哩哔哩读取行为沿用现状。

### 3.2 侧栏归属

删除 `ClaweeSidebar` 的 `contributionsAllowed` 属性、独立贡献 action 及 `AppController` 中对应的属性传递；清理仅由这些删除产生的废弃引用，不移除企业 Skill 入口仍使用的图标。

在侧栏计算当前导航归属时，仅将 `skill-contributions` 映射为 `dashboard`，用于按钮的 `aria-current` 判断。真实的 `state.activeView` 保持 `skill-contributions`，避免把内容渲染、路由和权限分支一并改为工作台。

贡献页面和贡献授权提示均保留现有侧栏。不得将贡献页加入 `sidebarHidden` 条件，也不修改 `sidebarCollapsed`、`workbenchModuleOpen` 或用户原有折叠设置。展开与折叠侧栏中均只保留工作台入口。

### 3.3 返回与路由兼容

`SkillContributionsPage` 新增必填 `onBack(): void`，标题栏添加「返回工作台」按钮，使用现有 CSS 令牌及 Lucide `ArrowLeft`。原刷新按钮与标题保留，窄屏下返回操作必须可见。

`AppController` 统一以 `openPrimaryView('dashboard')` 完成返回，不使用浏览器历史回退。这样从收藏或外部链接直达贡献页时也能返回工作台，不会退出应用或回到不相关页面。

授权提示分支同样渲染返回按钮，覆盖「正在验证 Skill 贡献授权」「无权查看 Skill 贡献」及授权服务错误；不能只在成功挂载的业务页内提供返回操作。

保留 `routes.ts` 中贡献路由的解析与格式化、初始状态恢复、路由变化处理和 `routeForActiveView` 映射。正常打开卡片沿用现有路由历史行为，支持刷新直达和浏览器前进后退；不增加重定向或新路由。

离开贡献页沿用卸载清理：停止页面订阅，不额外发送取消后台 Run 的请求。再次进入继续由专用贡献接口恢复历史和进行中的会话。页面筛选按现有初始规则恢复，本次不承诺返回后保留筛选、页码或工作台分类。

## 4. 模型门禁调整

### 4.1 区分外层连接状态和模型状态

`connectionState.status === 'configuration_required'` 是外层状态，其中的 `connectionState.configuration.status` 还可能是 `configuration_required`、`resolving` 或 `unavailable`。本节的模型状态指后者。

对该外层门禁的最小修改是在已登录用户的页面白名单中增加 `dashboard`，保留原有 `workflow` 和 `skill-contributions`。不将其他业务页面整体放行，不把 `connected` 人为设为真，不将 daemon 断连解释为模型未配置。

工作台继续接收真实的 `connected={connectionState.status === 'connected'}`，贡献页继续沿用现有 `modelReady` 传递。此举只让目录可进入，不宣称其他模块在无模型时也能完整工作，不修改现有模型探测和错误提示策略。

### 4.2 状态矩阵

以下读取和导出能力均以企业登录、贡献授权及对应接口实际可用为前提；失败应显示现有错误状态，不能显示为零或伪造成功。

| 登录与运行状态 | 配置页快捷入口 | 工作台目录及贡献页面 | 贡献对话 |
| --- | --- | --- | --- |
| 已登录，外层 `connected` | 沿用正常应用流程 | 授权卡片可见，查询与导出正常 | 沿用现有启动条件与模型错误处理 |
| 已登录，模型 `configuration_required` | 有贡献权限时展示「进入工作台（无需模型）」 | 允许进入，贡献查询、详情和导出可用 | 保持禁用，显示模型暂不可用 |
| 已登录，模型 `unavailable` | 同上 | 同上 | 同上 |
| 已登录，模型 `resolving` | 继续隐藏无需模型快捷入口 | 直达或已打开的目录及贡献页保持可进入，仍校验企业权限 | 保持禁用，不因页面加载自动启动 |
| 未登录 | 不展示该快捷入口 | 沿用现有登录门禁，不因目录放行绕过登录 | 不可启动 |
| daemon 未连接或连接配置缺失 | 不新增旁路 | 沿用现有连接界面与失败处理，不凭缓存授权展示可用业务 | 不可启动 |

模型准备阶段「配置页不展示快捷入口」和「已登录用户可直达无需模型页面」是两个规则。现有工作流已经区分二者，本次保留该区分，不把隐藏按钮当作授权机制。

### 4.3 配置页操作

在现有无需模型功能区中，用「进入工作台（无需模型）」替换 Skill 贡献直达按钮，仍由 `contributionAccess.allowed` 控制该快捷入口。点击调用 `openPrimaryView('dashboard')`。保留「进入工作流（无需模型）」及其行为。

继续沿用该区域现有的已登录及非 `resolving` 条件。无贡献权限时不额外增加这个快捷入口；从其他正常路径进入工作台仍按各模块自己的权限展示。

## 5. 权限、身份与会话边界

权限继续由 `AppController` 的单份 `useContributionAccess` 结果控制。工作台只接收可见性，不自行查询授权。保留 `contributionIdentityKey` 作为业务页的 React `key`，不弱化企业账号、Agent 身份和 daemon 地址切换时的隔离。

授权撤销后仍由 `contributionAccess.revoke` 或既有权限刷新使业务页卸载，清理当前结果、详情、对话订阅和下载描述；随后显示带返回操作的授权提示。目录中的贡献卡片也随授权状态消失。直达路由继续检查授权，前端隐藏入口不替代 Gateway 的查询、详情、工具及导出权限校验。

`ContributionConversation`、`/enterprise/skill-contribution-conversations` 及 daemon 专用会话管理器保持现有调用关系。不增加 `projectId`、`workbenchContext` 或普通工作台会话包装，不因进入工作台而创建默认项目或新会话。

无模型时仍可通过页面直接导出；对话导出继续使用既有受控下载描述。不修改导出条件、上限、文件内容、统计口径及首次通过认定。

## 6. 逐文件开发清单

以下路径除文档外均相对于 `client/apps/web/src/`。

| 文件 | 必须完成的修改 |
| --- | --- |
| `features/dashboard/DashboardPage.tsx` | 增加两个入口属性、模块配置、独立权限过滤和点击分支；分类计数自动使用可见模块 |
| `features/shell/ClaweeSidebar.tsx` | 删除独立贡献入口和废弃属性；贡献视图的导航高亮归入工作台 |
| `app/AppController.tsx` | 连接工作台入口属性；传入贡献页返回回调；授权提示补返回；模型门禁允许工作台；替换配置页贡献快捷入口；删除侧栏废弃属性传递 |
| `features/skill-contributions/SkillContributionsPage.tsx` | 新增 `onBack` 并在标题栏接入返回按钮，不拆分数据和会话实现 |
| `features/skill-contributions/skill-contributions.css` | 仅补返回按钮与标题所需布局，验证刷新按钮及窄屏布局 |
| `features/dashboard/DashboardPage.test.tsx` | 覆盖授权卡片、顺序、分类计数及点击回调，保持既有模块测试通过 |
| `features/shell/ClaweeSidebar.test.tsx` | 替换“保留授权后的 Skill 贡献入口”的旧断言，覆盖两种侧栏状态下无独立入口及工作台高亮 |
| `features/skill-contributions/SkillContributionsPage.test.tsx` | 所有渲染夹具补 `onBack`；验证返回回调及原筛选、详情、导出行为 |
| `app/App.test.tsx` | 覆盖完整入口路径、模型状态、授权提示返回、账号切换和历史导航；复用现有 model-independent 测试夹具 |
| `app/routes.test.ts` | 补充或确认贡献路由的解析和格式化断言；实现不需要修改 `routes.ts` |
| `docs/skill-contribution-panel-design.md`、`docs/workbench.md` | 关联本方案；实现完成后同步入口、模型门禁及侧栏例外的最终说明，避免将待实现方案写成已上线行为 |

工作区可能存在其他未提交改动，特别是 `AppController.tsx` 和 `App.test.tsx`。实施时在当前工作区、当前分支内做局部修改，保留已有改动，不重置文件、不自动创建分支或 worktree。

## 7. 验收用例

### 7.1 自动化验收

| 编号 | 场景 | 必须验证的结果 |
| --- | --- | --- |
| A1 | 贡献授权为真，Agent 动态授权分别为真和假 | 贡献卡片独立可见，顺序正确；全部与数据洞察计数仅包含实际可见模块 |
| A2 | 贡献无权、检查中或检查失败 | 无贡献卡片，不计入分类数量；不因 Agent 动态有权而出现 |
| A3 | 打开工作台后点击贡献卡片 | 进入原贡献路由并挂载现有页面；打开目录本身不读取贡献明细、历史或启动模型 |
| A4 | 侧栏展开与折叠 | 均无独立贡献按钮；贡献页及其授权提示下工作台具有 `aria-current="page"`；侧栏折叠偏好未改变 |
| A5 | 贡献业务页返回 | 按钮回到 `#/dashboard`，不会依赖上一条浏览历史；不会取消后台 Run |
| A6 | 直达贡献路由，授权检查中、无权或服务失败 | 均展示对应提示和可用返回按钮；无贡献数据泄露 |
| A7 | 模型未配置、模型不可用，分别在浏览器端和桌面端 | 配置页经工作台进入贡献页，返回仍是目录而非配置页；可筛选、查看详情和直接导出，对话不启动 |
| A8 | 模型准备中，分别在浏览器端和桌面端 | 配置页没有新增快捷入口；已登录用户直达目录或贡献页仍按现有无需模型页面规则处理，对话不启动 |
| A9 | 未登录、daemon 断连或连接配置缺失 | 保留原登录和连接门禁；不得因工作台白名单绕过认证或启动 Agent |
| A10 | 无本地项目 | 贡献读取和导出正常；模型就绪时专用对话沿原接口启动，不创建或要求本地项目 |
| A11 | 账号切换、注销、贡献权限撤销 | 旧数据、详情和下载描述清理；卡片更新，旧页面进入授权或登录状态；授权提示可返回 |
| A12 | 贡献旧链接、刷新和浏览器前进后退 | 路由解析与页面一致，不被强制重定向为目录；再次进入按专用接口恢复会话，不新增空会话 |
| A13 | 普通筛选、分页、审核抽屉、直接及对话导出 | 原有数据条件与统计口径不变；移动入口不改变会话中的实际查询条件 |
| A14 | Agent 动态、哔哩哔哩、工作流与其他需模型页面 | 原点击路径、全屏行为、返回和模型门禁保持；不把其他页面整体放行 |

优先补能验证新行为的组件及应用测试，复用现有贡献页面、对话与权限回归用例，不为本次导航修改复制底层统计或 Run 事件测试。

`App.test.tsx` 中现有 `createModelGatedWorkflowFetch` 夹具只为贡献提供授权结果，不能直接验证完整贡献页面。新增用例时按需补齐概览、明细、详情、导出及专用会话的响应，并记录实际请求；断言无模型时仍调用读取与导出接口、不会创建贡献 Run，无项目时不会调用普通项目会话创建接口。账号切换和撤权用例需要能动态切换身份与授权响应，避免仅依赖静态组件快照。

### 7.2 人工验收

在桌面端与浏览器端各走一遍「工作台 → 数据洞察 → Skill 贡献 → 返回工作台」，确认标题栏、焦点、刷新和返回按钮可用。分别检查宽窗口、窄窗口及移动端数据/对话切换，审核抽屉不遮挡必要操作。折叠侧栏再进入和退出贡献页，折叠状态应保持。

通过模型未配置账号完成一次页面查询和 CSV 导出；通过模型就绪且没有本地项目的环境完成一次贡献专用对话。测试使用受控账号及测试数据，不依赖生产数据或生产凭据。

## 8. 开发顺序与验证命令

1. 补入口和模型门禁的行为用例，确认当前实现无法满足新路径 → 验证 A1–A3、A7–A9。
2. 接入工作台卡片、侧栏归属、业务页及授权提示返回 → 验证 A4–A6、A12。
3. 调整工作台模型白名单和配置页快捷入口，保持权限及专用会话边界 → 验证 A7–A11、A13–A14。
4. 运行定向测试、类型检查及客户端本地预检，完成人工布局验收并更新文档状态 → 记录实际通过项和未通过原因。

在仓库根目录执行定向测试：

```sh
node scripts/clawee.mjs client --filter @clawee/web test src/features/dashboard/DashboardPage.test.tsx src/features/shell/ClaweeSidebar.test.tsx src/features/skill-contributions/SkillContributionsPage.test.tsx src/features/skill-contributions/ContributionConversation.test.tsx src/app/routes.test.ts src/app/App.test.tsx
node scripts/clawee.mjs client --filter @clawee/web typecheck
```

完成客户端可执行代码修改后，在提交前运行：

```sh
corepack pnpm desktop:preflight:local
```

预检必须覆盖仓库要求的测试、类型检查、实际打包 App 和内嵌 Web 哈希。未通过不得宣称可发布；本方案不授权提交、推送、打 Tag 或触发远端发布。

本次只保存方案文档时，检查 Markdown、相对链接和变更范围即可，不需要执行客户端打包预检。实施后的交付说明必须区分新增测试的实际运行结果、完整预检结果和人工验收结果，不把本方案的用例清单视为已验证结论。


## 9. 实施记录（2026-10-16）

已完成工作台贡献卡片、侧栏归属、业务页及授权提示返回、模型白名单与配置页快捷入口调整，并同步关联文档。贡献路由、权限状态、身份键、专用会话、数据查询及导出实现沿用现有链路。

sub agent 已对照本设计完成代码审核与修复复核，未发现生产代码功能缺陷。审核发现无项目测试夹具未返回真实项目列表，已补齐空项目初始化响应，并在启动初始化完成后记录请求边界，验证贡献导航与对话不新增项目或普通项目会话请求。应用原有的启动时空项目库尝试创建默认项目行为不属于本次修改；测试模拟默认目录不可用，确保专用贡献对话在无项目时仍可执行。导出测试等待对象 URL 清理完成，避免延迟定时器影响后续用例。

实际验证结果：

- 本文第 8 节六文件定向测试：317 项全部通过；审核修复后已复测。
- Web 独立类型检查：通过。
- `corepack pnpm desktop:preflight:local`：通过，包含 Codex Runtime 契约、完整客户端测试、类型检查、本机 App 打包、实际打包 App 与内嵌 Web 哈希校验。Web 全量 1,456 项通过；实际打包 App 验证 16 项通过、1 项按原有条件跳过。预检记录位于 `client/apps/desktop/release/clawee-desktop-local-preflight.json`，当前为未提交工作区的本地开发预检（`dirty=true`、`releaseReady=false`），不代表正式发布验证。
- `git diff --check`：通过。

新增应用用例覆盖浏览器端与桌面端的模型未配置、模型不可用、模型准备中直达及返回，授权检查中、拒绝与服务错误提示返回，撤权清理、切换企业身份及断连后的业务隐藏，以及无项目专用会话和离开页面不取消后台 Run。历史导航复用现有 `popstate` 模拟；本次未进行真实浏览器前进后退的人工验收。

人工验收状态：尚未在浏览器端和桌面端实际检查宽窄窗口、移动端切换、焦点及抽屉布局，也未用受控企业账号完成真实查询、CSV 导出和模型对话。自动化用例使用测试数据与接口夹具，实际打包 App 验证不替代这些业务和布局人工验收。本次未提交、推送或发布。
