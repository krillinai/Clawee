import type {
  EnterpriseActivityDetailResponse,
  EnterpriseActivityRange,
  EnterpriseActivityStatisticsResponse,
  EnterpriseActivityTokenUsage,
  EnterpriseBillingOverviewResponse
} from '@clawee/protocol';
import { useState } from 'react';
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  CircleAlert,
  CreditCard,
  History,
  LoaderCircle,
  RefreshCw,
  Search,
  Users
} from 'lucide-react';
import type { AppRoute } from '../../app/routes.js';
import './activity.css';

type ActivityRoute = Extract<
  AppRoute,
  { view: 'activity' | 'activity-agent' }
>;

const rangeOptions: Array<{
  value: EnterpriseActivityRange;
  label: string;
}> = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' }
];

export function ActivityPage(props: {
  route: ActivityRoute;
  statistics?: EnterpriseActivityStatisticsResponse;
  statisticsLoading: boolean;
  statisticsError?: string;
  detail?: EnterpriseActivityDetailResponse;
  detailLoading: boolean;
  detailError?: string;
  onRetryStatistics(): void;
  onRetryDetail(): void;
  onNavigate(route: AppRoute): void;
  billingEnabled?: boolean;
  billingOverview?: EnterpriseBillingOverviewResponse;
  billingLoading?: boolean;
  billingError?: string;
  rechargePending?: boolean;
  rechargeError?: string;
  onRetryBilling?(): void;
  onRecharge?(): void;
}) {
  if (props.route.view === 'activity-agent') {
    return <AgentDetail {...props} route={props.route} />;
  }
  return <ActivityOverview {...props} route={props.route} />;
}

function ActivityOverview(props: {
  route: Extract<ActivityRoute, { view: 'activity' }>;
  statistics?: EnterpriseActivityStatisticsResponse;
  statisticsLoading: boolean;
  statisticsError?: string;
  onRetryStatistics(): void;
  onNavigate(route: AppRoute): void;
  billingEnabled?: boolean;
  billingOverview?: EnterpriseBillingOverviewResponse;
  billingLoading?: boolean;
  billingError?: string;
  rechargePending?: boolean;
  rechargeError?: string;
  onRetryBilling?(): void;
  onRecharge?(): void;
}) {
  const [query, setQuery] = useState('');
  const statistics = props.statistics;
  const filteredAgents = (statistics?.agents ?? []).filter(agent => (
    `${agent.name}${agent.status}${agent.collectorId}${agent.agentId}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  ));

  return (
    <main className="activity-page">
      <div className="activity-page__inner">
        <header className="activity-header">
          <div>
            <h1>Agent动态</h1>
            <p>
              {statistics === undefined
                ? '团队 Agent 用量与执行概览'
                : `${statistics.startDate} 至 ${statistics.endDate} · ${statistics.timezone}`}
            </p>
          </div>
          <RangeControl
            range={props.route.range}
            onChange={range => props.onNavigate({ view: 'activity', range })}
          />
        </header>

        {props.billingEnabled === true ? (
          <BillingOverview
            overview={props.billingOverview}
            loading={props.billingLoading === true}
            error={props.billingError}
            rechargePending={props.rechargePending === true}
            rechargeError={props.rechargeError}
            onRetry={props.onRetryBilling}
            onRecharge={props.onRecharge}
            onOpenRecords={() => props.onNavigate({
              view: 'activity-recharge-records',
              range: props.route.range
            })}
          />
        ) : null}

        {props.statisticsLoading ? (
          <ActivityState loading label="正在加载 Agent 动态" />
        ) : props.statisticsError !== undefined ? (
          <ActivityState
            error={props.statisticsError}
            label="Agent 动态加载失败"
            onRetry={props.onRetryStatistics}
          />
        ) : statistics === undefined ? (
          <ActivityState
            error="当前没有可展示的活动数据"
            label="暂无 Agent 动态"
            onRetry={props.onRetryStatistics}
          />
        ) : (
          <div className="activity-content">
            <MetricGrid metrics={[
              ['总 Token', formatNumber(statistics.organization.usage.totalTokens)],
              ['活跃员工', formatNumber(statistics.organization.activeEmployees)],
              ['活跃 Agent', formatNumber(statistics.organization.activeAgents)],
              ['完成轮次', formatNumber(statistics.organization.completedTurns)]
            ]} />

            <div className="activity-overview-grid">
              <TrendPanel statistics={statistics} />
              <TokenBreakdown usage={statistics.organization.usage} />
            </div>

            <TokenUsageRanking items={statistics.tokenUsageRanking} />

            <div className="activity-usage-grid">
              <ModelDistribution statistics={statistics} />
              <UsageDistribution
                title="MCP 使用分布"
                items={statistics.organization.mcpDistribution.map(item => ({
                  id: item.id,
                  label: item.label,
                  countLabel: `${formatNumber(item.invocationCount)} 次`,
                  share: item.share
                }))}
              />
            </div>

            <section className="activity-section">
              <div className="activity-section__header">
                <div>
                  <h2>Agent 列表</h2>
                  <span>{filteredAgents.length} 个 Agent</span>
                </div>
                <label className="activity-search">
                  <Search size={15} aria-hidden="true" />
                  <input
                    aria-label="搜索 Agent"
                    type="search"
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder="搜索名称、状态或标识"
                  />
                </label>
              </div>
              {filteredAgents.length === 0 ? (
                <EmptySection label="当前范围没有匹配的 Agent" />
              ) : (
                <div className="activity-table-wrap">
                  <table aria-label="Agent 列表">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>状态</th>
                        <th>会话</th>
                        <th>轮次</th>
                        <th>最近活动</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAgents.map(agent => (
                        <tr key={`${agent.collectorId}:${agent.agentId}`}>
                          <td>
                            <strong>{agent.name}</strong>
                            <small>{agent.agentId}</small>
                          </td>
                          <td>{formatStatus(agent.status)}</td>
                          <td>{formatNumber(agent.sessionCount)}</td>
                          <td>{formatNumber(agent.turnCount)}</td>
                          <td>{formatDateTime(agent.lastActivityAt)}</td>
                          <td>
                            <button
                              className="activity-row-link"
                              aria-label={`查看 ${agent.name}`}
                              title={`查看 ${agent.name}`}
                              onClick={() => props.onNavigate({
                                view: 'activity-agent',
                                collectorId: agent.collectorId,
                                agentId: agent.agentId,
                                range: props.route.range
                              })}
                            >
                              <ChevronRight size={16} aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <p className="activity-generated-at">
              数据生成于 {formatDateTime(statistics.generatedAt)}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function BillingOverview(props: {
  overview?: EnterpriseBillingOverviewResponse;
  loading: boolean;
  error?: string;
  rechargePending: boolean;
  rechargeError?: string;
  onRetry?(): void;
  onRecharge?(): void;
  onOpenRecords(): void;
}) {
  return (
    <section className="activity-billing" aria-labelledby="activity-billing-title">
      <div className="activity-billing__header">
        <h2 id="activity-billing-title">账户额度</h2>
        {props.onRetry === undefined ? null : (
          <button
            className="activity-icon-button"
            type="button"
            aria-label="刷新账户额度"
            title="刷新账户额度"
            disabled={props.loading}
            onClick={props.onRetry}
          >
            <RefreshCw
              className={props.loading ? 'activity-spin' : undefined}
              size={16}
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      {props.loading && props.overview === undefined ? (
        <div className="activity-billing__skeleton" role="status" aria-label="正在加载账户额度">
          <i /><i />
        </div>
      ) : props.error !== undefined ? (
        <div className="activity-billing__error" role="alert">
          <span>{props.error}</span>
          {props.onRetry === undefined ? null : (
            <button type="button" onClick={props.onRetry}>重试</button>
          )}
        </div>
      ) : props.overview === undefined ? null : (
        <div className="activity-billing__content">
          <div className="activity-billing__amount">
            <span>账户余额</span>
            <strong>{formatCny(props.overview.balanceCny)}</strong>
          </div>
          <div className="activity-billing__actions">
            <button
              className="activity-primary-button"
              type="button"
              disabled={props.rechargePending}
              onClick={props.onRecharge}
            >
              {props.rechargePending ? (
                <LoaderCircle className="activity-spin" size={15} aria-hidden="true" />
              ) : (
                <CreditCard size={15} aria-hidden="true" />
              )}
              充值
            </button>
            <button
              className="activity-secondary-button"
              type="button"
              onClick={props.onOpenRecords}
            >
              <History size={15} aria-hidden="true" />
              充值记录
            </button>
          </div>
        </div>
      )}
      {props.rechargeError === undefined ? null : (
        <p className="activity-billing__notice" role="alert">
          {props.rechargeError}
        </p>
      )}
      {props.overview === undefined ? null : (
        <p className="activity-billing__generated">
          数据生成于 {formatDateTime(props.overview.generatedAt)}
        </p>
      )}
    </section>
  );
}

function AgentDetail(props: {
  route: Extract<ActivityRoute, { view: 'activity-agent' }>;
  detail?: EnterpriseActivityDetailResponse;
  detailLoading: boolean;
  detailError?: string;
  onRetryDetail(): void;
  onNavigate(route: AppRoute): void;
}) {
  const detail = props.detail;
  return (
    <main className="activity-page">
      <div className="activity-page__inner">
        <header className="activity-detail-header">
          <button
            className="activity-icon-button"
            aria-label="返回 Agent动态"
            title="返回 Agent动态"
            onClick={() => props.onNavigate({
              view: 'activity',
              range: props.route.range
            })}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <div className="activity-agent-icon">
            <Bot size={20} aria-hidden="true" />
          </div>
          <div className="activity-detail-heading">
            <div className="activity-title-row">
              <h1>{detail?.agent.displayName ?? 'Agent 详情'}</h1>
              {detail === undefined ? null : (
                <span className="activity-status">
                  {formatStatus(detail.agent.status)}
                </span>
              )}
            </div>
            <p>
              {detail === undefined
                ? `${props.route.collectorId} · ${props.route.agentId}`
                : [
                    detail.agent.workspaceName,
                    detail.agent.agentType,
                    detail.agent.agentId
                  ].filter(Boolean).join(' · ')}
            </p>
          </div>
          <RangeControl
            range={props.route.range}
            onChange={range => props.onNavigate({ ...props.route, range })}
          />
        </header>

        {props.detailLoading ? (
          <ActivityState loading label="正在加载 Agent 详情" />
        ) : props.detailError !== undefined ? (
          <ActivityState
            error={props.detailError}
            label="Agent 详情加载失败"
            onRetry={props.onRetryDetail}
          />
        ) : detail === undefined ? (
          <ActivityState
            error="当前没有可展示的 Agent 详情"
            label="暂无 Agent 详情"
            onRetry={props.onRetryDetail}
          />
        ) : (
          <div className="activity-content">
            <MetricGrid metrics={[
              ['活跃会话', formatNumber(detail.stats.activeSessions)],
              ['活跃工作时长', formatDuration(detail.stats.activeWorkMs)],
              ['Tool 调用', formatNumber(detail.stats.toolCallCount)],
              ['子 Agent', `${formatNumber(detail.stats.activeSubAgents)} / ${formatNumber(detail.stats.totalSubAgents)}`]
            ]} />

            <div className="activity-detail-grid">
              <div className="activity-detail-main">
                <DetailList
                  title="会话"
                  count={`${detail.sessions.length} 个`}
                  emptyLabel="暂无会话"
                  items={detail.sessions.map((session, index) => ({
                    key: session.sessionId ?? `session-${index}`,
                    title: session.title ?? session.sessionId ?? '未命名会话',
                    meta: [
                      formatStatus(session.status),
                      formatDateTime(session.startedAt),
                      formatDuration(session.durationMs)
                    ].filter(Boolean).join(' · '),
                    lines: [
                      session.summary,
                      session.workspaceName
                    ].filter((value): value is string => Boolean(value))
                  }))}
                />
                <DetailList
                  title="Turn"
                  count={`${detail.turns.length} 轮`}
                  emptyLabel="暂无 Turn"
                  items={detail.turns.map((turn, index) => ({
                    key: turn.turnId ?? `turn-${index}`,
                    title: turn.title ?? turn.turnId ?? '未命名 Turn',
                    meta: [
                      formatStatus(turn.status),
                      turn.model,
                      formatDateTime(turn.startedAt)
                    ].filter(Boolean).join(' · '),
                    lines: [
                      turn.prompt === undefined ? undefined : `提示：${turn.prompt}`,
                      turn.assistantSummary === undefined
                        ? undefined
                        : `回答：${turn.assistantSummary}`
                    ].filter((value): value is string => Boolean(value))
                  }))}
                />
              </div>

              <div className="activity-detail-side">
                <section className="activity-section">
                  <div className="activity-section__header">
                    <div>
                      <h2>Tool 调用</h2>
                      <span>{detail.toolCalls.length} 次 · 已脱敏</span>
                    </div>
                  </div>
                  {detail.toolCalls.length === 0 ? (
                    <EmptySection label="暂无 Tool 调用" compact />
                  ) : detail.toolCalls.map((tool, index) => (
                    <ToolActivity
                      key={tool.toolCallId ?? `tool-${index}`}
                      tool={tool}
                    />
                  ))}
                </section>

                <section className="activity-section">
                  <div className="activity-section__header">
                    <div>
                      <h2>子 Agent</h2>
                      <span>{detail.subAgents.length} 个</span>
                    </div>
                  </div>
                  {detail.subAgents.length === 0 ? (
                    <EmptySection label="暂无子 Agent" compact />
                  ) : (
                    <div className="activity-subagents">
                      {detail.subAgents.map((agent, index) => (
                        <p key={agent.subAgentId ?? `sub-agent-${index}`}>
                          <Users size={15} aria-hidden="true" />
                          <strong>{agent.name ?? agent.subAgentId ?? '子 Agent'}</strong>
                          <span>
                            {[formatStatus(agent.status), agent.completedTurns === undefined
                              ? undefined
                              : `${agent.completedTurns} 轮`]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </p>
                      ))}
                    </div>
                  )}
                </section>

                <DetailList
                  title="最近活动"
                  count={`${detail.recentActivities.length} 条`}
                  emptyLabel="暂无最近活动"
                  compact
                  items={detail.recentActivities.map((item, index) => ({
                    key: item.activityId ?? `activity-${index}`,
                    title: item.title ?? item.type ?? '活动记录',
                    meta: [
                      formatStatus(item.status),
                      formatDateTime(item.occurredAt)
                    ].filter(Boolean).join(' · '),
                    lines: []
                  }))}
                />
              </div>
            </div>

            <p className="activity-generated-at">
              详情生成于 {formatDateTime(detail.serverTime)}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function ActivityState(props: {
  label: string;
  loading?: boolean;
  error?: string;
  onRetry?(): void;
}) {
  return (
    <section className="activity-state" role={props.error ? 'alert' : 'status'}>
      {props.loading ? (
        <LoaderCircle className="activity-spin" size={24} aria-hidden="true" />
      ) : (
        <CircleAlert size={24} aria-hidden="true" />
      )}
      <h2>{props.label}</h2>
      {props.error === undefined ? null : <p>{props.error}</p>}
      {props.onRetry === undefined ? null : (
        <button type="button" onClick={props.onRetry}>
          <RefreshCw size={15} aria-hidden="true" />
          重试
        </button>
      )}
    </section>
  );
}

function MetricGrid(props: { metrics: Array<[string, string]> }) {
  return (
    <div className="activity-metrics">
      {props.metrics.map(([label, value]) => (
        <div className="activity-metric" key={label}>
          <span>{label}</span>
          <strong data-testid={label === '总 Token' ? 'total-tokens' : undefined}>
            {value}
          </strong>
        </div>
      ))}
    </div>
  );
}

function TrendPanel(props: {
  statistics: EnterpriseActivityStatisticsResponse;
}) {
  const points = props.statistics.trend.points;
  const max = Math.max(...points.map(point => point.totalTokens), 1);
  return (
    <section className="activity-panel">
      <div className="activity-panel__heading">
        <h2>Token 趋势</h2>
        <span>{props.statistics.trend.granularity === 'hour' ? '按小时' : '按天'}</span>
      </div>
      {points.length === 0 ? (
        <EmptySection label="当前范围暂无 Token 趋势" compact />
      ) : (
        <>
          <div
            className="activity-trend"
            aria-label="Token 趋势"
            data-granularity={props.statistics.trend.granularity}
          >
            {points.map(point => (
              <i
                key={point.bucketStart}
                role="img"
                aria-label={`${formatTrendTime(point.bucketStart, props.statistics.trend.granularity)} ${formatNumber(point.totalTokens)} Token`}
                title={`${formatTrendTime(point.bucketStart, props.statistics.trend.granularity)} · ${formatNumber(point.totalTokens)} Token`}
                style={{
                  height: `${Math.max(4, point.totalTokens / max * 100)}%`
                }}
              />
            ))}
          </div>
          <div className="activity-chart-labels">
            <span>{formatTrendTime(points[0]!.bucketStart, props.statistics.trend.granularity)}</span>
            <span>{formatTrendTime(points.at(-1)!.bucketStart, props.statistics.trend.granularity)}</span>
          </div>
        </>
      )}
    </section>
  );
}

function TokenBreakdown(props: { usage: EnterpriseActivityTokenUsage }) {
  const fields = [
    ['输入 Token', props.usage.inputTokens],
    ['缓存输入', props.usage.cachedInputTokens],
    ['输出 Token', props.usage.outputTokens]
  ] as const;
  return (
    <section className="activity-panel">
      <div className="activity-panel__heading">
        <h2>Token 构成</h2>
        <span>缓存输入已包含在输入中</span>
      </div>
      <div className="activity-breakdown">
        {fields.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{formatNumber(value)}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function TokenUsageRanking(props: {
  items: EnterpriseActivityStatisticsResponse['tokenUsageRanking'];
}) {
  return (
    <section className="activity-section">
      <div className="activity-section__header">
        <div>
          <h2>Token 使用排行</h2>
          <span>最多展示 50 项</span>
        </div>
      </div>
      {props.items.length === 0 ? (
        <EmptySection label="当前范围暂无 Token 使用记录" compact />
      ) : (
        <div className="activity-table-wrap activity-ranking-table">
          <table aria-label="Token 使用排行">
            <thead>
              <tr>
                <th>排名</th>
                <th>使用方</th>
                <th>请求数</th>
                <th>Token 消耗</th>
              </tr>
            </thead>
            <tbody>
              {props.items.map(item => (
                <tr key={`${item.rank}:${item.name}`}>
                  <td>{formatNumber(item.rank)}</td>
                  <td><strong>{item.name}</strong></td>
                  <td>{formatNumber(item.requests)}</td>
                  <td><strong>{formatNumber(item.totalTokens)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ModelDistribution(props: {
  statistics: EnterpriseActivityStatisticsResponse;
}) {
  return (
    <UsageDistribution
      title="模型分布"
      items={props.statistics.modelDistribution.map(item => ({
        id: item.model,
        label: item.model,
        countLabel: `${formatNumber(item.requests)} 次请求`,
        share: item.share
      }))}
    />
  );
}

function UsageDistribution(props: {
  title: string;
  items: Array<{
    id: string;
    label: string;
    countLabel: string;
    share: number;
  }>;
}) {
  return (
    <section className="activity-panel">
      <div className="activity-panel__heading">
        <h2>{props.title}</h2>
        <span>{props.items.length} 项</span>
      </div>
      {props.items.length === 0 ? (
        <EmptySection label={`当前范围暂无${props.title}`} compact />
      ) : (
        <div className="activity-distribution">
          {props.items.map((item, index) => (
            <p key={item.id}>
              <i data-tone={index % 3} />
              <span>{item.label}</span>
              <strong>
                {item.countLabel} · {formatPercent(item.share)}
              </strong>
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function DetailList(props: {
  title: string;
  count: string;
  emptyLabel: string;
  compact?: boolean;
  items: Array<{
    key: string;
    title: string;
    meta: string;
    lines: string[];
  }>;
}) {
  return (
    <section className="activity-section">
      <div className="activity-section__header">
        <div>
          <h2>{props.title}</h2>
          <span>{props.count}</span>
        </div>
      </div>
      {props.items.length === 0 ? (
        <EmptySection label={props.emptyLabel} compact={props.compact} />
      ) : (
        <div className="activity-list">
          {props.items.map(item => (
            <article key={item.key}>
              <div className="activity-list__meta">
                <strong>{item.title}</strong>
                <span>{item.meta}</span>
              </div>
              {item.lines.map(line => <p key={line}>{line}</p>)}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ToolActivity(props: {
  tool: EnterpriseActivityDetailResponse['toolCalls'][number];
}) {
  return (
    <div className="activity-tool-row">
      <span className="activity-tool-icon" aria-hidden="true">T</span>
      <div>
        <strong>{props.tool.name ?? props.tool.type ?? 'Tool 调用'}</strong>
        <div className="activity-tool-meta">
          {props.tool.type === undefined ? null : <span>{props.tool.type}</span>}
          {props.tool.status === undefined ? null : (
            <span>{formatStatus(props.tool.status)}</span>
          )}
          {props.tool.occurredAt === undefined ? null : (
            <span>{formatDateTime(props.tool.occurredAt)}</span>
          )}
          {props.tool.durationMs === undefined ? null : (
            <span>{formatDuration(props.tool.durationMs)}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptySection(props: { label: string; compact?: boolean }) {
  return (
    <div
      className="activity-empty-section"
      data-compact={props.compact ? 'true' : undefined}
    >
      {props.label}
    </div>
  );
}

function RangeControl(props: {
  range: EnterpriseActivityRange;
  onChange(range: EnterpriseActivityRange): void;
}) {
  return (
    <div className="activity-segmented" role="group" aria-label="时间范围">
      {rangeOptions.map(option => (
        <button
          key={option.value}
          type="button"
          aria-pressed={props.range === option.value}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatCny(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'percent',
    maximumFractionDigits: 1
  }).format(value);
}

function formatDateTime(value: string | undefined): string {
  if (value === undefined) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function formatTrendTime(
  value: string,
  granularity: 'hour' | 'day'
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', granularity === 'hour'
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit' }
  ).format(date);
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return '';
  if (value < 1_000) return `${value} 毫秒`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} 秒`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

function formatStatus(value: string | undefined): string {
  if (value === undefined || value.length === 0) return '未知';
  const labels: Record<string, string> = {
    online: '在线',
    offline: '离线',
    active: '活跃',
    running: '运行中',
    completed: '已完成',
    succeeded: '成功',
    success: '成功',
    failed: '失败',
    canceled: '已取消',
    pending: '等待中'
  };
  return labels[value.toLocaleLowerCase()] ?? value;
}
