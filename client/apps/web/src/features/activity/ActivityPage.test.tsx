import type {
  EnterpriseActivityDetailResponse,
  EnterpriseActivityAgentUsage,
  EnterpriseActivityRuntimeResponse,
  EnterpriseActivityStatisticsResponse
} from '@clawee/protocol';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ActivityPage } from './ActivityPage.js';
import { buildActivityAgentModuleContext, buildActivityModuleContext } from '../dashboard/workbench-module-context.js';

vi.mock('react-virtuoso', async () => import('../../test/react-virtuoso-mock.js'));

const statistics: EnterpriseActivityStatisticsResponse = {
  range: '7d',
  timezone: 'Asia/Shanghai',
  startDate: '2026-08-12',
  endDate: '2026-08-18',
  generatedAt: '2026-08-18T08:00:00Z',
  organization: {
    usage: {
      inputTokens: 18_279_996,
      cachedInputTokens: 16_894_080,
      outputTokens: 116_251,
      totalTokens: 18_396_247
    },
    activeEmployees: 3,
    activeAgents: 2,
    completedTurns: 42,
    platformActivity: {
      activeUsers: 2,
      totalUsers: 4,
      rate: 0.5
    },
    mcpDistribution: [{
      id: 'filesystem',
      label: 'filesystem',
      invocationCount: 18,
      share: 0.6
    }]
  },
  trend: {
    granularity: 'day',
    points: [{
      bucketStart: '2026-08-12T00:00:00+08:00',
      inputTokens: 1_000,
      cachedInputTokens: 600,
      outputTokens: 200,
      totalTokens: 1_200
    }, {
      bucketStart: '2026-08-18T00:00:00+08:00',
      inputTokens: 2_000,
      cachedInputTokens: 900,
      outputTokens: 300,
      totalTokens: 2_300
    }]
  },
  modelDistribution: [{
    model: 'gpt-5.6-sol',
    requests: 20,
    inputTokens: 1_000,
    cachedInputTokens: 600,
    outputTokens: 200,
    totalTokens: 1_200,
    share: 0.8
  }],
  tokenUsageRanking: [{
    rank: 1,
    name: '研发团队',
    requests: 20,
    totalTokens: 18_396_247
  }],
  agents: [{
    collectorId: 'collector-shanghai',
    agentId: 'agent-research',
    name: '研究助理',
    status: 'online',
    sessionCount: 4,
    turnCount: 12,
    lastActivityAt: '2026-08-18T07:59:00Z'
  }, {
    collectorId: 'collector-beijing',
    agentId: 'agent-customer',
    name: '客户洞察',
    status: 'offline',
    sessionCount: 2,
    turnCount: 5
  }],
  dataStatus: {
    sub2api: 'available',
    activity: 'available'
  }
};

const detail: EnterpriseActivityDetailResponse = {
  schemaVersion: 'office.v1',
  serverTime: '2026-08-18T08:00:00Z',
  agent: {
    collectorId: 'collector-shanghai',
    agentId: 'agent-research',
    displayName: '研究助理',
    agentType: 'clawee',
    workspaceName: '研发项目',
    status: 'online',
    activeSubAgentCount: 1,
    totalSubAgentCount: 2,
    recentToolCalls: 1,
    lastSeenAt: '2026-08-18T07:59:00Z'
  },
  sessions: [{
    sessionId: 'session-1',
    title: '竞品调研',
    status: 'active',
    summary: '整理公开资料',
    workspaceName: '研发项目',
    startedAt: '2026-08-18T07:00:00Z',
    durationMs: 3_600_000
  }],
  turns: [{
    turnId: 'turn-1',
    sessionId: 'session-1',
    title: '资料汇总',
    status: 'completed',
    prompt: '整理本周公开资料',
    assistantSummary: '已形成摘要',
    model: 'gpt-5.6-sol',
    startedAt: '2026-08-18T07:10:00Z'
  }],
  subAgents: [{
    subAgentId: 'sub-1',
    name: '网页检索',
    status: 'completed',
    completedTurns: 3
  }],
  toolCalls: [{
    toolCallId: 'tool-1',
    name: 'WebSearch',
    type: 'mcp',
    status: 'success',
    occurredAt: '2026-08-18T07:20:00Z',
    durationMs: 1_800
  }],
  statusTimeline: [],
  recentActivities: [{
    activityId: 'activity-1',
    type: 'turn',
    title: '完成资料汇总',
    status: 'completed',
    occurredAt: '2026-08-18T07:30:00Z'
  }],
  stats: {
    sessionDurationMs: 3_600_000,
    activeSubAgents: 1,
    totalSubAgents: 2,
    recentActivityCount: 1,
    businessRiskLevel: 'unknown',
    activeSessions: 1,
    activeWorkMs: 180_000,
    toolTypeVariety: 1,
    toolCallCount: 1
  }
};

const personalUsage: EnterpriseActivityAgentUsage = {
  collectorId: 'collector-shanghai', agentId: 'agent-research', range: '7d', timezone: 'Asia/Shanghai',
  startDate: '2026-08-12', endDate: '2026-08-18', generatedAt: '2026-08-18T08:00:00Z',
  sessionCount: 51, turnCount: 123, completedTurns: 120, toolCallCount: 345, granularity: 'day',
  points: [{ bucketStart: '2026-08-18T00:00:00+08:00', sessionCount: 51, turnCount: 123, completedTurns: 120, toolCallCount: 345 }],
  mcpStatus: 'available', mcpDistribution: [{ id: 'search', label: '搜索服务', invocationCount: 77, share: 1 }],
  skillUsage: [{ skillId: 'research', skillKey: 'research', skillName: '调研', source: 'enterprise', requestedRuns: 8, observedRuns: 5, implicitRuns: 2 }],
  skillUsageTotals: { requestedSkillRuns: 8, observedSkillRuns: 5, explicitSkillRuns: 3, implicitSkillRuns: 2 }
};

function overviewProps() {
  return {
    route: { view: 'activity' as const, range: '7d' as const },
    statistics,
    statisticsLoading: false,
    detailLoading: false,
    onRetryStatistics: vi.fn(),
    onRetryDetail: vi.fn(),
    onBack: vi.fn(),
    onNavigate: vi.fn()
  };
}

describe('ActivityPage', () => {
  it('shows Skill evidence separately and filters Agents by employee name', async () => {
    const user = userEvent.setup();
    render(<ActivityPage {...overviewProps()} statistics={{ ...statistics,
      agents: [{ ...statistics.agents[0]!, employeeId: 'employee-1', employeeName: '张三' }, statistics.agents[1]!],
      organization: { ...statistics.organization,
        skillUsage: [{ skillId: 'skill-1', skillKey: 'research', skillName: '调研', source: 'enterprise', requestedRuns: 8, observedRuns: 5, implicitRuns: 2 }],
        skillUsageTotals: { requestedSkillRuns: 8, observedSkillRuns: 5, explicitSkillRuns: 3, implicitSkillRuns: 2 }
      }
    }} />);
    const skills = screen.getByRole('region', { name: 'Skill 使用情况' });
    expect(within(skills).getByText('观察到使用', { selector: 'dt' }).nextElementSibling).toHaveTextContent('5');
    expect(within(skills).getByText('用户指定', { selector: 'dt' }).nextElementSibling).toHaveTextContent('8');
    expect(within(skills).getByText('调研')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: '搜索 Agent' }), '张三');
    const agents = screen.getByRole('table', { name: 'Agent 列表' });
    expect(within(agents).getByText('研究助理')).toBeInTheDocument();
    expect(within(agents).queryByText('客户洞察')).not.toBeInTheDocument();
    expect(within(agents).queryByRole('columnheader', { name: '当前任务' })).not.toBeInTheDocument();
    expect(within(agents).queryByText('状态未同步')).not.toBeInTheDocument();
  });

  it('uses current runtime status instead of the historical status and includes it in analysis', () => {
    const runtime: EnterpriseActivityRuntimeResponse = {
      schemaVersion: 'office.v1', scope: 'organization', serverTime: '2026-10-28T00:00:00Z',
      summary: { totalAgents: 2, onlineAgents: 1, workingAgents: 0, blockedAgents: 1, errorAgents: 0 },
      agents: [{ collectorId: statistics.agents[0]!.collectorId, agentId: statistics.agents[0]!.agentId,
        status: 'blocked', currentTask: '等待确认调研范围', lastSeenAt: '2026-10-28T00:00:00Z' }]
    };
    render(<ActivityPage {...overviewProps()} runtime={runtime} />);
    const agents = screen.getByRole('table', { name: 'Agent 列表' });
    expect(within(agents).getByText('阻塞')).toBeInTheDocument();
    expect(within(agents).getByText('等待确认调研范围')).toBeInTheDocument();
    expect(within(agents).queryByText('在线')).not.toBeInTheDocument();
    expect(screen.getByText('当前网关尚未提供 Skill 使用统计')).toBeInTheDocument();
    expect(within(agents).getByRole('columnheader', { name: '当前任务' })).toBeInTheDocument();
    const context = buildActivityModuleContext({ range: '7d', statistics, loading: false, runtime });
    expect(JSON.parse(context.workbenchContext!).runtime).toEqual(runtime);
  });

  it('shows a side conversation with the selected activity period and mobile view switch', async () => {
    const user = userEvent.setup();
    const props = overviewProps();
    render(<ActivityPage {...props} conversationRuntime={{
      client: null, connection: null, connected: false,
      config: { permission: 'workspace-write', profile: 'default', model: null, reasoning: null }
    }} />);
    const panel = screen.getByRole('complementary', { name: '模块对话' });
    expect(within(panel).getByText('团队 Agent · 近 7 天')).toBeInTheDocument();
    expect(within(panel).getByText('例如：分析本周 Token 用量趋势，哪些 Agent 最活跃？')).toBeInTheDocument();
    expect(within(panel).getByRole('textbox', { name: '输入任务' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^对话$/ }));
    expect(screen.getByRole('button', { name: /^对话$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Agent动态' })).toBeInTheDocument();
  });

  it('includes the current activity snapshot and marks missing sources for analysis', () => {
    const context = buildActivityModuleContext({ range: '7d', statistics, loading: false });
    expect(context.unavailableReason).toBeUndefined();
    expect(JSON.parse(context.workbenchContext!)).toMatchObject({
      moduleId: 'activity', mode: 'read-only', range: '7d',
      organization: statistics.organization, agents: statistics.agents
    });
    const partial = buildActivityModuleContext({ range: '7d', loading: false,
      statistics: { ...statistics, dataStatus: { ...statistics.dataStatus, activity: 'unavailable' } } });
    expect(partial.partial).toBe(true);
    expect(JSON.parse(partial.workbenchContext!).dataStatus.activity).toBe('unavailable');
  });

  it('shows a personal side conversation scoped to the selected Agent and keeps it across tabs', async () => {
    const user = userEvent.setup();
    const route = { view: 'activity-agent' as const, collectorId: detail.agent.collectorId,
      agentId: detail.agent.agentId, range: '7d' as const };
    render(<ActivityPage {...overviewProps()} route={route} detail={{ ...detail, usage: personalUsage }}
      conversationRuntime={{ client: null, connection: null, connected: false,
        config: { permission: 'workspace-write', profile: 'default', model: null, reasoning: null } }} />);
    const panel = screen.getByRole('complementary', { name: '模块对话' });
    expect(within(panel).getByText('研究助理 · 近 7 天')).toBeInTheDocument();
    expect(within(panel).getByRole('textbox', { name: '输入任务' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: '活动详情' }));
    expect(screen.getByRole('complementary', { name: '模块对话' })).toBe(panel);
    const context = buildActivityAgentModuleContext({ ...route, detail: { ...detail, usage: personalUsage }, loading: false });
    expect(JSON.parse(context.workbenchContext!)).toMatchObject({ scope: 'agent', range: '7d', agent: detail.agent });
    expect(context.workbenchContext).not.toContain('研发团队');
    const otherContext = buildActivityAgentModuleContext({ ...route, agentId: 'other-agent', detail, loading: false });
    expect(otherContext.scopeKey).not.toBe(context.scopeKey);
    expect(otherContext.workbenchContext).toBeUndefined();
    const staleUsage = buildActivityAgentModuleContext({ ...route, range: 'today', detail: { ...detail, usage: personalUsage }, loading: false });
    expect(staleUsage.partial).toBe(true);
    expect(JSON.parse(staleUsage.workbenchContext!).usage).toBeUndefined();
  });

  it('does not send stale, failed, loading, or oversized activity data to the model', () => {
    for (const input of [
      { range: 'today' as const, statistics, loading: false },
      { range: '7d' as const, statistics, loading: true },
      { range: '7d' as const, statistics, loading: false, error: '加载失败' },
      { range: '7d' as const, loading: false },
      { range: '7d' as const, loading: false,
        statistics: { ...statistics, agents: [{ ...statistics.agents[0]!, name: 'x'.repeat(128000) }] } }
    ]) {
      const context = buildActivityModuleContext(input);
      expect(context.workbenchContext).toBeUndefined();
      expect(context.unavailableReason).toBeDefined();
    }
  });

  it('returns from the overview to the workbench', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<ActivityPage {...overviewProps()} onBack={onBack} />);

    await user.click(screen.getByRole('button', { name: '返回工作台' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('renders only fields supplied by the activity statistics contract', () => {
    render(<ActivityPage {...overviewProps()} />);

    expect(screen.getByRole('heading', { name: 'Agent动态' })).toBeInTheDocument();
    expect(screen.getByTestId('total-tokens')).toHaveTextContent('18,396,247');
    expect(screen.getByRole('heading', { name: '平台活跃度' })).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('2 / 4 名用户')).toBeInTheDocument();
    expect(screen.getByText('活跃员工')).toBeInTheDocument();
    expect(screen.getByText('模型分布')).toBeInTheDocument();
    expect(screen.getByText('MCP 使用分布')).toBeInTheDocument();
    const ranking = screen.getByRole('table', { name: 'Token 使用排行' });
    expect(within(ranking).getByText('研发团队')).toBeInTheDocument();
    expect(within(ranking).getByText('18,396,247')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Agent 列表' })).toBeInTheDocument();
    expect(screen.queryByText('员工用量')).not.toBeInTheDocument();
    expect(screen.queryByText('Skill 使用分布')).not.toBeInTheDocument();
    expect(screen.queryByText('推理输出')).not.toBeInTheDocument();
    expect(screen.queryByText('对话分析')).not.toBeInTheDocument();
  });

  it('searches Agent rows and navigates with opaque identifiers', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<ActivityPage {...overviewProps()} onNavigate={onNavigate} />);

    await user.type(screen.getByRole('searchbox', { name: '搜索 Agent' }), '研究');
    const table = screen.getByRole('table', { name: 'Agent 列表' });
    expect(within(table).getByText('研究助理')).toBeInTheDocument();
    expect(within(table).queryByText('客户洞察')).not.toBeInTheDocument();

    await user.click(within(table).getByRole('button', { name: '查看 研究助理' }));
    expect(onNavigate).toHaveBeenCalledWith({
      view: 'activity-agent',
      collectorId: 'collector-shanghai',
      agentId: 'agent-research',
      range: '7d'
    });
  });

  it('changes ranges without synthesizing new data', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<ActivityPage {...overviewProps()} onNavigate={onNavigate} />);

    await user.click(screen.getByRole('button', { name: '近 30 天' }));
    expect(onNavigate).toHaveBeenCalledWith({
      view: 'activity',
      range: '30d'
    });
  });

  it('shows recoverable loading and error states', async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ActivityPage
        {...overviewProps()}
        statistics={undefined}
        statisticsLoading
      />
    );
    expect(screen.getByRole('heading', { name: '正在加载 Agent 动态' })).toBeInTheDocument();

    rerender(
      <ActivityPage
        {...overviewProps()}
        statistics={undefined}
        statisticsError="Token 数据源暂不可用，请稍后重试"
        onRetryStatistics={retry}
      />
    );
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('merges turns into their own sessions and removes the Tool detail view', async () => {
    const user = userEvent.setup();
    render(<ActivityPage {...overviewProps()}
      route={{ view: 'activity-agent', collectorId: 'collector-shanghai', agentId: 'agent-research', range: '7d' }}
      detail={{ ...detail,
        sessions: [...detail.sessions, { sessionId: 'session-2', title: '第二会话' }],
        turns: [...detail.turns,
          { turnId: 'turn-2', sessionId: 'session-2', prompt: '只属于第二会话' },
          { turnId: 'orphan', sessionId: 'missing-session', prompt: '尚未关联的交互' }
        ]
      }} />);
    const tabs = screen.getByRole('tablist', { name: 'Agent 个人详情分区' });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(2);
    expect(screen.queryByText('提示：整理本周公开资料')).not.toBeInTheDocument();
    await user.click(within(tabs).getByRole('tab', { name: '活动详情' }));
    expect(screen.getByRole('heading', { name: '会话' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: '活动详情类型' })).not.toBeInTheDocument();
    const firstSession = screen.getByRole('group', { name: '竞品调研' });
    expect(within(firstSession).getByText('提示：整理本周公开资料')).toBeVisible();
    expect(within(firstSession).getByText('回答：已形成摘要')).toBeVisible();
    expect(within(firstSession).queryByText('提示：只属于第二会话')).not.toBeInTheDocument();
    const secondSession = screen.getByRole('group', { name: '第二会话' });
    expect(within(secondSession).getByText('提示：只属于第二会话')).not.toBeVisible();
    await user.click(within(secondSession).getByRole('heading', { name: '第二会话' }));
    expect(within(secondSession).getByText('提示：只属于第二会话')).toBeVisible();
    const unlinked = screen.getByRole('group', { name: '未关联会话' });
    await user.click(within(unlinked).getByRole('heading', { name: '未关联会话' }));
    expect(within(unlinked).getByText('提示：尚未关联的交互')).toBeVisible();
    expect(screen.queryByText('WebSearch')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tool 调用' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '子 Agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '最近活动' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });

  it('shows scoped personal usage totals, trends and MCP/Skill without using organization Token data', async () => {
    const user = userEvent.setup();
    render(<ActivityPage {...overviewProps()}
      route={{ view: 'activity-agent', collectorId: 'collector-shanghai', agentId: 'agent-research', range: '7d' }}
      detail={{ ...detail, usage: personalUsage }} />);
    expect(screen.getByRole('tablist', { name: 'Agent 个人详情分区' })).toBeInTheDocument();
    expect(screen.getByText('123')).toBeInTheDocument();
    expect(screen.getByText('345')).toBeInTheDocument();
    expect(screen.getByText('搜索服务')).toBeInTheDocument();
    expect(screen.getByText('调研')).toBeInTheDocument();
    expect(screen.queryByTestId('total-tokens')).not.toBeInTheDocument();
    expect(screen.getByText('当前网关尚未提供按 Agent 归属的 Token 和模型用量。')).toBeInTheDocument();
    const chart = screen.getByRole('region', { name: '个人执行趋势' });
    expect(within(chart).getByRole('button', { name: 'Token 消耗' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(chart).getByText('当前网关尚未提供此 Agent 的 Token 消耗数据')).toBeInTheDocument();
    expect(within(chart).queryByRole('img')).not.toBeInTheDocument();
    await user.click(within(chart).getByRole('button', { name: '交互轮次' }));
    expect(within(chart).getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('123 次'));
    await user.click(within(chart).getByRole('button', { name: '工具调用' }));
    expect(within(chart).getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('345 次'));
    await user.click(screen.getByRole('tab', { name: '活动详情' }));
    expect(screen.queryByText('搜索服务')).not.toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(screen.getByText('搜索服务')).toBeInTheDocument();
    expect(screen.getByText('调研')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '个人执行趋势' })).toBeInTheDocument();
  });

  it('defaults to personal Token consumption and does not fill gaps with other usage metrics', () => {
    const props = { ...overviewProps(), route: { view: 'activity-agent' as const,
      collectorId: 'collector-shanghai', agentId: 'agent-research', range: '7d' as const } };
    const usage = { ...personalUsage, points: personalUsage.points.map(point => ({ ...point, totalTokens: 76_000 })) };
    const { rerender } = render(<ActivityPage {...props} detail={{ ...detail, usage }} />);
    const chart = screen.getByRole('region', { name: '个人执行趋势' });
    expect(within(chart).getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('76,000 Token'));
    expect(within(chart).getByRole('button', { name: 'Token 消耗' })).toHaveAttribute('aria-pressed', 'true');
    rerender(<ActivityPage {...props} detail={{ ...detail, usage: { ...usage,
      points: [...usage.points, { ...personalUsage.points[0]!, bucketStart: '2026-08-17T00:00:00+08:00' }] } }} />);
    expect(within(chart).queryByRole('img')).not.toBeInTheDocument();
    expect(within(chart).getByText('当前网关尚未提供此 Agent 的 Token 消耗数据')).toBeInTheDocument();
  });

  it('keeps execution history accessible when personal usage is missing or belongs to another range or Agent', async () => {
    const user = userEvent.setup();
    const props = { ...overviewProps(), route: { view: 'activity-agent' as const, collectorId: 'collector-shanghai', agentId: 'agent-research', range: '7d' as const } };
    const { rerender } = render(<ActivityPage {...props} detail={detail} />);
    for (const usage of [undefined, { ...personalUsage, range: 'today' as const }, { ...personalUsage, collectorId: 'other' }]) {
      rerender(<ActivityPage {...props} detail={{ ...detail, ...(usage === undefined ? {} : { usage }) }} />);
      await user.click(screen.getByRole('tab', { name: '概览' }));
      expect(screen.getByText('个人使用统计暂不可用，请重试或升级网关。')).toBeInTheDocument();
      expect(screen.queryByText('345')).not.toBeInTheDocument();
      expect(screen.queryByText('WebSearch')).not.toBeInTheDocument();
      await user.click(screen.getByRole('tab', { name: '活动详情' }));
      expect(screen.getByText('提示：整理本周公开资料')).toBeVisible();
      expect(screen.queryByText('WebSearch')).not.toBeInTheDocument();
    }
  });

  it('renders account billing independently from activity statistics', async () => {
    const onNavigate = vi.fn();
    const onRecharge = vi.fn();
    const user = userEvent.setup();
    render(
      <ActivityPage
        {...overviewProps()}
        statistics={undefined}
        statisticsError="Agent 动态暂不可用"
        billingEnabled
        billingOverview={{
          balanceCny: 100,
          generatedAt: '2026-08-28T10:00:00+08:00'
        }}
        onRecharge={onRecharge}
        onNavigate={onNavigate}
      />
    );

    expect(screen.getByRole('heading', { name: '账户额度' })).toBeInTheDocument();
    expect(screen.getByText('¥100.00')).toBeInTheDocument();
    expect(screen.queryByText('当前区间实际费用')).not.toBeInTheDocument();
    expect(screen.getByText('Agent 动态暂不可用')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '充值' }));
    expect(onRecharge).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '充值记录' }));
    expect(onNavigate).toHaveBeenCalledWith({
      view: 'activity-recharge-records', range: '7d'
    });
  });

  it('does not synthesize zero values when billing is unavailable', async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    render(
      <ActivityPage
        {...overviewProps()}
        billingEnabled
        billingError="账户额度暂不可用"
        onRetryBilling={retry}
      />
    );
    expect(screen.getByText('账户额度暂不可用')).toBeInTheDocument();
    expect(screen.queryByText('¥0.00')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: '重试' })[0]!);
    expect(retry).toHaveBeenCalledOnce();
  });
});
