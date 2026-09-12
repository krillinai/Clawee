# GitHub Actions 发布产物同步腾讯云 COS 设计与实现基线

> 状态：已实现并投入正式发布。
>
> 更新日期：2026-09-12。
>
> 当前实现基线：`v0.1.7`，Commit `268e493a76782a2856504850170860e2f2004a27`。

## 1. 背景

Clawee 当前通过 GitHub Actions 构建并发布以下产物：

- macOS x64、macOS arm64 桌面安装包和自动更新文件。
- Windows x64 未签名桌面安装包和自动更新文件。
- Linux amd64、Linux arm64 服务端压缩包。
- Linux amd64、Linux arm64 GHCR 容器镜像。
- 统一发布清单、SHA256 校验文件和桌面构建清单。

当前稳定正式桌面客户端使用 COS 自定义域名下的 generic feed 作为 `electron-updater` 更新源。GitHub Release 继续作为公开发布记录、旧客户端迁移入口和回退镜像；GHCR 继续承载服务端容器镜像。

本方案中的“COS 发布”只负责二进制、更新元数据和官网发布目录。它不改变本地任务、Runtime 会话、Gateway 数据或模型凭据的存储边界。

## 2. 当前能力

仓库当前已经实现：

1. 正式 Release 将完整公开产物集中上传到 COS；Preflight 只上传完整候选产物集的摘要清单。
2. 正式版本按版本号永久保存，官网可以下载最新版本和指定历史版本。
3. 官网通过公开 JSON 目录获取稳定版、预发布版和历史版本信息，不依赖列举 COS Bucket。
4. 正式桌面客户端通过官网/CDN 域名检查更新，并从同一域名下载更新包。
5. 保留 `latest.yml`、`latest-mac.yml`、`latest-arm64-mac.yml`、`.blockmap` 和 `sha512`，继续使用 `electron-updater` 的标准更新协议。
6. 版本文件先上传并验证，最后才更新可变的 `latest` 元数据；失败发布不能让客户端看到不存在或不完整的新包。
7. COS 密钥只进入受保护的集中上传 Job，不进入 macOS、Windows 或服务端构建矩阵。
8. 正式发布继续同步到 GitHub Release，至少在 COS 更新源完成迁移和稳定运行前不移除 GitHub 分发。

## 3. 当前实现不包含

当前实现不包含：

- 新增 Linux Desktop、Windows arm64、MSI、deb 或 rpm 产物。
- 为当前 Windows 安装包增加 Authenticode 签名。COS 分发不能替代代码签名。
- 在 COS 中公开源码、测试报告、运行日志或 Runtime E2E 证据。
- 将普通 push/PR 的测试构建提升为正式版本。
- 在客户端实现完整的更新公告中心。客户端继续使用现有更新提示流程。
- 取消 GitHub Release 或 GHCR。

## 4. 当前实现决策

### 4.1 上传工具

采用腾讯云官方 `COSCLI`，固定到经过校验的版本，不直接使用 `TencentCloud/cos-action@v1`。

截至本文更新日期：

- COSCLI 当前版本为 `v1.0.9`。
- Linux amd64 二进制名称为 `coscli-v1.0.9-linux-amd64`。
- 该二进制 SHA256 为 `a07de5ba2800147a700ed29036b0c76a4229088cee68e1682d0eae19b638a915`。

选择 COSCLI 的原因：

- 支持大文件分片上传、断点续传、失败重试和 CRC64 校验。
- 支持通过 `--meta` 设置 `Cache-Control`、`Content-Type` 等对象元数据。
- 有明确的非零失败退出码，能够直接阻断发布。
- 官方 COS Action 的唯一 `v1` Tag 发布于 2020 年，仍声明 `node12` 运行时，且不支持本方案需要的对象缓存策略、发布顺序和远端完整性校验。

CI 必须从官方 Release 下载 COSCLI，校验 SHA256 后再执行。不得使用浮动的 `master`、`latest` 或未固定提交的第三方 COS Action。

### 4.2 分发主从关系

- COS 自定义域名是官网和新版本桌面客户端的主下载源。
- GitHub Release 是公开发布记录和回退镜像。
- GHCR 继续承载服务端容器镜像，不复制容器镜像层到 COS。
- COS 的 `release.json` 记录 GHCR 镜像名称与 digest，官网可展示容器部署信息。

### 4.3 发布边界

- `Release Preflight` 只上传内部预检目录，不更新官网或客户端的稳定更新入口。
- 正式 `Release` 上传永久版本目录，并在全部校验通过后更新对应渠道。
- 稳定版本只更新 `stable`；SemVer 预发布版本只更新 `prerelease`。
- 预发布版本永远不能覆盖 `stable/latest.json` 或稳定版 updater YML。

## 5. 配置约定

### 5.1 GitHub 配置项

敏感值配置在 GitHub 已有的 `release` Environment 中：

| 类型 | 名称 | 必填 | 说明 |
| --- | --- | --- | --- |
| Secret | `TENCENT_CLOUD_SECRET_ID` | 是 | COS 专用 CAM 子账号 SecretId |
| Secret | `TENCENT_CLOUD_SECRET_KEY` | 是 | COS 专用 CAM 子账号 SecretKey |

配置路径为仓库 `Settings` -> `Environments` -> `release` -> `Environment secrets`。不要通过 Issue、聊天、提交或 CI 日志传递真实值。

非敏感值配置为 Repository Variables，以便 Desktop 构建和 Preflight 读取：

| 类型 | 名称 | 必填 | 示例/约束 |
| --- | --- | --- | --- |
| Variable | `COS_BUCKET` | 是 | 完整桶名，例如 `clawee-release-1250000000` |
| Variable | `COS_REGION` | 是 | 例如 `ap-guangzhou` |
| Variable | `COS_PUBLIC_BASE_URL` | 是 | 例如 `https://download.example.com`，末尾不得带 `/` |
| Variable | `COS_PREFIX` | 是 | 默认并建议使用 `clawee`，不得以 `/` 开头或结尾 |
| Variable | `COS_UPLOAD_ENDPOINT` | 否 | 开启全球加速后配置为 `cos.accelerate.myqcloud.com`；未配置时使用 Region 默认端点 |

配置路径为仓库 `Settings` -> `Secrets and variables` -> `Actions` -> `Variables`。这些值需要配置为 Repository Variables，不要只配置在 `release` Environment 中，否则不声明该 Environment 的 Desktop Preflight Job 无法读取公开更新地址。

上传端点优先使用 `COS_UPLOAD_ENDPOINT`；未配置时由 `COS_REGION` 计算为 `cos.${COS_REGION}.myqcloud.com`。全球加速必须先在 Bucket 的“域名与传输管理”中开启，然后将 `COS_UPLOAD_ENDPOINT` 设置为 `cos.accelerate.myqcloud.com`。公开下载域名仍由 `COS_PUBLIC_BASE_URL` 控制，不受上传端点影响。

正式上传 Job 和 Preflight 集中上传 Job 都声明 `environment: release`，从同一受保护 Environment 读取两个 Secret。Repository Variables 不包含凭据，可以被构建 Job 读取。

如果后续希望 Preflight 不经过正式发布审批，应新增 `cos-preflight` Environment 和只允许写入 `${COS_PREFIX}/preflight/*` 的独立 CAM 密钥，不能放宽正式发布密钥的范围。

### 5.2 配置校验

COS 发布脚本启动时必须拒绝以下情况：

- 任一必填配置为空。
- `COS_PUBLIC_BASE_URL` 不是 `https://` URL、包含查询串/片段或以 `/` 结尾。
- `COS_PREFIX` 包含 `..`、反斜杠、连续斜杠或首尾斜杠。
- `COS_BUCKET` 不是包含 APPID 后缀的完整桶名。
- `COS_REGION` 不符合腾讯云 Region 标识格式。
- `COS_UPLOAD_ENDPOINT` 不是当前 Region 默认端点或 `cos.accelerate.myqcloud.com`。
- Tag、根 `package.json` 版本和统一发布清单版本不一致。

日志只输出 Bucket、Region、对象 Key、文件大小和非敏感校验值。不得输出 Secret、授权头、COSCLI 配置文件内容或预签名 URL。

## 6. COS 对象目录协议

所有对象统一位于 `${COS_PREFIX}/` 下：

```text
clawee/
├── releases/
│   ├── v0.1.0/
│   │   ├── release.json
│   │   ├── release-notes.md
│   │   ├── release-manifest.json
│   │   ├── SHA256SUMS
│   │   ├── desktop/
│   │   │   ├── macos/x64/
│   │   │   ├── macos/arm64/
│   │   │   └── windows/x64/
│   │   ├── server/linux/amd64/
│   │   ├── server/linux/arm64/
│   │   └── updates/
│   │       ├── latest.yml
│   │       ├── latest-mac.yml
│   │       └── latest-arm64-mac.yml
│   └── v0.2.0/...
├── updates/
│   ├── stable/
│   │   ├── latest.yml
│   │   ├── latest-mac.yml
│   │   └── latest-arm64-mac.yml
│   └── prerelease/
├── catalog/
│   ├── stable/
│   │   ├── latest.json
│   │   └── versions.json
│   └── prerelease/
│       ├── latest.json
│       └── versions.json
└── preflight/
    └── <commit-sha>/<github-run-id>/...
```

### 6.1 不可变对象

`releases/vX.Y.Z/**` 一经发布不允许被不同内容覆盖。工作流重跑时：

1. 对象不存在则上传。
2. 对象已存在且本地 SHA256、字节数与已发布清单一致则跳过。
3. 对象已存在但内容不一致则立即失败，不允许覆盖。

同一个版本不能由不同 Git SHA 重新构建并替换。需要修复时必须发布新版本。

### 6.2 可变对象

只有以下对象允许覆盖：

- `updates/<channel>/latest*.yml`
- `catalog/<channel>/latest.json`
- `catalog/<channel>/versions.json`

COS Bucket 必须开启版本控制，以便误发布时恢复这些对象的上一版本；发布器启动时会检查该状态。发布脚本不需要 `cos:DeleteObject` 权限。

### 6.3 Preflight 对象

Preflight 目录使用完整 Commit SHA 和 GitHub Run ID，避免不同运行互相覆盖。完整安装包和服务端包保留在 GitHub Actions Artifacts 中，COS 目录只包含：

- `preflight-manifest.json`，记录 Commit SHA、Run ID、创建时间，以及完整产物集的文件名、字节数和 SHA256。

发布器仍须先在本地严格校验完整产物集、Desktop build manifest 和服务端包内 Commit，再生成并上传清单。该目录不进入官网目录，不供客户端更新使用。COS 生命周期规则应自动删除超过 14 天的 `clawee/preflight/` 对象。

### 6.4 `v0.1.7` 实际文件清单与用途

以下清单来自成功的 [Release Run 34622536741](https://github.com/krillinai/Clawee/actions/runs/34622536741)，对应 Tag `v0.1.7` 和 Commit `268e493a76782a2856504850170860e2f2004a27`。该版本实际使用 `clawee` 前缀；正式发布写入 24 个不可变版本对象，并将 5 个对象晋级为当前 `stable` 渠道。

不可变版本目录的完整对象 Key：

```text
clawee/releases/v0.1.7/
├── SHA256SUMS
├── release-manifest.json
├── release-notes.md
├── release.json
├── desktop/
│   ├── macos/
│   │   ├── arm64/
│   │   │   ├── Clawee-0.1.7-arm64.dmg
│   │   │   ├── Clawee-0.1.7-arm64.dmg.blockmap
│   │   │   ├── Clawee-0.1.7-arm64-mac.zip
│   │   │   ├── Clawee-0.1.7-arm64-mac.zip.blockmap
│   │   │   └── clawee-desktop-build-manifest-mac-arm64.json
│   │   └── x64/
│   │       ├── Clawee-0.1.7.dmg
│   │       ├── Clawee-0.1.7.dmg.blockmap
│   │       ├── Clawee-0.1.7-mac.zip
│   │       ├── Clawee-0.1.7-mac.zip.blockmap
│   │       └── clawee-desktop-build-manifest-mac-x64.json
│   └── windows/x64/
│       ├── Clawee-Setup-0.1.7.exe
│       ├── Clawee-Setup-0.1.7.exe.blockmap
│       └── clawee-desktop-build-manifest-win-x64.json
├── server/linux/
│   ├── amd64/
│   │   ├── clawee-server-v0.1.7-linux-amd64.tar.gz
│   │   └── server-linux-amd64-SHA256SUMS
│   └── arm64/
│       ├── clawee-server-v0.1.7-linux-arm64.tar.gz
│       └── server-linux-arm64-SHA256SUMS
└── updates/
    ├── latest-arm64-mac.yml
    ├── latest-mac.yml
    └── latest.yml
```

稳定渠道的完整可变对象 Key：

```text
clawee/
├── updates/stable/
│   ├── latest-arm64-mac.yml
│   ├── latest-mac.yml
│   └── latest.yml
└── catalog/stable/
    ├── versions.json
    └── latest.json
```

各文件的作用如下：

| 文件或文件组 | 数量 | 作用 |
| --- | ---: | --- |
| `SHA256SUMS` | 1 | 当前版本目录的总校验文件，覆盖其余 23 个不可变对象，不包含自身。 |
| `release-manifest.json` | 1 | CI 构建阶段生成的统一输入清单，记录版本、Commit、签名状态、GHCR digest，以及进入 COS layout 前的 Desktop/Server 构建产物、字节数和 SHA256。 |
| `release-notes.md` | 1 | 与 GitHub Release 同源的版本说明，供官网或其他发布消费者展示。 |
| `release.json` | 1 | 官网发布协议的版本主清单，记录 20 个最终可下载 artifact 的 COS URL、字节数和 SHA256，并包含 Desktop 签名状态与 GHCR 镜像 digest。 |
| macOS `*.dmg` | 2 | macOS x64、arm64 的用户安装镜像。 |
| macOS `*.dmg.blockmap` | 2 | electron-builder 生成的 DMG 块映射，作为发布辅助文件保留；当前 macOS 自动更新 feed 主要引用 ZIP 及其 blockmap。 |
| macOS `*-mac.zip` | 2 | macOS x64、arm64 的自动更新完整包，分别由 `latest-mac.yml` 和 `latest-arm64-mac.yml` 引用。 |
| macOS `*-mac.zip.blockmap` | 2 | macOS ZIP 的差分块映射，供 electron-updater 尝试差分下载。 |
| `Clawee-Setup-0.1.7.exe` | 1 | Windows x64 NSIS 安装包，也是 Windows 自动更新的完整包；`v0.1.7` 未进行 Authenticode 签名。 |
| `Clawee-Setup-0.1.7.exe.blockmap` | 1 | Windows 安装包的差分块映射，供 electron-updater 尝试差分下载。 |
| `clawee-desktop-build-manifest-*.json` | 3 | macOS x64、macOS arm64、Windows x64 的构建证据，记录 Commit、平台、架构、内嵌 Runtime、Web 构建哈希、正式发布标记和本平台产物摘要。 |
| `clawee-server-*.tar.gz` | 2 | Linux amd64、arm64 的独立 Server 部署包。 |
| `server-linux-*-SHA256SUMS` | 2 | 对应架构 Server 部署包的独立 SHA256 校验文件。 |
| `releases/v0.1.7/updates/latest*.yml` | 3 | `v0.1.7` 的不可变 updater feed 快照，记录版本、最终 COS 包 URL、大小和 `sha512`，用于审计和重跑恢复。 |
| `updates/stable/latest*.yml` | 3 | 客户端实际读取的当前稳定更新入口；晋级 `v0.1.7` 时内容与上述不可变快照一致，后续稳定版发布时会覆盖。 |
| `catalog/stable/versions.json` | 1 | 稳定版历史索引，按 SemVer 从新到旧列出版本及其不可变 `release.json` URL。 |
| `catalog/stable/latest.json` | 1 | 当前稳定版官网入口，内容与 `releases/v0.1.7/release.json` 一致，并作为渠道晋级最后写入的发布完成标志。 |

`release.json` 的 20 个 artifact 是 13 个 Desktop 文件、4 个 Server 文件和 3 个不可变 updater YML；它不包含 `SHA256SUMS`、`release-manifest.json`、`release-notes.md` 和自身。GHCR 镜像层也不复制到 COS，只在 `release.json.serverImage` 中记录镜像名称与 digest。

同一个 Release Run 还写入以下 Preflight 对象，但它不属于正式公开分发文件：

```text
clawee/preflight/268e493a76782a2856504850170860e2f2004a27/34622536741/preflight-manifest.json
```

该文件只记录候选构建完整产物集的文件名、字节数和 SHA256，使用 `private,no-store`，不进入官网 catalog 或 Desktop updater feed。GitHub Release 将上述 24 个不可变对象作为公开镜像上传，但资产位于 Release 根级，未保留 COS 的分层目录。

## 7. 官网发布目录协议

### 7.1 `release.json`

每个正式版本生成一个不可变的 `releases/vX.Y.Z/release.json`：

```json
{
  "schemaVersion": 1,
  "product": "Clawee",
  "version": "0.2.0",
  "tag": "v0.2.0",
  "channel": "stable",
  "commit": "40位GitSHA",
  "publishedAt": "2026-09-10T10:00:00.000Z",
  "releaseNotesUrl": "https://download.example.com/clawee/releases/v0.2.0/release-notes.md",
  "artifacts": [
    {
      "id": "desktop-macos-arm64-dmg",
      "component": "desktop",
      "platform": "macos",
      "arch": "arm64",
      "format": "dmg",
      "name": "Clawee-0.2.0-arm64.dmg",
      "bytes": 123456789,
      "sha256": "64位十六进制摘要",
      "downloadUrl": "https://download.example.com/clawee/releases/v0.2.0/desktop/macos/arm64/Clawee-0.2.0-arm64.dmg"
    }
  ],
  "desktop": {
    "macosSigning": "developer-id-notarized",
    "windowsSigning": "unsigned"
  },
  "serverImage": {
    "name": "ghcr.io/krillinai/clawee-server",
    "digest": "sha256:..."
  }
}
```

约束：

- `artifacts` 必须覆盖本次正式发布的二进制、更新辅助文件、服务端包和 build manifest；`release.json` 不记录自身，避免自引用摘要。
- 当前 `v0.1.7` 的 `release.json` 包含 20 个 artifact；数量会随受支持平台或产物协议变化，消费者应按字段筛选，不应写死数量。
- `downloadUrl` 必须位于 `COS_PUBLIC_BASE_URL/COS_PREFIX/releases/<tag>/` 下。
- Desktop 安装包、更新 ZIP、blockmap、服务端 tar.gz、校验文件和 build manifest 都要记录。
- Runtime E2E 证据、Playwright 报告和 CI 日志不得进入该文件。
- Windows 仍未签名时，发布说明和清单必须继续明确该限制。

`SHA256SUMS` 在 `release.json` 和 `release-notes.md` 生成后创建，覆盖全部不可变公开文件但不包含 `SHA256SUMS` 自身。

### 7.2 `latest.json`

`catalog/stable/latest.json` 与对应版本的 `release.json` 内容保持一致。官网只需一次请求即可获得当前稳定版本和平台下载地址。

发布 `v0.2.0-rc.1` 时只更新 `catalog/prerelease/latest.json`。稳定版客户端和官网默认下载入口不得读取 prerelease 目录。

### 7.3 `versions.json`

```json
{
  "schemaVersion": 1,
  "product": "Clawee",
  "channel": "stable",
  "generatedAt": "2026-09-10T10:00:00.000Z",
  "versions": [
    {
      "version": "0.2.0",
      "tag": "v0.2.0",
      "publishedAt": "2026-09-10T10:00:00.000Z",
      "releaseUrl": "https://download.example.com/clawee/releases/v0.2.0/release.json"
    }
  ]
}
```

版本按 SemVer 从新到旧排列。官网历史版本页读取该文件，不调用 COS List Objects，不需要向匿名用户开放 Bucket 列举权限。

### 7.4 官网接入边界

本仓库不包含独立的公开官网；`server/web` 和 `client/apps/web` 都是工作台，不承担公开下载页。因此本仓库只生成并验证上述目录协议，官网项目按以下最小契约接入：

- 默认下载读取 `${COS_PUBLIC_BASE_URL}/${COS_PREFIX}/catalog/stable/latest.json`，并使用其 `artifacts[].downloadUrl`。
- 历史版本读取 `${COS_PUBLIC_BASE_URL}/${COS_PREFIX}/catalog/stable/versions.json`，再按 `releaseUrl` 读取指定版本。
- 预发布入口只在官网明确提供预览渠道时读取 `catalog/prerelease/`，不与稳定版列表合并。

官网上线不在本仓库内伪造占位实现；必须在官网所属仓库完成并按 16.3 节联调验收。

## 8. Desktop 自动更新设计

### 8.1 更新地址

正式稳定版客户端使用 `electron-updater` generic provider：

```yaml
provider: generic
url: https://download.example.com/clawee/updates/stable
channel: latest
useMultipleRangeRequest: false
```

实际 URL 在构建时由 `COS_PUBLIC_BASE_URL` 和 `COS_PREFIX` 生成。正式构建缺少该配置时必须失败，不能静默回退到错误地址。

现有架构选择保持不变：

- Windows x64 请求 `latest.yml`。
- macOS x64 请求 `latest-mac.yml`。
- macOS arm64 将 channel 设为 `latest-arm64`，请求 `latest-arm64-mac.yml`。

只有同时满足稳定 SemVer、`CLAWEE_OFFICIAL_RELEASE=1`、仓库为 `krillinai/Clawee` 且当前 Ref 为 `v<version>` 时，打包脚本才写入 `deployment/official-release.json` 并启用正式 COS 更新源。开发构建、预发布版本和 Preflight 包使用 `https://updates.invalid/clawee/disabled`，且不写入该标记，因此自动更新保持禁用。

### 8.2 YML 重写

electron-builder 生成的 YML 默认使用同目录文件名。COS 发布准备脚本当前执行：

1. 使用结构化 YAML 解析器读取文件。
2. 校验 `version` 与 Tag 一致。
3. 校验 `files[].url` 和兼容字段 `path` 只引用本次构建产物。
4. 保留原始 `sha512`、`size`、`releaseDate` 和 blockmap 关系。
5. 将下载 URL 改写为 `releases/<tag>/desktop/...` 下的绝对 HTTPS URL。
6. 将改写后的文件先保存到 `releases/<tag>/updates/`，再在渠道晋级阶段复制到 `updates/<channel>/`。

不能通过字符串替换修改 YAML，也不能接受 `..`、绝对本地路径、未知域名或不在发布清单中的文件名。

版本目录和文件名都包含版本号，因此 electron-updater 推导旧版本 blockmap 时可以定位到相同目录结构中的历史文件。发布后必须实际验证一次从上一稳定版到当前稳定版的差分下载；失败时仍应能够回退到完整包下载。

### 8.3 老客户端迁移与双发

旧客户端内嵌 GitHub provider，无法通过修改 COS 文件改变其更新地址；当前稳定正式包已经完成 COS generic provider 接入。

正式 Release 仍执行双发布：

1. 新的稳定正式安装包内嵌 COS generic provider。
2. 同一批安装包和 updater 元数据继续上传 GitHub Release。
3. 尚未迁移的旧客户端仍可通过 GitHub Release 获取迁移版本。
4. 已迁移客户端从 COS 检测和下载后续稳定版本。

旧版本到迁移版本、迁移版本到后续 COS 版本的真实跨版本升级仍属于发布验收项。除非有覆盖主要用户的升级数据和明确退役决策，否则不得停止生成 GitHub updater 文件；建议长期保留 GitHub Release 镜像。

## 9. 缓存、域名与访问控制

推荐使用私有 COS Bucket，并通过开启回源鉴权的 CDN 自定义域名对外提供下载。若暂不使用 CDN，则必须为公开下载对象配置匿名 GET，不能让客户端持有 COS 凭据。

对象缓存策略：

| 对象 | `Cache-Control` |
| --- | --- |
| `releases/vX.Y.Z/**` | `public,max-age=31536000,immutable` |
| `updates/<channel>/latest*.yml` | `no-cache,max-age=0,must-revalidate` |
| `catalog/<channel>/latest.json` | `no-cache,max-age=0,must-revalidate` |
| `catalog/<channel>/versions.json` | `no-cache,max-age=0,must-revalidate` |
| `preflight/**` | `private,no-store` |

当前发布器按上述策略写入对象元数据，并在公网校验时把 `Cache-Control` 解析为不区分大小写、空格和指令顺序的指令集合。工作流不调用 CDN 刷新 API；可变目录能否及时生效依赖 `no-cache,max-age=0,must-revalidate` 和 CDN 回源配置。`v0.1.6` 曾因 CDN 返回 `public, immutable, max-age=31536000` 导致校验失败，`v0.1.7` 已按当前比较规则和缓存策略完成发布。

同时要求：

- CDN 对 `updates/**`、`catalog/**` 配置不缓存或每次重验证；如运维侧另行配置刷新能力，只刷新这些可变 Key。
- COS/CDN 保留 `ETag`、`Last-Modified`、`Content-Length` 和 Range 请求能力。
- JSON 使用 `application/json; charset=utf-8`。
- YML 使用 `application/yaml; charset=utf-8`。
- ZIP 使用 `application/zip`，tar.gz 使用 `application/gzip`，DMG 使用 `application/x-apple-diskimage`，EXE 和 blockmap 使用 `application/octet-stream`。
- 官网若跨域请求 `catalog/*.json`，COS/CDN CORS 只允许官网 Origin 的 `GET`、`HEAD`；不开放匿名写入。

官网固定的“下载最新版”URL 应由官网服务读取 `latest.json` 后返回 `302` 到不可变版本 URL，或由前端读取 JSON 后直接设置下载链接。不要在 COS 中维护一份会不断覆盖的 `downloads/latest/Clawee.dmg`。

COS/CDN 的 Bucket 级配置不由发布 Job 修改，以免扩大 CAM 权限。配置人员应在腾讯云控制台配置并定期复核：

- `${COS_PREFIX}/preflight/**` 对象的生命周期为 14 天后自动删除。
- 公开域名允许 `GET`、`HEAD` 和 Range；CORS 只允许官网 Origin 的 `GET`、`HEAD`。
- `updates/**` 和 `catalog/**` 不缓存或短缓存，`releases/**` 保持不可变长缓存。
- 发布子账号的 CAM Policy 只包含第 13 节权限和目标 Bucket 的 `${COS_PREFIX}/` 前缀。

验收结果需记录规则名称、目标 Bucket/前缀、公开域名和验收时间，但不记录 Secret。

## 10. 当前 GitHub Actions 流程

### 10.1 `Release Preflight`

现有工作流在 Desktop 和 Server Package Job 成功后运行 `cos-preflight-upload`：

- `needs: [client, server, desktop, server-package, container]`。
- 运行于 `ubuntu-latest`。
- 声明 `environment: release`，只有该 Job 读取 COS Secret。
- 下载 `clawee-desktop-preflight-*` 和 `clawee-server-preflight-*` artifacts。
- 严格校验允许的文件名、扩展名、路径和 target SHA。
- 校验完整产物集，只生成并上传 `preflight-manifest.json`；完整包仅保留在 GitHub Actions Artifacts。
- 上传到 `preflight/<target-sha>/<github-run-id>/`。
- 远端验证失败则整个 Preflight 失败，不写 `release-preflight=success` 状态。

`record` Job 的 `needs`、结果环境变量和成功条件均包含 `cos-preflight-upload`；上传失败时 Commit Status 不会被记录为成功。

安全边界：该 Job 先下载候选构建产物，再另行 checkout 默认受保护分支到 `publisher/`，并从该目录运行 `publisher/scripts/cos-publish.mjs`。它不 checkout 或执行 `inputs.ref` 指向的候选代码；候选构建产物只作为不可信数据处理，不执行其中的脚本或二进制。

### 10.2 正式 `Release`

正式 Tag Release 当前按以下顺序执行：

1. Tag 触发 Release，并运行完整的 reusable Release Preflight。
2. Gate 校验版本、Tag、签名/公证凭据和 GitHub Release 状态。
3. 对尚未公开的版本构建 Desktop、Server 包和 `sha-<commit>` 多架构镜像。
4. `publish` 创建或复用 GitHub 草稿 Release，读取 release notes 和 `createdAt`。
5. 下载并校验产物，生成统一清单、COS staged layout、`release.json` 和 updater YML。
6. 上传并验证 COS 不可变版本目录。
7. 将发布资产上传到 GitHub 草稿 Release。
8. 为已构建的 GHCR digest 发布版本 Tag；稳定版同时更新 `latest`。
9. 仅当 COS 渠道尚未建立时，在无消费者的前提下执行 bootstrap。
10. 公开 GitHub Release。
11. 晋级 COS updater YML 和 `versions.json`，最后写入 `catalog/<channel>/latest.json`。

COS 不可变文件失败时不得公开 GitHub Release。GitHub 已公开但 COS 晋级失败时，workflow 会失败；重跑同一 Tag 时跳过 Desktop、Server 和镜像重建，从 GitHub Release 下载原始 `release.json` 与三个 updater YML，以 `--verify-immutable` 核对不可变目录后只重试 COS 渠道晋级。该分支不得重建不可变内容或重新绑定 GHCR 版本标签。

### 10.3 并发和版本顺序

正式 `publish` 使用以下全局互斥，防止不同 Tag 并行晋级同一 COS 渠道：

```yaml
concurrency:
  group: cos-production-release
  cancel-in-progress: false
```

进入互斥区后重新读取当前 `latest.json`：

- 待发布版本高于当前渠道版本才允许晋级。
- 相同版本且 Commit、摘要完全一致时允许幂等重跑。
- 相同版本内容不同或版本更低时拒绝覆盖。

预发布版本与稳定版本分别比较，不跨渠道排序或晋级。

## 11. 发布原子性与回滚

COS 不提供跨多个对象的事务。发布脚本按以下规则获得可接受的一致性：

1. 先上传所有不可变二进制和版本元数据。
2. 对每个远端对象执行存在性、字节数和校验验证。
3. 读取并备份当前渠道三个 `latest*.yml`、`versions.json` 和 `latest.json` 的对象内容。
4. 更新 updater YML。
5. 更新 `versions.json`。
6. 最后更新 `latest.json`。

`latest.json` 是官网的单一发布完成标志。任何渠道文件更新失败时，脚本按写入的逆序重新上传备份内容，并再次执行 COS 端和公网校验，然后返回非零退出码。发布器不读取或保存 COS `VersionId`；Bucket 版本控制是强制启动检查，也是自动恢复失败后的第二层人工恢复手段。若当前 `latest.json` 已存在但五个渠道对象中任一对象缺失，发布器会拒绝晋级，避免在没有完整备份时覆盖渠道。

首次建立某个渠道时没有旧对象，在不授予 `DeleteObject` 且 COS 无跨对象事务的前提下，无法对“原本不存在”做严格回滚。发布脚本在不可变对象、GitHub 草稿产物和 GHCR 镜像已就绪后检查渠道；若 `latest.json` 不存在，它会在公开 GitHub Release 前执行一次 bootstrap。该操作只允许用于官网和 Desktop 尚未消费 COS 的空渠道；若中途失败，GitHub Release 保持草稿，直接重跑同一 Tag 补齐对象，直到三个 updater YML、`versions.json` 和最后的 `latest.json` 全部通过公开域名验证。建立基线后，bootstrap 自动跳过，后续晋级仍必须遵守上述备份恢复规则。

禁止使用 `coscli sync --delete` 或官方 Action 的 `clean: true`。历史版本不能因本地工作目录不完整而被删除。

## 12. 上传与完整性校验

发布脚本当前执行以下校验：

- 上传前重新计算所有文件 SHA256，与统一发布清单比较。
- COSCLI 启用错误重试、断点续传和整体 CRC64 校验，不使用 `--disable-checksum=true` 的默认行为。
- 上传时写入 SHA256 自定义元数据，上传后通过 COS `stat` 确认对象存在、字节数和 SHA256 元数据正确；历史对象缺少元数据时才回退为完整下载校验。
- 对 `release.json` 和三个 updater YML 从公开域名执行完整 GET 并解析，确认 CDN/COS 返回的是刚发布内容。
- updater 引用的包，以及其余 DMG、ZIP、EXE、blockmap 和 tar.gz，均通过公开域名执行 HEAD、`Content-Length`、`Content-Type`、`Cache-Control` 和 Range 校验。
- `release-manifest.json`、`SHA256SUMS`、Desktop build manifest 等其他对象不逐个执行公网 GET，但均经过 COS `stat` 的字节数和自定义 SHA256 校验；缺少 SHA256 元数据时完整下载校验。
- updater YML 的 `sha512` 在上传前与本地产物核对；公网 `Cache-Control` 校验忽略大小写、空格和指令顺序。
- `release.json` 中的 SHA256、文件大小、版本、Commit 和 GHCR digest 必须与当前 Release 一致。

COS multipart ETag 不能作为文件 SHA256 使用。官网展示和用户校验统一以 `SHA256SUMS`、`release.json` 中的 SHA256 为准。

## 13. 凭据与 CAM 权限

使用专用 CAM 子账号，不使用主账号密钥。正式账号只允许操作目标 Bucket 的 `${COS_PREFIX}/` 前缀。

按照 COSCLI 当前的上传与校验行为，需要以下权限：

- `cos:HeadBucket`
- `cos:GetBucket`
- `cos:HeadObject`
- `cos:GetObject`
- `cos:PutObject`
- `cos:InitiateMultipartUpload`
- `cos:UploadPart`
- `cos:CompleteMultipartUpload`
- `cos:ListMultipartUploads`
- `cos:ListParts`

不授予：

- `cos:DeleteObject`
- Bucket 创建、删除和策略修改权限
- 对象 ACL 修改权限
- 其他 Bucket 或 `${COS_PREFIX}/` 之外的对象权限

根据实际 APPID、Bucket、Region 和前缀生成精确 CAM Policy JSON，由配置人员在腾讯云控制台创建并验证。Policy JSON 不包含 Secret，可以作为运维文档保存；真实 Secret 不进入仓库。

发布器在 `$RUNNER_TEMP` 下创建权限为 `0600` 的临时 COSCLI 配置，并在存储操作的 `finally` 清理临时目录。该配置不得加入缓存或上传为 artifact；命令日志不得展开 Secret 参数。

## 14. 当前实现位置与职责

- `.github/workflows/release.yml`：正式 Tag 发布门禁、构建、GitHub 草稿/公开 Release、GHCR 标记、COS 不可变上传和渠道晋级。
- `.github/workflows/release-preflight.yml`：候选 SHA 的完整预检，以及从受保护默认分支执行 COS Preflight 清单上传。
- `scripts/cos-release-layout.mjs`：对象 Key、公开 URL、artifact 分类、catalog、`release.json` 和 updater 元数据生成。
- `scripts/cos-publish.mjs`：固定 COSCLI 安装、配置校验、上传、COS/公网验证、bootstrap、晋级和失败恢复。
- `scripts/build-release-manifest.mjs`：生成 Desktop、Server 和 GHCR digest 的统一发布清单。
- `scripts/release-version.mjs`：稳定版/预发布版 SemVer、Tag 和渠道解析。
- `client/apps/desktop/electron-builder.yml`：正式包的 generic provider 模板和三种平台/架构 feed 约定。
- `client/apps/desktop/scripts/package-release.mjs`：判断正式发布上下文、注入 COS URL，并只为稳定正式包生成 `official-release.json`。
- `client/apps/desktop/src/main/updater.ts`：根据正式发布标记启用自动更新，并处理 macOS arm64 独立 channel。

COS 上传不在 Desktop、daemon 或 Gateway 业务层实现。发布行为由根脚本和 GitHub Actions 负责，后续修改应继续保持该边界。

## 15. 后续开发与变更规则

1. 新增平台、架构或产物格式时，同时更新 artifact 分类、完整产物集合、MIME 类型、`release.json` 契约和相关测试。
2. 修改 updater 文件名、channel 或目录结构时，同时验证 electron-builder 输出、YML URL 改写、旧 blockmap 推导和真实跨版本升级。
3. 修改渠道晋级逻辑时，必须保持不可变对象先完成、渠道对象可恢复、`latest.json` 最后写入、stable/prerelease 隔离和禁止降级。
4. 修改 COS Secret 使用位置时，必须确保只有受保护的集中上传 Job 能读取凭据，候选 Ref 的代码不能在该权限上下文中执行。
5. 修改公开目录 schema 时，应保持向后兼容；确需破坏性变更时提升 `schemaVersion`，并先协调官网消费者。
6. 不得通过重建或移动正式 Tag 修复已发布内容；应发布新版本。对已公开但晋级失败的同一 Tag，只允许走现有恢复分支。

## 16. 测试要求

### 16.1 已自动化的单元和契约测试

- JSON schema 和字段稳定性。
- 文件名到平台、架构、格式的唯一映射。
- 版本目录不可变和同版本幂等重跑。
- SemVer stable/prerelease 分流和禁止降级。
- YAML 结构化解析、URL 改写及 SHA512 保留。
- URL 编码、路径穿越、重复文件名和未知产物拒绝。
- COSCLI 下载摘要校验。
- 上传顺序和失败恢复。
- Workflow 只有集中发布 Job 引用 COS Secret。

当前主要测试入口：

```bash
pnpm test
pnpm --dir client --filter @clawee/desktop test
```

对应测试文件为 `scripts/cos-release-layout.test.mjs`、`scripts/cos-publish.test.mjs`、`client/apps/desktop/test/package-release-script.test.mjs` 和 `client/apps/desktop/test/release-workflow.test.mjs`。

### 16.2 Release 中的真实 COS/CDN 校验

- 正式发布和 Preflight 均上传真实 COS 对象，并通过 COS `stat` 校验字节数和 SHA256 元数据。
- 正式发布通过公开域名验证 `release.json`、三个 updater YML 和公开二进制的 HEAD/GET/Range、MIME 与缓存头。
- 正式发布解析 `latest*.yml` 的实际包 URL，核对文件大小、Range 能力和本地 `sha512`。
- 渠道晋级执行版本顺序、同版本幂等、stable/prerelease 隔离和 `latest.json` 最后写入检查；失败恢复由单元测试覆盖。

### 16.3 外部运维和人工发布验收

- 修改客户端可执行代码、打包或发布配置后，提交前运行并通过 `pnpm run desktop:preflight:local`。
- 正式发布在干净提交上运行 `pnpm run desktop:preflight:release`。
- 推送后审查普通 CI、Server CI、Source Security。
- 对同一 SHA 运行一次远端 Release Preflight。
- 运行 `pnpm run desktop:tag:check` 后创建不可移动的正式 Tag。
- 正式发布后从 COS 公网域名实际下载并安装 macOS x64、macOS arm64、Windows x64 包。
- 校验 Linux amd64/arm64 服务端包和 GHCR 多架构镜像 digest。
- 从上一正式版本执行一次真实自动更新。
- 在腾讯云侧确认 Bucket Versioning、Preflight 14 天生命周期、CORS、CDN 回源鉴权和可变目录缓存规则仍生效。
- 在官网所属仓库验证 `latest.json`、`versions.json`、历史版本和预发布入口；本仓库不自动化官网 UI 验收。

## 17. 当前状态与外部边界

仓库侧 COS 分发一期已经落地，当前代码具备：

- GitHub Actions 中只有集中上传 Job 可以访问 COS Secret。
- 正式版本按本文目录上传完整产物，Preflight 只上传包含完整产物摘要的清单。
- Desktop 稳定正式包使用官网/COS generic feed；非正式包不会连接正式更新源。
- stable、prerelease 不会互相覆盖，旧版本不能反向覆盖新版本。
- 任一二进制上传失败时，客户端和官网仍看到上一完整版本。
- COS、GitHub Release 和 GHCR 的版本、Commit、文件摘要和镜像 digest 可相互核对。
- 仓库、日志、缓存、artifact 和发布包中不存在 COS Secret 或临时配置文件。

以下事项不由仓库代码自动配置，仍属于外部部署或人工验收责任：

- 官网读取稳定版/预发布版 catalog 并提供最新和历史版本下载入口。
- COS Bucket Versioning、生命周期、CAM Policy、CORS、CDN 域名、回源鉴权和缓存规则。
- macOS、Windows 安装包的真实安装验收，以及上一正式版本到当前版本的真实自动更新验收。
- 旧 GitHub provider 客户端迁移覆盖率的观测，以及未来是否退役 GitHub updater 镜像的产品决策。

## 18. 参考资料

- [腾讯云官方 COS Action](https://github.com/TencentCloud/cos-action)
- [腾讯云 COSCLI 仓库](https://github.com/tencentyun/coscli)
- [腾讯云 COSCLI 官方文档](https://cloud.tencent.com/document/product/436/63143)
- [腾讯云 COS 全球加速](https://cloud.tencent.com/document/product/436/38866)
- [腾讯云 COS 临时密钥说明](https://cloud.tencent.com/document/product/436/14048)
- [腾讯云 COS CDN 加速配置](https://cloud.tencent.com/document/product/436/18670)
- [Tencent Cloud COS Node.js SDK](https://github.com/tencentyun/cos-nodejs-sdk-v5)
- [electron-builder Auto Update](https://www.electron.build/auto-update.html)
- [electron-updater Generic Provider](https://www.electron.build/publish.html#genericserveroptions)
- [GitHub Actions 使用机密](https://docs.github.com/zh/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
