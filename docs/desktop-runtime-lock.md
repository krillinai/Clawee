# 桌面端 Runtime 数据目录锁与退出验证

## 排查结论与边界

原实现把 `clawee-runtime.lock` 的内容解释为 PID，并只用 `process.kill(pid, 0)` 判断占用。PID 复用可能导致误报，权限错误也不能解释为进程不存在。仅凭示例中的 PID 23364 无法确认是残留 daemon。

关闭窗口默认隐藏到托盘，daemon 继续运行是预期行为；本修复没有改变该行为。托盘“退出”、菜单退出及桌面退出 API 才会进入真正退出流程。

退出原本已有约 5 秒总预算和终止尝试。新增回归分别证明并修复了：排队启动可能在退出后 fork、并发重启可能在退出后再次启动，以及清理超时仍被记录为完成而未确认进程退出。

## 锁身份与安全恢复

- 保留原 PID 文件，避免旧版本把 JSON 当作无效 PID 并删除新锁。
- 增加 `clawee-runtime.lock.json`：版本、PID、随机实例 ID、规范化后的真实目录和租约端口。这里不保存 API Token 或模型凭据。
- 使用 Node 内置 `net` 在 IPv4 回环地址建立独占实例租约，端口由真实目录的 SHA-256 派生。成功取得租约后才检查或恢复磁盘锁；竞争实例无法同时执行恢复。目录别名经过 `realpath` 归一化，Windows 下另做大小写归一化。
- 对活跃租约读取实例身份，与磁盘记录交叉核对；匹配时报告真实占用。取得同目录租约后，对匹配的新格式遗留记录可安全恢复，不依赖旧 PID 是否被复用。
- 旧 PID-only 锁：确认进程不存在，或查询命令行确认不是 daemon，才恢复。Windows 使用带超时且不显示窗口的 PowerShell/CIM 查询；其他平台使用 `ps`。能识别的旧 daemon 仍拒绝第二实例；命令行不可读、权限不足、无法区分的 Electron Utility Process 或损坏锁均保守拒绝，不删锁、不杀进程。
- 释放时同时核对实例 ID 和 PID，并等待租约关闭，允许正常退出后立即重开。服务关闭失败时不提前释放写入保护；进程实际退出时操作系统释放租约。

这是无需第三方依赖、无需原生插件及 Electron ABI 重编译的内置租约方案；没有引入原生文件锁库。文件锁只校验 PID/进程创建时间仍不足以消除“并发回收旧锁时删掉另一实例的新锁”的竞态，因此恢复阶段也需要独占保护。

限制：哈希端口可能与其他目录或本地服务冲突；Windows 的保留端口、安全软件或本机网络策略也可能阻止绑定。此时返回身份无法确认的错误，不把其他服务误认成 daemon，也不会绕过独占保护。损坏锁或无法确认的旧版 Utility Process 不能自动接管。混用旧版本不享有新租约协议，不能将本修复视为对所有历史版本行为的保证。

## 退出与诊断

桌面端每秒经已有父子 IPC 发送心跳。daemon 从启动早期安装退出监听；心跳超过 10 秒未到达时进入清理，最多再等待 5 秒，然后自退出。正常父进程退出请求也有 daemon 自身的 5 秒截止时间，避免启动或关闭阻塞时无限等待。心跳丢失也可能意味着父进程长时间无响应，不能据此声称已证实父进程死亡。

Windows 的重试终止只使用已持有的 `UtilityProcess`，不从锁文件取 PID 调用 `taskkill`。桌面停止必须观察到子进程 `exit` 才确认结束；未确认则抛出 `DAEMON_STOP_TIMEOUT`、保留占用状态并阻止替换实例。桌面自身预算耗尽时仍可能先退出，daemon 的心跳机制是有界兜底，而非“桌面退出瞬间进程必然已结束”的保证。

daemon 还把退出触发原因、关闭失败分类及退出请求写入数据目录下的 `daemon-lifecycle.log`，不依赖已经死亡的桌面主进程转存日志。`DAEMON_EXIT_REQUESTED` 仅表示请求自退出，不替代系统进程状态检查。该日志不保存凭据或任务内容。

| 分类/日志 | 含义与检查点 |
| --- | --- |
| `DAEMON_DATA_DIR_IN_USE` | 实例租约身份匹配，或识别到旧 daemon；检查 `ownerPid`、`dataDir`、`lockPath`、`reason` |
| `DAEMON_DATA_DIR_LOCK_UNVERIFIED` | 无法安全判断占用；检查 `leasePort`、`systemCode`、权限及旧锁身份，不自动删锁 |
| `DAEMON_DATA_DIR_LOCK_IO_FAILED` | 锁文件读写失败，不混同为第二实例占用 |
| `Daemon Utility Process exited` | 真正收到子进程退出事件，含退出码和是否主动停止 |
| `Daemon shutdown cleanup finished` | 仅表示清理流程结束，必须结合 `processExited` 和 `pid` |
| `Desktop shutdown cleanup finished` | 桌面清理流程结束，必须结合 `daemonExited` 和 `daemonPid` |
| `Daemon terminate requested` / `Daemon forced terminate requested` | 终止请求是否被接受，不代表进程已退出 |
| `DAEMON_SHUTDOWN_STARTED` / `DAEMON_SHUTDOWN_TIMEOUT` | daemon 的退出触发原因和自身截止时间失败 |

## 自动化覆盖

定向运行：

```sh
corepack pnpm --dir client/apps/daemon exec vitest run test/unit/runtime-lock.test.ts test/unit/runtime-lock-legacy.test.ts test/unit/shutdown.test.ts
corepack pnpm --dir client/apps/desktop exec vitest run test/daemon-manager.test.ts test/bootstrap-controller.test.ts
corepack pnpm desktop:preflight:local
```

- 锁测试：真实子进程第二实例拒绝、正常释放后立即重开、强制结束锁持有进程后的恢复、跨进程并发抢锁、PID 指向无关进程、PID 复用的新格式遗留锁、旧 daemon 拒绝、未知身份/EPERM/损坏锁拒绝、租约端口被无关服务占用时不删锁。
- 退出单测：排队启动中退出、fork 后退出、退出后迟到的就绪输出、并发重启与退出、退出超时不宣称成功、Windows 终止重试不向未知 PID 发信号、心跳断开后清理阻塞仍有界退出、持续心跳不误触发退出。
- 打包 App E2E：已有空闲/任务执行中退出及立即重开；新增仅强制结束桌面主进程、等待 daemon 自退出、再以原数据目录重开。不是用整个进程树终止来掩盖孤儿进程。

## Windows 实机验收（必须另行执行）

在隔离的测试用户数据目录和实际 Windows 安装包上执行，不操作真实用户数据库、配置或工作区。macOS 打包验证及模拟 Windows 分支的单测不能替代此项。

1. 关闭窗口后确认托盘和 daemon 仍存在；从托盘真正退出后立即重开，确认未发生错误锁冲突。
2. 空闲、任务执行中分别正常退出，核对主进程、daemon 与受管理 Runtime 子进程以及日志中的退出确认。
3. 任务管理器只强制结束桌面主进程，不使用“结束进程树”；观察 daemon 在心跳超时加清理预算内退出，再用同一目录启动。
4. 制造关闭阻塞或不接受终止请求，核对超时分类、`processExited=false`、终止请求结果及最终自退出。失败时不得声称清理成功。
5. 在启动/探测尚未完成时退出；确认没有迟到的 daemon、后台重启或重新打开数据目录。
6. 分别准备死 PID 锁、指向无关进程的旧锁、失效实例记录、身份不可查的旧锁及真实第二实例；无关进程必须保持运行，真实占用必须拒绝，未知身份必须保守报告。
7. 验证 PowerShell/CIM 可用及受限场景、回环端口被占用/保留/安全软件拦截、路径大小写和目录别名。绑定失败应给出可诊断错误，不得允许两个 daemon 写同一目录。

此次实际执行结果及未执行项目以任务交付说明为准；本清单本身不是通过验收的证明。
