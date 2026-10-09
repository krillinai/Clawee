import {
  mkdtempSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexAppServerClient } from '../../src/codex/app-server-client.js';
import {
  createModelServiceRuntime,
  ModelServiceConfigurationError,
  resolveStoredModelServiceConfiguration,
  type ResolvedModelServiceConfiguration,
  validateModelServiceConfiguration
} from '../../src/codex/model-service-configuration.js';
import type {
  ModelServiceCredentialStore
} from '../../src/codex/model-service-credential-store.js';
import {
  CLAWEE_MODEL_API_KEY_ENV,
  prepareCodexRuntimeConfiguration
} from '../../src/codex/runtime-configuration.js';
import { createFakeAppServer } from '../helpers/fake-app-server.js';

let tempDir = '';

afterEach(() => {
  if (tempDir.length > 0) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = '';
});

describe('model service configuration', () => {
  it('writes an isolated Responses provider and verifies it with the supplied API key', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-model-service-'));
    const fake = createFakeAppServer({
      directory: join(tempDir, 'fake')
    });
    const probe = vi.fn(async input => ({
      ready: true,
      responseReceived: true,
      markerMatched: true,
      durationMs: 12,
      timings: {
        homePreparationMs: 1,
        responseReceivedMs: 10,
        processExitMs: 12
      },
      exitCode: 0,
      signal: null,
      terminationReason: 'completed' as const
    }));

    await expect(validateModelServiceConfiguration({
      codexBin: fake.bin,
      dataDir: tempDir,
      request: {
        baseUrl: 'https://api.example.test/v1/',
        model: 'model-1',
        apiKey: 'secret-key'
      },
      probe
    })).resolves.toEqual({
      configuration: {
        baseUrl: 'https://api.example.test/v1',
        model: 'model-1'
      },
      apiKey: 'secret-key'
    });

    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      codexBin: fake.bin,
      env: {
        [CLAWEE_MODEL_API_KEY_ENV]: 'secret-key'
      }
    }));
    const write = fake.readMessages().find(
      message => message.method === 'config/batchWrite'
    );
    expect(write?.params).toMatchObject({
      edits: expect.arrayContaining([
        {
          keyPath: 'model',
          value: 'model-1',
          mergeStrategy: 'upsert'
        },
        {
          keyPath: 'model_provider',
          value: 'clawee',
          mergeStrategy: 'upsert'
        },
        {
          keyPath: 'model_providers.clawee.base_url',
          value: 'https://api.example.test/v1',
          mergeStrategy: 'upsert'
        },
        {
          keyPath: 'model_providers.clawee.env_key',
          value: CLAWEE_MODEL_API_KEY_ENV,
          mergeStrategy: 'upsert'
        }
      ])
    });
  });

  it('loads ready only when public config and secure API key are both present', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawee-model-service-'));
    const fake = createFakeAppServer({
      directory: join(tempDir, 'fake')
    });
    const codexHome = join(tempDir, 'codex-home');
    const prepared = await prepareCodexRuntimeConfiguration({
      codexBin: fake.bin,
      codexHome,
      modelService: {
        baseUrl: 'https://api.example.test/v1',
        model: 'model-1'
      },
      env: {
        [CLAWEE_MODEL_API_KEY_ENV]: 'secret-key'
      }
    });
    await prepared.client.close();

    await expect(resolveStoredModelServiceConfiguration({
      codexBin: fake.bin,
      codexHome,
      credentialStore: credentialStore('secret-key'),
      createClient: createCodexAppServerClient
    })).resolves.toEqual({
      status: {
        status: 'ready',
        configuration: {
          baseUrl: 'https://api.example.test/v1',
          model: 'model-1'
        },
        apiKeyConfigured: true
      },
      configuration: {
        baseUrl: 'https://api.example.test/v1',
        model: 'model-1'
      },
      apiKey: 'secret-key'
    });
    expect(fake.readSpawns()).toHaveLength(2);

    await expect(resolveStoredModelServiceConfiguration({
      codexBin: fake.bin,
      codexHome,
      credentialStore: credentialStore(undefined),
      createClient: createCodexAppServerClient
    })).resolves.toMatchObject({
      status: {
        status: 'configuration_required',
        apiKeyConfigured: false
      }
    });
    expect(fake.readSpawns()).toHaveLength(2);
  });

  it('does not become ready until validation, secure persistence, and activation all succeed', async () => {
    const operations: string[] = [];
    const listeners = vi.fn();
    const store: ModelServiceCredentialStore = {
      async read() {
        return undefined;
      },
      async write() {
        operations.push('credential');
      },
      async delete() {
        operations.push('delete');
      }
    };
    const runtime = createModelServiceRuntime({
      credentialStore: store,
      async loadStored() {
        return {
          status: {
            status: 'configuration_required',
            configuration: null,
            apiKeyConfigured: false
          }
        };
      },
      async validate(request) {
        operations.push('validate');
        return {
          configuration: {
            baseUrl: request.baseUrl,
            model: request.model
          },
          apiKey: request.apiKey
        };
      },
      async activate() {
        operations.push('activate');
      },
      async deactivate() {
        operations.push('deactivate');
      }
    });
    runtime.subscribeReady(listeners);

    await runtime.resolve('token', async () => ({
      mode: 'enterprise_managed'
    }));
    operations.length = 0;

    expect(runtime.ready()).toBe(false);
    await expect(runtime.configure({
      baseUrl: 'https://api.example.test/v1',
      model: 'model-1',
      apiKey: 'secret-key'
    })).resolves.toEqual({
      status: 'ready',
      configuration: {
        baseUrl: 'https://api.example.test/v1',
        model: 'model-1'
      },
      apiKeyConfigured: true
    });
    expect(operations).toEqual(['validate', 'credential', 'activate']);
    expect(runtime.ready()).toBe(true);
    expect(listeners).toHaveBeenCalledOnce();
  });

  it('activates stored configuration without waiting for model availability', async () => {
    const request = { baseUrl: 'https://api.example.test/v1', model: 'model-1', apiKey: 'secret' };
    const validation = deferred<{ configuration: typeof request; apiKey: string }>();
    const runtime = createModelServiceRuntime({
      credentialStore: credentialStore(request.apiKey),
      async loadStored() {
        return {
          status: { status: 'ready', configuration: request, apiKeyConfigured: true },
          configuration: request,
          apiKey: request.apiKey
        };
      },
      validate: () => validation.promise,
      async activate() {},
      async deactivate() {}
    });
    const resolving = runtime.resolve('token', async () => ({ mode: 'enterprise_managed' }));
    try {
      await vi.waitFor(() => expect(runtime.ready()).toBe(true), { timeout: 200 });
    } finally {
      validation.resolve({ configuration: request, apiKey: request.apiKey });
      await resolving;
    }
  });

  it('applies platform configuration in memory without writing credentials', async () => {
    const operations: string[] = [];
    const runtime = createModelServiceRuntime({
      credentialStore: {
        async read() {
          throw new Error('platform mode must not read local credentials');
        },
        async write() {
          operations.push('write');
        },
        async delete() {
          operations.push('delete');
        }
      },
      async loadStored() {
        throw new Error('platform mode must not load stored configuration');
      },
      async validate(request) {
        operations.push('validate');
        return {
          configuration: { baseUrl: request.baseUrl, model: request.model },
          apiKey: request.apiKey
        };
      },
      async preparePlatformCatalog(configuration, apiKey, credentialVersion) {
        expect(configuration).toEqual({
          baseUrl: 'https://platform.example/v1',
          model: 'platform-model'
        });
        expect(apiKey).toBe('platform-secret');
        expect(credentialVersion).toBe(3);
        operations.push('catalog');
        return { modelCatalogPath: '/catalog/current.json' };
      },
      async activate(_configuration, apiKey, context) {
        expect(apiKey).toBe('platform-secret');
        expect(context).toEqual({
          mode: 'platform_managed',
          credentialVersion: 3,
          modelCatalogPath: '/catalog/current.json'
        });
        operations.push('activate');
      },
      async deactivate() {
        operations.push('deactivate');
      }
    });

    await runtime.resolve('enterprise-token', async () => ({
      mode: 'platform_managed',
      baseUrl: 'https://platform.example/v1',
      model: 'legacy-model',
      defaultModel: 'platform-model',
      apiKey: 'platform-secret',
      credentialVersion: 3
    }));

    expect(operations).toEqual([
      'deactivate',
      'catalog',
      'delete',
      'activate',
      'validate'
    ]);
    expect(runtime.status()).toEqual({
      status: 'ready',
      mode: 'platform_managed',
      configuration: {
        baseUrl: 'https://platform.example/v1',
        model: 'platform-model'
      }
    });
    expect(JSON.stringify(runtime.status())).not.toContain('platform-secret');
    await expect(runtime.configure({
      baseUrl: 'https://enterprise.example/v1',
      model: 'enterprise-model',
      apiKey: 'enterprise-secret'
    })).rejects.toMatchObject({
      code: 'model_configuration_managed_by_platform'
    });
  });

  it('keeps platform configuration ready when background validation fails', async () => {
    const operations: string[] = [];
    const activate = vi.fn();
    const availability = vi.fn();
    const runtime = createModelServiceRuntime({
      credentialStore: credentialStore(undefined),
      async loadStored() {
        throw new Error('unexpected local configuration read');
      },
      async preparePlatformCatalog() {
        operations.push('catalog');
        return { modelCatalogPath: '/catalog/current.json' };
      },
      async validate() {
        operations.push('validate');
        throw new Error('validation failed');
      },
      activate,
      onAvailabilityChange: availability,
      async deactivate() {
        operations.push('deactivate');
      }
    });

    await runtime.resolve('enterprise-token', async () => ({
      mode: 'platform_managed',
      baseUrl: 'https://platform.example/v1',
      model: 'platform-model',
      apiKey: 'platform-secret',
      credentialVersion: 1
    }));

    expect(operations).toEqual(['deactivate', 'catalog', 'validate']);
    expect(runtime.status()).toMatchObject({
      status: 'ready',
      mode: 'platform_managed'
    });
    expect(activate).toHaveBeenCalled();
    await vi.waitFor(() => expect(availability).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' })));
  });

  it('does not activate platform configuration when deleting old credentials fails', async () => {
    const activate = vi.fn();
    const runtime = createModelServiceRuntime({
      credentialStore: {
        async read() {
          return 'old-secret';
        },
        async write() {},
        async delete() {
          throw new Error('delete failed');
        }
      },
      async loadStored() {
        throw new Error('unexpected local configuration read');
      },
      async validate(request) {
        return {
          configuration: { baseUrl: request.baseUrl, model: request.model },
          apiKey: request.apiKey
        };
      },
      activate,
      async deactivate() {}
    });

    await runtime.resolve('enterprise-token', async () => ({
      mode: 'platform_managed',
      baseUrl: 'https://platform.example/v1',
      model: 'platform-model',
      apiKey: 'platform-secret',
      credentialVersion: 1
    }));

    expect(runtime.status()).toMatchObject({
      status: 'unavailable',
      mode: 'platform_managed'
    });
    expect(activate).not.toHaveBeenCalled();
  });

  it('does not read local configuration after a remote failure or activate a stale result', async () => {
    const loadStored = vi.fn();
    const validate = vi.fn(async () => ({
      configuration: {
        baseUrl: 'https://platform.example/v1',
        model: 'platform-model'
      },
      apiKey: 'platform-secret'
    }));
    const activate = vi.fn();
    const runtime = createModelServiceRuntime({
      credentialStore: credentialStore(undefined),
      loadStored,
      validate,
      activate,
      deactivate: vi.fn(async () => undefined)
    });

    await runtime.resolve('enterprise-token', async () => {
      throw new Error('network unavailable');
    });
    expect(runtime.status()).toMatchObject({ status: 'unavailable' });
    expect(loadStored).not.toHaveBeenCalled();

    const remote = deferred<{
      mode: 'platform_managed';
      baseUrl: string;
      model: string;
      apiKey: string;
      credentialVersion: number;
    }>();
    const resolving = runtime.resolve('enterprise-token', async () => remote.promise);
    await vi.waitFor(() => expect(runtime.status()).toEqual({ status: 'resolving' }));
    await runtime.signOut();
    remote.resolve({
      mode: 'platform_managed',
      baseUrl: 'https://platform.example/v1',
      model: 'platform-model',
      apiKey: 'platform-secret',
      credentialVersion: 1
    });
    await resolving;
    expect(validate).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it('ignores a stale stored-configuration failure after sign-out', async () => {
    const stored = deferred<ResolvedModelServiceConfiguration>();
    const loadStored = vi.fn(async () => stored.promise);
    const runtime = createModelServiceRuntime({
      credentialStore: credentialStore(undefined),
      loadStored,
      async validate(request) {
        return {
          configuration: { baseUrl: request.baseUrl, model: request.model },
          apiKey: request.apiKey
        };
      },
      activate: vi.fn(),
      deactivate: vi.fn(async () => undefined)
    });

    const resolving = runtime.resolve('enterprise-token', async () => ({
      mode: 'enterprise_managed'
    }));
    await vi.waitFor(() => expect(loadStored).toHaveBeenCalledOnce());
    await runtime.signOut();
    stored.reject(new Error('stale local read failed'));
    await resolving;

    expect(runtime.status()).toEqual({ status: 'resolving' });
  });

  it('serializes stale activation cleanup before activating the latest result', async () => {
    const firstActivation = deferred<void>();
    let activeKey: string | undefined;
    const activate = vi.fn(async (_configuration, apiKey: string) => {
      if (apiKey === 'first-secret') await firstActivation.promise;
      activeKey = apiKey;
    });
    const runtime = createModelServiceRuntime({
      credentialStore: credentialStore(undefined),
      async loadStored() {
        throw new Error('unexpected local configuration read');
      },
      async validate(request) {
        return {
          configuration: { baseUrl: request.baseUrl, model: request.model },
          apiKey: request.apiKey
        };
      },
      activate,
      async deactivate() {
        activeKey = undefined;
      }
    });
    const platform = (model: string, apiKey: string) => async () => ({
      mode: 'platform_managed' as const,
      baseUrl: 'https://platform.example/v1',
      model,
      apiKey,
      credentialVersion: 1
    });

    const first = runtime.resolve('first-token', platform('first-model', 'first-secret'));
    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
    const second = runtime.resolve('second-token', platform('second-model', 'second-secret'));
    firstActivation.resolve();
    await Promise.all([first, second]);

    expect(activeKey).toBe('second-secret');
    expect(runtime.status()).toMatchObject({
      status: 'ready',
      mode: 'platform_managed',
      configuration: { model: 'second-model' }
    });
  });

  it('serializes platform credential deletion between resolutions', async () => {
    const firstDelete = deferred<void>();
    const remove = vi.fn(async () => {
      if (remove.mock.calls.length === 1) await firstDelete.promise;
    });
    const runtime = createModelServiceRuntime({
      credentialStore: {
        async read() {
          return undefined;
        },
        async write() {},
        delete: remove
      },
      async loadStored() {
        throw new Error('unexpected local configuration read');
      },
      async validate(request) {
        return {
          configuration: { baseUrl: request.baseUrl, model: request.model },
          apiKey: request.apiKey
        };
      },
      activate: vi.fn(async () => undefined),
      deactivate: vi.fn(async () => undefined)
    });
    const platform = (model: string) => async () => ({
      mode: 'platform_managed' as const,
      baseUrl: 'https://platform.example/v1',
      model,
      apiKey: `${model}-secret`,
      credentialVersion: 1
    });

    const first = runtime.resolve('first-token', platform('first-model'));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    const second = runtime.resolve('second-token', platform('second-model'));
    await Promise.resolve();
    expect(remove).toHaveBeenCalledOnce();
    firstDelete.resolve();
    await Promise.all([first, second]);

    expect(remove).toHaveBeenCalledTimes(2);
    expect(runtime.status()).toMatchObject({
      status: 'ready',
      configuration: { model: 'second-model' }
    });
  });

  it('checks drafts without saving or activating them and allows updating ready enterprise configuration', async () => {
    const request = { baseUrl: 'https://api.example.test/v1', model: 'model-1', apiKey: 'old-secret' };
    const store = credentialStore(request.apiKey);
    const write = vi.spyOn(store, 'write');
    const activate = vi.fn();
    const runtime = createModelServiceRuntime({
      credentialStore: store,
      async loadStored() {
        return { status: { status: 'ready', configuration: request, apiKeyConfigured: true }, configuration: request, apiKey: request.apiKey };
      },
      async validate(target) { return { configuration: { baseUrl: target.baseUrl, model: target.model }, apiKey: target.apiKey }; },
      activate,
      async deactivate() {}
    });
    await runtime.resolve('token', async () => ({ mode: 'enterprise_managed' }));
    expect(await runtime.readApiKey()).toBe('old-secret');
    activate.mockClear();
    const draft = { ...request, model: 'model-2', apiKey: 'new-secret' };
    expect(await runtime.check(draft)).toMatchObject({ status: 'succeeded', checkedAt: expect.any(String) });
    expect(write).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(runtime.status()).toMatchObject({ configuration: { model: 'model-1' } });
    await runtime.configure(draft);
    expect(write).toHaveBeenCalledWith('new-secret');
    expect(runtime.status()).toMatchObject({ configuration: { model: 'model-2' } });
  });

  it('retains the current background check when saving an invalid draft fails', async () => {
    const configuration = { baseUrl: 'https://api.example.test/v1', model: 'model-1' };
    const validation = deferred<{ configuration: typeof configuration; apiKey: string }>();
    const availability = vi.fn();
    const runtime = createModelServiceRuntime({
      credentialStore: credentialStore('saved-secret'),
      async loadStored() {
        return { status: { status: 'ready', configuration, apiKeyConfigured: true }, configuration, apiKey: 'saved-secret' };
      },
      validate: vi.fn().mockImplementationOnce(() => validation.promise).mockRejectedValue(
        new ModelServiceConfigurationError('MODEL_SERVICE_VALIDATION_FAILED', '检测失败', { message: '401 Unauthorized api_key=draft-secret' })
      ),
      async activate() {},
      async deactivate() {},
      onAvailabilityChange: availability
    });
    await runtime.resolve('token', async () => ({ mode: 'enterprise_managed' }));
    const draft = { ...configuration, apiKey: 'draft-secret' };
    await expect(runtime.configure(draft)).rejects.toMatchObject({ code: 'MODEL_SERVICE_VALIDATION_FAILED' });
    validation.resolve({ configuration, apiKey: 'saved-secret' });
    await vi.waitFor(() => expect(availability).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded' })));
    const result = await runtime.check(draft);
    expect(result).toMatchObject({ status: 'failed', message: '模型服务认证失败，请检查 API Key' });
    expect(JSON.stringify(result)).not.toContain('draft-secret');
    expect(runtime.ready()).toBe(true);
  });

  it('does not expose platform keys or publish stale checks after sign-out', async () => {
    const validation = deferred<{ configuration: { baseUrl: string; model: string }; apiKey: string }>();
    const availability = vi.fn();
    const read = vi.fn();
    const runtime = createModelServiceRuntime({
      credentialStore: { ...credentialStore(undefined), read },
      async loadStored() { throw new Error('unexpected'); },
      validate: () => validation.promise,
      async activate() {},
      async deactivate() {},
      onAvailabilityChange: availability
    });
    await runtime.resolve('token', async () => ({ mode: 'platform_managed', baseUrl: 'https://api.example.test/v1', model: 'model-1', apiKey: 'platform-secret', credentialVersion: 1 }));
    expect(await runtime.readApiKey()).toBeNull();
    expect(read).not.toHaveBeenCalled();
    await expect(runtime.check({ baseUrl: 'https://draft.example/v1', model: 'draft', apiKey: 'draft-secret' })).rejects.toMatchObject({ code: 'model_configuration_managed_by_platform' });
    await runtime.signOut();
    availability.mockClear();
    validation.reject(new Error('old check failed'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(availability).not.toHaveBeenCalled();
    expect(await runtime.readApiKey()).toBeNull();
  });

  it('restores the previous enterprise API key when activation fails', async () => {
    let stored = 'old-secret';
    const runtime = createModelServiceRuntime({
      credentialStore: {
        async read() {
          return stored;
        },
        async write(apiKey) {
          stored = apiKey;
        },
        async delete() {
          stored = '';
        }
      },
      async loadStored() {
        return {
          status: {
            status: 'configuration_required',
            configuration: null,
            apiKeyConfigured: false
          }
        };
      },
      async validate(request) {
        return {
          configuration: { baseUrl: request.baseUrl, model: request.model },
          apiKey: request.apiKey
        };
      },
      async activate() {
        throw new Error('activation failed');
      },
      async deactivate() {}
    });
    await runtime.resolve('enterprise-token', async () => ({
      mode: 'enterprise_managed'
    }));

    await expect(runtime.configure({
      baseUrl: 'https://enterprise.example/v1',
      model: 'enterprise-model',
      apiKey: 'new-secret'
    })).rejects.toThrow('activation failed');
    expect(stored).toBe('old-secret');
  });
});

function credentialStore(
  apiKey: string | undefined
): ModelServiceCredentialStore {
  return {
    async read() {
      return apiKey;
    },
    async write() {},
    async delete() {}
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
