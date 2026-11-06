import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { requireAuth } from '../../src/api/auth.js';
import { registerModelServiceRoutes } from '../../src/api/routes.model-service.js';
import { createModelServiceRuntime } from '../../src/codex/model-service-configuration.js';
import type { EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';

describe('lightweight model service API', () => {
  it('checks first text over HTTP without running Codex and saves after failed detection', async () => {
    const requests: Array<{ url?: string; authorization?: string; body: unknown }> = [];
    const closed = vi.fn();
    const upstream = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.on('close', closed);
      if (request.headers.authorization !== 'Bearer valid-secret') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'invalid_api_key', message: `Invalid key ${request.headers.authorization}` } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      response.write('data: {"type":"response.created"}\n\n');
      response.write('data: {"type":"response.output_text.delta","delta":"OK"}\n\n');
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    const write = vi.fn();
    const activate = vi.fn();
    const validate = vi.fn().mockRejectedValue(new Error('Codex validation must not run'));
    const availability = vi.fn();
    const runtime = createModelServiceRuntime({
      credentialStore: { async read() { return undefined; }, write, async delete() {} },
      async loadStored() { return { status: { status: 'configuration_required', configuration: null, apiKeyConfigured: false } }; },
      validate,
      activate,
      async deactivate() {},
      onAvailabilityChange: availability
    });
    await runtime.resolve('enterprise-token', async () => ({ mode: 'enterprise_managed' }));
    availability.mockClear();
    const server = Fastify();
    server.addHook('preHandler', requireAuth('local-token'));
    await registerModelServiceRoutes(server, {
      runtime,
      sessionManager: { async requireAccessToken() { return 'enterprise-token'; } } as EnterpriseSessionManager,
      httpClient: {} as EnterpriseHttpClient
    });
    const headers = { authorization: 'Bearer local-token' };
    const configuration = { baseUrl: `http://127.0.0.1:${address.port}/custom/v1`, model: 'model-1', apiKey: 'valid-secret' };
    const originalParentPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
    const postMessage = vi.fn();
    Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
    try {
      const success = await server.inject({ method: 'POST', url: '/runtime/model-service/check', headers, payload: configuration });
      expect(success.json()).toMatchObject({ status: 'succeeded', httpStatus: 200, headersReceived: true, responseReceived: true, stage: 'model_text' });
      expect(requests).toEqual([{ url: '/custom/v1/responses', authorization: 'Bearer valid-secret', body: { model: 'model-1', input: [{ role: 'user', content: '请只回复 OK' }], stream: true, store: false } }]);
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
      expect(activate).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(availability).not.toHaveBeenCalled();
      const draft = { ...configuration, apiKey: 'invalid-secret' };
      const failed = await server.inject({ method: 'POST', url: '/runtime/model-service/check', headers, payload: draft });
      expect(failed.json()).toMatchObject({ status: 'failed', httpStatus: 401, headersReceived: true, responseReceived: false, stage: 'response_body', errorCode: 'MODEL_SERVICE_AUTH_FAILED', suggestion: expect.any(String) });
      expect(failed.body).not.toContain('invalid-secret');
      expect(postMessage).not.toHaveBeenCalled();
      const invalid = await server.inject({ method: 'POST', url: '/runtime/model-service/check', headers, payload: { ...draft, baseUrl: 'not-a-url' } });
      expect(invalid.statusCode).toBe(400);
      const saved = await server.inject({ method: 'POST', url: '/runtime/model-service/configure', headers, payload: draft });
      expect(saved.json()).toMatchObject({ status: 'ready', apiKeyConfigured: true });
      expect(saved.body).not.toContain('invalid-secret');
      expect(write).toHaveBeenCalledWith('invalid-secret');
      expect(activate).toHaveBeenCalledOnce();
      expect(validate).not.toHaveBeenCalled();
      expect(requests).toHaveLength(2);
      expect(availability).toHaveBeenLastCalledWith({ status: 'skipped' });
      const activeFailure = await server.inject({ method: 'POST', url: '/runtime/model-service/check', headers, payload: draft });
      expect(activeFailure.json()).toMatchObject({ status: 'failed', errorCode: 'MODEL_SERVICE_AUTH_FAILED' });
      expect(postMessage).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith({ type: 'clawee_incident', observation: expect.objectContaining({
        source: 'daemon', event_type: 'error', stage: 'model_check.response_body', error_code: 'MODEL_SERVICE_AUTH_FAILED', http_status: 401,
        diagnostics: expect.objectContaining({ error_name: 'ManualModelCheck' })
      }) });
      expect(requests).toHaveLength(3);
      for (const value of ['invalid-secret', 'enterprise-token', 'local-token', configuration.baseUrl]) {
        expect(JSON.stringify(postMessage.mock.calls)).not.toContain(value);
      }
    } finally {
      if (originalParentPort) Object.defineProperty(process, 'parentPort', originalParentPort);
      else Reflect.deleteProperty(process, 'parentPort');
      await server.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    }
  });
});
