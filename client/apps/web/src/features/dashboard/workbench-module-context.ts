import { WORKBENCH_CONTEXT_MAX_CHARS } from '@clawee/protocol';
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
