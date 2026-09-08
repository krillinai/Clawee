import type {
  EnterpriseActivityRange,
  EnterpriseBillingOverviewResponse,
  EnterpriseRechargeOrderPageResponse,
  EnterpriseRechargeSessionResponse,
  EnterpriseSessionResponse,
  ModelAccessState
} from '@clawee/protocol';
import { useEffect, useRef, useState } from 'react';
import type { AppRoute } from '../../app/routes.js';
import { ApiClientError } from '../../runtime/client.js';
import type {
  EnterpriseActivityCapabilityState
} from './useEnterpriseActivity-2026-08-18.js';

type EnterpriseBillingService = {
  getBillingOverview(
    range: EnterpriseActivityRange
  ): Promise<EnterpriseBillingOverviewResponse>;
  createRechargeSession(): Promise<EnterpriseRechargeSessionResponse>;
  listRechargeOrders(page: number): Promise<EnterpriseRechargeOrderPageResponse>;
};

type ScopedData<T> = {
  scopeKey: string;
  value: T;
};

export function useEnterpriseBilling(input: {
  connected: boolean;
  session: EnterpriseSessionResponse;
  modelAccess: ModelAccessState;
  capability: EnterpriseActivityCapabilityState;
  route: AppRoute;
  service: EnterpriseBillingService | null;
  onUnauthorized(): void;
  onForbidden(): void;
}) {
  const [overviewData, setOverviewData] =
    useState<ScopedData<EnterpriseBillingOverviewResponse>>();
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string>();
  const [ordersData, setOrdersData] =
    useState<ScopedData<EnterpriseRechargeOrderPageResponse>>();
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string>();
  const [ordersPage, setOrdersPage] = useState(1);
  const [rechargePending, setRechargePending] = useState(false);
  const [rechargeError, setRechargeError] = useState<string>();
  const [remoteNotManaged, setRemoteNotManaged] = useState(false);
  const [overviewReloadKey, setOverviewReloadKey] = useState(0);
  const [ordersReloadKey, setOrdersReloadKey] = useState(0);
  const dataGenerationRef = useRef(0);
  const rechargeGenerationRef = useRef(0);
  const rechargePendingRef = useRef(false);
  const ordersPageScopeRef = useRef<string>();
  const unauthorizedRef = useRef(input.onUnauthorized);
  const forbiddenRef = useRef(input.onForbidden);
  unauthorizedRef.current = input.onUnauthorized;
  forbiddenRef.current = input.onForbidden;

  const platformReady = input.connected
    && input.service !== null
    && input.session.status === 'signed_in'
    && input.modelAccess.status === 'ready'
    && input.modelAccess.mode === 'platform_managed'
    && input.capability === 'allowed';
  const accountId = input.session.account?.subjectId;
  const mode = input.modelAccess.status === 'ready'
    ? input.modelAccess.mode
    : undefined;
  const billingScopeKey = JSON.stringify({
    connected: input.connected,
    sessionStatus: input.session.status,
    accountId,
    modelAccessStatus: input.modelAccess.status,
    mode,
    capability: input.capability
  });
  const overviewScopeKey = input.route.view === 'activity'
    ? `${billingScopeKey}:${input.route.range}`
    : undefined;
  const ordersPageScopeKey = platformReady
    && input.route.view === 'activity-recharge-records'
    ? billingScopeKey
    : undefined;
  const effectiveOrdersPage = ordersPageScopeRef.current === ordersPageScopeKey
    ? ordersPage
    : 1;
  const overview = overviewScopeKey !== undefined
    && overviewData?.scopeKey === overviewScopeKey
    ? overviewData.value
    : undefined;
  const orders = ordersPageScopeKey !== undefined
    && ordersData?.scopeKey === ordersPageScopeKey
    && (ordersLoading || ordersData.value.page === effectiveOrdersPage)
    ? ordersData.value
    : undefined;

  useEffect(() => {
    if (ordersPageScopeRef.current === ordersPageScopeKey) return;
    ordersPageScopeRef.current = ordersPageScopeKey;
    setOrdersPage(1);
  }, [ordersPageScopeKey]);

  useEffect(() => {
    const generation = ++dataGenerationRef.current;
    rechargeGenerationRef.current += 1;
    rechargePendingRef.current = false;
    setRechargePending(false);
    setRechargeError(undefined);
    setRemoteNotManaged(false);

    if (!platformReady || input.service === null) {
      setOverviewData(undefined);
      setOverviewLoading(false);
      setOverviewError(undefined);
      setOrdersData(undefined);
      setOrdersLoading(false);
      setOrdersError(undefined);
      return;
    }

    const service = input.service;
    if (input.route.view === 'activity') {
      const requestScopeKey = `${billingScopeKey}:${input.route.range}`;
      setOverviewLoading(true);
      setOverviewError(undefined);
      setOrdersData(undefined);
      setOrdersLoading(false);
      setOrdersError(undefined);
      void service.getBillingOverview(input.route.range)
        .then(response => {
          if (dataGenerationRef.current !== generation) return;
          setOverviewData({ scopeKey: requestScopeKey, value: response });
          setOverviewLoading(false);
        })
        .catch(error => {
          if (dataGenerationRef.current !== generation) return;
          setOverviewLoading(false);
          handleBillingFailure(error, {
            unavailable: () => setOverviewError('账户额度暂不可用'),
            notManaged: () => {
              setOverviewData(undefined);
              setRemoteNotManaged(true);
            },
            unauthorized: unauthorizedRef.current,
            forbidden: forbiddenRef.current
          });
        });
      return;
    }

    setOverviewData(undefined);
    setOverviewLoading(false);
    setOverviewError(undefined);
    if (input.route.view !== 'activity-recharge-records') {
      setOrdersData(undefined);
      setOrdersLoading(false);
      setOrdersError(undefined);
      return;
    }

    const requestScopeKey = billingScopeKey;
    setOrdersLoading(true);
    setOrdersError(undefined);
    void service.listRechargeOrders(effectiveOrdersPage)
      .then(response => {
        if (dataGenerationRef.current !== generation) return;
        setOrdersData({ scopeKey: requestScopeKey, value: response });
        setOrdersLoading(false);
      })
      .catch(error => {
        if (dataGenerationRef.current !== generation) return;
        setOrdersLoading(false);
        handleBillingFailure(error, {
          unavailable: () => setOrdersError(
            '充值记录暂不可用，请稍后重试'
          ),
          notManaged: () => {
            setOrdersData(undefined);
            setRemoteNotManaged(true);
          },
          unauthorized: unauthorizedRef.current,
          forbidden: forbiddenRef.current
        });
      });
  }, [
    platformReady,
    input.service,
    input.route.view,
    input.route.view === 'activity' ? input.route.range : undefined,
    accountId,
    mode,
    input.capability,
    effectiveOrdersPage,
    overviewReloadKey,
    ordersReloadKey
  ]);

  useEffect(() => {
    if (!platformReady || remoteNotManaged) return;
    const handleFocus = () => {
      if (input.route.view === 'activity') {
        setOverviewReloadKey(current => current + 1);
      } else if (input.route.view === 'activity-recharge-records') {
        setOrdersReloadKey(current => current + 1);
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [platformReady, remoteNotManaged, input.route.view]);

  async function recharge(
    openExternal: (url: string) => Promise<void>
  ): Promise<void> {
    if (!platformReady || input.service === null || rechargePendingRef.current) {
      return;
    }
    const generation = ++rechargeGenerationRef.current;
    rechargePendingRef.current = true;
    setRechargePending(true);
    setRechargeError(undefined);
    try {
      const session = await input.service.createRechargeSession();
      if (rechargeGenerationRef.current !== generation) return;
      try {
        await openExternal(session.rechargeUrl);
      } catch {
        if (rechargeGenerationRef.current === generation) {
          setRechargeError('无法打开充值页面，请重试');
        }
      }
    } catch (error) {
      if (rechargeGenerationRef.current !== generation) return;
      handleBillingFailure(error, {
        unavailable: () => setRechargeError('充值入口暂不可用'),
        notManaged: () => setRemoteNotManaged(true),
        unauthorized: unauthorizedRef.current,
        forbidden: forbiddenRef.current
      });
    } finally {
      if (rechargeGenerationRef.current === generation) {
        rechargePendingRef.current = false;
        setRechargePending(false);
      }
    }
  }

  const billingNotManaged = mode === 'enterprise_managed' || remoteNotManaged;

  return {
    enabled: platformReady && !remoteNotManaged,
    resolving: input.modelAccess.status === 'resolving',
    billingNotManaged,
    overview,
    overviewLoading,
    overviewError,
    orders,
    ordersLoading,
    ordersError,
    ordersPage: effectiveOrdersPage,
    rechargePending,
    rechargeError,
    recharge,
    retryOverview() {
      setOverviewReloadKey(current => current + 1);
    },
    retryOrders() {
      setOrdersReloadKey(current => current + 1);
    },
    refreshOrders() {
      setOrdersReloadKey(current => current + 1);
    },
    previousOrdersPage() {
      if (ordersLoading) return;
      setOrdersPage(Math.max(1, effectiveOrdersPage - 1));
    },
    nextOrdersPage() {
      if (
        ordersLoading
        || orders === undefined
        || effectiveOrdersPage * 20 >= orders.total
      ) {
        return;
      }
      setOrdersPage(effectiveOrdersPage + 1);
    }
  };
}

function handleBillingFailure(error: unknown, handlers: {
  unavailable(): void;
  notManaged(): void;
  unauthorized(): void;
  forbidden(): void;
}): void {
  if (!(error instanceof ApiClientError)) {
    handlers.unavailable();
    return;
  }
  if (
    error.status === 401
    || error.code === 'ENTERPRISE_UNAUTHORIZED'
    || error.code === 'ENTERPRISE_SESSION_EXPIRED'
  ) {
    handlers.unauthorized();
    return;
  }
  if (error.code === 'ENTERPRISE_DATA_VIEW_FORBIDDEN') {
    handlers.forbidden();
    return;
  }
  if (error.code === 'ENTERPRISE_BILLING_NOT_MANAGED') {
    handlers.notManaged();
    return;
  }
  handlers.unavailable();
}
