import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEnterpriseBillingManager
} from '../../src/enterprise/billing-manager-2026-08-28.js';
import type {
  EnterpriseHttpClient
} from '../../src/enterprise/http-client-2026-07-30.js';
import {
  EnterpriseHttpError
} from '../../src/enterprise/http-client-2026-07-30.js';
import type {
  EnterpriseSessionManager
} from '../../src/enterprise/session-manager-2026-07-30.js';
import {
  EnterpriseSessionError
} from '../../src/enterprise/session-manager-2026-07-30.js';

afterEach(() => vi.restoreAllMocks());

describe('enterprise billing manager', () => {
  it('gets the current token for every uncached operation', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const session = sessionManager();
    const getBillingOverview = vi.fn(async () => overview());
    const createRechargeSession = vi.fn(async () => ({
      rechargeUrl: 'https://billing.example/recharge/token'
    }));
    const listRechargeOrders = vi.fn(async (_token: string, page: number) => ({
      items: [], page, total: 0
    }));
    const manager = createEnterpriseBillingManager({
      sessionManager: session,
      httpClient: {
        getBillingOverview,
        createRechargeSession,
        listRechargeOrders
      } as unknown as EnterpriseHttpClient
    });

    await manager.getOverview('7d');
    await manager.getOverview('7d');
    await manager.createRechargeSession();
    await manager.listRechargeOrders({ page: 2 });

    expect(session.requireAccessToken).toHaveBeenCalledTimes(4);
    expect(getBillingOverview).toHaveBeenCalledTimes(2);
    expect(createRechargeSession).toHaveBeenCalledWith('access-token');
    expect(listRechargeOrders).toHaveBeenCalledWith('access-token', 2);
    const logs = info.mock.calls.flat().join(' ');
    expect(logs).not.toContain('access-token');
    expect(logs).not.toContain('https://billing.example');
  });

  it('does not call the HTTP client when signed out', async () => {
    const getBillingOverview = vi.fn();
    const manager = createEnterpriseBillingManager({
      sessionManager: {
        requireAccessToken: vi.fn(async () => {
          throw new EnterpriseSessionError('ENTERPRISE_UNAUTHORIZED', 401);
        })
      } as unknown as EnterpriseSessionManager,
      httpClient: { getBillingOverview } as unknown as EnterpriseHttpClient
    });

    await expect(manager.getOverview('7d')).rejects.toMatchObject({
      code: 'ENTERPRISE_UNAUTHORIZED', statusCode: 401
    });
    expect(getBillingOverview).not.toHaveBeenCalled();
  });

  it('returns unavailable when an optional billing method is not installed', async () => {
    const manager = createEnterpriseBillingManager({
      sessionManager: sessionManager(),
      httpClient: {} as EnterpriseHttpClient
    });
    await expect(manager.createRechargeSession()).rejects.toMatchObject({
      code: 'ENTERPRISE_BILLING_UNAVAILABLE', statusCode: 503
    });
  });

  it('invalidates unauthorized sessions and redacts diagnostic identifiers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const session = sessionManager();
    const manager = createEnterpriseBillingManager({
      sessionManager: session,
      httpClient: {
        getBillingOverview: vi.fn(async () => {
          throw new EnterpriseHttpError(
            'ENTERPRISE_UNAUTHORIZED', 'response', 401,
            'unauthorized', undefined, 'complete-sensitive-request-id'
          );
        })
      } as unknown as EnterpriseHttpClient
    });

    let caught: unknown;
    try {
      await manager.getOverview('today');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'ENTERPRISE_SESSION_EXPIRED',
      statusCode: 401,
      details: { requestId: expect.stringMatching(/^[a-f0-9]{12}$/) }
    });
    expect(JSON.stringify(caught)).not.toContain('complete-sensitive-request-id');
    expect(session.invalidateUnauthorized).toHaveBeenCalledOnce();
  });

  it.each([
    ['ENTERPRISE_DATA_VIEW_FORBIDDEN', 403],
    ['ENTERPRISE_BILLING_NOT_MANAGED', 409],
    ['ENTERPRISE_BILLING_UNAVAILABLE', 503],
    ['ENTERPRISE_PROTOCOL_ERROR', 502]
  ] as const)('preserves stable billing error %s', async (code, statusCode) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = createEnterpriseBillingManager({
      sessionManager: sessionManager(),
      httpClient: {
        getBillingOverview: vi.fn(async () => {
          throw new EnterpriseHttpError(code, 'response', statusCode);
        })
      } as unknown as EnterpriseHttpClient
    });
    await expect(manager.getOverview('30d')).rejects.toMatchObject({
      code, statusCode
    });
  });
});

function sessionManager(): EnterpriseSessionManager {
  return {
    requireAccessToken: vi.fn(async () => 'access-token'),
    invalidateUnauthorized: vi.fn(async () => undefined)
  } as unknown as EnterpriseSessionManager;
}

function overview() {
  return {
    balanceCny: 100,
    generatedAt: '2026-08-28T10:00:00+08:00'
  };
}
