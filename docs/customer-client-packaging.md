# 客户客户端打包与下载配置

## 公共打包入口

`CLAWEE_DESKTOP_GATEWAY_CONFIG_PATH` 可指定一个绝对路径的 TOML 文件。未设置时仍读取 `client/config/config.toml`；指定文件缺失、路径非绝对路径或内容无效时构建失败。

```toml
gateway = "https://gateway.demo.example.com"
```

文件应放在仓库外的临时目录，不要放入 `.pack/deployment`。打包流程读取、校验并重新序列化配置，然后完成 staging、签名及安装包生成。包中只包含 Gateway；已有用户的 `~/.clawee/config.toml` 不会被覆盖。客户构建必须设置 `CLAWEE_OFFICIAL_RELEASE=0`。

在仓库根目录执行本地验证：

```sh
CLAWEE_DESKTOP_GATEWAY_CONFIG_PATH=/绝对路径/config.toml CLAWEE_OFFICIAL_RELEASE=0 pnpm desktop:preflight:local
```

客户表、基线记录、选择脚本、交付清单和客户 workflow 位于独立 `clawee-agent` 仓库的 `customer-packaging` 分支，操作说明见该仓库 `packaging/README.md`。公共仓库不保存真实客户表。双方当前新增代码在本地尚未提交；正式同步应使用提交，不能以开发工作区为后续同步来源。

## Gateway 下载页

`/downloads` 无需登录，支持直接访问和刷新。登录页已提供“下载客户端”入口。匿名只读接口为 `GET /api/v1/public/client-downloads`，只返回 `gateway`、`standard` 和 `packages`，不返回其他部署配置。

在仓库外的部署 YAML 中添加以下配置，然后重启 Gateway；完整示例见 `server/configs/config.example.yaml`。

```yaml
client_downloads:
  gateway: "https://gateway.demo.example.com"
  standard:
    url: "https://github.com/krillinai/Clawee/releases/latest"
  packages:
    - platform: "macos"
      arch: "arm64"
      version: "0.1.7"
      url: "https://downloads.example.com/demo/0.1.7/完整私有SHA/macos/arm64/Clawee.dmg"
      sha256: "替换为安装包实际64位SHA256"
      signature: "signed_notarized"
```

上述安装包 URL、SHA 为占位，必须替换后才能使用。平台只允许 `macos/arm64`、`macos/x64`、`windows/x64`，同一平台不可重复。下载 URL 必须使用无用户凭据的 HTTPS URL，SHA256 必须为 64 位十六进制。

macOS 签名状态允许 `signed_notarized` 或 `unsigned`，Windows 允许 `signed` 或 `unsigned`。状态由运维依据构建及签名验证证据填写，Gateway 不下载或检测安装包。首期 Windows 客户包应标为 `unsigned`。

Gateway 地址应是 origin，不附加 `/api` 或 `/mcp`；必须使用 HTTPS，本机回环 HTTP 调试地址除外。同域部署可留空，页面使用自身 origin；分域部署必须填写客户端可达的地址，服务端不会从 Host 或转发头推导地址。

没有客户包时将 `packages` 留空或省略，标准包和配置指南始终可见。下载接口异常也不会阻止标准包入口与指南显示；分域部署遇到接口异常时，需要向管理员确认 Gateway 地址。

GitHub 不可达时，可将 `standard.url` 替换为静态服务上的一个标准安装包，同时填写对应 `standard.version`、`standard.sha256`。下载文件直接由静态服务提供，Gateway 不代理大型文件。此配置会匿名公开，不填写密码、令牌或其他客户信息。

## 开发验收与后续操作

本地开发验收记录：2026-09-12。已完成公共配置入口、下载页和接口，以及客户交付脚本和三平台手动 workflow。测试不会访问开发者真实 `.clawee` 数据。

| 检查 | 结果 |
| --- | --- |
| 公共仓库与客户交付分支 `desktop:preflight:local` | 均通过；包括客户端测试、类型检查、arm64 App 打包、包内 Web 哈希和各 3 项 Runtime E2E |
| 客户包配置与官方更新标记 | 包内 TOML 与配置哈希一致；无 `official-release.json` |
| 交付分支实际 App 首启及覆盖安装配置保留 | 1 项通过，使用隔离配置目录 |
| 交付分支包内真实 Codex 会话 | 1 项通过，包括冷启动和重启恢复；模型端使用既有受控测试服务 |
| 两处管理台测试与构建 | 各 11 项相关测试通过，生产构建通过 |
| 两处 Go 配置、HTTP 路由与应用层测试 | 通过；使用 Go 1.25.11，不使用生产数据库 |
| 客户选择、注入与交付清单测试 | 6 项通过，包括三平台缺失、不同客户或 SHA、文件篡改拒绝 |
| 客户 workflow 与默认分支入口模板 | actionlint 通过 |

客户端预检证据分别保存在各仓库的 `client/apps/desktop/release/clawee-desktop-local-preflight.json`。客户补充证据在 `clawee-agent/client/test-results/customer-first-launch.json` 和 `clawee-desktop-real-codex-smoke.json`。当前证据均对应本地未提交工作区，不能作为正式签名交付证据。

本地开发包不等于客户可交付安装包。尚需完成以下外部操作：

1. 恢复 GitHub CLI 对 `wulien/clawee-agent` 的 API 访问，目前查询仍返回 404。复核仓库可见性、`release` Environment 的分支规则，以及设计文档列出的五个签名 Secret，勿导出凭据。
2. 审阅并提交两处工作区的修改，记录公共通用改动提交和客户提交。私有分支基线仍是文档指定的 `268e493a76782a2856504850170860e2f2004a27`；后续公共升级必须先有成功构建证据，再合并并更新基线。
3. 配置本机 `CLAWEE_APPLE_TEAM_ID` 或 `APPLE_TEAM_ID`，准备 Developer ID 签名身份及公证凭据；当前环境未设置 Team ID，凭据有效性未验收。在干净客户提交运行 `desktop:preflight:release`，通过后推送。试点阶段在旧默认分支登记同路径的 dispatch 入口，模板已放在 `packaging/customer-desktop-dispatch.yml`。
4. 报告目标完整 SHA、本地结果和预计一次 workflow 后，选择 `customer-packaging` 分支运行客户 workflow。三平台全部成功后再验收安装启动、macOS 签名公证与 Windows 未签名状态。本次未触发远端 workflow，未创建 Tag 或 Release。
5. 三平台试点验收后再将仓库转私有、复核可见性，设置交付默认分支并清理临时入口，随后录入真实客户地址。真实客户 HTTPS Gateway、下载域名和存储目录由运维提供。
6. 将最终汇总 artifact 中的文件部署到独立客户静态目录，核对 SHA256 与下载可达性，再配置本 Gateway 的下载链接。不使用官方 `releases`、`catalog`、`updates/stable` 前缀，不向客户提供会过期的 Actions artifact 链接。
