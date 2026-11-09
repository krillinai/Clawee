# 第三方组件与再分发

根目录 Apache-2.0 适用于项目自有代码。第三方依赖保留原许可、版权与归属说明，不改写为项目统一许可。

本仓库包含 Go 服务端、管理台及根目录工程工具。generated/ 保留 Go、管理台与工程工具的组件清单、许可原文和 review.json；npm-licenses/ 保存可追溯的补充许可。运行 node scripts/license-inventory.mjs 重新生成，需要安装本仓库根目录、server/web 的锁定依赖，下载 Go modules，并提供 jq。

客户端、Electron、字体和内嵌 Codex Runtime 的再分发材料随源码移至 https://github.com/krillinai/ClaweeAgent 。Gateway 不分发客户端 Runtime。

清单包含开发依赖，并非实际容器和服务端包的完整二进制 SBOM。未找到许可原文的组件以 review.json 为准；源码公开不代表全部二进制再分发审查已完成。正式发行前仍须按实际产物复核，保留现有待核对项，不编造版权或许可文件。
