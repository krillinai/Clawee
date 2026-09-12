# 客户客户端交付

当前分支为 `customer-packaging`，从公共成功发布提交 `268e493a76782a2856504850170860e2f2004a27` 建立。`origin` 保持 `wulien/clawee-agent`，`upstream` 指向公共仓库。旧分支和历史保留，未创建或推送正式 Tag。

`customers.json` 目前只有公开示例域名，不能用于真实客户登录。仓库正式转私有前不要加入真实客户信息。客户 ID 只允许小写字母、数字和连字符，以字母或数字开头，最多 63 个字符。Gateway 只接受规范的非回环 HTTPS origin，不允许路径、查询参数、fragment 或凭据。

## 本地开发验证

在仓库根目录执行：

```sh
pnpm --dir client install --frozen-lockfile
pnpm --dir client --filter @clawee/desktop exec node -e "require('electron')"
node --test packaging/*.test.mjs
node packaging/customer-config.mjs validate demo
node packaging/customer-config.mjs generate demo
```

最后一个命令输出临时 TOML 的绝对路径。用该路径设置 `CLAWEE_DESKTOP_GATEWAY_CONFIG_PATH` 并运行根目录 `pnpm desktop:preflight:local`。生成文件不修改受 Git 管理的配置，不放入会被打包脚本清理的 staging 目录。

本地预检完成后，在 `client` 目录运行客户首启验证：

```sh
CUSTOMER_ID=demo pnpm exec playwright test --config ../packaging/playwright.config.ts
```

测试沿用现有隔离启动机制，删除隔离用户的 fake Gateway 配置后启动 App，验证真实包内配置初始化；然后写入已有地址和身份再次启动，验证不会覆盖。它不会读写开发者的真实 `.clawee` 配置。

## 远端试点

工作区开发完成后，先运行本地预检再提交；干净目标提交还必须通过 `desktop:preflight:release`，然后推送。准备运行前报告本地结果、完整 SHA 和预计一次 workflow。

GitHub 的旧默认分支需登记 `.github/workflows/customer-desktop.yml` 才会显示手动入口；模板是 `packaging/customer-desktop-dispatch.yml`。模板在旧默认分支只提示选择交付分支，不执行打包。正式执行时始终选择 `customer-packaging`，输入清单内客户 ID 和完整 SHA。

workflow 先检查 SHA 属于受维护交付分支，再从同一个 SHA 读取客户表、公共基线和应用源码；校验、测试通过后才启动三平台任务。证书只在 macOS 打包步骤注入，使用既有 `release` Environment 的五个 Secret：`MACOS_CERTIFICATE`、`MACOS_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。

客户构建强制关闭官方更新。macOS 使用原签名、公证及装订链路；Windows 使用未签名 NSIS EXE，并通过 Authenticode 检查确认其未签名状态。还会从 DMG 或 NSIS 安装到 CI 临时目录，启动已安装内容验证首启与配置保留。首期不支持 Windows 签名证书；如改为已签名交付，需要同时修改构建路径、签名验证和交付状态，不能仅改标签。

所有平台完成后，`delivery` job 会重新计算安装包及原始构建清单的文件大小和 SHA256，生成唯一最终汇总 artifact。平台中转 artifact 不单独视为完整交付。目录为：

```text
客户ID/版本/完整私有SHA/平台/架构/
  原始安装包
  原始 Desktop build manifest
  customer-delivery.json
  SHA256SUMS
```

顶层 `客户ID/版本/完整私有SHA/customer-delivery.json` 汇总三平台验证结果。清单记录公共与私有 SHA、客户配置哈希、workflow run、实际验证过的签名状态和文件摘要。目录禁止覆盖，不发布 GitHub Release，也不上传官方 COS 更新目录。

Actions artifact 保留 14 天，仅用作交付中转；正式下载必须部署到客户静态 HTTPS 服务。部署前复核文件校验值及下载可达性，再按公共仓库 `docs/customer-client-packaging.md` 配置 Gateway 下载页。

## 后续同步与当前边界

当前公共通用改动已作为开发补丁同步到此工作区，尚未提交，`packaging/upstream.json` 仍准确记录最初成功基线。后续只同步已提交并有成功公共构建证据的代码：获取公共提交时使用 `--no-tags`，合并到本分支，再更新基线记录。不要合并旧独立客户端分支或运行旧 `desktop-release.yml`。

2026-09-12 本地验证：本分支 `desktop:preflight:local` 已通过，实际 arm64 App 的 3 项 Runtime E2E、客户首启与旧配置保留检查、真实 Codex 会话与重启恢复均通过；客户脚本 6 项测试、管理台 11 项相关测试与生产构建、Go 配置和路由测试、actionlint 均通过。预检证据在 `client/apps/desktop/release/clawee-desktop-local-preflight.json`，补充 E2E 证据在 `client/test-results/`。

首次全新依赖安装曾触发 Electron 并行初始化冲突，已通过测试前串行初始化解决，workflow 已加入该步骤。本机图标工具下载曾超时，本地验证使用现有 Electron Builder 缓存后通过；只复用了依赖缓存，没有复用 App 或 release 输出。当前环境未设置 Apple Team ID，正式签名与公证有效性尚未验收。

GitHub API 当前返回 404，尚未验证仓库可见性、Environment 分支规则与签名凭据可用性。未推送提交，未登记旧默认分支入口，未运行任何远端 workflow，未变更可见性或默认分支。签名预检、远端三平台安装验收、转私有、真实客户域名及静态文件部署仍由维护者接续。
