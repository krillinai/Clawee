# Gateway 管理台前端设计指南

本文约束 `server/web` 中 Gateway 管理后台（`/admin`）的产品表达、界面风格和组件使用。Gateway 用户端（`/app`）可复用相同组件，但不强制沿用管理后台的信息架构；`client/apps/web` 的本地任务工作台不适用本指南。页面级需求和实施计划按具体功能维护，不在本目录重复定义。

组件分层、API、路由、可访问性与验证流程参见 [Gateway 前端开发指导](../frontend/frontend-development-guidelines.md)。

Clawee 整体包含本地 Agent Runtime；Gateway 管理台只负责企业治理，不承担本地任务执行或模型凭据管理。不得把 Gateway 的边界误写成整个项目不包含 Agent Runtime。

## 1. 总体风格

- 风格克制、清晰、稳定、高信息密度，接近成熟 B 端 SaaS 控制台。
- 优先使用表格、筛选、状态徽标、详情抽屉、表单和审计时间线承载信息。
- 页面标题、操作区、详情区、筛选区和反馈状态保持一致。
- 避免大面积渐变、大标题 Hero、装饰插画、夸张圆角、强阴影、漂浮元素和卡片堆叠。
- 不把聊天入口作为管理台主视觉或主结构，也不把 OA、ERP、CRM 等业务流程做成本项目主体。
- 卡片只用于指标、重复条目、表单分组和抽屉内容，不要卡片套卡片。

## 2. 组件规则

管理后台优先组合仓库已有的 shadcn/ui 风格组件，不为单个页面手写独立视觉体系：

- `server/web/src/components/ui/*`：通用 UI primitives，不放 MCP 领域文案或业务规则。
- `server/web/src/components/governance-ui.tsx`：项目级治理组件，例如 `PageHeader`、`MetricCard`、`DataTableShell`、`TableStateRow`、`DetailDrawer`、`ModalShell`、`ErrorAlert`、`EmptyState`、`LoadingState`、`ConfirmDialog`。
- 操作优先用 `Button`、`ConfirmDialog`；表单优先用 `Input`、`Textarea`、`Select`、`Checkbox`、`Field`；布局优先用 `Sidebar`、`Tabs`、`Card`、`Separator`；数据优先用 `Table`、`Badge`；反馈和覆盖层优先用 `Alert`、`Skeleton`、`Tooltip`、`Dialog`、`Sheet`、`Popover`。确有需要时再沿现有组件风格补充缺失组件。

交互约束：

- 可见操作按钮使用 `Button`；表格行操作使用紧凑尺寸；仅图标操作使用 `Button size="icon"`，并提供 `aria-label`，含义不明显时加 `Tooltip`。
- 错误提示使用 `ErrorAlert` 或 `Alert variant="destructive"`；模态表单和高风险确认使用 `ModalShell`、`ConfirmDialog` 或已有 `Dialog`；右侧详情和行内复杂操作使用 `DetailDrawer` 或 `Sheet`。
- JSON、payload 或详情视图切换使用 `Tabs`；加载、空数据和错误状态都必须有明确反馈。

## 3. 视觉规范

- 使用现有语义 tokens：`background`、`foreground`、`card`、`popover`、`primary`、`secondary`、`muted`、`accent`、`destructive`、`border`、`input`、`ring`。
- 治理状态使用统一语义：成功、警告、危险、禁用、待处理、运行中。危险操作使用 `destructive`；状态展示使用现有语义色。
- 字号层级服务信息密度，表格、表单、抽屉和紧凑面板内不要使用展示型大字。
- 圆角、阴影和边框保持克制，沿用现有组件视觉；图标辅助识别，不替代关键文字。

## 4. Tailwind 使用边界

Tailwind CSS 主要用于布局、间距、尺寸和少量状态微调，不用于绕开组件体系重建视觉风格。

- 优先使用组件自带的 `variant`、`size` 和状态。
- 优先使用语义 token，例如 `bg-background`、`text-muted-foreground`、`border-border`。
- 避免散落硬编码颜色、随意阴影、一次性圆角和页面级特殊样式。
- 表格、表单、弹窗、菜单和反馈状态不要用普通 `div` 临时拼出替代组件。
- 页面可以定义业务布局，不应重复定义共享组件外观。

## 5. 交互与状态

- 列表页应具备清晰的筛选、搜索、排序、分页或加载更多策略，按数据量和实际需求选择，不制造无效控件。
- 表单明确区分必填、可选、只读、禁用、错误和提交中状态。
- 异步操作展示加载、成功、失败和空状态；导航可按权限隐藏，但已进入页面的受限操作应说明不可用原因，不能只靠隐藏入口表达权限规则。
- 高风险操作有确认流程、结果反馈和可追踪的审计信息。
- 审计相关页面优先展示时间、操作者、对象、动作、结果和来源。
- Token 明文只在创建、复制或轮换成功后的受控区域短暂展示；列表和常驻详情只显示脱敏值或 fingerprint。

## 6. 文案规范

- 文案直接、准确，面向企业管理、运维和安全治理场景。
- 优先使用“治理、授权、审计、上游、能力、门禁、代理调用、活动采集”等与页面实际功能匹配的词汇；不使用“智能管理”“高效协同”之类没有上下文的表述。
- 不使用“开启智能新时代”“一键赋能所有业务”等营销化文案。
- 操作按钮以动词开头，例如“新增连接器”“保存策略”“查看审计”。
- 错误信息说明失败原因和下一步处理方式。

## 7. 设计验收

- 首屏是可用管理控制台，不是宣传页；导航围绕 Gateway 治理和当前已提供的企业能力，不暴露无关历史分组或无效入口。
- 页面清楚区分 Gateway 治理、本地 Agent Runtime 和企业业务系统的边界。
- 核心工作流覆盖上游服务、能力目录、Agent 授权、门禁、代理审计、Agent 活动和已启用的采集器管理等能力。
- UI 优先复用现有 primitives 和治理组件；页面文件不重复定义共享视觉样式。
- 桌面和移动宽度下文字、表格、筛选及操作区可阅读、可使用，不发生遮挡；整体保持企业级、克制、高信息密度和可扫描。
