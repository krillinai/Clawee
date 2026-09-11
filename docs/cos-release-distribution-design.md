# GitHub Actions 发布产物同步腾讯云 COS 方案

> 状态：方案已确认，可以进入实现。
>
> 更新日期：2026-09-10。

## 1. 背景

Clawee 当前通过 GitHub Actions 构建并发布以下产物：

- macOS x64、macOS arm64 桌面安装包和自动更新文件。
- Windows x64 未签名桌面安装包和自动更新文件。
- Linux amd64、Linux arm64 服务端压缩包。
- Linux amd64、Linux arm64 GHCR 容器镜像。
- 统一发布清单、SHA256 校验文件和桌面构建清单。

当前正式桌面客户端使用 GitHub Release 作为 `electron-updater` 更新源。为了让官网提供稳定、可控的下载入口，并降低最终用户访问 GitHub Release 的依赖，需要在现有发布流程后增加腾讯云 COS 分发，同时保留 GitHub Release 作为发布记录和回退镜像。

本方案中的“COS 发布”只负责二进制、更新元数据和官网发布目录。它不改变本地任务、Runtime 会话、Gateway 数据或模型凭据的存储边界。

## 2. 目标

一期必须实现：

1. GitHub Actions 每次生成可分发包后，将产物集中上传到 COS。
2. 正式版本按版本号永久保存，官网可以下载最新版本和指定历史版本。
3. 官网通过公开 JSON 目录获取稳定版、预发布版和历史版本信息，不依赖列举 COS Bucket。
4. 正式桌面客户端通过官网/CDN 域名检查更新，并从同一域名下载更新包。
5. 保留 `latest.yml`、`latest-mac.yml`、`latest-arm64-mac.yml`、`.blockmap` 和 `sha512`，继续使用 `electron-updater` 的标准更新协议。
6. 版本文件先上传并验证，最后才更新可变的 `latest` 元数据；失败发布不能让客户端看到不存在或不完整的新包。
7. COS 密钥只进入受保护的集中上传 Job，不进入 macOS、Windows 或服务端构建矩阵。
8. 正式发布继续同步到 GitHub Release，至少在 COS 更新源完成迁移和稳定运行前不移除 GitHub 分发。

## 3. 非目标

一期不包含：

- 新增 Linux Desktop、Windows arm64、MSI、deb 或 rpm 产物。
- 为当前 Windows 安装包增加 Authenticode 签名。COS 分发不能替代代码签名。
- 在 COS 中公开源码、测试报告、运行日志或 Runtime E2E 证据。
- 将普通 push/PR 的测试构建提升为正式版本。
- 在客户端实现完整的更新公告中心。客户端一期继续使用现有更新提示流程。
- 取消 GitHub Release 或 GHCR。

## 4. 已确认决策

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

COS Bucket 应开启版本控制，以便误发布时恢复这些对象的上一版本。发布脚本不需要 `cos:DeleteObject` 权限。

### 6.3 Preflight 对象

Preflight 目录使用完整 Commit SHA 和 GitHub Run ID，避免不同运行互相覆盖。完整安装包和服务端包保留在 GitHub Actions Artifacts 中，COS 目录只包含：

- `preflight-manifest.json`，记录 Commit SHA、Run ID、创建时间，以及完整产物集的文件名、字节数和 SHA256。

发布器仍须先在本地严格校验完整产物集、Desktop build manifest 和服务端包内 Commit，再生成并上传清单。该目录不进入官网目录，不供客户端更新使用。COS 生命周期规则应自动删除超过 14 天的 `clawee/preflight/` 对象。

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
  "serverImage": {
    "name": "ghcr.io/krillinai/clawee-server",
    "digest": "sha256:..."
  }
}
```

约束：

- `artifacts` 必须覆盖本次正式发布的二进制、更新辅助文件、服务端包和 build manifest；`release.json` 不记录自身，避免自引用摘要。
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

官网上线不在本仓库内伪造占位实现；必须在官网所属仓库完成并按 16.2 节联调验收。

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

开发构建和 Preflight 包没有 `deployment/official-release.json`，继续禁用自动更新，不得连接正式 COS 更新源执行安装。

### 8.2 YML 重写

electron-builder 生成的 YML 默认使用同目录文件名。COS 发布准备脚本需要：

1. 使用结构化 YAML 解析器读取文件。
2. 校验 `version` 与 Tag 一致。
3. 校验 `files[].url` 和兼容字段 `path` 只引用本次构建产物。
4. 保留原始 `sha512`、`size`、`releaseDate` 和 blockmap 关系。
5. 将下载 URL 改写为 `releases/<tag>/desktop/...` 下的绝对 HTTPS URL。
6. 将改写后的文件先保存到 `releases/<tag>/updates/`，再在渠道晋级阶段复制到 `updates/<channel>/`。

不能通过字符串替换修改 YAML，也不能接受 `..`、绝对本地路径、未知域名或不在发布清单中的文件名。

版本目录和文件名都包含版本号，因此 electron-updater 推导旧版本 blockmap 时可以定位到相同目录结构中的历史文件。发布后必须实际验证一次从上一稳定版到当前稳定版的差分下载；失败时仍应能够回退到完整包下载。

### 8.3 老客户端迁移

当前已发布的 `v0.1.0` 客户端内嵌 GitHub provider，无法通过修改 COS 文件改变其更新地址。

第一个切换版本必须执行双发布：

1. 新版本安装包内嵌 COS generic provider。
2. 同一批安装包继续上传 GitHub Release，并保留 GitHub updater 元数据。
3. `v0.1.0` 从 GitHub 检测并安装该迁移版本。
4. 迁移版本之后从 COS 检测和下载更新。

在确认迁移版本覆盖主要用户之前，不得停止生成 GitHub updater 文件。为降低迁移风险，建议长期保留 GitHub Release 镜像。

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

同时要求：

- CDN 对 `updates/**`、`catalog/**` 配置不缓存或短缓存，发布后只刷新这些可变 Key。
- COS/CDN 保留 `ETag`、`Last-Modified`、`Content-Length` 和 Range 请求能力。
- JSON 使用 `application/json; charset=utf-8`。
- YML 使用 `application/yaml; charset=utf-8`。
- ZIP 使用 `application/zip`，tar.gz 使用 `application/gzip`，DMG 使用 `application/x-apple-diskimage`，EXE 和 blockmap 使用 `application/octet-stream`。
- 官网若跨域请求 `catalog/*.json`，COS/CDN CORS 只允许官网 Origin 的 `GET`、`HEAD`；不开放匿名写入。

官网固定的“下载最新版”URL 应由官网服务读取 `latest.json` 后返回 `302` 到不可变版本 URL，或由前端读取 JSON 后直接设置下载链接。不要在 COS 中维护一份会不断覆盖的 `downloads/latest/Clawee.dmg`。

COS/CDN 的 Bucket 级配置不由发布 Job 修改，以免扩大 CAM 权限。首次发布前由配置人员在腾讯云控制台一次性确认：

- `${COS_PREFIX}/preflight/**` 对象的生命周期为 14 天后自动删除。
- 公开域名允许 `GET`、`HEAD` 和 Range；CORS 只允许官网 Origin 的 `GET`、`HEAD`。
- `updates/**` 和 `catalog/**` 不缓存或短缓存，`releases/**` 保持不可变长缓存。
- 发布子账号的 CAM Policy 只包含第 13 节权限和目标 Bucket 的 `${COS_PREFIX}/` 前缀。

验收结果需记录规则名称、目标 Bucket/前缀、公开域名和验收时间，但不记录 Secret。

## 10. GitHub Actions 改造

### 10.1 `Release Preflight`

在现有 Desktop 和 Server Package Job 成功后新增 `cos-preflight-upload`：

- `needs: [client, server, desktop, server-package, container]`。
- 运行于 `ubuntu-latest`。
- 声明 `environment: release`，只有该 Job 读取 COS Secret。
- 下载 `clawee-desktop-preflight-*` 和 `clawee-server-preflight-*` artifacts。
- 严格校验允许的文件名、扩展名、路径和 target SHA。
- 校验完整产物集，只生成并上传 `preflight-manifest.json`；完整包仅保留在 GitHub Actions Artifacts。
- 上传到 `preflight/<target-sha>/<github-run-id>/`。
- 远端验证失败则整个 Preflight 失败，不写 `release-preflight=success` 状态。

现有 `record` Job 的 `needs`、结果环境变量和成功条件都必须加入 `cos-preflight-upload`；不能只让上传 Job 失败而仍把 Commit Status 记录为成功。

安全要求：该 Job 不得 checkout 或执行 `inputs.ref` 指向的候选代码。上传器必须来自受保护的默认分支，或完全由 workflow 内固定的 COSCLI 下载与命令组成。候选构建产物只作为不可信数据处理，不能执行其中的脚本或二进制。

### 10.2 正式 `Release`

现有 `publish` Job 已集中下载 `clawee-*-release-*` artifacts，适合承担正式 COS 发布。改造如下：

1. 为 `publish` 增加 `environment: release`。
2. 下载并校验所有 Desktop、Server artifacts。
3. 生成统一清单、`release.json`、版本列表候选文件和 COS updater YML。
4. 创建或复用 GitHub 草稿 Release，生成 `release-notes.md`。
5. 上传并验证 COS 不可变版本目录。
6. 将相同文件上传 GitHub 草稿 Release。
7. 发布 GHCR 版本标签。
8. 仅当该 COS 渠道尚未建立时，在无消费者的前提下完成一次 bootstrap。
9. 公开 GitHub Release。
10. 晋级 COS updater YML 和 `versions.json`。
11. 最后上传 `catalog/<channel>/latest.json`，以该对象作为官网发布完成标志。

COS 不可变文件失败时不得公开 GitHub Release。GitHub 已公开但 COS 晋级失败时，workflow 必须失败；修复后重跑同一 Tag，必须从已公开 GitHub Release 下载原始 `release.json` 和 updater YML，只重新执行 COS 晋级。该分支不得重建或覆盖 COS 不可变目录，也不得重新绑定 GHCR 版本标签。

### 10.3 并发和版本顺序

当前 Release concurrency 以 Tag 分组，不同 Tag 仍可能并行。COS 渠道晋级必须增加全局互斥：

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
3. 备份当前渠道的 `latest*.yml`、`latest.json`、`versions.json` 内容和 VersionId。
4. 更新 updater YML。
5. 更新 `versions.json`。
6. 最后更新 `latest.json`。

`latest.json` 是官网的单一发布完成标志。任何渠道文件更新失败时，脚本使用备份内容恢复已覆盖的渠道文件，并返回非零退出码。Bucket 版本控制是第二层人工恢复手段。

首次建立某个渠道时没有旧对象，在不授予 `DeleteObject` 且 COS 无跨对象事务的前提下，无法对“原本不存在”做严格回滚。发布脚本在不可变对象、GitHub 草稿产物和 GHCR 镜像已就绪后检查渠道；若 `latest.json` 不存在，它会在公开 GitHub Release 前执行一次 bootstrap。该操作只允许用于官网和 Desktop 尚未消费 COS 的空渠道；若中途失败，GitHub Release 保持草稿，直接重跑同一 Tag 补齐对象，直到三个 updater YML、`versions.json` 和最后的 `latest.json` 全部通过公开域名验证。建立基线后，bootstrap 自动跳过，后续晋级仍必须遵守上述备份恢复规则。

禁止使用 `coscli sync --delete` 或官方 Action 的 `clean: true`。历史版本不能因本地工作目录不完整而被删除。

## 12. 上传与完整性校验

发布脚本至少执行以下校验：

- 上传前重新计算所有文件 SHA256，与统一发布清单比较。
- COSCLI 启用错误重试、断点续传和整体 CRC64 校验，不使用 `--disable-checksum=true` 的默认行为。
- 上传时写入 SHA256 自定义元数据，上传后通过 COS `stat` 确认对象存在、字节数和 SHA256 元数据正确；历史对象缺少元数据时才回退为完整下载校验。
- 对 JSON/YML 从公开域名重新下载并解析，确认 CDN/COS 返回的是刚发布内容。
- 抽查每个平台主安装包的 Range 请求、`Content-Length`、`Content-Type` 和缓存头。
- updater YML 中每个 URL 都必须通过公开域名的 HEAD、`Content-Length` 和 Range 检查；`sha512` 在上传前与本地产物核对。
- `release.json` 中的 SHA256、文件大小、版本、Commit 和 GHCR digest 必须与当前 Release 一致。

COS multipart ETag 不能作为文件 SHA256 使用。官网展示和用户校验统一以 `SHA256SUMS`、`release.json` 中的 SHA256 为准。

## 13. 凭据与 CAM 权限

使用专用 CAM 子账号，不使用主账号密钥。正式账号只允许操作目标 Bucket 的 `${COS_PREFIX}/` 前缀。

按照 COSCLI 上传与校验行为，一期需要：

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

实现前根据实际 APPID、Bucket、Region 和前缀生成精确 CAM Policy JSON，由配置人员在腾讯云控制台创建并验证。Policy JSON 不包含 Secret，可以作为运维文档保存；真实 Secret 不进入仓库。

COSCLI 若必须使用配置文件，应由脚本在 `$RUNNER_TEMP` 中以 `0600` 权限生成，Job 结束时通过 `if: always()` 清理。不得把该配置加入缓存或上传为 artifact。避免在命令日志中展开 Secret 参数。

## 14. 代码改动范围

预计修改：

- `.github/workflows/release.yml`
- `.github/workflows/release-preflight.yml`
- `client/apps/desktop/electron-builder.yml`
- `client/apps/desktop/scripts/package-release.mjs`
- `client/apps/desktop/scripts/release-artifacts.mjs`
- `client/apps/desktop/src/main/updater.ts`，仅在 generic provider 初始化确有需要时修改
- `scripts/build-release-manifest.mjs`
- `client/apps/desktop/test/release-workflow.test.mjs`

预计新增：

- `scripts/cos-release-layout.mjs`：纯函数，负责对象 Key、公开 URL、catalog 和 updater 元数据生成。
- `scripts/cos-release-layout.test.mjs`：目录、URL、SemVer、路径穿越和 schema 测试。
- `scripts/cos-publish.mjs`：COSCLI 安装校验、上传、远端验证、晋级与恢复编排。
- `scripts/cos-publish.test.mjs`：使用假 COSCLI/临时目录验证顺序、幂等和失败恢复，不访问真实 COS。

不在 Desktop、daemon 或 Gateway 业务层直接实现 COS 上传。发布行为继续由根脚本和 GitHub Actions 负责。

## 15. 实施步骤

1. 实现对象目录与 catalog 生成器。
   验证：单元测试覆盖正式版、预发布版、三种 Desktop feed、两种 Server 架构、非法路径和降级发布。
2. 实现 COSCLI 下载、SHA256 固定和上传编排。
   验证：假 COSCLI 测试证明不可变对象先于可变对象、`latest.json` 最后上传、失败时恢复旧渠道文件。
3. 改造正式 Release，先只上传 COS 版本目录，不切换客户端更新源。
   验证：测试版本上传到隔离前缀，公开域名下载、Range、缓存头、SHA256 全部通过。
4. 增加 Preflight 集中上传和 14 天生命周期。
   验证：目标 SHA/Run ID 目录正确，Preflight 不修改 stable/prerelease。
5. 将 Desktop 正式包切换为 COS generic provider，继续双发 GitHub。
   验证：解包检查 `app-update.yml` 指向 COS；从旧 GitHub 源版本升级到迁移版本，再从迁移版本升级到下一 COS 测试版本。
6. 接入官网 `latest.json` 和 `versions.json`。
   验证：默认下载选择最新稳定版，用户可以选择并下载指定历史版本，预发布版不会出现在稳定入口。
7. 开启正式渠道晋级。
   验证：完整执行本地发布门禁、远端 Release Preflight 和正式 Tag Release，并记录 COS/GitHub/GHCR 三方摘要。

## 16. 测试要求

### 16.1 单元和契约测试

- JSON schema 和字段稳定性。
- 文件名到平台、架构、格式的唯一映射。
- 版本目录不可变和同版本幂等重跑。
- SemVer stable/prerelease 分流和禁止降级。
- YAML 结构化解析、URL 改写及 SHA512 保留。
- URL 编码、路径穿越、重复文件名和未知产物拒绝。
- COSCLI 下载摘要校验。
- 上传顺序和失败恢复。
- Workflow 只有集中发布 Job 引用 COS Secret。

### 16.2 集成测试

- 隔离 COS 前缀上传真实小文件并验证元数据。
- 上传大于分片阈值的测试文件，验证断点续传和 CRC64。
- 使用公开域名执行 HEAD、GET、Range 请求。
- 从 `latest*.yml` 解析实际包 URL，并完成 HEAD、Range 和文件大小校验。
- 官网目录能够列出最新和指定历史版本。
- Preflight 生命周期和访问策略符合预期。

### 16.3 发布验收

- 修改客户端可执行代码、打包或发布配置后，提交前运行并通过 `pnpm run desktop:preflight:local`。
- 正式发布在干净提交上运行 `pnpm run desktop:preflight:release`。
- 推送后审查普通 CI、Server CI、Source Security。
- 对同一 SHA 运行一次远端 Release Preflight。
- 运行 `pnpm run desktop:tag:check` 后创建不可移动的正式 Tag。
- 正式发布后从 COS 公网域名实际下载并安装 macOS x64、macOS arm64、Windows x64 包。
- 校验 Linux amd64/arm64 服务端包和 GHCR 多架构镜像 digest。
- 从上一正式版本执行一次真实自动更新。

## 17. 完成标准

满足以下条件才视为 COS 分发一期完成：

- GitHub Actions 中只有集中上传 Job 可以访问 COS Secret。
- 正式版本按本文目录上传完整产物，Preflight 只上传包含完整产物摘要的清单，且生命周期策略生效。
- 官网默认下载指向稳定版 `latest.json`，历史版本可按版本选择。
- Desktop 使用官网/COS generic feed，并完成跨版本真实升级。
- stable、prerelease 不会互相覆盖，旧版本不能反向覆盖新版本。
- 任一二进制上传失败时，客户端和官网仍看到上一完整版本。
- COS、GitHub Release 和 GHCR 的版本、Commit、文件摘要和镜像 digest 可相互核对。
- 仓库、日志、缓存、artifact 和发布包中不存在 COS Secret 或临时配置文件。

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
