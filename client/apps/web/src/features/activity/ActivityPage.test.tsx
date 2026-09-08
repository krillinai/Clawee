import type {
  EnterpriseActivityDetailResponse,
  EnterpriseActivityStatisticsResponse
} from '@clawee/protocol';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ActivityPage } from './ActivityPage.js';

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

function overviewProps() {
  return {
    route: { view: 'activity' as const, range: '7d' as const },
    statistics,
    statisticsLoading: false,
    detailLoading: false,
    onRetryStatistics: vi.fn(),
    onRetryDetail: vi.fn(),
    onNavigate: vi.fn()
  };
}

describe('ActivityPage', () => {
  it('renders only fields supplied by the activity statistics contract', () => {
    render(<ActivityPage {...overviewProps()} />);

    expect(screen.getByRole('heading', { name: 'Agent动态' })).toBeInTheDocument();
    expect(screen.getByTestId('total-tokens')).toHaveTextContent('18,396,247');
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
    expect(screen.getByRole('status')).toHaveTextContent('正在加载 Agent 动态');

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

  it('renders detail while exposing only sanitized Tool metadata', () => {
    render(
      <ActivityPage
        {...overviewProps()}
        route={{
          view: 'activity-agent',
          collectorId: 'collector-shanghai',
          agentId: 'agent-research',
          range: '7d'
        }}
        detail={detail}
      />
    );

    expect(screen.getByRole('heading', { name: '研究助理' })).toBeInTheDocument();
    expect(screen.getByText('会话')).toBeInTheDocument();
    expect(screen.getByText('Turn')).toBeInTheDocument();
    expect(screen.getByText('WebSearch')).toBeInTheDocument();
    expect(screen.getByText('1.8 秒')).toBeInTheDocument();
    expect(screen.getByText('提示：整理本周公开资料')).toBeInTheDocument();
    expect(screen.getByText('回答：已形成摘要')).toBeInTheDocument();
    expect(screen.queryByText(/private customer query/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/raw tool response/i)).not.toBeInTheDocument();
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
