import { describe, expect, it } from 'vitest';
import { createWorkbenchDashboard } from '../../test/workbench-fixtures.js';
import { buildBilibiliModuleContext } from './workbench-module-context.js';

describe('workbench data context', () => {
  it('includes the selected account, period, metrics, trends and content without other account metadata', () => {
    const dashboard = createWorkbenchDashboard();
    dashboard.sources.push({ sourceId: 'other', name: '其他账号', status: 'active', statusReason: '' });
    const context = buildBilibiliModuleContext({ status: 'loaded', dashboard }, { range: '7d', sourceId: 'bdsrc_1' });
    expect(context.summary).toBe('品牌官方账号 · 近 7 天');
    expect(context.unavailableReason).toBeUndefined();
    expect(JSON.parse(context.workbenchContext!)).toMatchObject({
      moduleId: 'bilibili', account: { sourceId: 'bdsrc_1', name: '品牌官方账号' }, range: '7d',
      startDate: '2026-08-24', endDate: '2026-08-30',
      data: { followerCount: 128600, trend: [{ viewCountDelta: 1800 }], topContents: [{ title: '夏日新品开箱' }] }
    });
    expect(context.workbenchContext).not.toContain('其他账号');
  });

  it.each([{ range: '30d' as const, sourceId: 'bdsrc_1' }, { range: '7d' as const, sourceId: 'other' }])(
    'does not reuse a snapshot after the selected period or account changes', filters => {
      const context = buildBilibiliModuleContext({ status: 'loaded', dashboard: createWorkbenchDashboard() }, filters);
      expect(context.workbenchContext).toBeUndefined();
      expect(context.unavailableReason).toBeDefined();
    }
  );

  it('includes missing-data information for partial dashboards', () => {
    const dashboard = createWorkbenchDashboard();
    dashboard.status = 'partial';
    dashboard.unavailableParts = ['历史互动明细'];
    const context = buildBilibiliModuleContext({ status: 'loaded', dashboard }, { range: '7d' });
    expect(context.partial).toBe(true);
    expect(JSON.parse(context.workbenchContext!)).toMatchObject({ status: 'partial', unavailableParts: ['历史互动明细'] });
  });

  it.each(['unconfigured', 'unavailable'] as const)('does not provide data for a %s dashboard', status => {
    const dashboard = { ...createWorkbenchDashboard(), status };
    expect(buildBilibiliModuleContext({ status: 'loaded', dashboard }, { range: '7d' }).workbenchContext).toBeUndefined();
  });

  it('does not silently truncate oversized data', () => {
    const dashboard = createWorkbenchDashboard();
    dashboard.data!.topContents[0]!.title = 'x'.repeat(128000);
    const context = buildBilibiliModuleContext({ status: 'loaded', dashboard }, { range: '7d' });
    expect(context.workbenchContext).toBeUndefined();
    expect(context.unavailableReason).toContain('超过单轮上下文限制');
  });
});
