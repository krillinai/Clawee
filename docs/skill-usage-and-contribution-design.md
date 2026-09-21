# Skill 使用与建设行为统计方案设计

> 状态：业务口径已确认；本文是后续开发与验收依据，不表示所有目标能力均已上线。
>
> 日期：2026-09-20。范围：Clawee 客户端任务采集、Gateway Skill Hub、Agent 动态统计。本文不改变模型服务、原始任务或 Skill 包的存储边界。

## 1. 目标与已确认口径

目标是将员工的 Agent 任务活动、任务中的 Skill 使用证据、Skill 新增与版本更新放在同一个分析语义下。三个维度分别统计，不合成为“AI 使用次数”或员工绩效分数。Skill 建设操作写入可扩展的员工 AI 行为事实表，后续其他行为须单独确认口径后才能接入。

1. **任务活动**：沿用已有 Agent 任务采集和完成轮次等指标。
2. **Skill 使用**：接受无法准确获知全部实际使用的限制，以可观测证据作保守统计；明确请求与观测到使用分列，后者区分显式和隐式。
3. **Skill 建设**：成功新增 Skill、成功上传已有 Skill 的新版本，是明确的建设行为；不等同于任务中使用该 Skill。
4. **Skill 采用**：下载安装到客户端、更新本地安装版本可作为独立维度，但不计入建设或任务使用；首期不要求进入员工分析。

已采集到的证据保存在后台，首期客户端对同一 Run × Skill × 证据类型只上报首条，不承诺保留每次读取或执行。前端暂不提供事件级证据、置信度或逐条解释视图；现有汇总数字可以保留。不能因为前端不展示而省略已上报证据的类型、来源或关联 ID。

本期不做任务质量评价、员工排名、隐式使用概率推断、跨设备本地同名 Skill 自动合并、Skill 内部执行次数估算，也不把未观测到解释为未使用。

## 2. 现状和运行时边界

仓库已有以下基础，开发时在原边界内扩展：

| 能力 | 当前落点 | 后续工作 |
| --- | --- | --- |
| Run 与规范化工具事件 | `client/apps/daemon/src/runs/manager.ts` | 校准识别范围和任务生命周期 |
| Skill 请求/读取/脚本证据 | `client/apps/daemon/src/enterprise/skill-usage-tracker.ts` | 持续校准误报、漏报及企业版本归属 |
| 活动上报与事件校验 | `client/apps/daemon/src/enterprise/activity-reporter-2026-08-28.ts`、`server/internal/office/claweeactivity/` | 沿用已有开关、认证、重试、限额、校验 |
| Skill 证据事实表与组织汇总 | `server/db/migrations/00057_skill_usage_observations.sql`、`server/internal/office/store/activity_statistics.go` | 补组织总量；员工维度查询留待员工分析阶段 |
| Skill Hub 版本与上传人 | `server/internal/skillhub/service.go`、`postgres_store.go`、`server/db/migrations/00035_skill_spaces.sql` | 将成功操作写入通用行为事实表，不因版本删除而消失 |
| Agent 动态数据视图 | `server/internal/server/activity_http.go`、`server/web/src/pages/app-activity.tsx` | 接入建设指标，收起当前页面上的证据解释文案 |

[OpenAI Docs 的 App Server 接口说明](https://learn.chatgpt.com/docs/app-server#api-overview)列出 `skills/list`（Skill 清单）和 `skills/changed`（本地 Skill 文件变化通知），没有可依赖的“本次任务激活了某 Skill”通知。本文的使用统计因此基于当前 Clawee 可观察的任务信号；若将来 Runtime 提供正式激活事件，应新增一种证据来源及口径版本，不把历史记录改写成确定使用。

当前 Skill Hub 的 `skill_versions.uploaded_by_user_id`、`uploaded_by_agent_id` 与 HTTP 操作日志有助于查询和审计，但普通日志不是可重放的业务事实，版本被清理后也可能无法恢复建设历史。操作事实需在成功写入版本的事务内形成。

## 3. 任务中的 Skill 使用

### 3.1 证据与判定

| 证据码 | 产生条件 | 统计含义 |
| --- | --- | --- |
| `explicit_request` | 创建 Run 的任务输入出现可唯一解析到已安装 Skill 的 `$name` | 员工明确请求；**不是**已使用 |
| `skill_file_read` | 与该 Skill `SKILL.md` 对应的读取命令成功结束 | 观测到读取使用说明；不证明模型遵循了内容 |
| `skill_resource_run` | 该 Skill 的脚本资源通过受支持的命令成功执行 | 观测到资源执行；不证明任务结果质量 |

首期只解析创建 Run 时的任务输入：该 Run × Skill 有明确请求时，两种观测证据标记为 `explicit`，否则为 `implicit`；同一 Run × Skill 的观测分类不在运行中变化。后续输入改变分类不在本期范围。仅提及名称、`skills/list` 清单、目录列举、失败或退出状态不明的命令都不产生主要使用指标。无法唯一归属的同名 Skill 不猜测具体实例。使用证据在客户端本地提取，按已有活动链路上报，不新增整个工作区扫描上传或 Skill 正文上传。

现有识别只覆盖支持的 Shell 命令形态；例如 Runtime 内部加载、其他工具读取、间接脚本调用、未识别的相对路径可能漏计。命令成功也可能只表示文件访问而非采纳。验收时分别报告误报与可观察范围内的漏报，不承诺总体召回率。后续新增识别器必须带证据码或采集规则版本，避免新旧时间段无标注混算。

### 3.2 事实数据与任务关联

已有 `office_agent_skill_evidence` 以 `(collector_id, source_event_id)` 幂等，保存 `agent_id`、`run_id`、`skill_id`、`skill_key`、`version_id`、`source`、`evidence`、`invocation`、`occurred_at`。企业 Skill 使用 Hub 的稳定 `skill_id`；本地 Skill 使用设备内稳定的不透明 `skill_key`。本地同名 Skill 不能据名称合并为企业级同一个对象，也不在页面公开本地路径或 key。

服务端只接受已有认证主体绑定的 Agent/采集源；员工归属从 Gateway 账号与采集身份取得，不信任客户端提供的员工 ID。对于企业安装记录与磁盘内容不一致的情况，开发时应核对本地安装摘要，无法确认时不宣称属于该企业版本。该校准不改变“成功读取是观测证据、非确定执行”的主口径。

当前活动上报本身还承担任务事件传输；本设计约束的是**新增 Skill 证据载荷**：只含受限的 Skill 元数据与枚举，不追加原始命令、文件绝对路径、Skill 内容、模型凭据或包文件。服务端继续执行字段白名单、长度和枚举校验，所有查询使用参数化 SQL。

### 3.3 去重与时间

- 证据入库按来源事件 ID 幂等；报表按 `(collector_id, agent_id, run_id, skill_key)` 去重，不能将一次 Run 中的多次读取相加。
- `requested_skill_runs` 只计明确请求；`observed_skill_runs` 只计读取或执行；`explicit_skill_runs` 与 `implicit_skill_runs` 按 `invocation` 分别去重。同一 Run × Skill 的观测只属于显式或隐式之一，因此在相同统计范围内两者之和等于观测总数；明确请求数仍不能与观测数相加。
- 若需要“用过任意 Skill 的任务数”，另外按 Run 去重；按 Skill 计数的总和不能冒充任务数。
- 按证据 `occurred_at` 落入现有 `today/7d/30d`、Gateway 时区范围。跨日 Run 的请求和观测可能位于不同日期，应在查询和测试中保留这一语义。
- 上报关闭、离线队列溢出或 Runtime 不提供可识别信号时，缺失不等于零使用。零只表示范围内未记录到相应证据，不表示实际未使用；不输出没有可靠分母的“Skill 使用率”。首期不建立采集覆盖状态，也不宣称可以识别所有缺失原因。

## 4. Skill 新增与更新：成功操作事实

### 4.1 分类与归属

同一版本写入事务中，以 Gateway 的实际存储结果判定：**本次创建了 Skill 主记录且保存首个版本**为 `skill.created`；**为既有 Skill 成功保存新版本**为 `skill.version_uploaded`。不能依赖前端按钮文案、提交时是否带 `skill_id` 或版本号字符串判定；按名称合并、指定目标替换都要以事务结果为准。

直接上传的 `actor_user_id` 必须来自 Gateway 已认证账号；app 上传还需遵循现有 Skill 空间写权限和绑定 Agent 校验。管理员代上传计在实际操作管理员名下，不能因为 Skill 名称、历史创建者或上传备注而算给另一名员工。`uploaded_by_agent_id` 不证明该版本由 Agent 生成。`origin` 由 Gateway 的 app/admin 上传入口或服务端 Git 同步路径指定，不由上传表单提供。自动 Git 来源同步记录为 `source_sync`，默认不计入某员工建设数量；触发同步的管理员是操作发起者，不自动成为每个生成版本的作者。

审批、发布、撤回发布、下载、失败上传及未产生新版本的无变化同步继续走治理审计，不计为 `skill.created` 或 `skill.version_uploaded`。同一员工上传并发布，建设指标也只算一次版本上传。删除未发布 Skill 不应抹掉已发生的成功建设事实；报表可以另行标示版本当前是否仍可用，但不追改历史事件。

### 4.2 通用行为事实表

在 `server/db` 增加顺序迁移，建立仅追加的 `employee_ai_activity_facts` 表。它只保存已成功发生、可定义统计口径的业务操作，不替代现有的任务事件、`office_agent_skill_evidence`、Skill 版本表或治理审计。首批只写 `skill.created` 和 `skill.version_uploaded`；新增其他 `event_type` 时再定义触发条件、员工归属、去重键、所需字段、统计指标与验收用例，不能把任意审计动作自动算作 AI 使用。

```text
fact_id            服务端生成的主键
event_type         受控事件码；首批 skill.created | skill.version_uploaded
actor_kind         user | system；区分员工动作和自动动作
actor_user_id      user 时取认证账号，system 时为空
origin             受控来源码；首批 app_upload | admin_upload | source_sync
target_id          资源 ID；首批为 skill_id，不依赖会级联删除的外键
target_name        创建事实时的 Skill 名称快照；用于版本删除后的识别
source_system      可信写入系统；首批为 skillhub
source_event_key   该系统内稳定的业务事件键；首批为版本 ID
occurred_at        Gateway 写入时间（UTC；仅事务成功提交后可见）
```

首批字段均来自认证主体和实际写入结果；`target_name` 限制长度，不保存 ZIP、Skill 正文、Git 路径或密钥。直接上传为 `actor_kind=user`，自动同步为 `actor_kind=system`；数据库约束 `user` 必须有 `actor_user_id`、`system` 不得有，并约束首批事件码与来源码，不能用空用户 ID 代替未知归属。`source_event_key=version_id`，使同一版本恰好产生 `skill.created` 或 `skill.version_uploaded` 中的一条，而非两条。对 `(source_system, source_event_key)` 建唯一约束，并按 `(event_type, occurred_at)`、`(actor_user_id, occurred_at)` 建查询索引；后续事件类型可定义各自的稳定事件键，不假设所有行为都有版本 ID。首期不增加任意属性载荷或尚无查询用途的 Agent、包摘要快照字段。

由 `server/internal/server/skillhub_http.go` 的 app/admin 入口及服务端 Git 同步路径指定受控 `origin`，经服务层传给 `server/internal/skillhub/postgres_store.go` 的 `CreateVersion`。事实表在保存版本的同一数据库事务内写入：以本次是否实际插入 Skill 主记录判定 `skill.created`，选中既有 Skill 时写 `skill.version_uploaded`；不能用 `current_version_id` 是否为空判定，因为未发布的既有 Skill 也可能为空。版本失败则没有事实，事实失败则整个版本写入回滚。不在 HTTP 成功响应之后异步补记，也不从普通日志反推。既有 `skill_versions` 继续承担版本详情，操作日志承担安全审计；事实表保留版本删除后的历史，因此不对 `skills`、`skill_versions` 建删除级联外键。将来接入别的领域时仍由该领域的可信服务在其成功事务内写事实，而非提供任意客户端直写入口。

首期不增加请求级上传幂等键、记录表或客户端自动重试。现有 `(skill_id, version)` 唯一约束可阻止同一 Skill 的同版本重复写入，但上传成功后响应丢失，重试可能返回冲突而不是原成功响应；版本被删除后也不承诺请求级幂等。这不影响“每个成功写入的版本恰好一条建设事实”。只有需要重放原上传响应时，再单独设计请求级幂等。Git 同步沿用已有来源、路径、提交的唯一约束，无变化同步不新增事实。

首期只统计事实写入上线后的成功操作，不用不完整的历史 HTTP 日志补造员工事实；历史 `skill_versions` 可供查询，但不进入严格建设指标。首期不提供缺少可靠启用时间来源的 `operation_data_since`；上线说明须标注建设统计不覆盖历史。

## 5. 指标与读取边界

在既有 Agent 动态服务中增加独立建设指标，不创建通用“AI 分数”：

| 指标 | 计算规则 | 注意 |
| --- | --- | --- |
| 新增 Skill 数 | 范围内 `event_type=skill.created` 且 `origin IN (app_upload, admin_upload)`，按 `source_event_key` 去重 | 按认证操作员工归属 |
| Skill 更新数 | 范围内 `event_type=skill.version_uploaded` 且 `origin IN (app_upload, admin_upload)`，按 `source_event_key` 去重 | 不是安装或发布次数；自动同步不计员工建设 |
| 明确请求的 Skill-任务数 | `explicit_request` 的不同 Run × Skill | 不等于观测使用 |
| 观测使用的 Skill-任务数 | `skill_file_read` 或 `skill_resource_run` 的不同 Run × Skill | 不能用 Skill 明细列表求和 |
| 其中显式 Skill-任务数 | 上一指标中 `invocation=explicit` 的不同 Run × Skill | 是观测使用的子集 |
| 其中隐式 Skill-任务数 | 上一指标中 `invocation=implicit` 的不同 Run × Skill | 与显式子集互斥，两者之和等于观测使用数 |

组织汇总与未来员工汇总共用相同聚合条件、时区和身份边界，避免两套查询给出不同数字。员工查询以认证上传者统计建设行为，以采集源所关联的员工统计任务使用；与现有 Agent 任务统计采用同一账号归属规则。当前任务报表按采集源的**当前** `user_id` 关联，账号转移可能使历史任务归属变化；员工分析上线前必须对转移/合并用例做一致性测试。若业务要求事件发生时归属不可变，需要连同原有任务指标统一引入归属快照，不能只给 Skill 事实单独改口径。

通用事实表只承载操作类行为；任务和 Skill 观测仍从现有专用表读取，分析层按已定义的指标并列呈现，不把不同来源的记录数直接相加。后续新增事实类型不自动进入“员工 AI 使用总数”，需要明确其是否属于使用、建设或管理动作。

沿用 `agent_activity` 数据视图读取授权；没有权限不返回 Skill 汇总。首期在已有 `/api/v1/app/activity/statistics` 的 `organization` 中增加两个独立汇总字段，示例仅展示新增字段：

```json
{
  "skill_contributions": { "created_count": 0, "updated_count": 0 },
  "skill_usage_totals": {
    "requested_skill_runs": 0,
    "observed_skill_runs": 0,
    "explicit_skill_runs": 0,
    "implicit_skill_runs": 0
  }
}
```

这两个总量均按查询范围全量聚合，不能对现有最多 100 条的 `skill_usage` 明细列表求和。现有列表和任务、Token 指标定义不变；员工维度查询及其接口留待员工分析页开发时再做。页面只需新增汇总数字，暂不新增逐事件证据、置信度及解释面板；现有 `app-activity.tsx` 中“未观测到不代表未使用”的可解释性文案应按本次产品决定从页面移出，但保留在内部指标定义中。页面零值仅表示未记录到证据，不能解释为实际未使用。

## 6. 部署、数据治理与验收

1. **迁移和兼容**：先部署 Gateway 行为事实表，再部署产生事实的版本上传路径；现有客户端上传接口不变。统计响应只增加可选读的新字段。迁移只在隔离测试库验证后进入部署，不手工修改运行库。
2. **隐私和权限**：Gateway 校验身份、空间写权限、包大小及 ZIP 内容，只允许受控事实事件码和来源码；服务日志不记录包正文、请求凭据或本地路径。行为事实保留、账号删除和审计访问遵循部署者现有数据治理策略。
3. **事务测试**：新 Skill、同名已有 Skill、新版本、替换、冲突回滚、事实写入失败、删除未发布版本分别验证事件分类和每个成功版本恰好一条事实；app 上传、管理员代传、自动同步分别验证可信 `origin` 和操作主体。未发布的既有 Skill 不误判为新增，无变化同步不新增事实；拒绝未登记事件码和来源码。
4. **证据测试**：创建 Run 时明确请求但未读取、隐式成功读取、脚本成功执行、失败命令、重名 Skill、多个 Skill 和重复读取分别验证计数；上报关闭或离线导致的缺失不解释为实际未使用。
5. **汇总与授权测试**：组织总量不受 100 条明细上限影响，显式加隐式等于观测总数；同一 Run 对多个 Skill 的任务数与 Skill-任务数不混用，跨日按证据时间归属。验证新字段的向后兼容及 `agent_activity` 授权。员工对账和账号转移/合并测试留待员工维度查询开发时进行。

推荐实施顺序：先完成版本上传事务事实和隔离数据库测试，再扩展组织聚合与授权测试，最后接入现有汇总页面。上线说明须说明建设事实不补历史、Skill 零值只是未记录到证据，以及当前 Codex 隐式加载不可观测。
