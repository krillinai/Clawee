import type {
  EnterpriseActivityDetailResponse,
  EnterpriseActivityAgentUsage,
  EnterpriseActivityRange,
  EnterpriseActivityRuntimeResponse,
  EnterpriseActivityStatisticsResponse,
  EnterpriseActivityTokenUsage,
  EnterpriseBillingOverviewResponse,
  ThreadResponse
} from '@clawee/protocol';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  CircleAlert,
  CreditCard,
  History,
  LoaderCircle,
  RefreshCw,
  Search
} from 'lucide-react';
import type { AppRoute } from '../../app/routes.js';
import { WorkbenchModuleLayout } from '../dashboard/WorkbenchModuleLayout.js';
import { WorkbenchConversationPanel } from '../dashboard/WorkbenchConversationPanel.js';
import { buildActivityAgentModuleContext, buildActivityModuleContext, type PersonalTokenRank } from '../dashboard/workbench-module-context.js';
import type { WorkbenchConversationRuntime } from '../dashboard/use-workbench-conversation.js';
import '../dashboard/workbench.css';
import './activity.css';

type ActivityRoute = Extract<
  AppRoute,
  { view: 'activity' | 'activity-agent' }
>;

type ActivityRuntimeProps = {
  runtime?: EnterpriseActivityRuntimeResponse;
  runtimeLoading?: boolean;
  runtimeError?: string;
  onRetryRuntime?(): void;
};

const rangeOptions: Array<{
  value: EnterpriseActivityRange;
  label: string;
}> = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' }
];

function useActivitySectionNavigation(sectionKey: string) {
  const pageRef = useRef<HTMLElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const [activeSection, setActiveSection] = useState('runtime');
  useEffect(() => {
    const page = pageRef.current;
    const navigation = navigationRef.current;
    if (page === null || navigation === null) return;
    const targets = Array.from(page.querySelectorAll<HTMLElement>('[data-activity-section]'));
    function updateActiveSection() {
      const threshold = page!.getBoundingClientRect().top + navigation!.offsetHeight + 16;
      let current = targets[0];
      for (const target of targets) {
        if (target.getBoundingClientRect().top <= threshold) current = target;
      }
      if (page!.scrollTop > 0 && page!.scrollTop + page!.clientHeight >= page!.scrollHeight - 2) {
        current = targets.at(-1);
      }
      if (current?.dataset.activitySection !== undefined) setActiveSection(current.dataset.activitySection);
    }
    updateActiveSection();
    page.addEventListener('scroll', updateActiveSection, { passive: true });
    window.addEventListener('resize', updateActiveSection);
    return () => {
      page.removeEventListener('scroll', updateActiveSection);
      window.removeEventListener('resize', updateActiveSection);
    };
  }, [sectionKey]);

  function navigateToSection(id: string) {
    const page = pageRef.current;
    const target = page?.querySelector<HTMLElement>(`#activity-${id}`);
    if (page === null || target === undefined || target === null) return;
    const top = target.getBoundingClientRect().top - page.getBoundingClientRect().top
      + page.scrollTop - (navigationRef.current?.offsetHeight ?? 0) - 16;
    page.scrollTo({ top: Math.max(0, top) });
    target.focus({ preventScroll: true });
    setActiveSection(id);
  }
  return { pageRef, navigationRef, activeSection, navigateToSection };
}

export function ActivityPage(props: ActivityRuntimeProps & {
  route: ActivityRoute;
  statistics?: EnterpriseActivityStatisticsResponse;
  statisticsLoading: boolean;
  statisticsError?: string;
  detail?: EnterpriseActivityDetailResponse;
  personalTokenRank?: PersonalTokenRank;
  detailLoading: boolean;
  detailError?: string;
  onRetryStatistics(): void;
  onRetryDetail(): void;
  onBack(): void;
  onNavigate(route: AppRoute): void;
  billingEnabled?: boolean;
  billingOverview?: EnterpriseBillingOverviewResponse;
  billingLoading?: boolean;
  billingError?: string;
  rechargePending?: boolean;
  rechargeError?: string;
  onRetryBilling?(): void;
  onRecharge?(): void;
  conversationRuntime?: WorkbenchConversationRuntime;
  onConversationCreated?(thread: ThreadResponse): void;
}) {
  const [conversationThreads, setConversationThreads] = useState<Record<string, string>>({});
  const agentRoute = props.route.view === 'activity-agent' ? props.route : undefined;
  const workspace = props.route.view === 'activity'
    ? <ActivityOverview {...props} route={props.route} />
    : <AgentDetail key={JSON.stringify([props.route.collectorId, props.route.agentId])} {...props} route={props.route} />;
  if (props.conversationRuntime === undefined) return workspace;
  const context = agentRoute === undefined
    ? buildActivityModuleContext({ range: props.route.range, statistics: props.statistics,
      loading: props.statisticsLoading, error: props.statisticsError,
      runtime: props.runtime, runtimeError: props.runtimeError })
    : buildActivityAgentModuleContext({ ...agentRoute, detail: props.detail,
      personalTokenRank: props.personalTokenRank, loading: props.detailLoading, error: props.detailError });
  const conversationKey = JSON.stringify([props.conversationRuntime.connection?.baseUrl,
    props.conversationRuntime.subjectId, props.conversationRuntime.project?.id, context.scopeKey]);
  return <WorkbenchModuleLayout onBack={agentRoute === undefined ? props.onBack
    : () => props.onNavigate({ view: 'activity', range: agentRoute.range })} workspace={workspace}
    conversation={<WorkbenchConversationPanel key={conversationKey} runtime={props.conversationRuntime}
      context={context} threadId={conversationThreads[conversationKey]}
      emptyPrompt={agentRoute === undefined ? '例如：分析本周 Token 用量趋势，哪些 Agent 最活跃？'
        : '例如：分析这个 Agent 的使用情况，最近主要完成了哪些工作？'}
      onThreadCreated={thread => {
        setConversationThreads(previous => ({ ...previous, [conversationKey]: thread.id }));
        props.onConversationCreated?.(thread);
      }} />} />;
}

function ActivityOverview(props: ActivityRuntimeProps & {
  route: Extract<ActivityRoute, { view: 'activity' }>;
  statistics?: EnterpriseActivityStatisticsResponse;
  statisticsLoading: boolean;
  statisticsError?: string;
  onRetryStatistics(): void;
  onBack(): void;
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
  const statisticsReady = statistics !== undefined && !props.statisticsLoading && props.statisticsError === undefined;
  const sections = [
    ...(props.billingEnabled === true ? [{ id: 'billing', label: '概览' }] : []),
    { id: 'runtime', label: '运行状态' },
    ...(statisticsReady ? [
      { id: 'tokens', label: 'Token 用量' },
      { id: 'tools', label: '模型用量' },
      { id: 'skills', label: 'MCP 与 Skill' },
      { id: 'agents', label: 'Agent 列表' }
    ] : [])
  ];

  const { pageRef, navigationRef, activeSection, navigateToSection } = useActivitySectionNavigation(
    sections.map(section => section.id).join(':')
  );
  const runtimeAgents = new Map(props.runtime?.agents.map(agent => [
    JSON.stringify([agent.collectorId, agent.agentId]), agent
  ]));
  const filteredAgents = (statistics?.agents ?? []).filter(agent => (
    `${agent.name}${agent.status}${agent.collectorId}${agent.agentId}${agent.employeeId ?? ''}${agent.employeeName ?? ''}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  ));

  return (
    <main className="activity-page" ref={pageRef}>
      <div className="activity-page__inner">
        <header className="activity-header">
          <div className="activity-header__heading">
            <button
              className="activity-icon-button"
              type="button"
              aria-label="返回工作台"
              title="返回工作台"
              onClick={props.onBack}
            >
              <ArrowLeft size={18} aria-hidden="true" />
            </button>
            <div>
              <h1>Agent动态</h1>
              <p>
                {statistics === undefined
                  ? '团队 Agent 用量与执行概览'
                  : `${statistics.startDate} 至 ${statistics.endDate} · ${statistics.timezone}`}
              </p>
            </div>
          </div>
          <RangeControl
            range={props.route.range}
            onChange={range => props.onNavigate({ view: 'activity', range })}
          />
        </header>

        <nav className="activity-section-nav" aria-label="Agent 动态分区" ref={navigationRef}>
          {sections.map(section => <a key={section.id} href={`#activity-${section.id}`}
            aria-current={activeSection === section.id ? 'location' : undefined}
            onClick={event => { event.preventDefault(); navigateToSection(section.id); }}>
            {section.label}
          </a>)}
        </nav>

        {props.billingEnabled === true ? (
          <div id="activity-billing" data-activity-section="billing" tabIndex={-1}>
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
          </div>
        ) : null}

        <div id="activity-runtime" data-activity-section="runtime" tabIndex={-1}>
          <RuntimeStatusPanel {...props} />
        </div>

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
            {statistics.range === '7d' && statistics.organization.platformActivity !== undefined ? (
              <PlatformActivityCard activity={statistics.organization.platformActivity} />
            ) : null}
            <div id="activity-tokens" className="activity-content" data-activity-section="tokens" tabIndex={-1}>
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
            </div>

            <div id="activity-tools" data-activity-section="tools" tabIndex={-1}>
              <ModelDistribution statistics={statistics} />
            </div>

            <div id="activity-skills" className="activity-usage-grid" data-activity-section="skills" tabIndex={-1}>
              <UsageDistribution
                title="MCP 使用分布"
                items={statistics.organization.mcpDistribution.map(item => ({
                  id: item.id,
                  label: item.label,
                  countLabel: `${formatNumber(item.invocationCount)} 次`,
                  share: item.share
                }))}
              />
              <SkillUsagePanel organization={statistics.organization} />
            </div>

            <section id="activity-agents" className="activity-section" data-activity-section="agents" tabIndex={-1}>
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
                    placeholder="搜索 Agent、员工或标识"
                  />
                </label>
              </div>
              {filteredAgents.length === 0 ? (
                <EmptySection label="当前范围没有匹配的 Agent" />
              ) : (
                <div className="activity-table-wrap activity-agent-table">
                  <table aria-label="Agent 列表">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>{props.runtime === undefined ? '最近状态' : '当前状态'}</th>
                        {props.runtime === undefined ? null : <th>当前任务</th>}
                        <th>会话</th>
                        <th>轮次</th>
                        <th>最近活动</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAgents.map(agent => {
                        const current = runtimeAgents.get(JSON.stringify([agent.collectorId, agent.agentId]));
                        const status = props.runtime === undefined ? agent.status : current?.status;
                        return (
                        <tr key={JSON.stringify([agent.collectorId, agent.agentId])}>
                          <td>
                            <strong>{agent.name}</strong>
                          </td>
                          <td><ActivityStatus status={status} /></td>
                          {props.runtime === undefined ? null : <td className="activity-current-task" title={current?.currentTask}>
                            {current?.currentTask || (current === undefined ? '状态未同步' : '暂无进行中任务')}
                          </td>}
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
                      ); })}
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

function RuntimeStatusPanel(props: ActivityRuntimeProps) {
  const summary = props.runtime?.summary;
  return <section className="activity-section activity-runtime" aria-label="实时运行状态">
    <div className="activity-section__header">
      <div><h2>实时运行状态</h2><span>团队当前状态 · 每 15 秒刷新</span></div>
      {props.onRetryRuntime === undefined ? null : <button type="button"
        className="activity-icon-button" aria-label="刷新运行状态" disabled={props.runtimeLoading}
        onClick={props.onRetryRuntime}>
        <RefreshCw size={15} className={props.runtimeLoading ? 'activity-spin' : undefined} aria-hidden="true" />
      </button>}
    </div>
    {props.runtimeError !== undefined ? <p className="activity-runtime-notice" role="status">{props.runtimeError}</p>
      : summary === undefined ? <p className="activity-runtime-notice" role="status">
        {props.runtimeLoading ? '正在同步运行状态' : '暂无运行状态快照'}</p>
      : <>
        <dl className="activity-inline-metrics">{([
          ['在线 Agent', summary.onlineAgents], ['执行中', summary.workingAgents],
          ['阻塞', summary.blockedAgents], ['异常', summary.errorAgents]
        ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatNumber(value)}</dd></div>)}</dl>
        <p className="activity-runtime-notice">共 {formatNumber(summary.totalAgents)} 个 Agent · 更新于 {formatDateTime(props.runtime?.serverTime)} · 不随统计周期变化</p>
      </>}
  </section>;
}

function SkillUsagePanel(props: { organization: Pick<EnterpriseActivityStatisticsResponse['organization'], 'skillUsage' | 'skillUsageTotals'> }) {
  const usage = props.organization.skillUsage;
  const totals = props.organization.skillUsageTotals;
  const items = [...(usage ?? [])].sort((left, right) => right.observedRuns - left.observedRuns
    || right.requestedRuns - left.requestedRuns || left.skillName.localeCompare(right.skillName));
  return <section className="activity-section activity-skills" aria-label="Skill 使用情况">
    <div className="activity-section__header"><div><h2>Skill 使用情况</h2><span>当前统计周期</span></div></div>
    {totals === undefined ? null : <dl className="activity-inline-metrics">{([
      ['用户指定', totals.requestedSkillRuns], ['观察到使用', totals.observedSkillRuns],
      ['指定后使用', totals.explicitSkillRuns], ['自动使用', totals.implicitSkillRuns]
    ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatNumber(value)}</dd></div>)}</dl>}
    {usage === undefined ? <EmptySection label="当前网关尚未提供 Skill 使用统计" compact />
      : items.length === 0 ? <EmptySection label="当前周期暂无 Skill 使用记录" compact />
      : <div className="activity-table-wrap activity-skill-table"><table aria-label="Skill 使用排行">
        <thead><tr><th>Skill</th><th>来源</th><th>用户指定</th><th>观察到使用</th><th>自动使用</th></tr></thead>
        <tbody>{items.map(item => <tr key={JSON.stringify([item.source, item.skillKey, item.skillId])}>
          <td><strong title={item.skillName || item.skillKey || item.skillId || undefined}>{item.skillName || item.skillKey || item.skillId || '未命名 Skill'}</strong></td>
          <td>{item.source === 'enterprise' ? '企业' : item.source === 'local' ? '本地' : '未知来源'}</td>
          <td>{formatNumber(item.requestedRuns)}</td><td>{formatNumber(item.observedRuns)}</td><td>{formatNumber(item.implicitRuns)}</td>
        </tr>)}</tbody>
      </table></div>}
    <p className="activity-runtime-notice">按运行与 Skill 去重；观察到读取或执行不代表任务成功。排行最多展示 100 项。</p>
  </section>;
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
  personalTokenRank?: PersonalTokenRank;
  detailLoading: boolean;
  detailError?: string;
  onRetryDetail(): void;
  onNavigate(route: AppRoute): void;
}) {
  const detail = props.detail;
  const usage = detail?.usage?.range === props.route.range
    && detail.usage.collectorId === props.route.collectorId && detail.usage.agentId === props.route.agentId
    ? detail.usage : undefined;
  const tokenRank = props.personalTokenRank?.range === props.route.range
    && props.personalTokenRank.collectorId === props.route.collectorId
    && props.personalTokenRank.agentId === props.route.agentId ? props.personalTokenRank : undefined;
  const pageRef = useRef<HTMLElement>(null);
  const [selectedTab, setSelectedTab] = useState('personal');
  const tabs = [
    { id: 'personal', label: '概览' },
    { id: 'records', label: '活动详情' }
  ];
  function selectTab(id: string) {
    setSelectedTab(id);
    if (pageRef.current !== null) pageRef.current.scrollTop = 0;
  }
  return (
    <main className="activity-page" ref={pageRef}>
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
                <ActivityStatus status={detail.agent.status} />
              )}
            </div>
            <p>
              {detail?.agent.agentType}
            </p>
          </div>
          <RangeControl
            range={props.route.range}
            onChange={range => props.onNavigate({ ...props.route, range })}
          />
        </header>

        <div className="activity-section-nav" role="tablist" aria-label="Agent 个人详情分区">
          {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab"
            id={`activity-detail-tab-${tab.id}`} aria-selected={selectedTab === tab.id}
            aria-controls={`activity-detail-panel-${tab.id}`} tabIndex={selectedTab === tab.id ? 0 : -1}
            onClick={() => selectTab(tab.id)}
            onKeyDown={event => {
              const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
              if (next === undefined) return;
              event.preventDefault();
              selectTab(tabs[next]!.id);
              const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
              buttons?.[next]?.focus();
            }}>{tab.label}</button>)}
        </div>

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
            {tabs.map(tab => <div key={tab.id} className="activity-content" role="tabpanel"
              id={`activity-detail-panel-${tab.id}`} aria-labelledby={`activity-detail-tab-${tab.id}`}
              hidden={selectedTab !== tab.id} tabIndex={0}>
              {selectedTab !== tab.id ? null : tab.id === 'personal' ? (
                <div className="activity-content">
                  {tokenRank === undefined && usage === undefined ? null : (
                    <div className="activity-personal-summary">
                      {tokenRank === undefined ? null : <section className="activity-personal-rank" aria-label="个人 Token 使用排名">
                        <span>Token 使用排名</span>
                        <p><strong>第 {formatNumber(tokenRank.rank)} 名</strong>
                          <span> / 共 {formatNumber(tokenRank.totalPeople)} 人</span></p>
                      </section>}
                      <span className="activity-personal-period">{usage === undefined
                        ? rangeOptions.find(option => option.value === props.route.range)?.label
                        : usage.startDate === usage.endDate ? usage.startDate : `${usage.startDate} 至 ${usage.endDate}`}</span>
                    </div>
                  )}
                  <MetricGrid className="activity-personal-metrics" metrics={[
                    ['会话总数', usage === undefined ? '—' : formatNumber(usage.sessionCount)],
                    ['交互轮次', usage === undefined ? '—' : formatNumber(usage.turnCount)],
                    ['完成轮次', usage === undefined ? '—' : formatNumber(usage.completedTurns)],
                    ['工具调用', usage === undefined ? '—' : formatNumber(usage.toolCallCount)],
                    ['活跃工作时长', formatDuration(detail.stats.activeWorkMs)]
                  ]} />
                  {usage === undefined ? <section className="activity-panel">
                    <p className="activity-personal-notice" role="status">个人使用统计暂不可用，请重试或升级网关。</p>
                    <button type="button" className="activity-personal-retry" onClick={props.onRetryDetail}>
                      <RefreshCw size={14} aria-hidden="true" />刷新个人统计
                    </button>
                  </section> : <AgentUsageTrend usage={usage} />}
                  <p className="activity-personal-notice">{usage !== undefined && usage.points.length > 0
                    && usage.points.every(point => point.totalTokens !== undefined)
                    ? '当前网关尚未提供按 Agent 归属的模型用量。'
                    : '当前网关尚未提供按 Agent 归属的 Token 和模型用量。'}</p>
                  {usage === undefined ? null : (
                    <div className="activity-usage-grid">
                      <UsageDistribution title="MCP 使用分布"
                        emptyLabel={usage.mcpStatus === 'unlinked' ? '尚未关联可统计的 MCP 身份' : undefined}
                        items={usage.mcpDistribution.map(item => ({ id: item.id, label: item.label,
                          countLabel: `${formatNumber(item.invocationCount)} 次`, share: item.share }))} />
                      <SkillUsagePanel organization={usage} />
                    </div>
                  )}
                </div>
              ) : (
                <ActivitySessions detail={detail} />
              )}
            </div>)}

            <p className="activity-generated-at">
              详情生成于 {formatDateTime(detail.serverTime)}
              {usage === undefined ? null : ` · 个人统计生成于 ${formatDateTime(usage.generatedAt)}`}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function ActivitySessions({ detail }: { detail: EnterpriseActivityDetailResponse }) {
  const sessionIds = new Set(detail.sessions.flatMap(session => session.sessionId === undefined ? [] : [session.sessionId]));
  const unlinkedTurns = detail.turns.filter(turn => turn.sessionId === undefined || !sessionIds.has(turn.sessionId));
  return <section className="activity-sessions" aria-label="会话与交互详情">
    <div className="activity-section__header">
      <div><h2>会话</h2><span>{detail.sessions.length} 个 · 已上报 {detail.turns.length} 轮交互</span></div>
    </div>
    {detail.sessions.length === 0 && unlinkedTurns.length === 0 ? <EmptySection label="暂无会话" compact /> : <>
      {detail.sessions.map((session, index) => <SessionActivity key={session.sessionId ?? `session-${index}`}
        session={session} defaultOpen={index === 0}
        turns={session.sessionId === undefined ? [] : detail.turns.filter(turn => turn.sessionId === session.sessionId)} />)}
      {unlinkedTurns.length === 0 ? null : <SessionActivity turns={unlinkedTurns} defaultOpen={detail.sessions.length === 0} />}
    </>}
  </section>;
}

function SessionActivity(props: {
  session?: EnterpriseActivityDetailResponse['sessions'][number];
  turns: EnterpriseActivityDetailResponse['turns'];
  defaultOpen: boolean;
}) {
  const session = props.session;
  const title = session === undefined ? '未关联会话' : session.title ?? '未命名会话';
  return <details className="activity-session" open={props.defaultOpen} aria-label={title}>
    <summary>
      <ChevronRight size={16} aria-hidden="true" />
      <div className="activity-session__heading">
        <h3>{title}</h3>
        {session === undefined ? <span>这些交互暂未匹配到会话</span> : <span className="activity-session__meta">
          <ActivityStatus status={session.status} />
          <span>{[formatDateTime(session.startedAt), formatDuration(session.durationMs)].filter(Boolean).join(' · ')}</span>
        </span>}
      </div>
      <span className="activity-session__count">{props.turns.length} 轮交互</span>
    </summary>
    <div className="activity-session__body">
      {session?.summary === undefined ? null : <p className="activity-session__summary">{session.summary}</p>}
      {session?.workspaceName === undefined ? null : <p className="activity-session__workspace">{session.workspaceName}</p>}
      {props.turns.length === 0 ? <p className="activity-session__empty">当前会话暂无已上报的交互轮次</p> : (
        <ol className="activity-session-turns" aria-label={`${title}的交互轮次`}>
          {props.turns.map((turn, index) => <li key={turn.turnId ?? `turn-${index}`}>
            <div className="activity-session-turns__heading">
              <h4>{turn.title ?? '交互轮次'}</h4>
              <span className="activity-session__meta">
                <ActivityStatus status={turn.status} />
                <span>{[turn.model, formatDateTime(turn.startedAt)].filter(Boolean).join(' · ')}</span>
              </span>
            </div>
            {turn.prompt === undefined ? null : <p>提示：{turn.prompt}</p>}
            {turn.assistantSummary === undefined ? null : <p>回答：{turn.assistantSummary}</p>}
          </li>)}
        </ol>
      )}
    </div>
  </details>;
}

function AgentUsageTrend({ usage }: { usage: EnterpriseActivityAgentUsage }) {
  const [metric, setMetric] = useState<'totalTokens' | 'turnCount' | 'toolCallCount' | 'sessionCount'>('totalTokens');
  const options = [
    { id: 'totalTokens', label: 'Token 消耗' },
    { id: 'turnCount', label: '交互轮次' },
    { id: 'toolCallCount', label: '工具调用' },
    { id: 'sessionCount', label: '会话' }
  ] as const;
  const label = options.find(option => option.id === metric)!.label;
  const unit = metric === 'totalTokens' ? 'Token' : '次';
  const unavailable = metric === 'totalTokens' && (usage.points.length === 0 || usage.points.some(point => point.totalTokens === undefined));
  const max = Math.max(...usage.points.map(point => point[metric] ?? 0), 1);
  return <section className="activity-panel" aria-label="个人执行趋势">
    <div className="activity-panel__heading activity-personal-trend-heading">
      <div><h2>执行趋势</h2><span>{usage.granularity === 'hour' ? '按小时' : '按天'}</span></div>
      <div className="activity-segmented" role="group" aria-label="执行趋势指标">
        {options.map(option => <button type="button" key={option.id} aria-pressed={metric === option.id}
          onClick={() => setMetric(option.id)}>{option.label}</button>)}
      </div>
    </div>
    {unavailable ? <EmptySection label="当前网关尚未提供此 Agent 的 Token 消耗数据" compact />
      : usage.points.every(point => point[metric] === 0) ? <EmptySection label={`当前周期暂无${label}`} compact /> : <>
      <div className="activity-trend activity-personal-trend" aria-label={`${label}趋势`} data-granularity={usage.granularity}>
        {usage.points.map(point => <i key={point.bucketStart} role="img"
          aria-label={`${formatTrendTime(point.bucketStart, usage.granularity, usage.timezone)} ${formatNumber(point[metric]!)} ${unit}`}
          title={`${formatTrendTime(point.bucketStart, usage.granularity, usage.timezone)} · ${formatNumber(point[metric]!)} ${unit}`}
          style={{ height: `${point[metric] === 0 ? 0 : Math.max(4, point[metric]! / max * 100)}%` }} />)}
      </div>
      <div className="activity-chart-labels">
        <span>{formatTrendTime(usage.points[0]!.bucketStart, usage.granularity, usage.timezone)}</span>
        <span>{formatTrendTime(usage.points.at(-1)!.bucketStart, usage.granularity, usage.timezone)}</span>
      </div>
    </>}
    <p className="activity-personal-notice">{metric === 'totalTokens' ? '按所选周期汇总 Token 消耗；仅包含已上报的数据。'
      : '会话、轮次和工具调用按开始时间统计，完成轮次按结束时间统计；仅包含已上报的数据。'}</p>
  </section>;
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

function MetricGrid(props: { metrics: Array<[string, string]>; className?: string }) {
  return (
    <div className={`activity-metrics${props.className === undefined ? '' : ` ${props.className}`}`}>
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

function PlatformActivityCard(props: {
  activity: NonNullable<EnterpriseActivityStatisticsResponse['organization']['platformActivity']>;
}) {
  const totalUsers = props.activity.totalUsers;
  return (
    <section className="activity-panel activity-platform-activity" aria-label="平台活跃度">
      <div className="activity-panel__heading">
        <h2>平台活跃度</h2>
        <span>近 7 天每天至少一次有效会话</span>
      </div>
      <div className="activity-platform-activity__summary">
        <strong>{totalUsers === 0 ? '暂无' : formatPercent(props.activity.rate)}</strong>
        <span>{formatNumber(props.activity.activeUsers)} / {formatNumber(totalUsers)} 名用户</span>
      </div>
      <p className="activity-platform-activity__notice">连续 7 天活跃用户 / 平台有效用户</p>
    </section>
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
  emptyLabel?: string;
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
        <EmptySection label={props.emptyLabel ?? `当前范围暂无${props.title}`} compact />
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
  granularity: 'hour' | 'day',
  timeZone?: string
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    ...(granularity === 'hour'
      ? { hour: '2-digit', minute: '2-digit', hour12: false } as const
      : { month: '2-digit', day: '2-digit' } as const),
    ...(timeZone === undefined ? {} : { timeZone })
  }).format(date);
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return '';
  if (value < 1_000) return `${value} 毫秒`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} 秒`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

const activityStatusTones: Record<string, string> = {
  online: 'positive', completed: 'neutral', succeeded: 'neutral', success: 'neutral',
  active: 'running', thinking: 'running', searching: 'running', working: 'running',
  coding: 'running', reading_files: 'running', running_commands: 'running', organizing_data: 'running',
  summarizing: 'running', calling_business_system: 'running', tool_running: 'running',
  subagent_running: 'running', sub_agent_running: 'running', running: 'running',
  waiting_user: 'waiting', waiting_approval: 'waiting', blocked: 'waiting', pending: 'waiting',
  error: 'negative', failed: 'negative'
};

function ActivityStatus({ status }: { status?: string }) {
  const value = status?.toLowerCase() ?? 'unknown';
  return <span className="activity-status" data-status={value} data-tone={activityStatusTones[value] ?? 'neutral'}>
    {formatStatus(status)}
  </span>;
}

function formatStatus(value: string | undefined): string {
  if (value === undefined || value.length === 0) return '未知';
  const labels: Record<string, string> = {
    online: '在线',
    offline: '离线',
    active: '活跃',
    idle: '空闲',
    thinking: '思考中',
    searching: '搜索中',
    working: '执行中',
    coding: '编写代码',
    reading_files: '读取文件',
    running_commands: '执行命令',
    organizing_data: '整理数据',
    summarizing: '汇总中',
    calling_business_system: '调用业务系统',
    waiting_user: '等待用户',
    tool_running: '调用工具',
    subagent_running: '子 Agent 执行中',
    sub_agent_running: '子 Agent 执行中',
    waiting_approval: '等待审批',
    blocked: '阻塞',
    error: '异常',
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
