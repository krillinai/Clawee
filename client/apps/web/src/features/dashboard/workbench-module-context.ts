import { WORKBENCH_CONTEXT_MAX_CHARS, type EnterpriseActivityDetailResponse, type EnterpriseActivityRuntimeResponse, type EnterpriseActivityStatisticsResponse } from '@clawee/protocol';
import type { BilibiliDashboardFilters, BilibiliLoadState } from './BilibiliDashboardDetail.js';

export type WorkbenchModuleContext = {
  moduleId: string;
  title: string;
  scopeKey: string;
  summary: string;
  workbenchContext?: string;
  unavailableReason?: string;
  partial: boolean;
};

const rangeLabels = { today: '今日', '7d': '近 7 天', '30d': '近 30 天' } as const;

export type PersonalTokenRank = {
  range: EnterpriseActivityStatisticsResponse['range'];
  collectorId: string;
  agentId: string;
  rank: number;
  totalPeople: number;
};

export function buildActivityAgentModuleContext(input: {
  range: EnterpriseActivityStatisticsResponse['range'];
  collectorId: string;
  agentId: string;
  detail?: EnterpriseActivityDetailResponse;
  personalTokenRank?: PersonalTokenRank;
  loading: boolean;
  error?: string;
}): WorkbenchModuleContext {
  const detail = input.detail?.agent.collectorId === input.collectorId
    && input.detail.agent.agentId === input.agentId ? input.detail : undefined;
  const base: WorkbenchModuleContext = {
    moduleId: 'activity', title: 'Agent 个人详情',
    scopeKey: JSON.stringify([input.collectorId, input.agentId]),
    summary: `${detail?.agent.displayName ?? '当前 Agent'} · ${rangeLabels[input.range]}`,
    partial: false,
    unavailableReason: input.error ?? 'Agent 详情加载完成后可发送消息。'
  };
  if (input.loading || input.error !== undefined || detail === undefined) return base;
  const usage = detail.usage?.range === input.range
    && detail.usage.collectorId === input.collectorId && detail.usage.agentId === input.agentId
    ? detail.usage : undefined;
  const personalTokenRank = input.personalTokenRank?.range === input.range
    && input.personalTokenRank.collectorId === input.collectorId && input.personalTokenRank.agentId === input.agentId
    ? input.personalTokenRank : undefined;
  const workbenchContext = JSON.stringify({
    moduleId: base.moduleId, moduleTitle: base.title, mode: 'read-only', scope: 'agent',
    range: input.range, ...detail, usage, personalTokenRank,
    usageUnavailable: usage === undefined,
    historyNotice: '执行记录为最近上报的明细，不代表所选周期的完整统计。'
  });
  return {
    ...base, partial: usage === undefined,
    workbenchContext: workbenchContext.length <= WORKBENCH_CONTEXT_MAX_CHARS ? workbenchContext : undefined,
    unavailableReason: workbenchContext.length <= WORKBENCH_CONTEXT_MAX_CHARS ? undefined : '详情数据超过单轮上下文限制，暂时无法发送。'
  };
}

export function buildActivityModuleContext(input: {
  range: EnterpriseActivityStatisticsResponse['range'];
  statistics?: EnterpriseActivityStatisticsResponse;
  runtime?: EnterpriseActivityRuntimeResponse;
  runtimeError?: string;
  loading: boolean;
  error?: string;
}): WorkbenchModuleContext {
  const base: WorkbenchModuleContext = {
    moduleId: 'activity', title: 'Agent动态', scopeKey: 'organization',
    summary: `团队 Agent · ${rangeLabels[input.range]}`, partial: false,
    unavailableReason: input.error ?? 'Agent 动态数据加载完成后可发送消息。'
  };
  const statistics = input.statistics;
  if (input.loading || input.error !== undefined || statistics?.range !== input.range) return base;
  const workbenchContext = JSON.stringify({
    moduleId: base.moduleId, moduleTitle: base.title, mode: 'read-only', ...statistics,
    runtime: input.runtime,
    ...(input.runtimeError === undefined ? {} : { runtimeUnavailable: input.runtimeError })
  });
  return {
    ...base,
    partial: input.runtimeError !== undefined || Object.values(statistics.dataStatus).some(status => status !== 'available'),
    workbenchContext: workbenchContext.length <= WORKBENCH_CONTEXT_MAX_CHARS ? workbenchContext : undefined,
    unavailableReason: workbenchContext.length <= WORKBENCH_CONTEXT_MAX_CHARS ? undefined : '动态数据超过单轮上下文限制，暂时无法发送。'
  };
}

export function buildBilibiliModuleContext(state: BilibiliLoadState, filters: BilibiliDashboardFilters): WorkbenchModuleContext {
  const base: WorkbenchModuleContext = {
    moduleId: 'bilibili', title: '哔哩哔哩运营', scopeKey: filters.sourceId ?? 'pending',
    summary: rangeLabels[filters.range], partial: false,
    unavailableReason: '当前看板数据尚不可用，加载完成后可发送消息。'
  };
  if (state.status !== 'loaded') return base;
  const dashboard = state.dashboard;
  if (dashboard.range !== filters.range
    || (filters.sourceId !== undefined && dashboard.account?.sourceId !== filters.sourceId)) return base;
  if ((dashboard.status !== 'available' && dashboard.status !== 'partial') || dashboard.data === undefined) return base;
  const workbenchContext = JSON.stringify({
    moduleId: base.moduleId, moduleTitle: base.title, mode: 'read-only',
    account: dashboard.account === undefined ? undefined : { sourceId: dashboard.account.sourceId, name: dashboard.account.name },
    range: dashboard.range, timezone: dashboard.timezone, startDate: dashboard.startDate, endDate: dashboard.endDate,
    status: dashboard.status, lastSyncedAt: dashboard.lastSyncedAt, unavailableParts: dashboard.unavailableParts,
    data: dashboard.data
  });
  return {
    ...base, scopeKey: dashboard.account?.sourceId ?? base.scopeKey,
    summary: `${dashboard.account?.name ?? '当前账号'} · ${rangeLabels[filters.range]}`,
    partial: dashboard.status === 'partial',
    workbenchContext: workbenchContext.length <= WORKBENCH_CONTEXT_MAX_CHARS ? workbenchContext : undefined,
    unavailableReason: workbenchContext.length <= WORKBENCH_CONTEXT_MAX_CHARS ? undefined : '看板数据超过单轮上下文限制，暂时无法发送。'
  };
}
