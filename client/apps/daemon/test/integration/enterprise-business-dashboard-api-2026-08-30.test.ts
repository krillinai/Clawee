import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../helpers/build-server.js';
import {
  EnterpriseBusinessDashboardManagerError,
  type EnterpriseBusinessDashboardManager
} from '../../src/enterprise/business-dashboard-manager-2026-08-30.js';

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('enterprise Bilibili dashboard runtime API', () => {
  it('requires runtime authentication and returns the manager response', async () => {
    const manager: EnterpriseBusinessDashboardManager = {
      getBilibiliDashboard: vi.fn(async () => ({ status: 'unconfigured' as const }))
    };
    server = await buildServer({
      token: 'secret',
      enterpriseBusinessDashboardManager: manager
    });

    const unauthorized = await server.inject({
      method: 'GET',
      url: '/enterprise/business-dashboards/bilibili-operation'
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await server.inject({
      method: 'GET',
      url: '/enterprise/business-dashboards/bilibili-operation',
      headers: { authorization: 'Bearer secret' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'unconfigured' });
    expect(manager.getBilibiliDashboard).toHaveBeenCalledTimes(1);
  });

  it('preserves a stable forbidden response', async () => {
    const manager: EnterpriseBusinessDashboardManager = {
      getBilibiliDashboard: vi.fn(async () => {
        throw new EnterpriseBusinessDashboardManagerError(
          'ENTERPRISE_DATA_VIEW_FORBIDDEN',
          403
        );
      })
    };
    server = await buildServer({
      token: 'secret',
      enterpriseBusinessDashboardManager: manager
    });

    const response = await server.inject({
      method: 'GET',
      url: '/enterprise/business-dashboards/bilibili-operation',
      headers: { authorization: 'Bearer secret' }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'ENTERPRISE_DATA_VIEW_FORBIDDEN' }
    });
  });
});
