import type { SkillContributionQuery, SkillContributionResponse, SkillContributionCSV } from '@clawee/protocol';
import { EnterpriseHttpError, enterpriseHttpErrorDetails, type EnterpriseHttpClient } from './http-client-2026-07-30.js';
import { EnterpriseSessionError, type EnterpriseSessionManager } from './session-manager-2026-07-30.js';

export type SkillContributionsManager = {
  capability(): Promise<{ allowed: boolean }>;
  requireRead(): Promise<void>;
  query(endpoint: 'summary' | 'records' | 'detail', query: SkillContributionQuery | { skill_id?: string; version_id?: string }): Promise<SkillContributionResponse>;
  export(query: SkillContributionQuery): Promise<SkillContributionCSV>;
};

export function createSkillContributionsManager(input: { sessionManager: EnterpriseSessionManager; httpClient: EnterpriseHttpClient }): SkillContributionsManager {
  async function call<T>(operation: (token: string) => Promise<T>): Promise<T> {
    const token = await input.sessionManager.requireAccessToken();
    try { return await operation(token); } catch (error) {
      if (error instanceof EnterpriseHttpError) {
        if (error.code === 'ENTERPRISE_UNAUTHORIZED') {
          await input.sessionManager.invalidateUnauthorized();
          throw new EnterpriseSessionError('ENTERPRISE_SESSION_EXPIRED', 401, enterpriseHttpErrorDetails(error));
        }
        const statusCode = error.statusCode !== undefined && error.statusCode >= 400
          ? error.statusCode
          : error.code === 'ENTERPRISE_DATA_VIEW_FORBIDDEN' ? 403 : 502;
        throw new EnterpriseSessionError(error.code, statusCode, enterpriseHttpErrorDetails(error));
      }
      throw error;
    }
  }
  const manager: SkillContributionsManager = {
    capability: () => call(async token => ({ allowed: await input.httpClient.hasSkillContributionGrant?.(token) ?? false })),
    async requireRead() {
      if (!(await manager.capability()).allowed) throw new EnterpriseSessionError('ENTERPRISE_DATA_VIEW_FORBIDDEN', 403);
    },
    query: (endpoint, query) => call(token => {
      if (!input.httpClient.getSkillContributions) throw new EnterpriseSessionError('ENTERPRISE_SERVICE_UNAVAILABLE', 503);
      return input.httpClient.getSkillContributions(token, endpoint, query);
    }),
    export: query => call(token => {
      if (!input.httpClient.exportSkillContributions) throw new EnterpriseSessionError('ENTERPRISE_SERVICE_UNAVAILABLE', 503);
      return input.httpClient.exportSkillContributions(token, query);
    })
  };
  return manager;
}
