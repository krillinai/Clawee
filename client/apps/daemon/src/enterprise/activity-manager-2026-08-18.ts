import type {
  EnterpriseActivityCapabilityResponse,
  EnterpriseActivityDetailResponse,
  EnterpriseActivityRange,
  EnterpriseActivityStatisticsResponse,
  RuntimeErrorCode
} from '@clawee/protocol';
import { createHash } from 'node:crypto';
import type { EnterpriseHttpClient } from './http-client-2026-07-30.js';
import { EnterpriseHttpError } from './http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from './session-manager-2026-07-30.js';
import { EnterpriseSessionError } from './session-manager-2026-07-30.js';

export type EnterpriseActivityManager = {
  getCapability(): Promise<EnterpriseActivityCapabilityResponse>;
  getStatistics(
    range: EnterpriseActivityRange
  ): Promise<EnterpriseActivityStatisticsResponse>;
  getDetail(input: {
    range: EnterpriseActivityRange;
    collectorId: string;
    agentId: string;
  }): Promise<EnterpriseActivityDetailResponse>;
  clear(): void;
};

export class EnterpriseActivityManagerError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>
  ) {
    super(`${code}: enterprise activity operation failed`);
    this.name = 'EnterpriseActivityManagerError';
  }
}

export function createEnterpriseActivityManager(input: {
  sessionManager: EnterpriseSessionManager;
  httpClient: EnterpriseHttpClient;
  now?: () => Date;
}): EnterpriseActivityManager {
  const now = input.now ?? (() => new Date());
  const visibleAgentsByRange = new Map<EnterpriseActivityRange, Set<string>>();

  function clear(): void {
    visibleAgentsByRange.clear();
  }

  async function requireToken(): Promise<string> {
    try {
      return await input.sessionManager.requireAccessToken();
    } catch (error) {
      if (error instanceof EnterpriseSessionError) {
        throw new EnterpriseActivityManagerError(
          error.code,
          error.statusCode,
          error.details
        );
      }
      throw error;
    }
  }

  async function runRemote<T>(
    stage: 'capability' | 'statistics' | 'detail',
    range: EnterpriseActivityRange | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const value = await operation();
      logActivity({
        stage,
        outcome: 'success',
        ...(range === undefined ? {} : { range }),
        durationMs: Date.now() - startedAt
      });
      return value;
    } catch (error) {
      if (!(error instanceof EnterpriseHttpError)) throw error;
      if (error.code === 'ENTERPRISE_UNAUTHORIZED') {
        clear();
        await input.sessionManager.invalidateUnauthorized();
        logActivity({
          stage,
          outcome: 'failed',
          ...(range === undefined ? {} : { range }),
          statusCode: 401,
          code: 'ENTERPRISE_SESSION_EXPIRED',
          requestId: error.requestId,
          durationMs: Date.now() - startedAt
        });
        throw new EnterpriseActivityManagerError(
          'ENTERPRISE_SESSION_EXPIRED',
          401,
          diagnosticDetails(error)
        );
      }
      if (
        error.code === 'ENTERPRISE_DATA_VIEW_FORBIDDEN'
        || error.code === 'ENTERPRISE_DATA_AUTHORIZATION_UNAVAILABLE'
      ) {
        clear();
      }
      logActivity({
        stage,
        outcome: 'failed',
        ...(range === undefined ? {} : { range }),
        statusCode: error.statusCode,
        code: error.code,
        requestId: error.requestId,
        durationMs: Date.now() - startedAt
      });
      throw new EnterpriseActivityManagerError(
        error.code,
        activityStatusCode(error),
        diagnosticDetails(error)
      );
    }
  }

  async function getCapability(): Promise<EnterpriseActivityCapabilityResponse> {
    const accessToken = await requireToken();
    const hasGrant = input.httpClient.hasAgentActivityGrant;
    if (hasGrant === undefined) {
      clear();
      throw new EnterpriseActivityManagerError(
        'ENTERPRISE_ACTIVITY_UNAVAILABLE',
        503
      );
    }
    const allowed = await runRemote(
      'capability',
      undefined,
      () => hasGrant(accessToken)
    );
    if (!allowed) clear();
    return {
      allowed,
      refreshedAt: now().toISOString()
    };
  }

  async function getStatistics(
    range: EnterpriseActivityRange
  ): Promise<EnterpriseActivityStatisticsResponse> {
    const accessToken = await requireToken();
    const loadStatistics = input.httpClient.getActivityStatistics;
    if (loadStatistics === undefined) {
      clear();
      throw new EnterpriseActivityManagerError(
        'ENTERPRISE_ACTIVITY_UNAVAILABLE',
        503
      );
    }
    visibleAgentsByRange.delete(range);
    const statistics = await runRemote(
      'statistics',
      range,
      () => loadStatistics(accessToken, range)
    );
    visibleAgentsByRange.set(
      range,
      new Set(statistics.agents.map(agentKey))
    );
    return statistics;
  }

  async function getDetail(request: {
    range: EnterpriseActivityRange;
    collectorId: string;
    agentId: string;
  }): Promise<EnterpriseActivityDetailResponse> {
    const allowedAgents = visibleAgentsByRange.get(request.range);
    if (
      allowedAgents === undefined
      || !allowedAgents.has(agentKey(request))
    ) {
      throw new EnterpriseActivityManagerError(
        'ENTERPRISE_ACTIVITY_NOT_FOUND',
        404
      );
    }
    const accessToken = await requireToken();
    const loadDetail = input.httpClient.getActivityDetail;
    if (loadDetail === undefined) {
      throw new EnterpriseActivityManagerError(
        'ENTERPRISE_ACTIVITY_UNAVAILABLE',
        503
      );
    }
    try {
      return await runRemote(
        'detail',
        request.range,
        () => loadDetail(
          accessToken,
          request.collectorId,
          request.agentId
        )
      );
    } catch (error) {
      if (
        error instanceof EnterpriseActivityManagerError
        && error.code === 'ENTERPRISE_ACTIVITY_NOT_FOUND'
      ) {
        visibleAgentsByRange.delete(request.range);
      }
      throw error;
    }
  }

  return {
    getCapability,
    getStatistics,
    getDetail,
    clear
  };
}

function agentKey(input: { collectorId: string; agentId: string }): string {
  return `${input.collectorId.length}:${input.collectorId}${input.agentId}`;
}

function diagnosticDetails(
  error: EnterpriseHttpError
): Record<string, unknown> | undefined {
  const details = {
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: error.retryAfterMs }),
    ...(error.upstreamCode === undefined
      ? {}
      : { providerCode: error.upstreamCode })
  };
  return Object.keys(details).length === 0 ? undefined : details;
}

function defaultStatusCode(code: RuntimeErrorCode): number {
  switch (code) {
    case 'ENTERPRISE_DATA_VIEW_FORBIDDEN':
      return 403;
    case 'ENTERPRISE_ACTIVITY_NOT_FOUND':
      return 404;
    case 'ENTERPRISE_DATA_AUTHORIZATION_UNAVAILABLE':
    case 'ENTERPRISE_ACTIVITY_UNAVAILABLE':
    case 'ENTERPRISE_SERVICE_UNAVAILABLE':
      return 503;
    case 'ENTERPRISE_ACTIVITY_PROVIDER_ERROR':
    case 'ENTERPRISE_PROTOCOL_ERROR':
      return 502;
    default:
      return 500;
  }
}

function activityStatusCode(error: EnterpriseHttpError): number {
  return error.statusCode !== undefined
    && (error.statusCode < 200 || error.statusCode >= 300)
    ? error.statusCode
    : defaultStatusCode(error.code);
}

function logActivity(input: {
  stage: 'capability' | 'statistics' | 'detail';
  outcome: 'success' | 'failed';
  range?: EnterpriseActivityRange;
  statusCode?: number;
  code?: RuntimeErrorCode;
  requestId?: string;
  durationMs: number;
}): void {
  const message = JSON.stringify({
    event: 'enterprise_activity',
    stage: input.stage,
    outcome: input.outcome,
    ...(input.range === undefined ? {} : { range: input.range }),
    ...(input.statusCode === undefined
      ? {}
      : { statusCode: input.statusCode }),
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.requestId === undefined
      ? {}
      : { requestId: redactRequestId(input.requestId) }),
    durationMs: input.durationMs
  });
  if (input.outcome === 'failed') {
    console.warn(message);
  } else {
    console.info(message);
  }
}

function redactRequestId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
