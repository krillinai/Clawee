import { describe, expect, it, vi } from 'vitest';
import {
  createEnterpriseHttpClient
} from '../../src/enterprise/http-client-2026-07-30.js';

const ORIGIN = 'https://enterprise.example';

describe('enterprise Bilibili dashboard HTTP client', () => {
  it('loads and maps the documented Bilibili dashboard response', async () => {
    const fetch = vi.fn(async (
      url: string | URL | Request,
      _init?: RequestInit
    ) => new Response(JSON.stringify(String(url).endsWith('/business-data-sources/bilibili') ? {
      data: { items: [{
        source_id: 'bdsrc/account',
        name: '品牌官方账号',
        status: 'active',
        status_reason: '',
        last_attempt_at: '2026-08-30T01:29:00Z',
        last_success_at: '2026-08-30T01:30:00Z',
        next_sync_at: '2026-08-30T02:30:00Z',
        active_run_status: ''
      }] }
    } : {
      data: {
        status: 'available',
        account: {
          source_id: 'bdsrc/account',
          name: '品牌官方账号',
          status: 'active',
          status_reason: '',
          last_success_at: '2026-08-30T01:30:00Z'
        },
        range: '30d',
        timezone: 'Asia/Shanghai',
        start_date: '2026-08-01',
        end_date: '2026-08-30',
        generated_at: '2026-08-30T01:31:00Z',
        last_synced_at: '2026-08-30T01:30:00Z',
        unavailable_parts: [],
        data: {
          captured_at: '2026-08-30T01:30:00Z',
          follower_count: 128600,
          following_count: 86,
          published_count: 30,
          collected_content_count: 24,
          view_count: 8650000,
          danmaku_count: 12800,
          reply_count: 9600,
          favorite_count: 48000,
          coin_count: 32000,
          share_count: 6400,
          like_count: 208000,
          interaction_count: 316800,
          trend: [{
            date: '2026-08-30',
            follower_count: 128600,
            view_count: 8650000,
            interaction_count: 316800,
            follower_count_delta: 700,
            view_count_delta: 170000,
            interaction_count_delta: 9800
          }],
          top_contents: [{
            source_id: 'bdsrc/account',
            account_name: '品牌官方账号',
            external_content_id: 'BV1test',
            title: '夏日新品开箱',
            published_at: '2026-08-26T03:00:00Z',
            status: '0',
            captured_at: '2026-08-30T01:20:00Z',
            view_count: 680000,
            danmaku_count: 1100,
            reply_count: 800,
            favorite_count: 4200,
            coin_count: 3100,
            share_count: 600,
            like_count: 18800,
            interaction_count: 28600
          }]
        }
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    await expect(client.getBilibiliDashboard!('access-token', {
      range: '30d',
      sourceId: 'bdsrc/account'
    })).resolves.toMatchObject({
      status: 'available',
      account: { sourceId: 'bdsrc/account', name: '品牌官方账号' },
      range: '30d',
      startDate: '2026-08-01',
      endDate: '2026-08-30',
      sources: [{ sourceId: 'bdsrc/account', name: '品牌官方账号' }],
      data: {
        capturedAt: '2026-08-30T01:30:00Z',
        followerCount: 128600,
        followingCount: 86,
        publishedCount: 30,
        collectedContentCount: 24,
        viewCount: 8650000,
        likeCount: 208000,
        interactionCount: 316800,
        trend: [{ viewCountDelta: 170000 }],
        topContents: [{
          sourceId: 'bdsrc/account',
          externalContentId: 'BV1test',
          title: '夏日新品开箱',
          publishedAt: '2026-08-26T03:00:00Z',
          viewCount: 680000,
          likeCount: 18800,
          interactionCount: 28600
        }]
      }
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${ORIGIN}/api/v1/app/business-data-sources/bilibili`
    );
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      `${ORIGIN}/api/v1/app/business-dashboards/bilibili-operation?range=30d&source_id=bdsrc%2Faccount`
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Bearer access-token' }
    });
  });

  it('maps the upstream Bilibili view denial to the shared permission error', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'business_data_view_forbidden',
        message: '无权查看业务数据',
        details: []
      }
    }), { status: 403, headers: { 'content-type': 'application/json' } }));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    await expect(client.getBilibiliDashboard!('access-token')).rejects.toMatchObject({
      code: 'ENTERPRISE_DATA_VIEW_FORBIDDEN',
      statusCode: 403
    });
  });

  it('returns unconfigured without requesting a dashboard when no account exists', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: { items: [] }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    await expect(client.getBilibiliDashboard!('access-token')).resolves.toEqual({
      status: 'unconfigured',
      range: '7d',
      unavailableParts: [],
      sources: []
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a partial dashboard returned by the current Gateway contract', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
      String(url).endsWith('/business-data-sources/bilibili')
        ? { data: { items: [{ source_id: 'bdsrc_1', status: 'active' }] } }
        : {
            data: {
              status: 'partial',
              data: {
                captured_at: '2026-09-04T01:30:00Z',
                follower_count: 10,
                collected_content_count: 1,
                view_count: 20,
                interaction_count: 2,
                top_contents: []
              }
            }
          }
    ), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    const result = await client.getBilibiliDashboard!('access-token');
    expect(result).toMatchObject({
      status: 'partial',
      data: { followerCount: 10 }
    });
    expect(result.data?.followingCount).toBeUndefined();
    expect(result.data?.publishedCount).toBeUndefined();
    expect(result.data?.likeCount).toBeUndefined();
  });
});
