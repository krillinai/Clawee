import type {
  EnterpriseBillingOverviewResponse,
  EnterpriseRechargeOrderPageResponse
} from '@clawee/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../helpers/build-server.js';
import {
  EnterpriseBillingManagerError,
  type EnterpriseBillingManager
} from '../../src/enterprise/billing-manager-2026-08-28.js';

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('enterprise billing runtime API', () => {
  it('requires runtime authentication and forwards valid requests', async () => {
    const manager = createManager();
    server = await buildServer({ token: 'secret', enterpriseBillingManager: manager });

    expect((await server.inject({
      method: 'GET', url: '/enterprise/billing/overview?range=7d'
    })).statusCode).toBe(401);
    expect(manager.getOverview).not.toHaveBeenCalled();

    expect((await auth('GET', '/enterprise/billing/overview?range=7d')).json())
      .toEqual(overview());
    expect(manager.getOverview).toHaveBeenCalledWith('7d');

    expect((await auth('POST', '/enterprise/billing/recharge-session')).json())
      .toEqual({ rechargeUrl: 'https://billing.example/recharge/token' });
    expect(manager.createRechargeSession).toHaveBeenCalledOnce();

    expect((await auth('GET', '/enterprise/billing/recharge-orders?page=2')).json())
      .toEqual({ items: [], page: 2, total: 0 });
    expect(manager.listRechargeOrders).toHaveBeenCalledWith({ page: 2 });
  });

  it('rejects unknown parameters, bodies, and invalid pages before the manager', async () => {
    const manager = createManager();
    server = await buildServer({ token: 'secret', enterpriseBillingManager: manager });
    const cases: Array<[
      'GET' | 'POST',
      string,
      Record<string, unknown>?
    ]> = [
      ['GET', '/enterprise/billing/overview'],
      ['GET', '/enterprise/billing/overview?range=7d&extra=1'],
      ['POST', '/enterprise/billing/recharge-session?extra=1'],
      ['POST', '/enterprise/billing/recharge-session', {}],
      ['GET', '/enterprise/billing/recharge-orders?page=0'],
      ['GET', '/enterprise/billing/recharge-orders?page=-1'],
      ['GET', '/enterprise/billing/recharge-orders?page=1.5'],
      ['GET', '/enterprise/billing/recharge-orders?page=9007199254740992'],
      ['GET', '/enterprise/billing/recharge-orders?page=1&page_size=20']
    ];
    for (const [method, url, payload] of cases) {
      const response = await auth(method, url, payload);
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'ENTERPRISE_INVALID_REQUEST' }
      });
    }
    expect(manager.getOverview).not.toHaveBeenCalled();
    expect(manager.createRechargeSession).not.toHaveBeenCalled();
    expect(manager.listRechargeOrders).not.toHaveBeenCalled();
  });

  it('maps known and unknown manager failures without leaking internals', async () => {
    const manager = createManager({
      getOverview: vi.fn(async () => {
        throw new EnterpriseBillingManagerError(
          'ENTERPRISE_BILLING_NOT_MANAGED', 409
        );
      }),
      listRechargeOrders: vi.fn(async () => {
        throw new Error('sensitive upstream body');
      })
    });
    server = await buildServer({ token: 'secret', enterpriseBillingManager: manager });

    const managed = await auth('GET', '/enterprise/billing/overview?range=7d');
    expect(managed.statusCode).toBe(409);
    expect(managed.json()).toMatchObject({
      error: { code: 'ENTERPRISE_BILLING_NOT_MANAGED' }
    });

    const unknown = await auth('GET', '/enterprise/billing/recharge-orders?page=1');
    expect(unknown.statusCode).toBe(500);
    expect(JSON.stringify(unknown.json())).not.toContain('sensitive upstream body');
  });
});

function auth(
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>
) {
  return server!.inject({
    method,
    url,
    headers: { authorization: 'Bearer secret' },
    ...(payload === undefined ? {} : { payload })
  });
}

function createManager(
  overrides: Partial<EnterpriseBillingManager> = {}
): EnterpriseBillingManager {
  return {
    getOverview: vi.fn(async () => overview()),
    createRechargeSession: vi.fn(async () => ({
      rechargeUrl: 'https://billing.example/recharge/token'
    })),
    listRechargeOrders: vi.fn(async ({ page }) => ({ items: [], page, total: 0 })),
    ...overrides
  };
}

function overview(): EnterpriseBillingOverviewResponse {
  return {
    balanceCny: 100,
    generatedAt: '2026-08-28T10:00:00+08:00'
  };
}

const _pageTypeCheck: EnterpriseRechargeOrderPageResponse = {
  items: [], page: 1, total: 0
};
void _pageTypeCheck;
