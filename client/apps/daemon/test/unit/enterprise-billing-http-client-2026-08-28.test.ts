import { describe, expect, it, vi } from 'vitest';
import {
  createEnterpriseHttpClient,
  EnterpriseHttpError
} from '../../src/enterprise/http-client-2026-07-30.js';

const ORIGIN = 'https://enterprise.example';
const TOKEN = 'enterprise-access-token';

describe('enterprise billing HTTP client', () => {
  it('maps overview and sends only the range and bearer token', async () => {
    const fetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => jsonResponse({
      error: 0,
      data: {
        currency: 'CNY',
        balance_cny: 100,
        generated_at: '2026-08-28T10:00:00+08:00',
        internal_account_id: 'must-not-escape'
      }
    }));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    await expect(client.getBillingOverview!(TOKEN, '7d')).resolves.toEqual({
      balanceCny: 100,
      generatedAt: '2026-08-28T10:00:00+08:00'
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${ORIGIN}/api/v1/app/billing/overview?range=7d`
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` }
    });
  });

  it.each([
    { currency: 'USD', balance_cny: 1 },
    { currency: 'CNY', balance_cny: -1 }
  ])('rejects invalid overview values %#', async value => {
    const client = createEnterpriseHttpClient({
      origin: ORIGIN,
      fetch: vi.fn(async () => jsonResponse({
        data: {
          currency: value.currency,
          balance_cny: value.balance_cny,
          generated_at: '2026-08-28T10:00:00+08:00'
        }
      }))
    });
    await expect(client.getBillingOverview!(TOKEN, 'today')).rejects
      .toMatchObject({ code: 'ENTERPRISE_PROTOCOL_ERROR', stage: 'decode' });
  });

  it('rejects an overview without a timezone-aware generation time', async () => {
    const client = createEnterpriseHttpClient({
      origin: ORIGIN,
      fetch: vi.fn(async () => jsonResponse({
        data: {
          currency: 'CNY',
          balance_cny: 1,
          generated_at: '2026-08-28 10:00:00'
        }
      }))
    });
    await expect(client.getBillingOverview!(TOKEN, 'today')).rejects
      .toMatchObject({ code: 'ENTERPRISE_PROTOCOL_ERROR' });
  });

  it('creates a fresh HTTPS recharge session without a request body', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const fetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => jsonResponse({
      data: {
        recharge_url: 'https://billing.example/recharge/session-token',
        expires_at: expiresAt,
        session_token: 'must-not-escape'
      }
    }));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    await expect(client.createRechargeSession!(TOKEN)).resolves.toEqual({
      rechargeUrl: 'https://billing.example/recharge/session-token'
    });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      body: undefined,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        'Content-Length': '0'
      }
    });
  });

  it.each([
    'http://billing.example/recharge/token',
    'https://user:password@billing.example/recharge/token'
  ])('rejects unsafe recharge URL %s', async rechargeUrl => {
    const client = createEnterpriseHttpClient({
      origin: ORIGIN,
      fetch: vi.fn(async () => jsonResponse({
        data: {
          recharge_url: rechargeUrl,
          expires_at: new Date(Date.now() + 60_000).toISOString()
        }
      }))
    });
    await expect(client.createRechargeSession!(TOKEN)).rejects
      .toMatchObject({ code: 'ENTERPRISE_PROTOCOL_ERROR' });
  });

  it('rejects expired recharge sessions', async () => {
    const client = createEnterpriseHttpClient({
      origin: ORIGIN,
      fetch: vi.fn(async () => jsonResponse({
        data: {
          recharge_url: 'https://billing.example/recharge/token',
          expires_at: new Date(Date.now() - 60_000).toISOString()
        }
      }))
    });
    await expect(client.createRechargeSession!(TOKEN)).rejects
      .toMatchObject({ code: 'ENTERPRISE_PROTOCOL_ERROR' });
  });

  it('maps all recharge statuses and omits nullable times', async () => {
    const statuses = [
      'pending_payment', 'crediting', 'succeeded', 'credit_failed',
      'cancelled', 'refunding', 'refunded', 'refund_failed'
    ] as const;
    const fetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => jsonResponse({
      data: {
        items: statuses.map((status, index) => ({
          order_no: `PAY-${index}`,
          amount_cents: 10_000,
          currency: 'CNY',
          channel: index % 2 === 0 ? 'alipay' : 'manual',
          status,
          payment_status: status === 'pending_payment' ? 'pending' : 'paid',
          fulfillment_status: status === 'succeeded' ? 'succeeded' : 'pending',
          created_at: '2026-08-28T10:00:00+08:00',
          paid_at: null,
          fulfilled_at: null,
          trade_no: 'must-not-escape'
        })),
        page: 2,
        page_size: 20,
        total: 25
      }
    }));
    const client = createEnterpriseHttpClient({ fetch, origin: ORIGIN });

    const result = await client.listRechargeOrders!(TOKEN, 2);
    expect(result.items.map(item => item.status)).toEqual(statuses);
    expect(result.items[0]).not.toHaveProperty('paidAt');
    expect(result.items[0]).not.toHaveProperty('tradeNo');
    expect(result).toMatchObject({ page: 2, total: 25 });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${ORIGIN}/api/v1/app/billing/recharge-orders?page=2&page_size=20`
    );
  });

  it.each([
    { page: 1, page_size: 10, total: 0, items: [] },
    { page: 2, page_size: 20, total: 0, items: [] },
    { page: 1, page_size: 20, total: -1, items: [] },
    { page: 1, page_size: 20, total: 1, items: [{ order_no: '' }] },
    {
      page: 1,
      page_size: 20,
      total: 1,
      items: [{
        order_no: 'PAY-1',
        amount_cents: 10_000,
        currency: 'CNY',
        channel: 'alipay',
        status: 'unknown',
        payment_status: 'paid',
        fulfillment_status: 'succeeded',
        created_at: '2026-08-28T10:00:00+08:00',
        paid_at: null,
        fulfilled_at: null
      }]
    }
  ])('rejects invalid recharge order page %#', async data => {
    const client = createEnterpriseHttpClient({
      origin: ORIGIN,
      fetch: vi.fn(async () => jsonResponse({ data }))
    });
    await expect(client.listRechargeOrders!(TOKEN, 1)).rejects
      .toMatchObject({ code: 'ENTERPRISE_PROTOCOL_ERROR' });
  });

  it.each([
    [409, 'billing_not_managed', 'ENTERPRISE_BILLING_NOT_MANAGED'],
    [503, 'billing_unavailable', 'ENTERPRISE_BILLING_UNAVAILABLE'],
    [503, 'recharge_unavailable', 'ENTERPRISE_BILLING_UNAVAILABLE'],
    [503, 'recharge_records_unavailable', 'ENTERPRISE_BILLING_UNAVAILABLE'],
    [403, 'data_view_forbidden', 'ENTERPRISE_DATA_VIEW_FORBIDDEN']
  ])('maps billing error %s %s', async (status, upstreamCode, code) => {
    const secretUrl = 'https://billing.example/recharge/private-token';
    const client = createEnterpriseHttpClient({
      origin: ORIGIN,
      fetch: vi.fn(async () => jsonResponse({
        error: { code: upstreamCode, message: secretUrl }
      }, status as number))
    });
    let error: unknown;
    try {
      await client.getBillingOverview!(TOKEN, '7d');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnterpriseHttpError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain(secretUrl);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status
  });
}
