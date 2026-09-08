# 第三方组件与再分发

根目录 Apache-2.0 仅适用于 Clawee 自有代码。第三方代码、字体、图标及内嵌可执行文件保留原许可证，不能改写为项目统一许可。

2026-09-08 决策：当前优先整理并公开 Clawee 自有源码，保持已验证的依赖版本、锁文件与 Runtime 分发方式。下列缺项转入后续许可补齐或依赖替换专项，不阻塞源码提交与公开。本轮继续保留已收集的许可和待复核记录，尚未完成的二进制再分发审查不标记为已通过。

`generated/` 保存本次 npm 依赖安装以及交付平台 Go 可执行程序依赖并集的 CycloneDX 组件清单和许可原文。运行 `node scripts/license-inventory.mjs` 可重新生成，需要先安装两端依赖、下载 Go modules，并安装 `jq`。Go 清单覆盖 Linux、macOS、Windows 的 amd64/arm64，标准库许可另见 `go-runtime-NOTICES.txt`。`review.json` 记录未找到顶层许可文本的条目、目标平台和输入锁文件哈希；未处理的条目不能据此宣称许可审查完成。npm 清单涵盖开发依赖，不等于每个平台最终包的完整 SBOM。

`npm-licenses/` 补充安装包中缺失的许可，包括 npm 元数据指定的 Git commit、版本 Tag 对应提交、上游历史原文或 README 明确链接的作者许可页面。每个目录的 `source.json` 记录具体来源、Git blob 或检索记录，不将补充来源冒充对应版本自带的文件。Go 许可证工具未识别的 mathutil v1.7.1 已人工核对为 BSD 三条款，原文保存在生成的 Go NOTICES 中。

`runtime/` 保存固定 Codex Runtime 与内含工具的上游许可。Codex 的版本、来源提交、各平台文件清单和哈希由 `client/config/codex-runtime.json` 锁定；不修改其上游签名文件。macOS 包包含 Codex、code-mode-host、ripgrep 和 zsh；Windows 包另含命令与沙箱辅助程序。Linux Runtime 还含 bubblewrap，虽然当前不承诺 Linux 桌面正式发行，再分发时仍须保留其许可。

zsh 仅分发核心可执行文件，未包含其某些另按 GPL 授权的 shell functions。上游对 zsh 的修改及构建过程见 Codex 仓库对应版本的 `codex-rs/shell-escalation/patches/zsh-exec-wrapper.patch` 与 `.github/scripts/build-zsh-release-artifact.sh`。ripgrep 的精确版本来自同一提交的 `scripts/codex_package/rg`。

Electron 与 Chromium 的原始许可由所安装 Electron 版本提供，打包时复制到 App 的 `licenses/electron`。Geist 字体按 SIL OFL 使用；Lucide 按 ISC 使用。项目中第三方品牌标识只用于识别集成服务，不表示对应权利人认可或赞助 Clawee。

正式发行前仍须对实际平台安装包、Runtime 内静态链接依赖和容器内容进行复核。生成清单和根 LICENSE 不能代替该检查。

## 当前缺项

2026-09-07 复核后，npm 清单剩余 13 个不同组件未找到完整许可原文，具体版本见 `generated/review.json`。其中 `lazy-val@1.0.5` 已确认在 macOS arm64 App 中再分发：发布元数据声明 MIT、作者为 Vladimir Krivosheev，但发布包和所指源提交均未附完整许可文件。后续专项需取得可追溯的许可及归属说明，或在专项替换时重新验收；本轮保留依赖，不编造版权年份或署名。

其余条目主要来自构建和测试工具；例如管理台的 `dlv` 由开发依赖 Tailwind CSS 引入。缺少文件不等于采用专有许可，也不能仅凭安装目录清单断言它们是否已被打入所有平台的 bundle。公开构建缓存、源码归档和不同平台安装包需按实际内容再核对。

Runtime 审计已读取固定源提交的 Cargo.lock，对 crates.io 源码包按锁文件 SHA-256 校验并收集许可，详细中间材料保存在仓库外。该清单包含构建、测试和其他平台依赖，尚不能替代真实二进制依赖图。还需处理 Git 来源依赖、缺失许可文本以及 V8、ICU、加密库等原生内容的再分发声明；若实际包含 MPL-2.0 组件，还需提供对应源码获取方式。多许可表达式中的 `OR` 是可选许可，不能直接将整个 Runtime 判定为 GPL。

Apple 签名与公证按维护者安排后置；许可缺项与签名权限是两项独立的发行条件。当前不能宣称已完成全部二进制再分发审查。
