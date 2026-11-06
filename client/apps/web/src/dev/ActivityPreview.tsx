// Standalone Vite development entry; not imported by the application or production build.
import type { EnterpriseActivityAgentUsage, EnterpriseActivityDetailResponse, EnterpriseActivityRange } from '@clawee/protocol';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityPage } from '../features/activity/ActivityPage.js';
import type { TimelineItem } from '../components/timeline/timeline-model.js';
import { WorkbenchModuleLayout } from '../features/dashboard/WorkbenchModuleLayout.js';
import { WorkbenchConversationView } from '../features/dashboard/WorkbenchConversationPanel.js';
import { useWorkbenchConversation } from '../features/dashboard/use-workbench-conversation.js';
import { buildActivityAgentModuleContext, type WorkbenchModuleContext } from '../features/dashboard/workbench-module-context.js';
import { applyColorMode, readColorModePreference } from '../styles/color-mode.js';
import '@fontsource-variable/noto-sans-sc/wght.css';
import '../styles/app.css';
import './activity-preview.css';

const collectorId = 'mock-collector';
const agentId = 'mock-research-agent';
const generatedAt = '2026-10-29T08:00:00Z';

function createDetail(range: EnterpriseActivityRange): EnterpriseActivityDetailResponse {
  const count = range === 'today' ? 24 : range === '7d' ? 7 : 30;
  const end = Date.parse('2026-10-29T00:00:00+08:00');
  const interval = range === 'today' ? 3_600_000 : 86_400_000;
  const start = end - (range === 'today' ? 0 : count - 1) * interval;
  const points = Array.from({ length: count }, (_, index) => {
    const turnCount = [12, 25, 18, 36, 22, 41, 29][index % 7]!;
    return {
      bucketStart: new Date(start + index * interval).toISOString(),
      sessionCount: 2 + index % 5,
      turnCount,
      completedTurns: turnCount - 2,
      toolCallCount: turnCount * 3 + index % 4,
      totalTokens: [186_200, 224_800, 172_400, 318_600, 261_900, 407_300, 299_500][index % 7]!
    };
  });
  const sum = (key: 'sessionCount' | 'turnCount' | 'completedTurns' | 'toolCallCount') =>
    points.reduce((total, point) => total + point[key], 0);
  const usage: EnterpriseActivityAgentUsage = {
    collectorId, agentId, range, timezone: 'Asia/Shanghai',
    startDate: new Date(start + 8 * 3_600_000).toISOString().slice(0, 10),
    endDate: '2026-10-29', generatedAt,
    sessionCount: sum('sessionCount'), turnCount: sum('turnCount'),
    completedTurns: sum('completedTurns'), toolCallCount: sum('toolCallCount'),
    granularity: range === 'today' ? 'hour' : 'day', points,
    mcpStatus: 'available',
    mcpDistribution: [
      { id: 'search', label: '网页搜索', invocationCount: 96, share: 0.48 },
      { id: 'dingtalk', label: '钉钉文档', invocationCount: 54, share: 0.27 },
      { id: 'github', label: 'GitHub', invocationCount: 32, share: 0.16 },
      { id: 'files', label: '企业文件', invocationCount: 18, share: 0.09 }
    ],
    skillUsage: [
      { skillId: 'research', skillKey: 'research', skillName: '行业调研', source: 'enterprise', requestedRuns: 24, observedRuns: 28, implicitRuns: 10 },
      { skillId: 'report', skillKey: 'report', skillName: '周报整理', source: 'enterprise', requestedRuns: 12, observedRuns: 15, implicitRuns: 5 },
      { skillId: 'review', skillKey: 'review', skillName: '代码审查', source: 'local', requestedRuns: 8, observedRuns: 11, implicitRuns: 6 },
      { skillId: 'bilibili', skillKey: 'bilibili', skillName: 'Bilibili 数据洞察', source: 'enterprise', requestedRuns: 6, observedRuns: 9, implicitRuns: 4 }
    ],
    skillUsageTotals: { requestedSkillRuns: 50, observedSkillRuns: 63, explicitSkillRuns: 38, implicitSkillRuns: 25 }
  };
  return {
    schemaVersion: 'office.v1', serverTime: generatedAt,
    agent: {
      collectorId, agentId, displayName: '研究助理', agentType: 'codex',
      workspaceName: '产品研发', status: 'online', activeSubAgentCount: 1,
      totalSubAgentCount: 3, recentToolCalls: 6, lastSeenAt: generatedAt
    },
    usage,
    sessions: [
      { sessionId: 'mock-session-1', title: 'AI 产品竞品调研', status: 'active', summary: '对比同类产品的功能、定价与近期更新，整理产品机会。', workspaceName: '产品研发', startedAt: '2026-10-29T06:00:00Z', durationMs: 7_200_000 },
      { sessionId: 'mock-session-2', title: 'Bilibili 内容表现分析', status: 'completed', summary: '汇总近一周视频播放、互动和涨粉趋势。', workspaceName: '内容运营', startedAt: '2026-10-29T03:00:00Z', durationMs: 2_700_000 },
      { sessionId: 'mock-session-3', title: '本周研发进展周报', status: 'completed', summary: '收集已完成事项与风险，生成周报草稿。', workspaceName: '产品研发', startedAt: '2026-10-29T01:30:00Z', durationMs: 1_200_000 }
    ],
    turns: [
      { turnId: 'mock-turn-1', sessionId: 'mock-session-1', title: '整理竞品更新', status: 'completed', prompt: '查找同类 AI 工作台最近一周的产品更新，并归纳值得关注的功能。', assistantSummary: '已检索 12 条公开来源，按协作、自动化与企业治理归纳为 3 类。', model: 'gpt-5.6-sol', startedAt: '2026-10-29T07:10:00Z' },
      { turnId: 'mock-turn-2', sessionId: 'mock-session-1', title: '生成对比分析', status: 'active', prompt: '把调研结果整理为功能对比表，并标注信息来源。', model: 'gpt-5.6-sol', startedAt: '2026-10-29T07:45:00Z' },
      { turnId: 'mock-turn-3', sessionId: 'mock-session-2', title: '汇总视频表现', status: 'completed', prompt: '对比本周视频的播放和互动情况，找出表现最好的内容。', assistantSummary: '已整理 8 条视频数据，教程类内容的互动率最高，建议继续更新系列内容。', model: 'gpt-5.6-sol', startedAt: '2026-10-29T03:10:00Z' },
      { turnId: 'mock-turn-4', sessionId: 'mock-session-3', title: '生成研发周报', status: 'completed', prompt: '整理本周完成事项、进行中的工作和下周计划。', assistantSummary: '已汇总 6 项已完成事项和 2 项进行中的工作，生成了周报草稿。', model: 'gpt-5.6-sol', startedAt: '2026-10-29T01:35:00Z' }
    ],
    toolCalls: [
      { toolCallId: 'mock-tool-1', name: '网页搜索', type: 'mcp', status: 'success', occurredAt: '2026-10-29T07:50:00Z', durationMs: 1_800 },
      { toolCallId: 'mock-tool-2', name: '读取钉钉文档', type: 'mcp', status: 'success', occurredAt: '2026-10-29T07:48:00Z', durationMs: 920 },
      { toolCallId: 'mock-tool-3', name: '读取项目文件', type: 'local', status: 'success', occurredAt: '2026-10-29T07:42:00Z', durationMs: 180 },
      { toolCallId: 'mock-tool-4', name: '获取 GitHub 更新', type: 'mcp', status: 'error', occurredAt: '2026-10-29T07:35:00Z', durationMs: 5_000 }
    ],
    subAgents: [
      { subAgentId: 'mock-sub-1', name: '竞品资料检索', status: 'active', completedTurns: 4 },
      { subAgentId: 'mock-sub-2', name: '产品功能对比', status: 'completed', completedTurns: 8 },
      { subAgentId: 'mock-sub-3', name: '数据汇总', status: 'completed', completedTurns: 6 }
    ],
    statusTimeline: [],
    recentActivities: [
      { activityId: 'mock-activity-1', type: 'tool', title: '完成网页资料检索', status: 'completed', occurredAt: '2026-10-29T07:50:00Z' },
      { activityId: 'mock-activity-2', type: 'turn', title: '开始生成竞品功能对比', status: 'active', occurredAt: '2026-10-29T07:45:00Z' },
      { activityId: 'mock-activity-3', type: 'skill', title: '使用「行业调研」Skill', status: 'completed', occurredAt: '2026-10-29T07:30:00Z' },
      { activityId: 'mock-activity-4', type: 'session', title: '完成 Bilibili 内容分析', status: 'completed', occurredAt: '2026-10-29T03:45:00Z' }
    ],
    stats: {
      sessionDurationMs: 11_100_000, activeSubAgents: 1, totalSubAgents: 3,
      recentActivityCount: 4, businessRiskLevel: 'unknown', activeSessions: 1,
      activeWorkMs: 7_200_000, toolTypeVariety: 2, toolCallCount: 46
    }
  };
}

function MockAgentConversation({ context }: { context: WorkbenchModuleContext }) {
  const conversation = useWorkbenchConversation({ context, onThreadCreated() {} });
  const [items, setItems] = useState<TimelineItem[]>([]);
  return <WorkbenchConversationView context={context}
    dataNotice="Mock 对话仅展示交互效果，不调用模型。"
    emptyPrompt="例如：分析这个 Agent 的使用情况，或者查看个人 Token 排名。"
    conversation={{ ...conversation, items, disabledReason: undefined,
      async send(prompt) {
        const detail = JSON.parse(context.workbenchContext!) as EnterpriseActivityDetailResponse;
        const reply = /排名|token/i.test(prompt)
          ? '当前员工的 Token 使用排名为第 3 名，共 28 人参与排名。'
          : `当前周期共记录 ${detail.usage!.sessionCount} 个会话、${detail.usage!.turnCount} 轮交互和 ${detail.usage!.toolCallCount} 次工具调用。最近的工作包括 AI 产品竞品调研、Bilibili 内容分析和研发周报整理。`;
        setItems(previous => [...previous,
          { kind: 'user_message', id: crypto.randomUUID(), text: prompt, source: 'mock' },
          { kind: 'assistant_message', id: crypto.randomUUID(), text: `【Mock 演示回复】${reply}`, source: 'mock' }
        ]);
        return true;
      }
    }} />;
}

function ActivityPreview() {
  const [range, setRange] = useState<EnterpriseActivityRange>('7d');
  const [theme, setTheme] = useState(readColorModePreference);
  const [agentStatus, setAgentStatus] = useState('online');
  const personalTokenRank = { range, collectorId, agentId, rank: 3, totalPeople: 28 };
  const detail = createDetail(range);
  detail.agent.status = agentStatus;
  const context = buildActivityAgentModuleContext({ range, collectorId, agentId, detail, personalTokenRank, loading: false });
  useEffect(() => applyColorMode(theme), [theme]);
  return <div className="activity-preview">
    <div className="activity-preview__toolbar">
      <span>Mock 预览 · 以下均为演示数据</span>
      <div>
        <label>状态 <select aria-label="预览 Agent 状态" value={agentStatus} onChange={event => setAgentStatus(event.target.value)}>
          <option value="online">在线</option><option value="offline">离线</option>
          <option value="working">执行中</option><option value="waiting_approval">等待审批</option>
          <option value="error">异常</option>
        </select></label>
        <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '切换浅色' : '切换深色'}
        </button>
        <a href="/">返回工作台</a>
      </div>
    </div>
    <WorkbenchModuleLayout onBack={() => { window.location.href = '/'; }}
      conversation={<MockAgentConversation context={context} />}
      workspace={<ActivityPage
      route={{ view: 'activity-agent', collectorId, agentId, range }}
      detail={detail} statisticsLoading={false} detailLoading={false}
      personalTokenRank={personalTokenRank}
      onRetryStatistics={() => {}} onRetryDetail={() => {}}
      onBack={() => { window.location.href = '/'; }}
      onNavigate={route => {
        if (route.view === 'activity-agent') setRange(route.range);
        else window.location.href = '/';
      }}
    />} />
  </div>;
}

createRoot(document.getElementById('root')!).render(<ActivityPreview />);
