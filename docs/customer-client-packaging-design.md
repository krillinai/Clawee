# 客户私有化客户端打包方案

状态：本地开发已实施，正式签名和远端三平台交付尚未验收。核对日期：2026-09-12。当前实现、验证结果与人工接续事项见 [客户客户端打包与下载配置](customer-client-packaging.md)；下文只读核对内容保留为方案编写时的依据。

## 1. 建议与范围

采用一个私有交付分支、一份客户配置表和一个手动客户打包 workflow。客户端沿用公共仓库代码及现有打包脚本，只增加一个可选的 Gateway 配置文件路径入口。客户包预置首次启动地址，标准包继续由用户手动配置。

首期覆盖已经成功发布的 macOS arm64、macOS x64 和 Windows x64。保持 Clawee 的应用名称、appId、版本号、协议和用户数据目录；客户差异仅为预置 Gateway 和交付目录。客户包保留手动修改地址的能力，通过 Gateway 下载页手动升级。Linux、Windows arm64、客户品牌定制、多实例并存和客户自动更新不纳入首期。

本方案中的客户域名均为示例。真实客户清单只在仓库转私有后提交。

## 2. 已核实的构建基础

- 公共仓库 `krillinai/Clawee` 的 `v0.1.7` Release 已成功，源码 SHA 为 `268e493a76782a2856504850170860e2f2004a27`。其三个桌面预检任务、三个桌面发布任务及最终发布任务均成功。证据：https://github.com/krillinai/Clawee/actions/runs/34622536741 。
- `.github/workflows/release.yml` 使用 Node.js 24、客户端锁定的 pnpm、三个原生 runner，以及现有缓存、Runtime E2E 和产物上传步骤。macOS 运行 `pnpm desktop:release`，Windows 运行 `pnpm desktop:dist`，当前 Windows 交付明确为未签名。
- `client/apps/desktop/scripts/package-release.mjs` 已读取 `client/config/config.toml`，通过 `enterprise-package-contract.mjs` 校验并序列化，将配置写入 `.pack/deployment/config.toml`。`electron-builder.yml` 再把它放入包内 `Resources/deployment/config.toml`；此过程发生在签名和安装包生成之前。
- 当前标准配置为 `gateway = "http://127.0.0.1:1904"`。账户页面已有“服务端地址”和“保存地址”，daemon 已提供地址校验、配置持久化和切换时的会话清理。
- `prepareEnterpriseUserConfig` 只在用户配置不存在时复制包内配置。实际用户路径是用户主目录下的 `.clawee/config.toml`，并非 Electron 的 userData 目录。
- 构建清单已有源码提交、dirty 状态、Gateway origin、配置 SHA256、Web 哈希及平台信息。正式签名打包要求 Git 工作区干净。
- 官方自动更新仅在指定公共仓库、稳定版本正式 Tag 和发布开关同时满足时生成启用标记；客户仓库构建默认没有该标记。
- Gateway 当前没有客户端公共下载页；Go 静态路由只允许 `/app`、`/admin`、`/login`、`/register` 等已知路径，新增下载页必须同时补充 Go 路由白名单。

本地 `Clawee` 当前比成功发布提交多两个文档提交，并有进行中的服务端修改。客户分支应从上述已成功的公共提交建立，再纳入所需的小改动，不把本地未提交变更作为同步来源。

## 3. 私有仓库与代码同步

使用现有 `/Users/mima000/codespace/krillinai/clawee-agent`，新增长期分支 `customer-packaging`，所有客户共用此分支。

该仓库现在是旧的客户端独立目录结构，公共仓库已经采用 `client/` 和 `server/` 的整合结构。初始化时，在现有仓库中获取公共仓库指定提交，以该提交为起点创建新分支；旧分支和历史保留。不要把新代码逐目录覆盖到旧客户端结构，也不要合并两套发布 workflow。

初始化和后续同步规则：

1. `origin` 继续指向 `wulien/clawee-agent`，增加只用于获取公共代码的 `upstream`，获取时使用 `--no-tags`，避免带入并误推正式 Tag。
2. 新分支基于公共成功提交建立，采用公共仓库完整目录结构。仓库级 Secrets 和 `release` Environment 不随分支变化，不需要把证书放进代码。
3. 私有层只增加 `customers.json`、`packaging/upstream.json`、客户配置选择脚本和客户 workflow。可复用的客户端入口、Gateway 下载页进入公共代码，随后同步到私有分支。
4. 每次升级先确认公共目标 SHA 的成功构建，再把该公共提交合并到 `customer-packaging`。`packaging/upstream.json` 只记录公共仓库名和完整 SHA；合并后核对目录和 workflow 差异。
5. 保留公共 `v*` Tag 语义；客户打包使用手动触发，不推 `v*` Tag，不运行旧仓库的 `desktop-release.yml`，不创建每客户分支。

首期手动同步已经足够，无需再建定时同步机器人、补丁应用框架或多仓库管理服务。客户版本升级是一次公共代码同步，新增客户是一条配置记录。

GitHub 的手动 workflow 发现依赖默认分支存在相应 workflow。试点时，在原默认分支登记同路径的最小 `workflow_dispatch` 入口，执行时明确选择 `customer-packaging` 分支；不搬动旧默认分支业务代码。正式转私有后，可把 `customer-packaging` 设为默认分支并清理临时入口。该仓库设置变更在实施时单独记录。

## 4. 客户配置与注入

私有仓库根目录集中维护 `customers.json`：

```json
{
  "demo": { "gateway": "https://gateway.demo.example.com" },
  "customer-a": { "gateway": "https://gateway.customer-a.example.com" }
}
```

每次手动输入一个客户 ID。使用字符串输入并校验清单，避免 GitHub 静态 choice 列表与配置表重复维护。平台沿用固定三平台矩阵。

配置选择脚本使用 JSON 解析器，按对象自有属性精确查找客户，不把输入拼进 shell 或文件路径。未知客户、空地址、非 HTTPS 地址、含用户凭据、路径、查询参数或 fragment 的 URL 都在启动平台构建前报错。正式客户配置比现有通用契约更严格，不允许 HTTP 或本机回环地址。临时试点域名也使用 HTTPS。

公共打包脚本仅增加可选环境变量 `CLAWEE_DESKTOP_GATEWAY_CONFIG_PATH`：未设置时保持读取原 `client/config/config.toml`；设置时读取指定绝对路径，并沿用现有 TOML 校验与序列化。显式传入的文件缺失或无效时直接失败，不回退到默认地址。

私有 workflow 在安装依赖后，通过现有 TOML 库生成仅包含 `gateway` 的临时文件，放在 runner 的临时目录，再把绝对路径传给原打包命令。生成操作不修改受 Git 管理的文件，也不污染正式打包的 clean 检查。临时源文件不能放进 `.pack/deployment`，因为现有脚本会先清空该目录。

仅包入当前选中客户的 Gateway。不把 `customers.json`、登录凭据、token、`agent_id`、证书或其他客户地址带入应用。

客户端配置优先级保持为：已有用户配置优先；用户配置不存在时使用包内默认配置。具体结果：

| 场景 | 行为 |
| --- | --- |
| 首次安装标准包 | 维持当前默认值，用户在账户页手动设置 Gateway |
| 首次安装客户包 | 初始化为该客户 Gateway，再由用户正常登录 |
| 升级客户包 | 保留本地 Gateway、身份和任务数据 |
| 标准包覆盖客户包，或客户包覆盖标准包 | 保留已有配置，必要时用户手动改地址 |
| 同一用户安装另一客户的包 | 不强制覆盖已有地址；通过手动切换处理 |

“客户专属”在首期表示预配置交付，不表示强制锁定租户或允许多个独立实例并存。即使未来修改 appId，也不会自动隔离当前共用的 `.clawee/config.toml`，不能把改 appId 当作完整的多客户隔离方案。

## 5. 客户 CI 与签名

新增私有 `.github/workflows/customer-desktop.yml`，输入为客户 ID 和要验证的私有完整提交 SHA。先解析并验证目标 SHA 属于交付分支、公共基线记录有效，再把同一 SHA 传给所有任务；客户表与应用源码均从该 SHA 读取，不混用分支最新状态。

首期从成功的 `release.yml` 复用桌面 job 的步骤，作为一个小型客户 workflow 维护。继续直接调用公共打包脚本，不复制 Electron 打包实现。现有完整 Release 同时包含服务端、镜像、COS 官方渠道和 GitHub Release 发布，直接调用会扩大客户打包的影响范围，因此不作为客户入口。暂不为此改造已成功的公共 Release 为大型可复用 workflow。

执行顺序：

1. 校验客户与提交，执行客户端测试、类型检查和 Runtime 契约检查。
2. 在 `macos-15-intel/x64`、`macos-14/arm64`、`windows-latest/x64` 三个平台安装锁定依赖，复用依赖和 Runtime 下载缓存。
3. 生成所选客户临时 TOML，设置可选配置路径，随后运行原命令；每个平台独立构建，不缓存或跨客户复用 `.pack`、应用包和 release 输出目录。
4. macOS 沿用 `release` Environment 的 Developer ID 签名、公证、装订及校验链路。Windows 首期沿用未签名 NSIS EXE；只有配置并验证 Authenticode 证书后，才切换到现有 `desktop:release` 路径并标注已签名。
5. 运行现有包内 Runtime E2E 和真实 Codex 会话检查，再验证包内 Gateway 配置及首次启动复制行为。
6. 汇总三个平台的安装包、原始 Desktop build manifest、SHA256 和客户交付清单，全部成功后才标为可交付。

Gateway 在上述第 3 步进入现有 staging 流程，后续才执行签名和生成安装包。不得解包修改已经签名的 App，也不得修改已生成的安装包内容来更换客户地址。

Secrets 使用现有名称：`MACOS_CERTIFICATE`、`MACOS_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。复用时检查 `release` Environment 是否允许新分支，不读取或导出证书内容。任何携带签名凭据的构建只执行受维护的交付分支提交。

客户构建保持 `CLAWEE_OFFICIAL_RELEASE=0`，并验证包内没有 `official-release.json`。客户端继续禁用官方更新检查；客户更新通过下载页安装新包，保留本地配置。首期不发布客户 updater YML 到官方 `updates/stable`。

## 6. 产物与分发

每次交付使用客户 ID、客户端版本和私有完整 SHA 标识，例如 `customer-a/0.1.7/<private-sha>/macos/arm64/`。目录和 Actions artifact 名称区分客户及平台，安装包内部名称与版本保持现状，避免改动已有产物识别逻辑。同一版本配置变化也有不同提交与独立交付目录，不覆盖旧产物。

增加一个轻量客户交付清单，记录客户 ID、公共 SHA、私有 SHA、版本、所选 Gateway 的配置哈希、workflow run、平台、实际签名状态、文件名、大小和 SHA256。优先引用现有 Desktop build manifest，不把当前要求服务端镜像 digest 的 `scripts/build-release-manifest.mjs` 强行改成客户桌面发布器。

Actions artifact 作为验证和交付中转。正式下载文件部署到客户现有的 HTTPS 静态文件服务或对象存储独立客户目录，发布前验证文件哈希和下载可达性。GitHub 私有仓库 Release/Actions 链接需要 GitHub 权限且 artifact 会过期，不能作为客户公共下载地址。

首期可以由运维把经过验证的安装包复制到静态下载目录，再填写 Gateway 下载链接，无需增加自动上传平台。沿用 COS 时也使用独立客户前缀，不写官方 `releases`、`catalog` 或 `updates/stable`；不直接运行绑定官方完整发布协议的发布命令。

下载页只展示本 Gateway 的配置和安装包链接，不提供全量客户列表。公开下载的包能被解包读出 Gateway 地址，因此预置 URL 本身不能承担访问控制；用户身份和能力授权继续由 Gateway 校验。

## 7. Gateway 公共下载页与配置指南

新增匿名访问的 `/downloads`，登录页增加“下载客户端”入口。它是现有 `server/web` 的一个页面，位于 `AuthGate` 外；同时将 `/downloads` 加入 Go 静态路由白名单，确保直接访问与刷新可用。

使用部署配置中的一个可选 `client_downloads` 配置块，无数据库、管理台编辑器或上传接口。内容仅包含本 Gateway 对外地址及可选的平台安装包记录（平台、架构、版本、下载 HTTPS URL、SHA256、签名状态）。通过只读匿名接口 `/api/v1/public/client-downloads` 返回这些公开字段，不返回整份服务端配置。

Gateway 对外地址优先采用明确部署配置；同域部署未配置时，页面可以使用自身 `window.location.origin`。分域部署明确填写客户端可达的 Gateway origin，不从未经验证的 Host 或转发头构造地址，不附加 `/api` 或 `/mcp`。

页面内容：

- 当前 Gateway 地址和复制按钮。
- 已配置的 macOS Apple Silicon、macOS Intel、Windows x64 客户包下载项，展示版本、校验值和实际签名状态。
- 始终可见的开源标准包入口，默认链接到 `https://github.com/krillinai/Clawee/releases/latest`；客户配置缺失时依然提供完整兜底。
- 简短手动配置指南：下载并安装标准包；打开账户页面；在“服务端地址”粘贴当前 Gateway；点击“保存地址”；再登录企业账号。
- 无法连接时，检查 HTTPS 地址和企业网络；有旧配置时通过账户页修改。切换 Gateway 前结束正在执行的任务，已登录时先退出账户。

客户包链接缺失时不展示对应无效入口，标准包与指南不依赖客户构建完成。下载失败时保留标准包入口。页面只链接安装包，不经 Gateway 业务接口代理大型文件；包服务不可用不会阻止指南显示。GitHub 无法访问的客户可在现有静态文件服务同步标准包并替换部署链接，仍须保留版本与 SHA256。

“公共”表示在该 Gateway 可达网络内无需登录；内网 Gateway 不因此要求开放到互联网。公开下载页也不会授予 Gateway 登录或业务权限。

## 8. 最小变更与验证

公共仓库的改动边界：

- `package-release.mjs` 的可选 Gateway 配置来源及针对性测试，复用已有配置契约、staging 和构建清单。
- Gateway 可选下载配置、公开只读接口、下载页面、登录页入口及静态路由白名单。
- 相应配置示例和使用说明；不改数据库，不改客户端业务 API、Bridge、安装身份、标准包默认配置或官方渠道规则。

私有分支的改动边界：客户表、公共基线记录、配置选择和交付清单脚本、客户 workflow。证书继续存储于仓库 Secrets/Environment。

实施与验收顺序：

1. 增加可选配置入口和私有配置选择脚本。验证：标准默认值不变，两个示例客户分别生成正确配置；未知客户、非法 URL、指定文件缺失均失败；工作区不因注入变脏。
2. 使用示例客户运行本地 `desktop:preflight:local`，通过后提交。在干净目标提交上运行 `desktop:preflight:release`；同时检查最终包内 TOML、构建清单配置哈希、内嵌 Web 哈希、更新禁用标记和实际 App 启动行为。
3. 首次启动检查使用隔离测试用户配置，验证客户地址真实写入；另用已有配置验证覆盖安装不改变地址。现有 fake Gateway E2E 的配置覆盖不能代替此项检查，也不接触开发者真实 `.clawee` 数据。
4. 目标 SHA 推送后，报告本地结果、目标 SHA 和远端 workflow 次数，再执行一次约定的远端三平台验证。macOS 检查签名、公证与安装启动；Windows 检查 NSIS 安装、启动和未签名标注。该步骤完成前不能宣称客户打包成功。
5. 实现并验证 Gateway 下载兜底：匿名请求、直接刷新 `/downloads`、有无客户包配置、三个平台链接、标准包入口、配置指南及私有字段不泄露；服务端测试沿用隔离测试数据库要求。
6. 三平台试点验收后，把 `clawee-agent` 正式切为私有，复核可见性、默认分支和 Environment 分支规则，再提交真实客户地址并交付客户包。

客户手动 workflow 不创建正式 Tag，也不能把官方 Release Preflight 的成功状态当作客户配置验证证据。公共通用改动进入新的正式开源版本时，仍完整执行现有 `desktop:preflight:local`、`desktop:preflight:release`、对应 SHA 的远端 Release Preflight 和 `desktop:tag:check` 流程。

## 9. 方案编写时的验证边界

本次仅完成源码、成功 CI 和仓库状态的只读核对，以及方案文档编写；尚未创建分支、修改构建实现或服务端下载页、推送提交、触发远端打包、变更仓库可见性。

`clawee-agent` 的 SSH Git 读取已成功。但当前 GitHub CLI 活跃账号访问 `wulien/clawee-agent` API 返回 404，另一个已保存账号认证失效，因此未能核实远端可见性、Secrets、Environment 和证书有效性。仓库现有 workflow 确实引用上述签名 Secret 名称；这只能证明使用约定，不能证明凭据当前可用。实施前需要恢复对该仓库的 GitHub Actions API 访问并检查凭据可用性。

按用户约定先试点、后转私有：试点阶段仅使用公开示例客户和可公开测试域名，产物停留在验证流程，不写入真实客户清单或发布客户公开 Release。变更仓库可见性不能收回此前已公开的 Git 历史、日志或已下载的安装包。
