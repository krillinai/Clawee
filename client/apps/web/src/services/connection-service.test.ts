import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, type RuntimeClient } from '../runtime/client.js';
import { createConnectionService } from './connection-service.js';

describe('ConnectionService', () => {
  it('returns the required model service configuration before reading Codex status', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === '/healthz') {
        return { ok: true, runtimeState: 'configuration_required' };
      }
      if (path === '/runtime/model-service') {
        return {
          status: 'configuration_required',
          mode: 'enterprise_managed'
        };
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const service = createConnectionService({
      get
    } as unknown as Pick<RuntimeClient, 'get'>);

    await expect(service.check()).resolves.toEqual({
      status: 'configuration_required',
      configuration: {
        status: 'configuration_required',
        mode: 'enterprise_managed'
      }
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).not.toHaveBeenCalledWith('/codex/status');
  });

  it('returns invalid_token for unauthorized Runtime responses', async () => {
    const client = {
      async get<T>(): Promise<T> {
        throw new ApiClientError({ status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' });
      }
    } satisfies Pick<RuntimeClient, 'get'>;
    const service = createConnectionService(client);

    await expect(service.check()).resolves.toEqual({ status: 'invalid_token', message: 'Unauthorized' });
  });

  it('returns disconnected for network errors', async () => {
    const client = {
      async get<T>(): Promise<T> {
        throw new TypeError('fetch failed');
      }
    } satisfies Pick<RuntimeClient, 'get'>;
    const service = createConnectionService(client);

    await expect(service.check()).resolves.toEqual({ status: 'disconnected', message: 'fetch failed' });
  });
});
