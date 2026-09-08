import type {
  EnterpriseBillingOverviewResponse,
  EnterpriseRechargeOrderPageResponse,
  EnterpriseSessionResponse,
  ModelAccessState
} from '@clawee/protocol';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../runtime/client.js';
import type { ActivityRange, AppRoute } from '../../app/routes.js';
import {
  useEnterpriseBilling
} from './useEnterpriseBilling-2026-08-28.js';

const signedIn: EnterpriseSessionResponse = {
  status: 'signed_in',
  account: {
    subjectId: 'account-1',
    email: 'member@example.com',
    name: 'Member'
  },
  transportSecurity: 'secure_https'
};
const platformReady: ModelAccessState = {
  status: 'ready',
  mode: 'platform_managed',
  configuration: { baseUrl: 'https://model.example/v1', model: 'model-1' }
};

describe('useEnterpriseBilling', () => {
  it.each([
    { connected: false, session: signedIn, modelAccess: platformReady, capability: 'allowed' },
    {
      connected: true,
      session: { status: 'signed_out', transportSecurity: 'secure_https' },
      modelAccess: platformReady,
      capability: 'allowed'
    },
    { connected: true, session: signedIn, modelAccess: { status: 'resolving' }, capability: 'allowed' },
    {
      connected: true,
      session: signedIn,
      modelAccess: {
        status: 'ready',
        mode: 'enterprise_managed',
        configuration: { baseUrl: 'https://model.example/v1', model: 'model-1' }
      },
      capability: 'allowed'
    },
    { connected: true, session: signedIn, modelAccess: platformReady, capability: 'denied' }
  ] as const)('does not query billing before all gates pass %#', async gate => {
    const service = createService();
    renderHook(() => useEnterpriseBilling({
      ...gate,
      route: { view: 'activity', range: '7d' },
      service,
      onUnauthorized: vi.fn(),
      onForbidden: vi.fn()
    }));
    await act(async () => Promise.resolve());
    expect(service.getBillingOverview).not.toHaveBeenCalled();
    expect(service.listRechargeOrders).not.toHaveBeenCalled();
  });

  it('requests only the data required by each activity route', async () => {
    const service = createService();
    const input = baseInput(service);
    const { rerender } = renderHook(
      ({ route }: { route: AppRoute }) => useEnterpriseBilling({ ...input, route }),
      { initialProps: { route: { view: 'activity', range: '7d' } } }
    );
    await waitFor(() => expect(service.getBillingOverview).toHaveBeenCalledWith('7d'));
    expect(service.listRechargeOrders).not.toHaveBeenCalled();

    rerender({
      route: {
        view: 'activity-agent', range: '7d',
        collectorId: 'collector-1', agentId: 'agent-1'
      }
    });
    await act(async () => Promise.resolve());
    expect(service.listRechargeOrders).not.toHaveBeenCalled();

    rerender({ route: { view: 'activity-recharge-records', range: '7d' } });
    await waitFor(() => expect(service.listRechargeOrders).toHaveBeenCalledWith(1));
    expect(service.getBillingOverview).toHaveBeenCalledTimes(1);
  });

  it('discards stale range responses and refreshes on focus without polling', async () => {
    const old = deferred<EnterpriseBillingOverviewResponse>();
    const getBillingOverview = vi.fn((range: 'today' | '7d' | '30d') => (
      range === '7d' ? old.promise : Promise.resolve(overview(30))
    ));
    const service = createService({ getBillingOverview });
    const input = baseInput(service);
    const { result, rerender } = renderHook(
      ({ range }: { range: ActivityRange }) => useEnterpriseBilling({
        ...input,
        route: { view: 'activity', range }
      }),
      { initialProps: { range: '7d' } }
    );
    await waitFor(() => expect(getBillingOverview).toHaveBeenCalledWith('7d'));
    rerender({ range: '30d' });
    await waitFor(() => expect(result.current.overview).toEqual(overview(30)));
    await act(async () => old.resolve(overview(7)));
    expect(result.current.overview).toEqual(overview(30));

    const setInterval = vi.spyOn(window, 'setInterval');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getBillingOverview).toHaveBeenCalledTimes(3);
    expect(setInterval).not.toHaveBeenCalled();
  });

  it('clears old account data when the session changes', async () => {
    const service = createService();
    const { result, rerender } = renderHook(
      ({ session }) => useEnterpriseBilling({
        ...baseInput(service),
        session,
        route: { view: 'activity', range: '7d' }
      }),
      { initialProps: { session: signedIn } }
    );
    await waitFor(() => expect(result.current.overview).toEqual(overview(7)));
    rerender({
      session: { status: 'signed_out', transportSecurity: 'secure_https' }
    });
    await waitFor(() => expect(result.current.overview).toBeUndefined());
  });

  it('hides old billing data while a different account is loading', async () => {
    const nextOverview = deferred<EnterpriseBillingOverviewResponse>();
    const nextOrders = deferred<EnterpriseRechargeOrderPageResponse>();
    const service = createService({
      getBillingOverview: vi.fn()
        .mockResolvedValueOnce(overview(7))
        .mockReturnValueOnce(nextOverview.promise),
      listRechargeOrders: vi.fn()
        .mockResolvedValueOnce({ items: [], page: 1, total: 1 })
        .mockReturnValueOnce(nextOrders.promise)
    });
    const { result, rerender } = renderHook(
      ({ session, route }: {
        session: EnterpriseSessionResponse;
        route: AppRoute;
      }) => useEnterpriseBilling({
        ...baseInput(service), session, route
      }),
      {
        initialProps: {
          session: signedIn,
          route: { view: 'activity', range: '7d' } as AppRoute
        }
      }
    );
    await waitFor(() => expect(result.current.overview).toEqual(overview(7)));

    const nextSession: EnterpriseSessionResponse = {
      ...signedIn,
      account: { ...signedIn.account!, subjectId: 'account-2' }
    };
    rerender({ session: nextSession, route: { view: 'activity', range: '7d' } });
    expect(result.current.overview).toBeUndefined();

    await act(async () => nextOverview.resolve(overview(30)));
    rerender({
      session: nextSession,
      route: { view: 'activity-recharge-records', range: '7d' }
    });
    await waitFor(() => expect(result.current.orders).toEqual({
      items: [], page: 1, total: 1
    }));

    rerender({
      session: signedIn,
      route: { view: 'activity-recharge-records', range: '7d' }
    });
    expect(result.current.orders).toBeUndefined();
    await act(async () => nextOrders.resolve({ items: [], page: 1, total: 0 }));
  });

  it('hides old overview when the activity range changes', async () => {
    const next = deferred<EnterpriseBillingOverviewResponse>();
    const service = createService({
      getBillingOverview: vi.fn()
        .mockResolvedValueOnce(overview(7))
        .mockReturnValueOnce(next.promise)
    });
    const { result, rerender } = renderHook(
      ({ range }: { range: ActivityRange }) => useEnterpriseBilling({
        ...baseInput(service),
        route: { view: 'activity', range }
      }),
      { initialProps: { range: '7d' as ActivityRange } }
    );
    await waitFor(() => expect(result.current.overview).toEqual(overview(7)));
    rerender({ range: '30d' });
    expect(result.current.overview).toBeUndefined();
    await act(async () => next.resolve(overview(30)));
    expect(result.current.overview).toEqual(overview(30));
  });

  it('requests page one only when the records route is re-entered', async () => {
    const service = createService({
      listRechargeOrders: vi.fn(async (page: number) => ({
        items: [], page, total: 40
      }))
    });
    const input = baseInput(service);
    const { result, rerender } = renderHook(
      ({ route }: { route: AppRoute }) => useEnterpriseBilling({ ...input, route }),
      {
        initialProps: {
          route: { view: 'activity-recharge-records', range: '7d' } as AppRoute
        }
      }
    );
    await waitFor(() => expect(result.current.orders).toEqual({
      items: [], page: 1, total: 40
    }));
    act(() => result.current.nextOrdersPage());
    await waitFor(() => expect(result.current.ordersPage).toBe(2));

    rerender({ route: { view: 'activity', range: '7d' } });
    rerender({ route: { view: 'activity-recharge-records', range: '7d' } });
    await waitFor(() => expect(service.listRechargeOrders).toHaveBeenCalledTimes(3));
    expect(service.listRechargeOrders.mock.calls.map(call => call[0])).toEqual([
      1, 2, 1
    ]);
  });

  it('requests page one immediately when the account changes on records', async () => {
    const service = createService({
      listRechargeOrders: vi.fn(async (page: number) => ({
        items: [], page, total: 40
      }))
    });
    const { result, rerender } = renderHook(
      ({ session }: { session: EnterpriseSessionResponse }) => useEnterpriseBilling({
        ...baseInput(service),
        session,
        route: { view: 'activity-recharge-records', range: '7d' }
      }),
      { initialProps: { session: signedIn } }
    );
    await waitFor(() => expect(result.current.orders).toBeDefined());
    act(() => result.current.nextOrdersPage());
    await waitFor(() => expect(result.current.ordersPage).toBe(2));

    rerender({
      session: {
        ...signedIn,
        account: { ...signedIn.account!, subjectId: 'account-2' }
      }
    });
    await waitFor(() => expect(service.listRechargeOrders).toHaveBeenCalledTimes(3));
    expect(service.listRechargeOrders.mock.calls.map(call => call[0])).toEqual([
      1, 2, 1
    ]);
  });

  it('does not label previous-page orders as a failed next page', async () => {
    const nextPage = deferred<EnterpriseRechargeOrderPageResponse>();
    const service = createService({
      listRechargeOrders: vi.fn()
        .mockResolvedValueOnce({ items: [], page: 1, total: 40 })
        .mockReturnValueOnce(nextPage.promise)
    });
    const { result } = renderHook(() => useEnterpriseBilling({
      ...baseInput(service),
      route: { view: 'activity-recharge-records', range: '7d' }
    }));
    await waitFor(() => expect(result.current.orders?.page).toBe(1));

    act(() => result.current.nextOrdersPage());
    expect(result.current.orders?.page).toBe(1);
    await act(async () => nextPage.reject(new Error('unavailable')));

    expect(result.current.ordersPage).toBe(2);
    expect(result.current.orders).toBeUndefined();
    expect(result.current.ordersError).toBe('充值记录暂不可用，请稍后重试');
  });

  it('prevents duplicate recharge sessions and reports external-open failures', async () => {
    const pending = deferred<{ rechargeUrl: string }>();
    const service = createService({
      createRechargeSession: vi.fn(() => pending.promise)
    });
    const { result } = renderHook(() => useEnterpriseBilling({
      ...baseInput(service),
      route: { view: 'activity', range: '7d' }
    }));
    const openExternal = vi.fn(async () => {
      throw new Error('blocked');
    });

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.recharge(openExternal);
      void result.current.recharge(openExternal);
      await Promise.resolve();
    });
    expect(service.createRechargeSession).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve({ rechargeUrl: 'https://billing.example/recharge/token' });
      await first;
    });
    expect(openExternal).toHaveBeenCalledWith(
      'https://billing.example/recharge/token'
    );
    expect(result.current.rechargeError).toBe('无法打开充值页面，请重试');
    expect(result.current.rechargePending).toBe(false);
  });

  it('handles billing-not-managed, permission, and session errors by code', async () => {
    const onUnauthorized = vi.fn();
    const onForbidden = vi.fn();
    const notManagedService = createService({
      getBillingOverview: vi.fn(async () => {
        throw apiError(409, 'ENTERPRISE_BILLING_NOT_MANAGED');
      })
    });
    const { result, unmount } = renderHook(() => useEnterpriseBilling({
      ...baseInput(notManagedService),
      route: { view: 'activity', range: '7d' },
      onUnauthorized,
      onForbidden
    }));
    await waitFor(() => expect(result.current.billingNotManaged).toBe(true));
    expect(result.current.overviewError).toBeUndefined();
    unmount();

    const forbiddenService = createService({
      getBillingOverview: vi.fn(async () => {
        throw apiError(403, 'ENTERPRISE_DATA_VIEW_FORBIDDEN');
      })
    });
    const forbiddenHook = renderHook(() => useEnterpriseBilling({
      ...baseInput(forbiddenService),
      route: { view: 'activity', range: '7d' },
      onUnauthorized,
      onForbidden
    }));
    await waitFor(() => expect(onForbidden).toHaveBeenCalledOnce());
    forbiddenHook.unmount();

    const unauthorizedService = createService({
      getBillingOverview: vi.fn(async () => {
        throw apiError(401, 'ENTERPRISE_SESSION_EXPIRED');
      })
    });
    renderHook(() => useEnterpriseBilling({
      ...baseInput(unauthorizedService),
      route: { view: 'activity', range: '7d' },
      onUnauthorized,
      onForbidden
    }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
  });
});

function baseInput(service: ReturnType<typeof createService>) {
  return {
    connected: true,
    session: signedIn,
    modelAccess: platformReady,
    capability: 'allowed' as const,
    service,
    onUnauthorized: vi.fn(),
    onForbidden: vi.fn()
  };
}

function createService(overrides: Record<string, unknown> = {}) {
  return {
    getBillingOverview: vi.fn(async () => overview(7)),
    createRechargeSession: vi.fn(async () => ({
      rechargeUrl: 'https://billing.example/recharge/token'
    })),
    listRechargeOrders: vi.fn(async (page: number) => ({
      items: [], page, total: 0
    })),
    ...overrides
  };
}

function overview(value: number): EnterpriseBillingOverviewResponse {
  return {
    balanceCny: value,
    generatedAt: '2026-08-28T10:00:00+08:00'
  };
}

function apiError(status: number, code: string): ApiClientError {
  return new ApiClientError({ status, code, message: 'ignored message' });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}
