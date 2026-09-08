import type {
  EnterpriseActivityDetailResponse,
  EnterpriseActivityRange,
  EnterpriseActivityStatisticsResponse,
  EnterpriseSessionResponse
} from '@clawee/protocol';
import { useEffect, useRef, useState } from 'react';
import type { AppRoute } from '../../app/routes.js';
import { ApiClientError } from '../../runtime/client.js';

export type EnterpriseActivityCapabilityState =
  | 'checking'
  | 'allowed'
  | 'denied'
  | 'unavailable';

type EnterpriseActivityService = {
  getActivityCapability(): Promise<{ allowed: boolean; refreshedAt: string }>;
  getActivityStatistics(
    range: EnterpriseActivityRange
  ): Promise<EnterpriseActivityStatisticsResponse>;
  getActivityDetail(input: {
    range: EnterpriseActivityRange;
    collectorId: string;
    agentId: string;
  }): Promise<EnterpriseActivityDetailResponse>;
};

export function useEnterpriseActivity(input: {
  connected: boolean;
  session: EnterpriseSessionResponse;
  service: EnterpriseActivityService | null;
  route: AppRoute;
  onNavigate(route: AppRoute, options?: { replace?: boolean }): void;
  onLeave(): void;
  onUnauthorized(): void;
}) {
  const [capability, setCapability] =
    useState<EnterpriseActivityCapabilityState>('checking');
  const [statistics, setStatistics] =
    useState<EnterpriseActivityStatisticsResponse>();
  const [statisticsLoading, setStatisticsLoading] = useState(false);
  const [statisticsError, setStatisticsError] = useState<string>();
  const [detail, setDetail] = useState<EnterpriseActivityDetailResponse>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [statisticsReloadKey, setStatisticsReloadKey] = useState(0);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [capabilityReloadKey, setCapabilityReloadKey] = useState(0);
  const capabilityGenerationRef = useRef(0);
  const dataGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const routeRef = useRef(input.route);
  const navigateRef = useRef(input.onNavigate);
  const leaveRef = useRef(input.onLeave);
  const unauthorizedRef = useRef(input.onUnauthorized);
  routeRef.current = input.route;
  navigateRef.current = input.onNavigate;
  leaveRef.current = input.onLeave;
  unauthorizedRef.current = input.onUnauthorized;

  function clearData(): void {
    dataGenerationRef.current += 1;
    detailGenerationRef.current += 1;
    setStatistics(undefined);
    setStatisticsLoading(false);
    setStatisticsError(undefined);
    setDetail(undefined);
    setDetailLoading(false);
    setDetailError(undefined);
  }

  useEffect(() => {
    const generation = ++capabilityGenerationRef.current;
    clearData();
    setCapability('checking');
    if (
      !input.connected
      || input.service === null
      || input.session.status !== 'signed_in'
    ) {
      return;
    }

    const service = input.service;
    void service.getActivityCapability()
      .then(response => {
        if (capabilityGenerationRef.current !== generation) return;
        const next = response.allowed ? 'allowed' : 'denied';
        setCapability(next);
        if (!response.allowed && isActivityRoute(routeRef.current)) {
          leaveRef.current();
        }
      })
      .catch(error => {
        if (capabilityGenerationRef.current !== generation) return;
        setCapability('unavailable');
        if (isUnauthorized(error)) unauthorizedRef.current();
        if (isActivityRoute(routeRef.current)) leaveRef.current();
      });
  }, [
    input.connected,
    input.service,
    input.session.status,
    input.session.account?.subjectId,
    capabilityReloadKey
  ]);

  const routeRange = activityRange(input.route);

  useEffect(() => {
    if (
      capability !== 'allowed'
      || input.service === null
      || routeRange === undefined
    ) {
      return;
    }
    const generation = ++dataGenerationRef.current;
    const service = input.service;
    setStatistics(undefined);
    setStatisticsLoading(true);
    setStatisticsError(undefined);
    setDetail(undefined);
    setDetailLoading(false);
    setDetailError(undefined);

    void service.getActivityStatistics(routeRange)
      .then(response => {
        if (dataGenerationRef.current !== generation) return;
        setStatistics(response);
        setStatisticsLoading(false);
      })
      .catch(error => {
        if (dataGenerationRef.current !== generation) return;
        setStatisticsLoading(false);
        if (isAuthorizationFailure(error)) {
          clearData();
          void closeAfterAuthorizationFailure(service, error);
          return;
        }
        setStatisticsError(formatActivityError(
          error,
          'Agent 动态统计加载失败'
        ));
      });
  }, [
    capability,
    input.service,
    routeRange,
    statisticsReloadKey
  ]);

  useEffect(() => {
    if (
      capability !== 'allowed'
      || input.service === null
      || input.route.view !== 'activity-agent'
      || statistics === undefined
      || statistics.range !== input.route.range
    ) {
      return;
    }
    const route = input.route;
    const knownAgent = statistics.agents.some(agent => (
      agent.collectorId === route.collectorId
      && agent.agentId === route.agentId
    ));
    if (!knownAgent) {
      setDetail(undefined);
      setDetailLoading(false);
      setDetailError(undefined);
      navigateRef.current(
        { view: 'activity', range: route.range },
        { replace: true }
      );
      return;
    }

    const generation = ++detailGenerationRef.current;
    const service = input.service;
    setDetail(undefined);
    setDetailLoading(true);
    setDetailError(undefined);
    void service.getActivityDetail({
      range: route.range,
      collectorId: route.collectorId,
      agentId: route.agentId
    })
      .then(response => {
        if (detailGenerationRef.current !== generation) return;
        setDetail(response);
        setDetailLoading(false);
      })
      .catch(error => {
        if (detailGenerationRef.current !== generation) return;
        setDetailLoading(false);
        if (isAuthorizationFailure(error)) {
          clearData();
          void closeAfterAuthorizationFailure(service, error);
          return;
        }
        if (isActivityNotFound(error)) {
          setStatistics(undefined);
          navigateRef.current(
            { view: 'activity', range: route.range },
            { replace: true }
          );
          setStatisticsReloadKey(current => current + 1);
          return;
        }
        setDetailError(formatActivityError(
          error,
          'Agent 详情加载失败'
        ));
      });
  }, [
    capability,
    input.route,
    input.service,
    statistics,
    detailReloadKey
  ]);

  async function closeAfterAuthorizationFailure(
    service: EnterpriseActivityService,
    error: unknown
  ): Promise<void> {
    const generation = ++capabilityGenerationRef.current;
    if (isUnauthorized(error)) {
      setCapability('checking');
      unauthorizedRef.current();
      leaveRef.current();
      return;
    }
    if (isAuthorizationUnavailable(error)) {
      setCapability('unavailable');
      leaveRef.current();
      return;
    }

    setCapability('checking');
    try {
      const response = await service.getActivityCapability();
      if (capabilityGenerationRef.current !== generation) return;
      setCapability(response.allowed ? 'allowed' : 'denied');
    } catch (capabilityError) {
      if (capabilityGenerationRef.current !== generation) return;
      setCapability('unavailable');
      if (isUnauthorized(capabilityError)) unauthorizedRef.current();
    } finally {
      if (capabilityGenerationRef.current === generation) {
        leaveRef.current();
      }
    }
  }

  const visibleStatistics = statistics?.range === routeRange
    ? statistics
    : undefined;
  const visibleDetail = input.route.view === 'activity-agent'
    && detail?.agent.collectorId === input.route.collectorId
    && detail.agent.agentId === input.route.agentId
    ? detail
    : undefined;

  return {
    capability,
    statistics: visibleStatistics,
    statisticsLoading,
    statisticsError,
    detail: visibleDetail,
    detailLoading,
    detailError,
    retryStatistics() {
      setStatisticsReloadKey(current => current + 1);
    },
    retryDetail() {
      setDetailReloadKey(current => current + 1);
    },
    refreshCapability() {
      setCapabilityReloadKey(current => current + 1);
    }
  };
}

function isActivityRoute(
  route: AppRoute
): route is Extract<AppRoute, {
  view: 'activity' | 'activity-agent' | 'activity-recharge-records'
}> {
  return route.view === 'activity'
    || route.view === 'activity-agent'
    || route.view === 'activity-recharge-records';
}

function activityRange(route: AppRoute): EnterpriseActivityRange | undefined {
  return route.view === 'activity' || route.view === 'activity-agent'
    ? route.range
    : undefined;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiClientError
    && (
      error.status === 401
      || error.code === 'ENTERPRISE_UNAUTHORIZED'
      || error.code === 'ENTERPRISE_SESSION_EXPIRED'
    );
}

function isAuthorizationUnavailable(error: unknown): boolean {
  return error instanceof ApiClientError
    && error.code === 'ENTERPRISE_DATA_AUTHORIZATION_UNAVAILABLE';
}

function isAuthorizationFailure(error: unknown): boolean {
  return isUnauthorized(error)
    || isAuthorizationUnavailable(error)
    || (
      error instanceof ApiClientError
      && error.code === 'ENTERPRISE_DATA_VIEW_FORBIDDEN'
    );
}

function isActivityNotFound(error: unknown): boolean {
  return error instanceof ApiClientError
    && error.code === 'ENTERPRISE_ACTIVITY_NOT_FOUND';
}

function formatActivityError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiClientError)) {
    return error instanceof Error && error.message.trim().length > 0
      ? error.message
      : fallback;
  }
  switch (error.code) {
    case 'ENTERPRISE_ACTIVITY_UNAVAILABLE':
      return '活动数据暂不可用，请稍后重试';
    case 'ENTERPRISE_ACTIVITY_PROVIDER_ERROR':
      return 'Token 数据源暂不可用，请稍后重试';
    case 'ENTERPRISE_PROTOCOL_ERROR':
      return '活动服务返回了无法识别的数据';
    case 'ENTERPRISE_AGENT_FORBIDDEN':
      return '当前设备的企业 Agent 已停用';
    default:
      return error.message.trim().length > 0 ? error.message : fallback;
  }
}
