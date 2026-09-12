import type {
  EnterpriseBilibiliDashboardRange,
  EnterpriseBilibiliDashboardResponse,
  RuntimeErrorCode
} from '@clawee/protocol';
import type { EnterpriseHttpClient } from './http-client-2026-07-30.js';
import { EnterpriseHttpError } from './http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from './session-manager-2026-07-30.js';
import { EnterpriseSessionError } from './session-manager-2026-07-30.js';

export type EnterpriseBusinessDashboardManager = {
  getBilibiliDashboard(input?: {
    range?: EnterpriseBilibiliDashboardRange;
    sourceId?: string;
  }): Promise<EnterpriseBilibiliDashboardResponse>;
};

export class EnterpriseBusinessDashboardManagerError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    readonly statusCode: number
  ) {
    super(`${code}: enterprise business dashboard operation failed`);
    this.name = 'EnterpriseBusinessDashboardManagerError';
  }
}

export function createEnterpriseBusinessDashboardManager(input: {
  sessionManager: EnterpriseSessionManager;
  httpClient: EnterpriseHttpClient;
}): EnterpriseBusinessDashboardManager {
  return {
    async getBilibiliDashboard(options) {
      let accessToken: string;
      try {
        accessToken = await input.sessionManager.requireAccessToken();
      } catch (error) {
        if (error instanceof EnterpriseSessionError) {
          throw new EnterpriseBusinessDashboardManagerError(
            error.code,
            error.statusCode
          );
        }
        throw error;
      }

      const loadDashboard = input.httpClient.getBilibiliDashboard;
      if (loadDashboard === undefined) {
        throw new EnterpriseBusinessDashboardManagerError(
          'ENTERPRISE_SERVICE_UNAVAILABLE',
          503
        );
      }
      try {
        return await loadDashboard(accessToken, options);
      } catch (error) {
        if (!(error instanceof EnterpriseHttpError)) throw error;
        if (error.code === 'ENTERPRISE_UNAUTHORIZED') {
          await input.sessionManager.invalidateUnauthorized();
          throw new EnterpriseBusinessDashboardManagerError(
            'ENTERPRISE_SESSION_EXPIRED',
            401
          );
        }
        throw new EnterpriseBusinessDashboardManagerError(
          error.code,
          dashboardStatusCode(error)
        );
      }
    }
  };
}

function dashboardStatusCode(error: EnterpriseHttpError): number {
  if (error.code === 'ENTERPRISE_DATA_VIEW_FORBIDDEN') return 403;
  if (error.code === 'ENTERPRISE_PROTOCOL_ERROR') return 502;
  if (error.code === 'ENTERPRISE_SERVICE_UNAVAILABLE') return 503;
  return error.statusCode ?? 500;
}
