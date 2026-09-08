# 参与贡献

从 README 的本地启动流程开始。客户端与服务端保持独立锁文件，请使用各目录声明的 pnpm 版本，不要跨目录重建锁文件。

提交前运行与改动有关的测试。客户端可执行代码、依赖或构建发布改动还需通过根命令 `npm run desktop:preflight:local`；服务端数据库改动需验证空数据库完整迁移和独立 PostgreSQL 集成测试。不得使用生产账号或数据完成测试。

PR 请说明解决的问题、用户可见变化、验证结果与尚未覆盖的环境。功能与修复应保持边界清楚，避免混入大范围格式化。桌面与浏览器的通用界面仅在共享 Web 中实现一次。

贡献者应拥有提交内容的授权，按 Apache-2.0 贡献代码，并保留第三方声明。推荐使用 `git commit -s` 为提交附加 DCO 签署；签署含义见 [Developer Certificate of Origin](https://developercertificate.org/)。无需在 PR 中粘贴个人身份证明。

不要提交密钥、真实配置、聊天记录、客户材料、数据库、截图 trace 或构建缓存。疑似漏洞按 SECURITY.md 私密报告。

发行由维护者在验证后的干净提交上执行。正式桌面发行必须完成本地 release 预检、该 SHA 的远端 preflight 和 Tag 检查，不移动已发布 Tag。
