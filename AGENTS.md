# Clawee 协作约定

- 默认中文回答和文档；保持现有代码风格，修改范围与需求一致。
- 在当前分支完成工作。未经用户要求不创建分支或 git worktree。
- 不使用 Superpowers，不导入内部技能、Hook、真实凭据或运行数据。
- 当前优先公开自有源码，保留已验证的依赖与锁文件。第三方再分发许可缺项留作后续专项补齐或替换，不阻塞源码整理、提交与公开，不为此改动依赖或 Runtime 分发方式。已有第三方声明与缺项记录继续保留，正式产物发行条件另行验收。
- `client/` 是 Electron、共享 Web 与本地 daemon；`server/` 是 Go Gateway、管理台与企业治理服务。
- 两个组件保留独立工具链与锁文件。Go module 为 `github.com/krillinai/Clawee/server`。
- 客户端通用界面只在 `client/apps/web` 实现一次，Desktop 嵌入本次构建的相同 Web 产物。本地 daemon 承担共用业务，Desktop Bridge 仅提供系统原生能力。
- Web/Desktop 的通用流程需使用同数据、同内容视口验证；能力不可用时不能显示无效入口。
- 修改客户端可执行代码、依赖、构建或发布配置后，提交前运行客户端 `desktop:preflight:local`，验证测试、类型检查、实际打包 App 和内嵌 Web 哈希。未通过不得宣称可发布。
- 正式发布在干净提交上运行 `desktop:preflight:release`，验证签名及公证凭据；随后对该已推送 SHA 运行一次远端 preflight，最后运行 `desktop:tag:check`。不得将远端打包用于反复试错，不移动或重建正式 Tag。
- 运行远端桌面发布前，报告本地结果、目标 SHA 和 workflow 次数。公开 PR 不使用维护者签名或生产凭据。
- 服务端集成测试使用隔离测试数据库。配置通过仓库外的 `CLAWEE_OPS_DIR` 或环境变量提供；不得操作旧生产实例或用户数据。
- 公开前扫描源码和产物，第三方许可按实际再分发内容保留。扫描报告留在仓库外，输出必须脱敏。
