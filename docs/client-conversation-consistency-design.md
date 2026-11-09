# 客户端会话一致性、流式回答与阅读稳定性方案

## 1. 目标与基线

本文将六项会话体验问题整理为可分批实施的开发方案。优先保证历史不误结束、消息不乱序和断流可恢复，再交付正文增量、稳定布局和符合阅读意图的滚动行为。

- 核对日期：2026-10-16。
- 代码基线：Clawee 本地 `develop`，HEAD 为 `2d847d592c72544b0800e3be81ca033594ff9b09`，提交标题为 `chore: update client modules and tests`。未拉取远端，本文的“当前代码”指该提交及检查时的本地文件。
- 工作区已有模型目录相关修改，不属于本方案。
- 文档状态：代码已实施并完成本地验收；实施记录见第 14 节。下文“当前实现与问题确认”保留实施前基线。
- 验证方式：基线源码核对与复现、实施后回归测试、隔离 Runtime 与真实 Virtuoso 浏览器测试；未读取或操作用户真实会话。

实施范围是共享 Web、daemon 和 `@clawee/protocol`。保留 Clawee 的 Codex Runtime、daemon 持久化、HTTP 和 SSE 边界。Octop 仅提供同气泡更新、回答与过程分离、跟随与自由阅读状态机的参考，不移植其 `chatStore`、存储模型或事件协议。

## 2. 当前实现与问题确认

下列路径均相对 Clawee 仓库根目录，行号对应检查时的源码，开发时应以函数名重新定位。

| 编号 | 当前代码依据 | 影响与证据 | 优先级 |
| --- | --- | --- | --- |
| H1 历史误终态 | `client/apps/web/src/components/timeline/history-mapping.ts:10` 的 `closeCurrentRun()` 补 `succeeded`；切换输入和遍历结束均调用 | 仅用户消息和中间回答就产生成功终态，已在本轮内存复现 | P0 |
| H2 历史与缓存错位 | `client/apps/web/src/features/runs/run-event-replay.ts:58` 先复制历史再追加缓存；`:216` 的 `timelineReplayMergeKey()` 对多类消息只使用正文 | 最新页与旧缓存合并得到“新问题、新回答、旧问题、旧回答”；不同 run 的相同回答被错误丢弃，已在本轮内存复现 | P0 |
| R1 重连耗尽后无法恢复 | `client/apps/web/src/features/runs/run-event-controller.ts` 的 `scheduleReconnect()` 耗尽后转 `disconnected`；`AppController.tsx:5566` 的错误回调保留控制器登记；`:5483` 拒绝重复登记 | 生命周期闭环缺失，由源码确认；本轮未模拟真实网络恢复 | P0 |
| S1 正文增量丢失 | `client/apps/daemon/src/events/normalizer.ts:297` 仅完成快照映射正文；`timeline-model.ts:119` 不显示未知事件 | `item/agentMessage/delta` 归一化为 `unknown_event`，投影为 `null`，已在本轮内存复现 | P1 |
| L1 正文结束时换容器 | `Timeline.tsx:87`、`:788`、`:819` 按成功状态挑选最后一条正文，运行时正文属于过程，成功后变独立消息 | 由源码确认；结束前后父容器发生变化，组件测试不能证明阅读位置稳定 | P1 |
| V1 滚动只依赖物理底部 | `Timeline.tsx:1824` 的 `followOutput` 仅判断 `isAtBottom`；用户交互标志主要用于加载旧历史 | 存在高度变化覆盖用户意图的风险；仍属于待实机验证项，不能标为已复现缺陷 | P2 |

### 2.1 最新代码中必须保留的已有能力

1. `client/packages/protocol/src/events.ts:57` 已支持 `assistant_message.delivery = 'message' | 'delta'`，无需另建正文事件类型。
2. `timeline-model.ts:133` 已采用 `${runId}:${rawEventId}` 作为实时正文 ID；`history-mapping.test.ts` 已验证历史与实时消息的 ID 一致性。应扩展这条路径，不替换成每个增量生成新 ID。
3. `run-event-controller.ts` 已有序号去重、五档退避、主动停止和 generation 隔离，应补生命周期管理，不重写 SSE 控制器。
4. `AppController.tsx:3036` 已按帧批量提交时间线更新，但 `mergeTimelineItems()`（`:7182`）对同 ID 非审批项直接跳过。仅增加增量归一化会使后续 delta 和完成快照继续丢失。
5. `use-thread-history.ts` 已支持最新页、旧页前插、搜索窗口和过期请求隔离，不能用全量加载替代分页。
6. `Timeline.tsx` 使用真实 `react-virtuoso`、稳定 item key 和 `firstItemIndex` 前插锚定；现有 `Timeline.test.tsx:8` mock 了该组件。

### 2.2 清单之外的必要链路补充

- daemon 的 `run-event-history.ts:230` 只把正文完成快照转成历史；正文、思考、工具调用等分支没有完整保留 run 和事件序号。`:338` 的 `richItemSignature()` 使用“秒级时间 + 正文/内容”匹配，需要和 Web 合并一起修改。
- `run-event-history.ts:293` 的历史 ID 和 Web 正文 ID 命名空间不同；当前依赖上下文补 run 进行对齐。必须显式保留来源身份，不能继续依赖相邻用户消息猜测。
- `codex/sessions/app-server-history-mapper.ts:50` 已根据真实 turn 状态映射终态，`inProgress` 不产生 `done`。应保留这一行为，同时区分 Runtime turn 结束与 daemon run 最终结束。
- `runs/manager.ts:795` 的 `finalizeRun()` 先发布 `done` 再更新持久化 run 状态，短时间内“新 done + 旧 running 快照”是正常竞态，前端不能倒退。
- `api/routes.threads.ts:253` 会向最新历史页补 daemon 事件，而旧页不补事件；`oldestItemAt`、分页游标不能被当作完整时间线水位。
- 工作台模块会话 `features/dashboard/use-workbench-conversation.ts:83` 已通过删除 `${activeRunId}_done` 规避误终态，属于应随 H1 移除的补丁。
- `features/skill-contributions/ContributionConversation.tsx` 有独立历史映射、合并和订阅逻辑。增量投影和重连验收需要覆盖它，但不重构贡献查询、下载及企业权限业务。

## 3. 必须满足的不变量

1. 历史页读完、SSE EOF、连接失败、新用户消息到来，都不构成任务成功的证据。
2. 对有 Clawee run 的任务，最终状态来自 daemon 的真实 `done` 或 run 状态快照；Runtime 的 `turn/completed` 只表示进入收尾阶段。
3. 同一 run 已确认的终态不能被迟到的非终态快照覆盖。终态相互冲突时重新查询 daemon 并记录诊断，不按状态名称排序猜测。
4. run 状态、订阅连接状态、正文是否完成、历史是否加载完是四个独立维度。
5. 一个 Runtime 正文项只有一个稳定气泡；delta 追加，完成快照替换正文；重复重放不重复追加。
6. 不跨 run、turn 或工具调用按正文去重。不同轮次的“继续”与相同回答均须保留。
7. 加载最新页不能把已加载的旧前缀搬到尾部；加载旧页不能覆盖当前流式尾部。
8. 回答首次出现后，不因任务终态改变父容器、身份和排列位置。过程自动折叠不得隐藏正文。
9. 自由阅读时，后续输出、任务结束和布局变化不能将视口拉到底部。
10. 从历史恢复的“已知最新事件序号”不等于客户端“已应用事件序号”，不得据此前移 SSE 恢复游标。

## 4. 最小共享契约

### 4.1 历史身份与排序信息

在 `client/packages/protocol/src/api.ts` 为 `ThreadHistoryItem` 提取或补齐可选公共来源字段。以下是拟新增契约，不是现有接口声明：

```ts
type ThreadHistoryOrigin = {
  runId?: string;
  turnId?: string;
  rawEventId?: string; // Runtime item ID；工具 use/result 仍需阶段区分
  eventId?: string;    // 对应 daemon envelope.id
  eventSeq?: number;   // 该历史状态已包含的最后一条 daemon 事件序号
};
```

已有必填 `runId` 的历史类型继续必填。保留现有 `id`、`createdAt`、`turnId`，避免破坏分页、搜索和旧客户端。旧数据缺少新字段时走兼容分支，不伪造事件序号。

历史 `done` 另加可选 `terminalSource: 'daemon' | 'runtime_turn'`，分别由 daemon 事件转换与 Runtime turn 映射写入。这个来源字段需要随批次 A 提前交付，以免前端将 Runtime turn 终态当作 daemon run 终态。旧响应缺少来源时，只有能关联到真实 daemon 事件或查询到 run 终态才确认任务结束，不通过 ID 前缀猜测来源。

事件与 UI 身份按以下规则区分：

| 用途 | 身份规则 | 说明 |
| --- | --- | --- |
| 单条传输事件去重 | `(runId, seq)`，保留 `event.id` 辅助诊断 | seq 仅在一个 run 内可比较 |
| 正文气泡 | 有 run 时沿用 `${runId}:${rawEventId}` | 多条 delta 共用一个气泡，但不是同一传输事件 |
| Runtime 历史正文 | 无 run 时使用含 turn 的稳定身份；完全无归属才保留原 id | 不把合成的 `history_*` 分组键误认成真实 run |
| 工具步骤 | run/turn + toolCallId/itemId + use/result 阶段 | 同一命令多次执行不能合并 |
| 审批 | `approval.id` | 维持现有审批更新语义 |
| 终态显示 | 同一真实 run 一处状态投影 | 真实 done 与状态快照不能重复生成两行结束提示 |

历史与 SSE 都从公共身份规则得到 UI ID，避免一侧二次拼接 run 前缀。`eventId` 与 `rawEventId` 不互相替代。搜索定位须兼容历史原始 `id`，不能因 UI ID 归一化失去定位。

### 4.2 run 与 turn 的关联

daemon 归一化时保留通知中的 `turnId`，并沿现有 run 启动、事件持久化路径保留真实关联。可以为 envelope 增加可选 `turnId`，不从正文推断长期关联。

历史关联优先使用已有显式 runId、事件关联、真实 turn 关联。旧数据只能在单一候选轮次和有时间/邻接约束时兼容匹配；同文输入存在多个候选时保留原数据，不绑定到任意 run。先检查现有事件与 run 持久化是否足以重建关联；只有证实不足时才单独提出最小数据库迁移，本文不预设新增表。

### 4.3 排序契约

- 保留 Runtime 返回的 turn/item 原始顺序；同一 run 的 daemon 事件按 seq 排序。
- 同一秒中不能按“思考、工具、回答”的类型优先级覆盖真实 seq，避免回答与工具交错时倒序。
- 跨 run 以服务端已确认的轮次顺序为主；有有效时间而没有共同锚点时，时间只用于放置不重叠轮次。
- 无法比较的项保持来源内的稳定顺序，不以随机 ID 或正文决定先后。
- 明确存在断档的缓存不能冒充连续分页区间；允许保留多个已知窗口，向前加载时继续使用服务端游标。

## 5. H1：终态只投影真实事实

### 5.1 实现步骤

1. 删除历史遍历结束及下一条用户输入触发的成功合成逻辑。mapper 只负责类型、身份和归属映射，不决定任务是否结束。
2. 映射所有历史类型时优先采用该项显式 runId，包括 `done`、`diagnostic`、`tool_result`，再使用真实 turn 关联；分页从工具或回答开始时不能绑定到前一轮。
3. 在历史恢复协调层使用 runs 列表补展示状态，沿用 `run-registry.ts` 的状态管理。不要将快照状态伪装成带 seq 的 SSE `done`。若需要供 Timeline 消费，增加明确的 run 状态输入或复用用户项 `runStatus`，仍由同一投影函数处理。
4. 真实 done 保留 `failed`、`canceled` 和 `terminationReason`；没有结束原因时不猜成 `completed`。
5. 有真实 run 归属时，Runtime 历史 turn 的完成结果仅供协调，daemon 仍 running 时显示“收尾中”，继续订阅。无 Clawee run 的导入历史可依据 Runtime 明确 turn 终态展示，需保留来源区别。
6. 未找到 run 且没有真实 turn 终态的旧记录显示“状态待确认”，停止无限运行计时，不显示“成功完成”。只读历史的不确定状态不应无条件阻塞新会话发送。
7. 删除工作台按 `${activeRunId}_done` 过滤的临时规避逻辑，并更新依赖历史自动闭合的测试。

### 5.2 状态决策

| 输入证据 | 展示结果 | 订阅行为 |
| --- | --- | --- |
| 用户消息 + 中间回答，无终态 | 不补 done；有 run 则按 run 状态，无 run 则状态待确认 | 有活动 run 时订阅 |
| Runtime turn completed + daemon run running | 收尾中，不显示任务成功 | 继续等待 daemon |
| daemon done + 较旧 running 快照 | 保持 done 的终态与原因 | 按已消费事件完成清理 |
| daemon 终态快照 + 事件尚未补齐 | 显示真实任务状态，另标输出同步中 | 继续补齐事件后清理 |
| 仅 SSE 断流 | 显示连接中断，任务状态保持最后事实 | 执行 R1 恢复流程 |

验收重点：输入不含任何终态时，输出数组不新增 `done`；运行中切走再切回，过程区不自动成功、正文不被提前折叠。

## 6. H2：以轮次身份协调历史窗口

### 6.1 合并算法

继续使用有序时间线数组和现有线程缓存，不引入第二套全局聊天状态仓库。将 `mergeTimelineHistoryWithCache()` 从“服务器全放前面”改为明确的窗口协调，并让调用者传递本次操作类型：最新页刷新、旧页前插、搜索窗口。

1. **归一化身份**：将可关联的历史 turn 与真实 run 对齐，生成前述稳定身份。先确认轮次，再匹配轮内项。
2. **查找共同锚点**：按稳定项身份寻找保持相对顺序的重叠区间。不能只以相同正文建立锚点。
3. **保留窗口外部分**：保留缓存中早于重叠区的旧前缀，以及晚于快照覆盖范围的实时尾部。旧页前插只能扩展前部，不能重排实时尾部。
4. **协调重叠部分**：服务端完整快照校正已完成消息；更新同一气泡时保留 UI ID。较旧的快照不得覆盖更新的 delta 投影，使用同源 eventSeq 判断覆盖范围。
5. **逐项保留额外信息**：合并缓存附件预览与服务器附件；保留没有服务端对应项的工具、错误、审批和未完成正文。移除按正文集合“整轮已被表示”就丢弃整轮缓存的路径。
6. **无共同锚点**：有可比较轮次时间时按轮次插入，保持轮内顺序；历史窗口范围之外的数据继续保留。没有可靠顺序时维持已知缓存顺序，新增服务器窗口作为待协调区间，不用正文强制匹配或清空缓存；记录脱敏诊断以便定位。
7. **重复调用幂等**：同一页重复合并结果不变；后台线程的历史回包只能更新所属线程，不能污染当前线程。

该算法需覆盖两个明确示例：

```text
缓存：[旧问题, 旧回答, 新问题, 新回答的流式部分]
最新页：[新问题, 新回答的完成快照]
结果：[旧问题, 旧回答, 新问题, 新回答的完成快照]

缓存：[run-A:继续, run-A:好的, run-B:继续, run-B:好的]
重放：run-B 的相同事件，以及 run-C 的“好的”
结果：run-B 不重复，run-A 保留，run-C 正常新增
```

### 6.2 兼容去重的严格边界

`createRunReplayDeduper()` 应显式接收当前 runId，并按当前 run/已确认 turn 建立重放窗口，不能使用“全列表最后一个用户输入”代替当前 run。后台活动 run 不一定是界面最后一轮。

缺少稳定 ID 的旧历史只允许在已经确认对应的单轮窗口内，使用“类型 + 内容 + 出现次数 + 相对顺序”做一对一兜底；明确不同 run 的项绝不匹配。终态不能用 `done:succeeded` 跨轮抵消，附件预览也不能仅按正文匹配到另一条“继续”。无法确认归属时宁可保留待协调项，不静默删消息。

daemon 的 `richItemSignature()` 同步收紧：有明确 run/turn 时必须绑定归属；不同 run 的同秒同文不得合并；与 Runtime 历史对应时优先使用 itemId 和 turnId。保留工具 use/result 后缀语义，不把两阶段当作重复。

### 6.3 分页边界

`use-thread-history.ts` 继续负责游标、请求 generation 和旧页加载状态。合并层负责内容协调，不能用 UI 数组长度推导 `hasMore` 或游标。

最新页刷新后，已加载旧前缀的分页游标仍应指向该前缀之前；搜索目标窗口使用独立覆盖范围，不能被误认成最新页。为每个线程记录必要的已加载窗口信息即可，不建立通用事件数据库。

验收重点：已加载两页后刷新最新页，旧消息仍在上方；重复输入、跨秒/同秒时间、缺少时间、重复工具、附件、失败原因均不被错配。

## 7. R1：重连与状态协调形成闭环

### 7.1 保留与补充的职责

- `run-event-controller.ts`：继续处理单 run 传输、退避、seq 去重、generation 和 abort；不负责历史 UI 合并。
- `AppController.tsx`：负责登记生命周期、run 事实协调、恢复入口和按线程路由。
- `run-registry.ts`：保留任务与订阅的独立状态、每个 run 的已应用事件水位。
- 工作台和贡献会话复用必要的投影与恢复规则，保留各自服务入口。

### 7.2 耗尽后的清理与恢复

1. 自动重试仍使用现有 `500/1000/2000/4000/8000ms` 退避。正常 done、主动 stop 和 generation 替换不触发故障恢复。
2. 最终错误回调先检查控制器身份；flush 该线程尚未提交的事件批次，再移除旧登记并 `stop()`，清理 timer、abort 和观察器。
3. 将 registry 中订阅状态标为 `disconnected`，保留最后真实 run 状态和已应用 seq。只显示一条可操作的断流提示，不将 run 标记为失败或允许重复启动同一任务。
4. 给恢复订阅 effect 加状态门槛：`disconnected` 必须经明确恢复触发才重试。否则“删 map + registry 更新”会立即再建控制器，形成无上限重连循环。
5. 提供“重试连接”操作，并在 `online`、daemon 从不可达恢复、窗口重新获得焦点/页面重新可见时触发同一恢复函数。`online` 仅表示可尝试，不能直接标记连接成功。
6. 同一个 `(runtimeGeneration, runId)` 的恢复请求合并为一个在途请求；焦点/可见性事件做短时合并。自动恢复每次外部恢复触发启动一轮有上限重试，耗尽后回到等待状态，不自行无限轮询。
7. 恢复期间切换 runtime、退出登录或卸载必须使旧异步结果失效。替换后的旧控制器回调不能删除新登记。

### 7.3 恢复流程

```text
手动重试 / online / daemon 恢复 / 回到页面
  -> 确认当前 runtime 身份，合并在途恢复请求
  -> 查询当前 run 状态，必要时获取线程 runs 的 lastEventSeq
  -> 从客户端已应用 seq 恢复 SSE，并协调最新历史窗口
  -> 活动 run：持续订阅
  -> 终态 run：补齐剩余事件和最终快照后停止
  -> 请求失败：保留 disconnected，等待下一次触发
```

当前 `GET /runs/:id` 返回 run 本身及附件，不能假定它包含 `lastEventSeq`；线程 runs 列表已有该字段。若实现需要单 run 的终态补齐水位，可最小扩展该响应，或复用线程 runs 查询，需配套契约测试。

daemon 的 `routes.runs.ts` 在终态 run 重放结束后可能直接 EOF。如果客户端此前已经消费 done，EOF 是正常结果；如果只取得终态快照，也应停止“意外 EOF -> 重试耗尽”的循环。不能通过关闭控制器提前丢弃最终回答：先应用所有实际返回事件，再结合终态快照判断输出是否同步完成。没有 seq 水位时，至少完整完成一次终态事件重放和历史校正；仍缺输出则显示同步失败并允许重试，不能假称完整。

为使这条路径可实现，在控制器正常 EOF、尚未收到 done、准备调用 `scheduleReconnect()` 之前增加协调回调，例如 `onStreamEnd()` 返回“同步已结束”或“需要重连”。调用方完成终态查询与输出校正后再给出结果；等待期间同样受 generation 和 abort 约束。该回调只决定订阅生命周期，不生成任务成功状态；传输异常继续沿原有退避路径处理。

如果 daemon 已有终态但没有持久化 done，前端可以据快照显示真实任务状态，不能制造假序号。该不一致应进入诊断，必要时由 daemon 自身恢复机制修复。

### 7.4 事件水位与帧批次

控制器去重的传输水位与 registry 的“已应用水位”应有明确约定。拟采用：事件按序应用到线程投影后才更新已应用 seq；React 绘制可以延后一帧。若继续把事件留在 batcher 中，恢复、错误、停止和切换前必须先 flush，避免 registry 提前前移但消息尚未应用。

`lastEventSeq` 是服务器最新序号，只用于判断是否需要补齐，不得直接写入客户端已应用水位。历史如果包含某个正文快照，仅能跳过该正文已覆盖的 delta，不能跳过同序号区间内尚未显示的工具或错误。

验收重点：超过重试上限后恢复网络，无需刷新页面可继续；任何时刻同一 run 只有一个有效订阅，旧回调不污染新控制器，断网期间已结束的任务能补出最终回答。

## 8. S1：正文 delta、快照与历史共用投影

### 8.1 daemon 归一化

在 `normalizeAppServerEvent()` 新增 `item/agentMessage/delta` 分支：

- 输出现有 `assistant_message`，`payload.delivery = 'delta'`，`text = params.delta`。
- `rawEventId` 必须来自有效 `params.itemId`，同时保留 turn 关联；不能使用 turnId、threadId 或 event seq 代替正文身份。
- `item/completed` 的 agentMessage 继续输出 `delivery = 'message'`，其 rawEventId 与增量相同，text 是完整快照。
- 空 delta 不创建空气泡；缺少 itemId 的 malformed delta 不合并到“最后一个正文”，保留为未知事件并使用现有诊断路径。
- 正文项完成与任务完成独立：正文 completed 不能生成 run done；`turn/completed` 仍投影为 `finalizing`。

沿现有脱敏、事件序号分配、持久化和 SSE 路径传递。确认 Runtime runner 会透传通知，并扩展 runtime contract fixture；不能只使用手写 Web 事件证明整链可用。更新 normalizerVersion 以记录归一化语义变化，不需要新事件枚举。

### 8.2 Web 的事件应用规则

在 `features/runs/` 增加小型纯事件应用函数，例如 `applyRunEventToTimeline(items, event)`。它可调用现有映射函数，但必须保留 delivery、seq 和正文稳定身份；不再对每条消息统一执行“转换成 item 后 append”。由主会话、工作台会话和贡献会话共用。

| 到达内容 | 当前气泡 | 动作 |
| --- | --- | --- |
| delta，seq 未应用 | 无 | 用稳定 ID 创建 streaming 正文 |
| delta，seq 未应用 | 同 ID streaming | 追加文本，更新该项覆盖 seq，原位置不变 |
| 相同或较早的已应用 delta | 有 | 忽略，不追加 |
| completed 完整快照 | 同 ID streaming | 完整替换文本，标记正文 complete，原位置不变 |
| 只有 completed，无 delta | 无 | 创建一条 complete 正文，兼容旧 daemon |
| completed 与本地前缀不一致 | 有 | 采用完整快照校正，不能只拼差集 |
| 较旧历史快照 | 更新的 streaming 正文 | 不回退；只补来源和附件等缺失元数据 |
| run 失败/取消但正文未完成 | 有 | 保留部分正文并标记 interrupted，展示实际 run 原因 |

新增可选消息级字段，如 `messageState: 'streaming' | 'complete' | 'interrupted'` 和 `eventSeq`，不要把 `runStatus` 当成正文完成状态。

重放去重必须先识别传输事件，再执行增量或快照更新。`shouldAppend()` 的布尔语义不足以表达更新，应改为事件应用决策或让正文走 reducer；不能因为气泡 ID 已存在就跳过所有后续事件。

### 8.3 历史恢复与重复 delta

daemon 历史层按 run + itemId 折叠持久化正文事件，返回每个正文项的当前快照及已覆盖 eventSeq，不能把每个 delta 当独立历史消息。完成快照存在时以它校正；未完成时返回聚合的部分正文。

聚合项保留首次出现的排序位置和创建时间，最后更新时间与覆盖 seq 分开维护，不能在每次 delta 后用最新事件时间把气泡重新排序。`eventSeq` 仅表示已按顺序折叠该正文事件的覆盖范围，不用于宣称整个 run 的历史已经完整加载。

客户端恢复已有聚合快照后，对该正文只应用覆盖序号之后的 delta。对没有序号信息的旧历史，如果需要重放正文 delta，应从该 item 的事件重新构建正文，再校正原气泡，不能在未知覆盖范围的历史文本后直接拼接。其他事件仍按自身身份应用。

按帧批量处理应保持 envelope 原始顺序。相同 item 的相邻 delta 可合并成一次绘制，但不能用“Map 只留最后一项”丢掉前面的文本；同一帧 delta 后紧接 completed 时，最终结果必须等于 completed 快照。done、审批和最终错误触发及时 flush。

### 8.4 兼容与负载

所有协议字段按可选方式新增，旧事件无需离线重写。旧 daemon 仅发送 completed 时新 Web 仍正常展示。新 daemon 使用已有事件类型，旧 Web 能解析但不保证正确增量渲染，因此默认按现有桌面内嵌 Web/daemon 配套构建发布；独立部署的 Web 与 daemon 应同步升级，不宣称任意版本混用兼容。

delta 会增加持久化与 SSE 数量，需检查长回答的事件写入和前端绘制成本。优先复用现有批次机制，避免每个 token 重排整个历史；若需要服务端合并传输，必须另行证明不破坏 seq 重放契约，不能在归一化时直接丢事件。

验收重点：完成前已显示至少两个阶段的正文；全部阶段只有一个气泡；重复重放不重复字符；最终快照内容精确一致；中途切会话或断网仍能恢复同一正文。

## 9. L1：回答从首次出现起保持独立容器

1. `assistant_message` 从首次出现就渲染为独立消息行，退出 `ProcessTimelineItem` 和 `VisibleProcessItem`。现阶段所有正文都这样处理，不根据文字像不像“正在执行”猜测内容类型。
2. 过程区只容纳 reasoning、工具、状态及相关诊断，正文项 completed 和 run done 都不改变正文归属。
3. 移除依赖成功状态的 `collectFinalAssistantMessageIds()` 和“仅最后正文外提”逻辑。一个 run 中多条正文分别保留，不在成功时只留下最后一条可见。
4. 过程块沿用稳定 run key；若该轮只有正文，确定是否创建过程摘要应在首条正文时完成，不能等 done 才在正文上方插入新过程行。已经出现的过程块不因完成而销毁重建。
5. 过程仍允许成功后默认收起，但仅作用于过程内容；用户手动展开/收起的 override 继续生效。失败诊断、取消原因、审批及工作流结果保持原有可见性规则。
6. item key 不使用数组索引、当前文字、终态或 streaming 状态。历史身份校正时保留已挂载正文的 UI ID，并维护原历史 ID 的定位别名。
7. 过程区高度变化仍会影响回答的屏幕位置，稳定父容器不等于滚动完全稳定，必须配合下一节的锚定验证。

默认顺序沿用“输入、过程摘要、该轮正文与其他独立项”的现有习惯。后续工具状态可更新既有过程摘要，正文行的身份与相对顺序保持稳定。不引入多代理内容块模型。

验收重点：保持正文行可见时发送 done，DOM 元素引用、父容器及消息 ID 不变；原生选区、展开的代码块等状态不因任务完成丢失。mock 虚拟列表只验证投影语义，真实保留行为由 E2E 验证。

## 10. V1：按用户意图控制跟随与阅读锚点

### 10.1 状态转换

将物理 `atBottom` 与意图状态 `follow | free` 分开管理，可提取 Timeline 私有 hook。沿用 Virtuoso，不为这项需求替换虚拟列表。

| 事件 | 状态变化 | 滚动动作 |
| --- | --- | --- |
| 首次进入普通会话 | 默认 follow | 初始定位末尾 |
| 搜索定位或恢复保存阅读位置 | free | 仅执行一次目标定位 |
| 用户滚轮上滑、触摸上翻、PageUp/Home/向上键或拖动滚动条上移 | follow -> free | 取消待执行的跟随 |
| 程序滚动或列表重新测量 | 不改变阅读意图 | 按当前模式处理 |
| 新消息、delta、图片加载、展开/折叠、任务结束 | 保持模式 | follow 跟底；free 维持阅读锚点 |
| 点击回到底部 | free -> follow | 显式滚到底并清除未读提示 |
| 用户主动滚到真正末尾 | free -> follow | 恢复跟随 |

物理底部的宽容阈值可先沿用现有 64px，主动恢复 follow 使用更小阈值，例如 12px，防止轻微上滑后立即恢复跟随。阈值是初始实现值，需在真实列表验证，不做产品配置项。

程序滚动 guard 应标注调用来源和生命周期；新的真实用户手势必须能打断 guard，不能在固定时间内吞掉滚轮/触摸输入。`TimelineHandle.scrollBy()` 的调用也需区分用户导航与自动布局补偿。

### 10.2 高度变化与未读提示

- free 模式优先利用 Virtuoso 的稳定 key 和前插锚定；必要时保存首个可见消息的 ID 与相对 scroller 顶部偏移，在布局稳定后恢复偏移，不强制回底。
- 仅当该锚点被虚拟化卸载或移除时选择邻近可见项，不在每个 delta 触发全列表测量。宽度变化、图片加载和过程折叠都要纳入验证。
- prepend 的 `firstItemIndex` 更新依据实际新增渲染行，不能因为正文从过程抽出导致历史锚定变化。具体 Virtuoso 索引坐标按仓库锁定版本验证。
- 新内容提示不仅统计数组长度：同 ID 正文继续增长也算新内容；单纯状态变化、审批更新不重复累加正文未读提示。
- 搜索 target effect 不应因流式内容改变目标索引而反复执行定位。每次显式搜索导航只定位一次。
- 前台会话切回时保留此前 free 模式和阅读锚点；没有保存状态时才使用默认末尾定位。持续输出不能覆盖恢复位置。

Octop 参考为 `../Octop/dashboard/src/pages/Chat/hooks/useAutoScroll.ts` 及其 `scrollFreeMode` 辅助逻辑。借鉴状态、输入来源隔离和恢复机制，不照搬全部手势、刷新或团队聊天逻辑。

## 11. 开发批次与改动地图

批次按依赖顺序实施；每批独立可验收，不在尚未支持同 ID 更新时先打开 delta 输出。

| 批次 | 任务与主要文件 | 本批验证出口 |
| --- | --- | --- |
| A | H1：`history-mapping.ts`、`AppController.tsx`、`run-registry.ts`、工作台恢复补丁；协调 Runtime turn 与 daemon run 终态来源 | 无终态输入不生成 done；真实 failed/canceled 与原因保留；运行中切回不提前结束 |
| B | H2：`protocol/src/api.ts`、必要的 envelope turn 字段、`run-event-history.ts`、Runtime 历史映射、`run-event-replay.ts`、`use-thread-history.ts` 及调用方 | 旧前缀、重叠窗口、实时尾部正确；重复文本与附件不跨轮误匹配；旧数据兼容 |
| C | R1：`run-event-controller.ts`、`run-registry.ts`、`AppController.tsx`、工作台与贡献会话的恢复入口；按需扩展单 run 响应水位 | 耗尽后手动/自动恢复；终态 EOF 正确退出；无双订阅、无恢复死循环 |
| D | S1：`normalizer.ts`、协议可选消息状态/水位、daemon 历史聚合、共享事件应用函数、三类会话消费链与帧批次 | delta、completed、历史快照、断线重放同一气泡；性能不明显退化 |
| E | L1：`Timeline.tsx` 的过程分类和 render projection，正文稳定 key、历史定位兼容 | 运行中与终态 DOM 父容器一致；过程收起不隐藏正文 |
| F | V1：Timeline 私有滚动 hook、真实浏览器测试 fixture 与 E2E | 用户上翻后不抢位；前插/折叠/图片/delta 保持锚点；明确操作可恢复跟随 |

批次 D 的客户端 reducer、daemon 归一化与历史聚合必须作为一组可用交付；批次 E 紧随其后。必要时 D/E 合并验收，不能发布“有 delta 却重复气泡”的中间状态。

不在本轮扩展 Gateway 治理功能、重构 AppController 全部状态、替换 UI 库或更换存储方案。贡献会话只接入必要公共规则，其导出副作用必须继续保证重放不会再次触发下载或重复消费结果。

## 12. 验证计划

### 12.1 本轮已完成的基线检查

7 个 Web 文件通过 138 项，2 个 daemon 文件通过 31 项，共 **9 个文件、169 项通过**。这更新了原清单的“136 项”数量，仅代表当前已有覆盖通过，不代表六项问题已修复。

从 `client/` 执行：

```sh
corepack pnpm --filter @clawee/web test src/components/timeline/history-mapping.test.ts src/components/timeline/timeline-model.test.ts src/components/timeline/Timeline.test.tsx src/features/runs/run-event-replay.test.ts src/features/runs/run-event-controller.test.ts src/runtime/sse.test.ts src/features/conversation/use-thread-history.test.ts
corepack pnpm --filter @clawee/daemon test test/unit/events.test.ts test/unit/run-event-history.test.ts
```

本轮另以直接导入源码的纯内存脚本确认：无终态历史产生 `succeeded`、最新页与旧缓存倒序、跨 run 同文回答被 deduper 丢弃，以及正文 delta 得到 `unknown_event -> null`。这些脚本应在实施时转换为正式回归测试；本文未新增测试源码。

### 12.2 必须补齐的回归矩阵

| 用例 | 测试层与位置 | 关键断言 |
| --- | --- | --- |
| 仅输入和中间回答；下一轮开始；分页末尾 | `history-mapping.test.ts` | 均不凭边界补成功 |
| 分页从回答/工具/done 开始，显式 run 与相邻输入不同 | 历史 mapper 与 daemon history 单测 | 显式归属优先，不借错 run |
| Runtime completed 而 daemon running；done 后迟到 running | registry、恢复集成测试 | 收尾不误成功，已确认终态不倒退 |
| 两页旧缓存 + 最新页；旧页与实时事件并发 | replay、history hook 测试 | 历史前缀不倒序，尾部不丢，重复合并幂等 |
| 连续两轮“继续”及相同回答、相同工具；同秒时间 | daemon history 与 replay 测试 | 不同 run 均保留，同一事件不重复 |
| 附件预览、失败原因、审批、文件变更 | replay 与现有专用测试 | 元数据不丢失、不串轮；use/result 不互相覆盖 |
| 重连耗尽后重试、online、focus 同时触发 | controller + `App.test.tsx` 集成 | 单一恢复在途请求、单有效订阅，无无限 effect 循环 |
| 网络断开期间任务完成、仅终态快照、正常 EOF | SSE/恢复集成 | 最后回答完整，终态不再重连，缺输出可重试 |
| 替换控制器后旧回调、卸载、runtime 切换、后台线程继续输出 | controller 与三类会话测试 | 不污染新登记与其他线程，不泄漏监听 |
| delta -> delta -> completed；同帧处理 | normalizer、纯投影、帧批次测试 | 一个气泡，文本为完整快照，无增量丢失 |
| 重放重复 delta、旧快照、仅完成快照、途中失败/取消 | 投影 + daemon history 测试 | 不重复字符、不回退、部分正文保留 |
| 历史聚合部分正文后从 seq=0 重放 | daemon/Web 联合 fixture | 历史已覆盖 delta 不再追加，其他事件仍保留 |
| 成功/失败/取消前后的回答容器 | Timeline 测试及 E2E | 同可见消息元素与父容器不变，正文不随过程折叠 |
| 搜索窗口、目标定位、旧页前插 | hook + Timeline/E2E | 游标正确，定位仅执行一次，滚动锚点保持 |
| free 中 delta、done、过程收起、图片加载 | 真实 Virtuoso E2E | 阅读锚点及偏移保持，不自动恢复 follow |
| 手动到底、按钮到底、触摸/键盘/滚动条上翻 | 真实 Virtuoso E2E | 模式转换符合用户输入；程序 guard 可被用户打断 |

保留现有行为测试，但对依赖错误设计的断言应更新：历史边界自动完成、仅末条正文外提、运行中正文必须在过程区等，不能为了让旧测试通过继续保留这些行为。

### 12.3 真实滚动验收

新增常规执行的 `client/apps/web/e2e/conversation-consistency.spec.ts`，复用 `e2e/fixtures/runtime.ts` 的隔离 runtime。扩展脚本化事件 fixture 支持 agentMessage delta、暂停完成、断流和重复重放，避免依赖真实模型与网络。不能只依赖 `run-process-visual.spec.ts`：该文件默认在没有 `CLAWEE_VISUAL_DIR` 时跳过，且主要用于阶段截图。

采用仓库已有桌面 `1440×900` 和移动 `390×844` 两个 Playwright 项目，并使用未 mock 的 Virtuoso。至少满足：

1. 生成超过三个视口的长回答，用户主动上翻至中段，记录首个可见消息身份和视口内文本标记。
2. 持续输出 delta，随后 completed、done、过程默认收起，再触发一个上方图片加载；每阶段检查标记仍在原位置。锚点元素仍存在时，布局稳定后偏移误差建议不超过 8px；浏览器环境差异须有明确依据，不能只放宽阈值。
3. 测试选区和正文 DOM 身份需保持在可见区域，避免把虚拟列表正常卸载误判为任务结束重挂载。
4. 点击回到底部后到末尾并恢复 follow，继续 delta 时能跟随；轻微上滑不能被 64px 宽容区立即恢复 follow。
5. 加载更早记录、切换会话后返回、搜索定位时均不被后续事件重新拉到末尾。
6. 无论是否新增行，同 ID 正文继续输出时 free 模式的新内容提示可出现；正常跟随时无多余提示。

测试用条件等待或明确的 fixture 阶段屏障，不用任意长 sleep 判断完成。保留失败截图与 trace，验证具体元素偏移、模式和气泡数量，而不只比较 `scrollTop`。

### 12.4 实施后的工程门禁

从 `client/` 执行以下命令。这里列的是未来代码实施的门禁，本轮文档交付未运行整套预检。

```sh
corepack pnpm --filter @clawee/protocol test
corepack pnpm --filter @clawee/daemon test
corepack pnpm --filter @clawee/web test
corepack pnpm typecheck
corepack pnpm exec playwright test conversation-consistency.spec.ts
corepack pnpm desktop:preflight:local
```

协议修改涉及独立企业会话适配器或其他消费者时，扩展其契约测试；涉及 Runtime 通知字段时运行既有 `corepack pnpm codex:runtime:verify`。按 Clawee 的 AGENTS.md，客户端可执行代码交付必须通过 `desktop:preflight:local`，它覆盖实际 App 打包和内嵌 Web 哈希；单元测试全绿不能替代发布门禁。

## 13. 风险、兼容与交付判定

| 风险 | 处理与退出条件 |
| --- | --- |
| 旧历史没有 run/turn/seq | 逐级降级且限制正文兜底范围；不假称可精确恢复身份；保留待确认状态 |
| 新身份破坏搜索、缓存或虚拟列表 key | 保留历史原 ID 与 UI ID 映射；旧缓存通过当前内存加载归一化，不要求用户清空会话 |
| 状态快照与事件存在短暂竞态 | 已确认终态不被旧 running 覆盖；状态结束与输出同步分别展示 |
| 删除控制器登记引发无上限重试 | registry 状态门槛、恢复触发合并、旧 generation 隔离，必须有集成断言 |
| delta 只接入主会话导致其他入口损坏 | 工作台与贡献会话共同接入纯投影；贡献结果重放副作用单独断言 |
| delta 放大 I/O 与渲染成本 | 保持事件顺序和按帧处理，长回答基线对比；未证明正确前不开启丢帧/丢事件优化 |
| 稳定正文后过程折叠仍带来高度变化 | 用真实 Virtuoso 的阅读锚点测试验收，不能把 DOM key 稳定当作滚动通过 |
| 测试夹具没有真实 delta 或真实列表 | normalizer 到 SSE 的完整 fixture 加真实浏览器；mock 单测仅作局部证据 |

每个批次交付需附：对应失败回归在修复后的结果、实际改动文件、协议兼容说明及仍未验证的条件。回退优先撤销该批业务行为，不删除既有历史或运行事件；新增可选协议字段应保持可读取，不以清空数据作为回退手段。

整体完成标准是：六项问题相关场景均有对应证据，P0 的历史与恢复测试通过，流式正文和快照共用同一气泡，真实浏览器证明主动阅读不被后续输出和结束过程打断，并完成客户端本地预检。仅“原有测试仍然通过”不构成完成。

## 14. 实施记录（2026-10-16）

| 项目 | 已实施内容 | 回归证据 |
| --- | --- | --- |
| H1 | 删除历史边界合成成功；区分 Runtime turn 与 daemon 终态；保护终态不被迟到 running 覆盖；补输出同步中提示 | history-mapping、registry、App 和工作台测试 |
| H2 | 保留 run/turn/item/seq 来源；按身份与轮次协调历史和缓存；窗口不重叠时保留缺口及各自游标；搜索范围独立保存 | daemon history、replay、history hook、贡献会话测试 |
| R1 | 耗尽后清理控制器并等待明确触发；合并恢复请求；支持手动、online、focus、可见性和 daemon 恢复；协调终态 EOF | controller、App 恢复/EOF 集成、恢复触发 hook、贡献会话测试 |
| S1 | 归一化有效正文 delta；共享增量应用函数；daemon 聚合正文与覆盖水位；完成快照校正原气泡 | normalizer、存储重开、daemon history、纯投影与真实 Runtime 契约 |
| L1 | 全部正文从首次出现即使用独立稳定行；过程收起不隐藏正文；保留历史定位别名 | Timeline 测试与真实浏览器 DOM、父容器、选区检查 |
| V1 | follow/free 意图区分；会话阅读状态恢复；图片和前插锚点补偿；同气泡增量未读提示 | 阅读 hook、Timeline 与桌面/移动真实 Virtuoso 测试 |

保留原有 delivery 协议、SSE 退避与 generation 隔离、帧批次、分页和 Virtuoso，不重复实现这些已有能力。主会话、工作台和贡献会话共用正文投影；主会话与贡献会话共用必要的历史窗口协调。未改 Gateway 业务或用户真实会话数据。

旧 `run_events` 缺少 turn 关联及 normalizer 版本，已通过现有迁移机制增加两列；旧记录版本默认为 1，新事件使用版本 2，并保留事件原始时间。协议新增字段均为可选，Web 与 daemon 仍按配套构建交付。

独立 sub agent 审核后已修复：历史身份校正后的重复气泡、无锚点时拆开轮次、Runtime 正文与旧水位混用、贡献恢复丢旧页/游标、贡献旧页合并参数、阅读状态切换遗漏，以及工作台迟到快照覆盖真实终态。搜索目标定位由 hook/组件测试覆盖；真实浏览器测试覆盖增量、快照、done、过程收起、图片、前插、切回、轻微上滚、键盘、触摸、滚动条及回底后的继续输出。

验证均使用隔离夹具。Web 全量 1426 项通过，daemon 全量 1838 项通过、24 项跳过；protocol 35 项、desktop 单测 450 项、skill-market 6 项、harness 3 项通过，全工作区类型检查通过。真实 Runtime 流式契约通过；`conversation-consistency.spec.ts` 的桌面与移动项目共 6 项通过。

最终 `desktop:preflight:local` 于 2026-10-16 通过，验证基于 HEAD `05ee3853a64b6115809d2e2629b491e05c0a92d4` 及本轮工作区修改，涵盖测试、类型检查、实际 App 打包、内嵌 Web 哈希和打包 App 验证（16 项通过、1 项平台跳过）。凭据位于 `client/apps/desktop/release/clawee-desktop-local-preflight.json`。工作区尚未提交，凭据为 `dirty=true`、`releaseReady=false`；本轮不涉及签名发布、远端 workflow 或正式 Tag。
