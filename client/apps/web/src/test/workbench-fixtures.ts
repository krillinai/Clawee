import type { EnterpriseBilibiliDashboardRange, EnterpriseBilibiliDashboardResponse } from '@clawee/protocol';

export function createWorkbenchDashboard(range: EnterpriseBilibiliDashboardRange = '7d', sourceId = 'bdsrc_1'): EnterpriseBilibiliDashboardResponse {
  return {
    status: 'available', account: { sourceId, name: '品牌官方账号', status: 'active', statusReason: '' },
    range, timezone: 'Asia/Shanghai', startDate: '2026-08-24', endDate: '2026-08-30',
    lastSyncedAt: '2026-08-30T01:30:00Z', unavailableParts: [],
    sources: [{ sourceId, name: '品牌官方账号', status: 'active', statusReason: '' }],
    data: {
      capturedAt: '2026-08-30T01:30:00Z', followerCount: 128600, collectedContentCount: 24,
      viewCount: 208000, interactionCount: 10000,
      trend: [{ date: '2026-08-30', followerCount: 128600, viewCount: 208000, interactionCount: 10000,
        followerCountDelta: 120, viewCountDelta: 1800, interactionCountDelta: 100 }],
      topContents: [{ sourceId, accountName: '品牌官方账号', externalContentId: 'BV1test', title: '夏日新品开箱',
        status: 'available', capturedAt: '2026-08-30T01:30:00Z', viewCount: 96000, interactionCount: 4800 }]
    }
  };
}
