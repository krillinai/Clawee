# 仓库边界与维护

## 源码归属

aigateway 维护 Gateway、管理台、PostgreSQL 迁移及企业治理；ClaweeAgent 维护 Web 工作台、daemon、Electron、Codex Runtime 与 Web＋daemon 部署包。两仓库各自安装依赖、构建、测试、发布，不读取对方源码。

源公开版本：krillinai/aigateway @ 3ddfa81a51584f3f6b8815686a2afd9569119e48。拆分首轮保留 client/ 和 server/ 内部路径；不改业务 API、数据库迁移、appId、本地数据目录和稳定 Agent ID。

## 版本与兼容

两边各自使用 VERSION 与 vX.Y.Z 标签；版本号无需一致。Gateway 先发布向后兼容的 API，再由客户端使用。新增能力通过现有能力查询或现有不可用状态处理；变更必填字段、错误语义或删除接口需提供兼容期。

本次拆分的初始兼容组合为两端 VERSION=1.0.25 的源码；它是迁移基线，不代表已发布新版本。后续发布说明须记录联调通过的双方版本或完整提交 SHA，不能把分支名当作可复现版本。

## 本地联调

两个目录可相邻，但并非运行条件。先在 aigateway 中准备外部配置、隔离数据库并启动 Gateway，再在 ClaweeAgent 中配置其 Origin（默认本地服务为 http://127.0.0.1:1904），运行客户端。配置与凭据留在仓库外。

接口变更和发布候选须验证注册登录、会话失效、Agent 身份、MCP 允许与拒绝、Skill 摘要校验和安装、知识库与共享文件权限、审批。可选企业集成未配置时沿用既有不可用行为。

跨仓库功能使用互相链接的 PR，明确服务端先行条件。自动联调如需另一端，显式检出完整 SHA 或下载固定版本产物；不依赖本机相邻目录。

## 发布渠道

ClaweeAgent 保留桌面签名、公证、Runtime 校验、COS 更新源及客户端官网目录。保留原 COS_PREFIX 和已安装客户端的更新 URL，发布凭据在新仓库独立配置；不得移动旧标签、删除旧 Release 或提前晋级更新渠道。

Gateway 独立发布服务端包和 ghcr.io/krillinai/aigateway-server 镜像，不写入桌面 COS 渠道。两边使用独立产物清单和发布门禁。普通 PR 仅运行无生产凭据的验证。

开源修复直接提交所属仓库；原私有仓库新增能力经审查后按归属迁移，避免用整包覆盖造成两边回退或重新引入私有内容。

## 可复现的接口冒烟验证

ClaweeAgent 提供 gateway:smoke，使用真实 daemon HTTP 适配器。先构建客户端，再把一次性 Gateway 的地址和测试账号配置写到仓库外 JSON 文件，设置 CLAWEE_GATEWAY_SMOKE_CONFIG 后运行。字段为 disposable=true、gateway、email、password。脚本会在空测试库注册该账号并检查登录、身份、目录读取、知识库未启用行为及会话失效，隔离环境不配置百炼凭据，知识库保持关闭；此检查不能指向用户数据实例。

ClaweeAgent 的 Gateway Compatibility 手动工作流要求输入 aigateway 完整 SHA，使用一次性 PostgreSQL，不读取签名或生产凭据。完整桌面流程、Skill 安装和权限边界仍由各端既有集成与 E2E 测试覆盖，目录冒烟不替代完整业务验收。
