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
      getBilibiliDashboard: vi.fn(async () => ({
        status: 'unconfigured' as const,
        range: '7d' as const,
        unavailableParts: [],
        sources: []
      }))
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
      url: '/enterprise/business-dashboards/bilibili-operation?range=30d&sourceId=bdsrc_1',
      headers: { authorization: 'Bearer secret' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'unconfigured',
      range: '7d',
      unavailableParts: [],
      sources: []
    });
    expect(manager.getBilibiliDashboard).toHaveBeenCalledWith({
      range: '30d',
      sourceId: 'bdsrc_1'
    });
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

  it.each([
    '/enterprise/business-dashboards/bilibili-operation?range=90d',
    '/enterprise/business-dashboards/bilibili-operation?sourceId='
  ])('rejects invalid dashboard query parameters: %s', async url => {
    const manager: EnterpriseBusinessDashboardManager = {
      getBilibiliDashboard: vi.fn()
    };
    server = await buildServer({
      token: 'secret',
      enterpriseBusinessDashboardManager: manager
    });

    const response = await server.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer secret' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED' }
    });
    expect(manager.getBilibiliDashboard).not.toHaveBeenCalled();
  });
});
