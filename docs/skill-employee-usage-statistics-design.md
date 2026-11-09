# Agent 动态 Skill 使用统计方案设计

> 状态：可开发实施
>
> 日期：2026-10-30
>
> 范围：Gateway Agent 动态、Skill 使用证据统计、员工账号汇总、个人 Agent 详情。本文不改动 Skill 采集规则和数据采集链路。

## 1. 目标和最终效果

在现有 Agent 动态基础上补齐员工账号维度的 Skill 使用统计，并把已有的个人 Agent Skill 统计展示出来。

页面最终分为三层：

1. **Skill 使用概览**：当前授权范围内的整体 Skill 使用情况，沿用现有页面。
2. **员工账号统计**：按员工账号聚合其多个设备、多个 Agent 的 Skill 使用情况。
3. **个人 Agent 统计**：查看单个 `collector_id + agent_id` 的 Skill 使用明细和时间范围趋势。

首期只做统计和展示，不做员工排名、绩效评分、Skill 效果评价或使用概率推断。

## 2. 当前代码基线

当前代码已经具备以下能力：

- `ActivitySnapshot`、`Organization` 和 `AgentUsage` 已有 Skill 使用字段，包括明确请求、观测使用、显式观测和隐式观测。[types.go](../server/internal/activity/types.go)
- `/api/v1/app/activity/statistics?range=...` 已返回整体 Skill 汇总和最多 100 条 Skill 明细。[activity_http.go](../server/internal/server/activity_http.go)、[activity_statistics.go](../server/internal/office/store/activity_statistics.go)
- Agent 动态页面已经展示 Skill 汇总卡片和 Skill 使用证据表。[app-activity.tsx](../server/web/src/pages/app-activity.tsx)
- `/api/v1/app/activity/agent-usage?collector_id=...&agent_id=...&range=...` 已返回单个 Agent 的 Skill 使用统计。[activity_http.go](../server/internal/server/activity_http.go)、[agent_usage.go](../server/internal/office/store/agent_usage.go)
- 当前 Agent 详情页面使用 `/activity/detail`，尚未请求和展示 `/activity/agent-usage` 的 Skill 数据。[activity-detail-view.tsx](../server/web/src/components/activity-detail/activity-detail-view.tsx)

因此，本次不重新设计采集链路、不新增 Skill 证据表，也不改变现有概览字段的含义。

## 3. 统计口径

### 3.1 使用指标

沿用现有 `SkillUsage` 和 `SkillUsageTotals`：

| 指标 | 统计条件 | 说明 |
| --- | --- | --- |
| 明确请求 Skill-任务数 | `evidence = explicit_request` | 员工在任务输入中明确请求 Skill，不代表 Skill 一定被执行 |
| 观测使用 Skill-任务数 | `evidence IN (skill_file_read, skill_resource_run)` | 观测到读取说明文件或执行 Skill 脚本 |
| 显式观测使用 | 观测使用且 `invocation = explicit` | 同一 Run 中有明确请求 |
| 隐式观测使用 | 观测使用且 `invocation = implicit` | 未发现明确请求 |

一次统计单位为：

`collector_id + agent_id + run_id + skill_key`

同一 Run 中同一个 Skill 被读取或执行多次，只计一次。不同 Skill 分别计数。

### 3.2 员工账号归属

- 通过 `office_collector_tokens.user_id` 归属员工账号。
- 同一员工的多个设备、多个 Agent 合并统计。
- 员工名称来自 `accounts.name`；名称为空时显示 `user_id`。
- 只统计 `user_id IS NOT NULL` 的采集记录。
- 继续沿用当前账号绑定关系。账号转移后，历史记录可能按当前绑定关系归属，这是现有 Agent 动态的既有语义。
- `observed_skill_count` 按 `source + skill_key` 区分；同一员工不同设备上相同来源、相同 `skill_key` 的 Skill 会合并计数。

### 3.3 统计范围和缺失数据

- 时间范围继续使用 `today`、`7d`、`30d`，时间边界和时区沿用 `ActivityService.DateRange`。
- 没有采集到证据表示“当前范围内没有记录”，不表示员工实际没有使用。
- 上报关闭、离线队列丢失、Runtime 内部加载或未识别命令都可能造成漏计。
- 统计只覆盖已有 Skill 证据，不补造历史数据。

## 4. 后端实施方案

### 4.1 新增员工统计结构

在 `server/internal/activity/types.go` 增加：

```go
type EmployeeSkillUsage struct {
    EmployeeID          string     `json:"employee_id"`
    EmployeeName        string     `json:"employee_name"`
    ObservedSkillCount  int64      `json:"observed_skill_count"`
    RequestedSkillRuns  int64      `json:"requested_skill_runs"`
    ObservedSkillRuns   int64      `json:"observed_skill_runs"`
    ExplicitSkillRuns   int64      `json:"explicit_skill_runs"`
    ImplicitSkillRuns   int64      `json:"implicit_skill_runs"`
    LastObservedAt      *time.Time `json:"last_observed_at,omitempty"`
}
```

在以下结构中增加字段：

```go
EmployeeSkillUsage []EmployeeSkillUsage `json:"employee_skill_usage"`
```

增加位置：

- `ActivitySnapshot`
- `Organization`

`AgentUsage` 不需要增加员工字段，它继续表示单个 Agent 的统计。

### 4.2 员工聚合查询

在 `server/internal/office/store/activity_statistics.go` 增加独立查询函数，例如：

```go
func (s *PostgresStore) employeeSkillUsage(
    ctx context.Context,
    start time.Time,
    end time.Time,
) ([]activity.EmployeeSkillUsage, error)
```

查询基于 `office_agent_skill_evidence e`：

- 连接 `office_collector_tokens ct`，按 `ct.user_id` 聚合。
- 左连接 `accounts owner` 获取员工名称。
- `requested_skill_runs` 使用 `explicit_request` 的去重 Run × Skill。
- `observed_skill_runs` 使用读取或资源执行的去重 Run × Skill。
- `explicit_skill_runs`、`implicit_skill_runs` 在观测使用集合上继续按 `invocation` 区分。
- `observed_skill_count` 使用观测证据中的 `DISTINCT (source, skill_key)`。
- `last_observed_at` 使用观测证据的最大 `occurred_at`。
- 按 `observed_skill_runs DESC, employee_name, employee_id` 排序。

查询结果在 `PostgresStore.Statistics` 中写入 `ActivitySnapshot.EmployeeSkillUsage`。`activity.Service.Statistics` 只负责空数组归一化和传递，不重新计算指标。

首期返回统计范围内有 Skill 证据的员工；没有 Skill 证据的员工不在该列表中。无需为此新增迁移或物化表。

### 4.3 保持现有概览查询

现有 `skillUsage(ctx, start, end, "", "")` 保持不变：

- 组织总量仍然从完整数据计算。
- Skill 明细仍最多返回 100 条。
- 前端不得通过 100 条明细相加得到总量。

### 4.4 个人 Agent 接口的归属校验

现有 `/activity/agent-usage` 已能返回单个 Agent 的 Skill 统计，但请求参数包含任意 `collector_id` 和 `agent_id`。接入个人详情页前，应使它与 `/activity/detail` 使用同一归属边界：

- `app` 路由从当前登录账号取得 `user_id`。
- 查询 Agent 时同时要求 `office_collector_tokens.user_id = current_user_id`。
- 不信任前端传入员工 ID。
- 如果未来开放管理员查看其他员工，再增加明确的 admin 路由或权限分支，不复用个人路由绕过归属校验。

实现上可将 `userID` 传入 `ActivityService.AgentUsage` 和 `AgentUsageStore.AgentUsage`，并在首条 Agent 查询中完成校验。相关单元测试和接口测试同步更新。

## 5. API 契约

### 5.1 概览接口

保持接口不变：

```text
GET /api/v1/app/activity/statistics?range=today|7d|30d
```

在现有响应的 `organization` 下增加：

```json
{
  "employee_skill_usage": [
    {
      "employee_id": "user-1",
      "employee_name": "张三",
      "observed_skill_count": 3,
      "requested_skill_runs": 12,
      "observed_skill_runs": 9,
      "explicit_skill_runs": 6,
      "implicit_skill_runs": 3,
      "last_observed_at": "2026-10-30T08:30:00Z"
    }
  ]
}
```

这是向后兼容的新增字段；旧客户端忽略该字段即可。

### 5.2 个人 Agent 接口

保持接口路径和返回主体不变：

```text
GET /api/v1/app/activity/agent-usage?
    collector_id=<collector_id>&agent_id=<agent_id>&range=today|7d|30d
```

继续使用现有返回字段：

- `skill_usage`
- `skill_usage_totals`
- `points`
- `session_count`
- `turn_count`
- `completed_turns`
- `tool_call_count`

只补充当前账号归属校验，不新增第二套个人统计接口。

## 6. 前端实施方案

### 6.1 Agent 动态概览页

修改：

- `server/web/src/lib/activity-api.ts`
- `server/web/src/pages/app-activity.tsx`

新增 `ActivityEmployeeSkillUsage` 类型，并在 `ActivityStatistics.organization` 增加 `employee_skill_usage`。

在现有“Skill 使用证据”表之后增加“员工 Skill 使用”表，沿用当前页面的时间范围选择：

| 员工 | Skill 数 | 明确请求 | 观测使用 | 最近使用 |
| --- | ---: | ---: | ---: | --- |

页面只展示汇总，不新增员工详情弹窗。员工账号下的单个 Skill 明细首期通过个人 Agent 详情查看；如果后续确认必须跨多个 Agent 展示员工的 Skill 明细，再增加员工筛选接口。

### 6.2 Agent 个人详情页

修改：

- `server/web/src/lib/activity-api.ts`
- `server/web/src/components/activity-detail/activity-detail-view.tsx`
- 可新增 `server/web/src/hooks/useAgentUsage.ts`
- 可新增独立的 Skill 统计组件，避免把表格逻辑继续堆入详情页

实现要求：

1. 仅 `scope="app"` 时请求 `/activity/agent-usage`；管理员详情页本期不新增个人 Skill 统计请求。
2. 默认范围使用 `7d`，提供 `today / 7d / 30d` 切换。
3. 在现有详情指标卡片后增加 Skill 汇总卡片：明确请求、观测使用、显式、隐式。
4. 增加 Skill 明细表：Skill、来源、明确请求、观测使用、隐式使用。
5. 空数据、加载失败和无权限状态使用现有页面组件处理。
6. 保留现有 Session、Turn 和活动详情，不改变已有详情接口。

## 7. 权限和隐私

- 员工汇总沿用现有 `agent_activity` 数据视图读取权限。
- 个人 Agent 接口必须校验当前账号与采集器的绑定关系。
- 不新增员工排名、百分位、绩效标签等容易产生误解的展示。
- 不向前端返回本地路径、Skill 内容、原始命令、凭据或完整 `skill_key`；现有 Skill 明细表继续只展示 Skill 名称和来源。
- `employee_id` 只作为后端聚合键和必要的内部标识，不在页面展示内部账号标识。

## 8. 验收标准

### 后端

- 同一员工拥有多个 collector、多个 Agent 时，员工统计会合并所有记录。
- 不同员工的记录不会相互合并。
- 同一个 Run 重复读取同一个 Skill 只计一次。
- 同一个 Run 使用两个 Skill 时分别计数。
- 明确请求、观测使用、显式和隐式四类数字与现有组织概览口径一致。
- 跨日 Run 按证据 `occurred_at` 所在范围统计。
- 没有关联员工账号的采集记录不进入员工统计。
- 个人 Agent 查询无法读取其他账号的 Agent 数据。
- 没有 Skill 证据时返回空数组和零值，不返回 `null`。

### 前端

- Agent 动态在切换今天、近 7 天、近 30 天时同时刷新组织概览和员工统计。
- 员工表能正确显示空数据、加载中和错误状态。
- Agent 详情页能切换时间范围并显示个人 Skill 统计。
- 旧接口缺少 `employee_skill_usage` 时页面仍可正常展示其他内容。
- 现有 Skill 概览、Agent 列表、Session 和 Turn 展示不回归。

## 9. 实施顺序

1. 扩展 Go 类型和 Postgres 员工聚合查询，补充多账号、多 Agent、重复证据和时间范围测试。
2. 扩展 `/activity/statistics` 响应及 TypeScript 类型，确认旧字段和旧客户端兼容。
3. 在 Agent 动态概览页增加员工 Skill 使用表。
4. 给 `/activity/agent-usage` 增加当前账号归属校验，并补接口测试。
5. 将个人 Skill 统计接入 Agent 详情页，补页面测试。
6. 运行服务端相关 Go 测试和 `server/web` 相关前端测试后再合并。

本方案不要求数据库迁移、不要求重新采集历史数据，也不要求改变客户端 daemon 的 Skill 识别逻辑。
