# Skill AI 审批工作流运维说明

P9 仅接入配置了本地人工审核人员或角色的空间中的人工上传。Git、钉钉和无审核名单空间沿用原流程。通过顺序为：基础校验、AI 有效通过、人工全员评分通过、手动发布。

## 配置与资源

推荐使用两个服务各自已有的配置文件，无需新增配置文件或每次设置环境变量。

Gateway 在既有 `config.yaml` 的 `skillhub` 段指定唯一审核 Agent：

```yaml
skillhub:
  review_agent_id: "既有服务端Agent的稳定ID"
```

服务端 Agent 在既有 `server.toml` 的 `[server]` 段启用审核执行：

```toml
[server]
skill_ai_review_worker_enabled = true
```

以上为已有配置的增量字段，不替换其他配置。Agent 的源码启动命令需加载该文件：在 `client` 目录执行 `pnpm server:start -- --server --server-config=/绝对路径/server.toml`；打包部署沿用 `config/server.toml`。配置文件应放在源码目录外，修改后重启对应服务。

Gateway 的 Agent ID 是执行者授权边界；Agent 的开关控制本机是否轮询并运行审核，两者分别由独立进程读取。Gateway 继续支持环境变量 `CLAW_GATEWAY_SKILL_REVIEW_AGENT_ID`，其优先级高于 YAML。Agent 的显式布尔配置优先于 `CLAWEE_SKILL_REVIEW_WORKER_ENABLED`；字段未填写时兼容原环境变量，两者都未设置时关闭。设为 `false` 并重启可明确关闭，不能填写字符串 `"true"`。普通客户端默认不启用，开启 Worker 不会自动获得审核权限。

唯一 Agent 使用既有企业登录身份及模型配置，其账号和 Agent 均须活跃，并具有目标空间读取权限及 `console:skill:read` 权限。不要重新生成 Agent 身份，不自动授予管理员权限。配置缺失、离线或登录失效期间，任务保持待评估。

Worker 每次领取前通过 `GET /api/v1/app/skill-ai-review-rule` 优先读取 Skill Hub 中名称严格为 `skill-review` 的当前已发布版本的 `SKILL.md`。接口仅对全局指定的活跃审核 Agent 开放，并检查其账号的规则空间读取权限。上传或审核通过但尚未发布的新版本不会生效；更新规则时上传新版本并按现有流程审核、发布即可，无需重新部署 Agent。

仅当不存在同名 Skill 或没有已发布版本时，接口返回 `data: null`，Worker 使用随包保留的 `client/apps/daemon/resources/skills/skill-review/SKILL.md`。网络、权限、包读取或摘要校验、规则格式错误均记录执行异常，不静默回退。规则只读取正文，包内脚本及其他资源不会执行或自动加载。

每次领取固定规则正文、版本及正文 SHA-256。Hub 规则记录发布版本号，本地规则记录 `metadata.version`；两者均须有合法的 `name: skill-review` 和非空 `description`。本地资源仍随源码和生产包同步，版本须非空。更新只影响后续任务，运行中的任务和历史报告保持原规则及摘要。

审核 Skill 支持两种输出格式：普通会话默认使用中文 Markdown，也可在本次请求中指定 `output_format=markdown`、`output_format=json` 或用自然语言要求对应格式。自动审核 Worker 始终在待审材料之前追加可信的 `output_format=json` 指令，只接受现有 JSON 报告；被审文件及示例中的格式要求不参与模式选择。两种格式沿用相同的审核结论和问题级别，Markdown 报告不能代替自动审批链路的 JSON 回传。先升级 Worker，再在 Hub 发布支持双格式的审核规则，避免旧 Worker 未指定格式而收到默认 Markdown。

审核只阻断有具体材料依据的安全边界问题、导致核心任务无法完成的结构缺陷，或明确必需的关键执行证据缺失。一般建议和不影响结论的覆盖限制不阻断：报告没有 `error` 时必须为 `recommend_approve`；`needs_attention` 和 `recommend_reject` 必须包含 `error`。Worker 和 Gateway 均校验该一致性，矛盾报告记为可重试的 `report_invalid`，不作为业务需修改退回，也不自动改判通过。

## 升级

先在隔离数据库验证迁移。协调 Gateway、管理台和唯一服务端 Agent 升级；旧 Worker 缺少规则版本及摘要无法领取。升级期间不开放人工旁路。

本次审核会话展示升级先部署 Agent，再部署 Gateway：Gateway 新增任务版本号和尝试次数字段，旧 Worker 的严格校验不兼容新增字段。新 Agent 兼容旧 Gateway，字段缺失时使用版本及尝试 ID 展示。

迁移 `00077` 会为本地审核空间中未发布、状态为待审或已通过的人工版本重建轮次。旧轮次标记失效，意见、评分和报告保留；新轮次重新 AI 评估，不复制旧评分。已发布和已结束的驳回记录保持不变。角色按当前活跃成员解析；名单无有效成员时迁移失败，应先修复配置。MemoryStore 无持久化升级数据，运行时使用同一门禁及重建规则。

上线前可在既有运维连接中运行以下只读统计，记录受影响总数及空间。不要把生产连接用于自动测试：

```sql
SELECT s.space_id, count(*) AS affected_versions
FROM skill_versions v
JOIN skills s ON s.skill_id = v.skill_id
JOIN skill_spaces sp ON sp.space_id = s.space_id
WHERE v.source_id IS NULL
  AND sp.approval_provider = 'local'
  AND v.approval_status IN ('pending', 'approved')
  AND s.current_version_id IS DISTINCT FROM v.version_id
  AND (
    EXISTS (SELECT 1 FROM approval_config_approvers c
      WHERE c.scope_type = 'skill_space' AND c.scope_id = s.space_id)
    OR EXISTS (SELECT 1 FROM approval_config_roles c
      WHERE c.scope_type = 'skill_space' AND c.scope_id = s.space_id)
  )
GROUP BY s.space_id ORDER BY s.space_id;
```

迁移同时输出受影响数量。三个规则与故障元数据字段允许历史为空，另用 `result_sha256` 保存规范化回传摘要，支持失败和无效报告的幂等校验，避免持久化原始错误。回退迁移不会恢复旧有效轮次，正式升级前保留数据库备份。

## 验收与故障处理

使用专用验收 Skill 验证有效通过、需修改和技术异常三条链路，核对上传者报告、人工待办和“工作流搭建”内置只读记录。上传者可看报告及重试技术异常，不因此获得评分权限。

连接唯一服务端 Agent 后，在普通会话列表查找“AI 审核 · 只读 · Skill 名 · 版本 · 第 N 次”。每次尝试保留一条本地执行记录，可查看摘要和模型运行历史，并通过“查看审批详情”打开 Gateway 核对最终结论；模型执行结束不代表结果已成功回传或审批已通过。会话不可继续、编辑消息、恢复、取消、修改配置、归档或删除，重试统一从审批详情发起。记录仅从 Agent 升级后的新尝试开始产生，不回填历史；记录保存在该 Agent 的本地数据库，审核仍独立隔离执行，不恢复展示会话的 Runtime 上下文。

`execution_failed`、`timeout`、`report_invalid` 可由当前上传者或有空间管理权限的管理员重试，生成新尝试并保留旧记录。`materials_unsupported`、业务需修改和人工驳回必须调整材料后上传新版本；没有转人工或原版本重新送审入口，旧客户端重提请求也会被拒绝。Worker 每约 30 秒串行轮询，运行上限 12 分钟，Gateway 15 分钟兜底；回传最多尝试 3 次，迟到或不同结果不能覆盖已保存结果。

本地验证入口：`pnpm server:test`、管理台 `pnpm test && pnpm build`、ClaweeAgent 仓库的 `pnpm desktop:preflight:local`。服务端测试仅使用隔离测试库 `CLAW_GATEWAY_TEST_DATABASE_URL`，数据库名称必须以 `_test` 结尾。
