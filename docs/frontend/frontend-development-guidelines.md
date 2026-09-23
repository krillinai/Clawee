# Gateway 前端开发指导

本文面向 `server/web` 的 Gateway 管理后台（`/admin`）与用户端（`/app`）开发。管理后台的产品表达、视觉风格和交互验收还应遵循 [设计指南](../design/design.md)；本地任务工作台 `client/apps/web` 使用独立技术栈和界面规范，不套用本文件。

以本仓库现有代码和接口契约为事实依据。实现发生变化时核对并更新本文件，不照搬其他仓库的目录、端口、组件清单或构建流程。

## 1. 工程边界

- `server/web/src/app.tsx` 组织路由和权限门禁；`components/admin-layout.tsx`、`components/app-layout.tsx` 分别负责管理后台和用户端布局。
- `components/ui/` 放通用基础组件，不放领域请求和业务文案；`components/governance-ui.tsx` 放已复用的治理组合组件。页面放在 `pages/`，跨页面业务组件放在 `components/`，按业务域维护请求和映射函数于 `lib/`。
- 页面的查询、mutation 和局部交互状态留在页面或就近的业务组件；只有确有复用或独立生命周期时再抽 Hook、Context 或组合组件。
- 遵循当前 React 19、TypeScript、Vite、React Router、TanStack Query、Tailwind、Radix 与 Lucide 技术栈；不因单个页面新增第二套组件或服务端状态方案。
- TypeScript 保持现有 `strict`、`noUnusedLocals`、`noUnusedParameters` 检查通过。优先沿用 `@/` 别名，外部数据按真实 DTO 建模，不用 `any` 掩盖未确认的字段。

## 2. 组件与样式

- 优先组合 `components/ui` 和现有治理组件；使用组件已有的 `variant`、`size`、disabled 与 focus 状态，不在页面用一串 Tailwind class 重做按钮、表格、弹窗或提示样式。
- Tailwind 主要处理布局、间距、尺寸和响应式约束；颜色使用 `styles/globals.css` 与 `tailwind.config.ts` 中的语义 token。浅色、深色及跟随系统主题通过现有 `ThemeProvider` 管理，不在页面另设局部主题。
- 交互性控件使用现有组件，图标按钮有可访问名称；表格保留语义化结构。复杂弹层使用现有 Radix 组件及治理组合组件，避免重新实现焦点与键盘行为。
- `AdminLayout` 已提供侧栏与内容间距。页面标题、筛选和操作区沿用 `PageHeader`、`PageShell`、`DataTableShell` 等现有布局。宽表格和长 ID 应可滚动、换行或截断，不能撑破主内容；窄视口下保持文字与操作可用。
- 设计层面的密度、卡片使用、文案和状态语义以[设计指南](../design/design.md)为准。

## 3. 路由与权限

- 新页面在 `app.tsx` 中接入对应路由，按用途选择 `/admin` 或 `/app`，并复用 `AuthGate`、`adminPage` 等现有门禁；管理导航维护于 `components/admin-sidebar.tsx`，用户端导航维护于 `components/app-navigation.tsx`。权限名沿用 `lib/rbac-api.ts` 的现有契约，不自造前端权限枚举。
- 管理后台导航可按权限和功能可用性隐藏入口；直接访问路由仍需门禁，实际授权和数据访问始终由 Gateway 后端校验。已进入页面的受限操作应给出明确原因和可执行的下一步，不把隐藏按钮当成安全措施。
- 新路由需检查导航、默认跳转、浏览器返回和直接刷新，并补相应路由测试；涉及服务端静态托管边界时同步核对 `server/internal/server` 中的 Web 托管实现。
- 保持 Gateway 与本地 Runtime 的数据边界：管理页面不能直接持久化本地任务、模型凭据或执行状态。

## 4. API 与服务端状态

- 业务请求优先放在 `src/lib/<domain>-api.ts` 一类现有业务 API 文件中，由页面通过业务函数调用。普通 JSON 请求复用 `src/lib/api.ts` 的 `adminApi`、`appApi`、`authApi` 或 `publicApi`；按访问范围选择，不能一律使用管理接口。
- 这些客户端是对象，调用形如 `adminApi.get<{ service: string; status: string }>("/status")`。它们分别补全 `/api/v1/admin`、`/api/v1/app`、`/api/v1/auth` 等前缀，Gateway 更新接口使用 PUT，不使用 PATCH；原有更新接口仍按请求字段更新，未提供的字段保持不变。客户端支持 GET、POST、PUT、DELETE 和表单请求。不要照搬其他项目的 `adminApi<T>("/v1/admin/...")` 写法。
- `api.ts` 负责带凭据请求、错误解析和响应解包。文件下载、流式响应、SSE 等与 JSON 协议不同的请求，可沿用仓库现有的业务专用处理；不得在页面散落未审查的裸 `fetch` 或硬编码后端地址。查询参数使用 `URLSearchParams` 等结构化方式编码。
- 使用 TanStack Query 管理异步数据时，query key 包含会影响结果的参数，mutation 成功后失效受影响的 key；高风险变更以服务端确认结果为准。沿用现有 `QueryClient` 对 403 不重试的配置，不额外发起无效重试。
- 列表、详情和提交覆盖加载、正常、空数据、失败、提交中及结果反馈；错误信息不能泄露内部地址、异常栈或敏感请求内容。Token、客户数据和审计材料按最小必要原则展示，具体展示规则遵循设计指南与后端权限契约。
- `VITE_*` 值会进入浏览器产物，不用于保存密钥、Token 或内部凭据。

## 5. 表单与可访问性

- 输入控件提供可访问名称，`Label` 与字段关联；必填、可选、禁用、只读、字段错误和提交中状态应易于辨识。受限值使用 `Select`、`Checkbox` 等合适控件，提交期间禁止重复操作。
- 所有操作可通过键盘访问，焦点可见；图标按钮有 `aria-label`，装饰图标设 `aria-hidden`。错误状态在字段附近标示，状态不能只依赖颜色或 Tooltip 传达。
- Dialog、Sheet、Select、Tabs 等沿用现有组件的键盘与焦点行为；新增动效须尊重减少动态效果的系统设置。

## 6. 本地开发与验证

- 根目录 `pnpm run admin:dev` 启动管理台开发服务；`server/web/vite.config.ts` 默认监听 `5904`，将 `/api/v1/auth`、`/api/v1/app`、`/api/v1/admin`、`/api/v1/public` 代理到默认 `127.0.0.1:1904`。可用 `VITE_DEV_PORT`、`VITE_BACKEND_URL` 调整开发连接。
- 在 `server/web` 运行 `pnpm test` 验证 Vitest 组件与单元测试；`pnpm build` 包含 TypeScript 构建、Vite 打包和产物压缩，输出到 `server/internal/server/webdist/dist`。涉及路由、布局或关键浏览器交互时运行 `pnpm e2e`；现有 Playwright 配置使用本机 Chrome 和开发端口，需要相应运行环境。
- API 测试覆盖请求路径、方法、参数、响应和错误；页面测试覆盖加载、空数据、失败与核心操作。优先用 role、可访问名称和可见文本定位，不用易变的 DOM 层级和样式串验证业务行为。
- 仅修改文档无需打包；修改 `server/web` 页面时至少运行相关测试和构建。若同时修改客户端可执行代码、依赖或构建发布配置，遵循根 `AGENTS.md` 的 `desktop:preflight:local` 约束；服务端集成测试只能使用隔离测试数据库。

## 7. 新增页面检查

1. 确认业务需求、接口和管理后台/用户端边界；对照设计指南确定信息层级及各状态。
2. 复用现有 API 客户端与组件，添加业务函数、页面、路由、权限和导航，避免无效入口。
3. 覆盖加载、空数据、错误、提交反馈、危险操作确认和窄视口可用性。
4. 为变更补足 API、权限与页面交互测试，运行相关测试、构建以及必要的浏览器验证。
