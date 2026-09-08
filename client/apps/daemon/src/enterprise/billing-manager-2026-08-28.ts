import type {
  EnterpriseActivityRange,
  EnterpriseBillingOverviewResponse,
  EnterpriseRechargeOrderPageResponse,
  EnterpriseRechargeSessionResponse,
  RuntimeErrorCode
} from '@clawee/protocol';
import { createHash } from 'node:crypto';
import type { EnterpriseHttpClient } from './http-client-2026-07-30.js';
import { EnterpriseHttpError } from './http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from './session-manager-2026-07-30.js';
import { EnterpriseSessionError } from './session-manager-2026-07-30.js';

export type EnterpriseBillingManager = {
  getOverview(
    range: EnterpriseActivityRange
  ): Promise<EnterpriseBillingOverviewResponse>;
  createRechargeSession(): Promise<EnterpriseRechargeSessionResponse>;
  listRechargeOrders(input: {
    page: number;
  }): Promise<EnterpriseRechargeOrderPageResponse>;
};

export class EnterpriseBillingManagerError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>
  ) {
    super(`${code}: enterprise billing operation failed`);
    this.name = 'EnterpriseBillingManagerError';
  }
}

export function createEnterpriseBillingManager(input: {
  sessionManager: EnterpriseSessionManager;
  httpClient: EnterpriseHttpClient;
}): EnterpriseBillingManager {
  async function requireToken(): Promise<string> {
    try {
      return await input.sessionManager.requireAccessToken();
    } catch (error) {
      if (error instanceof EnterpriseSessionError) {
        throw new EnterpriseBillingManagerError(
          error.code,
          error.statusCode,
          error.details
        );
      }
      throw error;
    }
  }

  async function runRemote<T>(
    stage: 'overview' | 'recharge_session' | 'recharge_orders',
    operation: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const value = await operation();
      logBilling({
        stage,
        outcome: 'success',
        durationMs: Date.now() - startedAt
      });
      return value;
    } catch (error) {
      if (!(error instanceof EnterpriseHttpError)) throw error;
      if (error.code === 'ENTERPRISE_UNAUTHORIZED') {
        await input.sessionManager.invalidateUnauthorized();
        logBilling({
          stage,
          outcome: 'failed',
          code: 'ENTERPRISE_SESSION_EXPIRED',
          statusCode: 401,
          requestId: error.requestId,
          durationMs: Date.now() - startedAt
        });
        throw new EnterpriseBillingManagerError(
          'ENTERPRISE_SESSION_EXPIRED',
          401,
          diagnosticDetails(error)
        );
      }
      const code = error.code === 'ENTERPRISE_SERVICE_UNAVAILABLE'
        ? 'ENTERPRISE_BILLING_UNAVAILABLE'
        : error.code;
      const statusCode = billingStatusCode(code, error.statusCode);
      logBilling({
        stage,
        outcome: 'failed',
        code,
        statusCode,
        requestId: error.requestId,
        durationMs: Date.now() - startedAt
      });
      throw new EnterpriseBillingManagerError(
        code,
        statusCode,
        diagnosticDetails(error)
      );
    }
  }

  return {
    async getOverview(range) {
      const accessToken = await requireToken();
      const getOverview = input.httpClient.getBillingOverview;
      if (getOverview === undefined) unavailable();
      return runRemote('overview', () => getOverview(accessToken, range));
    },
    async createRechargeSession() {
      const accessToken = await requireToken();
      const createSession = input.httpClient.createRechargeSession;
      if (createSession === undefined) unavailable();
      return runRemote('recharge_session', () => createSession(accessToken));
    },
    async listRechargeOrders(request) {
      const accessToken = await requireToken();
      const listOrders = input.httpClient.listRechargeOrders;
      if (listOrders === undefined) unavailable();
      return runRemote(
        'recharge_orders',
        () => listOrders(accessToken, request.page)
      );
    }
  };
}

function unavailable(): never {
  throw new EnterpriseBillingManagerError(
    'ENTERPRISE_BILLING_UNAVAILABLE',
    503
  );
}

function billingStatusCode(
  code: RuntimeErrorCode,
  upstreamStatus: number | undefined
): number {
  switch (code) {
    case 'ENTERPRISE_INVALID_REQUEST':
      return 400;
    case 'ENTERPRISE_DATA_VIEW_FORBIDDEN':
      return 403;
    case 'ENTERPRISE_BILLING_NOT_MANAGED':
      return 409;
    case 'ENTERPRISE_BILLING_UNAVAILABLE':
      return 503;
    case 'ENTERPRISE_PROTOCOL_ERROR':
      return 502;
    default:
      return upstreamStatus !== undefined
        && (upstreamStatus < 200 || upstreamStatus >= 300)
        ? upstreamStatus
        : 500;
  }
}

function diagnosticDetails(
  error: EnterpriseHttpError
): Record<string, unknown> | undefined {
  if (error.requestId === undefined) return undefined;
  return { requestId: redactRequestId(error.requestId) };
}

function logBilling(input: {
  stage: 'overview' | 'recharge_session' | 'recharge_orders';
  outcome: 'success' | 'failed';
  statusCode?: number;
  code?: RuntimeErrorCode;
  requestId?: string;
  durationMs: number;
}): void {
  const message = JSON.stringify({
    event: 'enterprise_billing',
    stage: input.stage,
    outcome: input.outcome,
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.requestId === undefined
      ? {}
      : { requestId: redactRequestId(input.requestId) }),
    durationMs: input.durationMs
  });
  if (input.outcome === 'failed') console.warn(message);
  else console.info(message);
}

function redactRequestId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
