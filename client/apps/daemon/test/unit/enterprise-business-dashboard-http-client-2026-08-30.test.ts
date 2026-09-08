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
      data: { items: [{ source_id: 'bdsrc/account', status: 'active' }] }
    } : {
      data: {
        status: 'available',
        data: {
          captured_at: '2026-08-30T01:30:00Z',
          follower_count: 128600,
          collected_content_count: 24,
          view_count: 8650000,
          interaction_count: 316800,
          top_contents: [{
            external_content_id: 'BV1test',
            title: '夏日新品开箱',
            captured_at: '2026-08-30T01:20:00Z',
            view_count: 680000,
            interaction_count: 28600
          }]
        }
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    await expect(client.getBilibiliDashboard!('access-token')).resolves.toEqual({
      status: 'available',
      data: {
        capturedAt: '2026-08-30T01:30:00Z',
        followerCount: 128600,
        collectedContentCount: 24,
        viewCount: 8650000,
        interactionCount: 316800,
        topContents: [{
          externalContentId: 'BV1test',
          title: '夏日新品开箱',
          capturedAt: '2026-08-30T01:20:00Z',
          viewCount: 680000,
          interactionCount: 28600
        }]
      }
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${ORIGIN}/api/v1/app/business-data-sources/bilibili`
    );
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      `${ORIGIN}/api/v1/app/business-dashboards/bilibili-operation?range=7d&source_id=bdsrc%2Faccount`
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
      status: 'unconfigured'
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

    await expect(client.getBilibiliDashboard!('access-token')).resolves.toMatchObject({
      status: 'partial',
      data: { followerCount: 10 }
    });
  });
});
