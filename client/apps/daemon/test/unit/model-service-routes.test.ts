import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { requireAuth } from '../../src/api/auth.js';
import { registerModelServiceRoutes } from '../../src/api/routes.model-service.js';
import { createModelServiceRuntime } from '../../src/codex/model-service-configuration.js';
import type { EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';

describe('model service routes', () => {
  it('protects key readback and checks drafts without saving, while withholding platform keys', async () => {
    const configuration = { baseUrl: 'https://model.example.test/v1', model: 'model-1' };
    const read = vi.fn(async () => 'local-secret');
    const write = vi.fn();
    const runtime = createModelServiceRuntime({
      credentialStore: { read, write, async delete() {} },
      async loadStored() {
        return { status: { status: 'ready', configuration, apiKeyConfigured: true }, configuration, apiKey: 'local-secret' };
      },
      async validate(request) { return { configuration: { baseUrl: request.baseUrl, model: request.model }, apiKey: request.apiKey }; },
      async activate() {},
      async deactivate() {}
    });
    await runtime.resolve('enterprise-token', async () => ({ mode: 'enterprise_managed' }));
    let signedIn = true;
    const sessionManager = {
      async requireAccessToken() {
        if (!signedIn) throw new Error('signed out');
        return 'enterprise-token';
      }
    } as EnterpriseSessionManager;
    const server = Fastify();
    server.addHook('preHandler', requireAuth('local-token'));
    await registerModelServiceRoutes(server, { runtime, sessionManager, httpClient: {} as EnterpriseHttpClient });
    const headers = { authorization: 'Bearer local-token' };
    try {
      expect((await server.inject({ method: 'GET', url: '/runtime/model-service/api-key' })).statusCode).toBe(401);
      const key = await server.inject({ method: 'GET', url: '/runtime/model-service/api-key', headers });
      expect(key.json()).toEqual({ apiKey: 'local-secret' });
      expect(key.headers['cache-control']).toBe('no-store');
      const status = await server.inject({ method: 'GET', url: '/runtime/model-service', headers });
      expect(status.body).not.toContain('local-secret');
      const draft = await server.inject({ method: 'POST', url: '/runtime/model-service/check', headers,
        payload: { ...configuration, model: 'model-2', apiKey: 'draft-secret' } });
      expect(draft.json()).toMatchObject({ status: 'succeeded', checkedAt: expect.any(String) });
      expect(draft.body).not.toContain('draft-secret');
      expect(write).not.toHaveBeenCalled();
      expect(runtime.status()).toMatchObject({ configuration: { model: 'model-1' } });
      await runtime.resolve('enterprise-token', async () => ({ mode: 'platform_managed', ...configuration, apiKey: 'platform-secret', credentialVersion: 1 }));
      read.mockClear();
      expect((await server.inject({ method: 'GET', url: '/runtime/model-service/api-key', headers })).json()).toEqual({ apiKey: null });
      expect(read).not.toHaveBeenCalled();
      const platformCheck = await server.inject({ method: 'POST', url: '/runtime/model-service/check', headers });
      expect(platformCheck.json().status).toBe('succeeded');
      signedIn = false;
      expect((await server.inject({ method: 'GET', url: '/runtime/model-service/api-key', headers })).statusCode).toBe(401);
      expect((await server.inject({ method: 'POST', url: '/runtime/model-service/check', headers })).statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });
});
