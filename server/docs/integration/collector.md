# Collector 接入

## 作用

Collector 在 Agent 所在设备上运行，采集允许上报的活动元数据，并向 Gateway 发送注册、心跳、事件和任务结果。Collector 不替代 Agent Runtime，也不应采集对话正文、密码、Token 或本地文件内容。

## 组件

- `clawee-collector`：采集、上报、诊断和安装管理命令。
- `clawee-collector-runner`：Windows 下隐藏控制台窗口的启动入口。
- Gateway Collector API：注册、心跳、事件、任务拉取与结果提交。

## 服务端入口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/v1/collector/register` | 使用注册码建立 Collector 身份 |
| `POST` | `/api/v1/collector/heartbeat` | 上报存活状态和版本 |
| `POST` | `/api/v1/collector/events` | 批量提交活动事件 |
| `POST` | `/api/v1/collector/tasks/pull` | 拉取服务端任务 |
| `POST` | `/api/v1/collector/tasks/result` | 提交任务结果 |

安装页面和二进制下载路径由 Gateway 提供：

- `/install`
- `/install.sh`
- `/install.ps1`
- `/downloads/clawee-collector/<os>/<arch>`

## 安装原则

1. 从受信 Gateway 获取安装脚本和二进制。
2. 校验目标操作系统、架构和下载结果。
3. 使用一次性或可吊销注册码完成注册。
4. 将 Collector 配置写入当前用户可访问、其他用户不可读的位置。
5. 安装当前用户级启动项，并验证心跳。

macOS 和 Linux 使用当前用户级常驻机制；Windows 使用当前用户登录触发的计划任务。只有清理遗留的机器级服务时才可能需要管理员权限。

## 身份与生命周期

- Collector 必须绑定到明确的账户和 Agent。
- 重装时复用稳定身份，不能无条件创建重复 Agent。
- Token 吊销、Agent 停用或归属变化后，旧 Collector 应无法继续上报。
- 卸载默认保留诊断所需的非敏感配置；彻底清理应由用户显式选择。

## 数据最小化

Collector 上报前执行字段白名单和敏感信息清理。日志、诊断包和事件中不得包含：

- 认证 Header、Cookie、API Key 和 OAuth Token；
- 提示词、模型完整输入输出和文件正文；
- 不属于活动统计所需的本机路径和环境变量值。

服务端应再次校验事件大小、类型、Agent 归属和时间范围，不能只依赖客户端过滤。

## 验收

- 注册后能持续发送心跳。
- 重启设备后 Collector 自动恢复。
- 重复安装不会产生重复身份。
- Token 吊销后上报返回未授权。
- 日志和诊断文件通过敏感字段检查。
