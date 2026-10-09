# 客户桌面包更新

## 构建渠道与清单

仅明确提供绝对路径 `CLAWEE_DESKTOP_GATEWAY_CONFIG_PATH`、配置为非回环 HTTPS origin 且非官方构建时，包内写入 `deployment/customer-update.json`。未注入配置、官方包、回环 HTTP 开发包均不携带客户更新标记；旧本地开发配置不因此阻断工作台。运行时忽略缺失或损坏的标记，返回 `supported:false`，不读取用户登录服务器来切换更新渠道，也不访问官方更新源。

`dist` / `release` 在本次 ZIP（macOS）或 NSIS EXE（Windows）生成后计算实际 SHA512/Base64 和大小，只输出本次平台的包。明确提供 `CLAWEE_CUSTOMER_UPDATE_DOWNLOAD_BASE` 时输出 `release/customer-update-manifest.json`，地址为 `<客户HTTPS base>/<版本>/<平台>/<架构>/<产物文件名>`。说明可通过 `CLAWEE_CUSTOMER_UPDATE_NOTES` 注入。

不得把客户 base 指向官方 COS 目录。脚本不继承官方上传地址；若传入官方 `COS_PUBLIC_BASE_URL` / `COS_PREFIX`，会拒绝指向该目录的客户 base。没有客户 base 时只输出 `customer-update-manifest.template.json`，URL 保留中文占位符，控制台明确标记“不可发布”，不会输出伪装成可发布清单的正式文件。此模板必须补齐独立、版本化的客户 HTTPS 下载地址后才能导入后台。生成清单不代表签名、公证或真实升级验收通过。

## 运行时与退出顺序

依赖锁定为 `electron-updater 6.8.10`（v26 渠道），保持现有 builder 26，不采用文档中 v27 / updater v7 的新方法签名。

主进程以 `app.getVersion()` 为当前版本。启动及每五分钟检查固定 Gateway，使用当前 revision 的 generic feed，不传企业令牌。检查、下载和安装均单飞；feed 与已批准快照逐项核对版本、说明、URL、SHA512 和大小，并拒绝额外的分阶段更新或 web-installer metadata。下载和安装还重新读取完整发布快照，包括 revision、发布时间及所有平台包。

`autoDownload=false`、`autoInstallOnAppQuit=false`、`disableWebInstaller=true`。macOS 下载阶段只下载 ZIP、校验实际文件字节、解压到临时目录，并调用系统 `codesign --verify --deep --strict`，核对当前应用和新应用的真实 TeamIdentifier；临时目录随后删除。这不是自研安装器，也不以清单里的签名声明代替验签。Windows 要求包内真实配置了签名发布者，并调用 updater 默认 Authenticode 验证器；缺失发布者不能绕过验签。

锁定 v6 的 `MacUpdater.updateDownloaded()` 先设置本地代理 feed、发出 updater 自身的 `update-downloaded`；仅当 `autoInstallOnAppQuit=true` 时才调用 Squirrel 的 `checkForUpdates()`。因此本实现的下载完成**不等于**原生安装准备完成。下载阶段和应用下次启动均不主动启动原生 Squirrel 下载。不能仅凭关闭自动退出安装开关，就把已启动的原生 Squirrel 流程解释为“可安全撤回”。

用户明确点击安装后：

1. 重新核对发布快照与本地文件；失败或离线均不进入 `installing`。
2. 用本机 daemon token、无请求 body 调用 `POST /desktop-update/prepare`，确认 `200 {prepared:true}`；409 等错误阻止安装。
3. 严格停止 Bootstrap / Runtime / daemon，等待 Utility Process `exit` 和 Codex 清理。超时或失败不得调用安装器；普通退出仍保持原有超时收尾策略。
4. 停机后再次检查完整快照与文件。此前任何失败调用 cancel、恢复 Bootstrap，不授权退出安装。
5. macOS **此时才**启动原生 Squirrel 检查；最多等待 120 秒，等待其成功验签并发出原生 `update-downloaded`。超时撤下本次 ready/error 监听并清理计时器，控制器执行恢复；迟到回调不能再次授权退出或调用 `quitAndInstall`。只有即将调用 `quitAndInstall` 时才授权 `before-quit` 放行，不经过普通退出的异步清理路径。Windows 同样先停机再调用 updater 安装。

安装准备和原生等待期间拦截普通退出，防止半途绕过停机门禁。原生失败恢复可操作状态。用户已经授权并进入 Squirrel 安装流程后，不承诺任意崩溃自动回滚或撤回原生暂存。

## 验证边界

`customer-update.test.ts` 使用 native adapter fake 验证状态、并发、渠道隔离、快照变化、离线、损坏文件、准备409、停止超时和安装顺序。`customer-update-native.test.ts` 另执行**实际安装的锁定 v6 MacUpdater 实现**的下载完成路径，替换的只有操作系统原生 updater；同时检查该版本源码中的退出开关和签名边界。此验证不是 macOS Squirrel 真正安装。

`customer-update-contract.test.mjs` 校验实际文件哈希、模板隔离和生产依赖。打包阶段与 `verify-package` 都递归验证真实 updater 及其生产依赖位于 staged / 包内资源，并实际加载模块，拒绝借用开发目录的依赖。

完整 `desktop:preflight:local` 由主线程执行。macOS arm64、macOS x64、Windows x64 仍需要真实签名客户旧包到新包的下载、安装替换、重启、版本核对与本地配置/会话/数据保留证据。未取得这些证据前，不宣称升级闭环可发布。
