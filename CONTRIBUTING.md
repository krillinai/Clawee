# 贡献指南

请先阅读 [README](README.md)、[AGENTS.md](AGENTS.md) 和 [维护约定](docs/repository-maintenance.md)。

aigateway 只维护本仓库职责内的源码。PR 说明问题、行为变化、验证结果和跨仓库依赖；不要提交凭据、生产配置、数据文件、构建缓存或安装包。遵守当前锁定工具链，运行相关测试与构建。涉及客户端构建或发布时须通过 desktop:preflight:local；服务端测试使用隔离数据库。

普通 PR 不读取发布凭据。API 变更优先保持向后兼容，关联另一端 PR 与验证版本。正式发布由维护者在受保护环境中操作。
