import type {
  ConfigureModelServiceRequest,
  ConfigureModelServiceResponse,
  ModelAccessMode,
  ModelAccessState,
  ModelServiceConfiguration,
  ModelServiceConfigurationStatusResponse
} from '@clawee/protocol';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodexAppServerRequestClient } from './app-server-client.js';
import {
  CLAWEE_MODEL_API_KEY_ENV,
  CLAWEE_MODEL_PROVIDER_ID,
  prepareCodexRuntimeConfiguration,
  readCachedCodexModelServiceConfiguration
} from './runtime-configuration.js';
import {
  CODEX_PROBE_TIMEOUT_MS,
  probeCodex,
  type CodexProbeInput,
  type CodexProbeResult
} from './probe.js';
import type {
  ModelServiceCredentialStore
} from './model-service-credential-store.js';
import type {
  EnterpriseModelConfiguration
} from '../enterprise/http-client-2026-07-30.js';

export type ResolvedModelServiceConfiguration = {
  status: ModelServiceConfigurationStatusResponse;
  configuration?: ModelServiceConfiguration;
  apiKey?: string;
};

export type ModelServiceRuntime = {
  status(): ModelAccessState;
  ready(): boolean;
  resolve(
    accessToken: string,
    fetchConfiguration: (
      accessToken: string
    ) => Promise<EnterpriseModelConfiguration>
  ): Promise<void>;
  signOut(): Promise<void>;
  configure(
    input: ConfigureModelServiceRequest
  ): Promise<ConfigureModelServiceResponse>;
  subscribeReady(listener: () => void): () => void;
};

export type ModelServiceActivationContext = {
  mode: ModelAccessMode;
  credentialVersion?: number;
  modelCatalogPath?: string;
};

export type ModelServiceConfigurationErrorCode =
  | 'MODEL_SERVICE_CONFIGURATION_INVALID'
  | 'MODEL_SERVICE_CONFIGURATION_BUSY'
  | 'MODEL_SERVICE_VALIDATION_FAILED'
  | 'MODEL_SERVICE_SECURE_STORAGE_UNAVAILABLE'
  | 'model_configuration_managed_by_platform';

export class ModelServiceConfigurationError extends Error {
  constructor(
    readonly code: ModelServiceConfigurationErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(`${code}: ${message}`);
    this.name = 'ModelServiceConfigurationError';
  }
}

export async function resolveStoredModelServiceConfiguration(input: {
  codexBin: string;
  codexHome: string;
  credentialStore: ModelServiceCredentialStore;
  createClient(input: {
    codexBin: string;
    codexHome: string;
  }): CodexAppServerRequestClient;
}): Promise<ResolvedModelServiceConfiguration> {
  mkdirSync(input.codexHome, { recursive: true, mode: 0o700 });
  const cached = readCachedCodexModelServiceConfiguration({
    codexBin: input.codexBin,
    codexHome: input.codexHome
  });
  let configuration = cached.configuration;
  if (!cached.cached) {
    const client = input.createClient({
      codexBin: input.codexBin,
      codexHome: input.codexHome
    });
    let response: unknown;
    try {
      response = await client.request('config/read', {
        includeLayers: false,
        cwd: null
      });
    } finally {
      await client.close();
    }
    configuration = parseStoredConfiguration(response);
  }
  let apiKey: string | undefined;
  try {
    apiKey = await input.credentialStore.read();
  } catch (error) {
    throw new ModelServiceConfigurationError(
      'MODEL_SERVICE_SECURE_STORAGE_UNAVAILABLE',
      error instanceof Error ? error.message : String(error)
    );
  }
  const ready = configuration !== undefined && apiKey !== undefined;
  return {
    status: {
      status: ready ? 'ready' : 'configuration_required',
      configuration: configuration ?? null,
      apiKeyConfigured: apiKey !== undefined
    },
    ...(configuration === undefined ? {} : { configuration }),
    ...(apiKey === undefined ? {} : { apiKey })
  };
}

export function createModelServiceRuntime(input: {
  credentialStore: ModelServiceCredentialStore;
  loadStored(): Promise<ResolvedModelServiceConfiguration>;
  validate(
    request: ConfigureModelServiceRequest
  ): Promise<{
    configuration: ModelServiceConfiguration;
    apiKey: string;
  }>;
  preparePlatformCatalog?(
    configuration: ModelServiceConfiguration,
    apiKey: string,
    credentialVersion: number
  ): Promise<{ modelCatalogPath: string }>;
  activate(
    configuration: ModelServiceConfiguration,
    apiKey: string,
    context: ModelServiceActivationContext
  ): Promise<void>;
  deactivate(): Promise<void>;
}): ModelServiceRuntime {
  let current: ModelAccessState = { status: 'resolving' };
  let configuring = false;
  let resolutionId = 0;
  let transition = Promise.resolve();
  const listeners = new Set<() => void>();

  async function runTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = transition;
    let release!: () => void;
    transition = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  function publishReady(
    mode: ModelAccessMode,
    configuration: ModelServiceConfiguration
  ): void {
    current = { status: 'ready', mode, configuration };
    for (const listener of listeners) listener();
  }

  async function activateResolved(
    operationId: number,
    mode: ModelAccessMode,
    configuration: ModelServiceConfiguration,
    apiKey: string,
    credentialVersion?: number
  ): Promise<void> {
    await runTransition(async () => {
      if (operationId !== resolutionId) return;
      await input.activate(configuration, apiKey, {
        mode,
        ...(credentialVersion === undefined ? {} : { credentialVersion })
      });
      if (operationId !== resolutionId) {
        await input.deactivate();
        return;
      }
      publishReady(mode, configuration);
    });
  }

  return {
    status() {
      return structuredClone(current);
    },
    ready() {
      return current.status === 'ready';
    },
    async resolve(accessToken, fetchConfiguration) {
      const operationId = ++resolutionId;
      let resolvedMode: ModelAccessMode | undefined;
      current = { status: 'resolving' };
      try {
        await runTransition(async () => {
          if (operationId === resolutionId) await input.deactivate();
        });
        if (operationId !== resolutionId) return;
        const remote = await fetchConfiguration(accessToken);
        resolvedMode = remote.mode;
        if (operationId !== resolutionId) return;
        if (remote.mode === 'enterprise_managed') {
          let stored: ResolvedModelServiceConfiguration;
          try {
            stored = await input.loadStored();
          } catch (error) {
            if (operationId !== resolutionId) return;
            current = {
              status: 'unavailable',
              code: modelAccessErrorCode(error),
              mode: remote.mode
            };
            return;
          }
          if (
            operationId !== resolutionId
            || stored.configuration === undefined
            || stored.apiKey === undefined
          ) {
            if (operationId === resolutionId) {
              current = {
                status: 'configuration_required',
                mode: remote.mode
              };
            }
            return;
          }
          try {
            const validated = await input.validate({
              ...stored.configuration,
              apiKey: stored.apiKey
            });
            await activateResolved(
              operationId,
              remote.mode,
              validated.configuration,
              validated.apiKey
            );
          } catch {
            if (operationId === resolutionId) {
              current = {
                status: 'configuration_required',
                mode: remote.mode
              };
            }
          }
          return;
        }

        const platformConfiguration = {
          baseUrl: remote.baseUrl,
          model: remote.defaultModel ?? remote.model
        };
        const preparedCatalog = await input.preparePlatformCatalog?.(
          platformConfiguration,
          remote.apiKey,
          remote.credentialVersion
        );
        if (operationId !== resolutionId) return;
        const validated = await input.validate({
          ...platformConfiguration,
          apiKey: remote.apiKey
        });
        if (operationId !== resolutionId) return;
        await runTransition(async () => {
          if (operationId !== resolutionId) return;
          await input.credentialStore.delete();
          if (operationId !== resolutionId) return;
          await input.activate(validated.configuration, validated.apiKey, {
            mode: remote.mode,
            credentialVersion: remote.credentialVersion,
            ...(preparedCatalog === undefined
              ? {}
              : { modelCatalogPath: preparedCatalog.modelCatalogPath })
          });
          if (operationId !== resolutionId) {
            await input.deactivate();
            return;
          }
          publishReady(remote.mode, validated.configuration);
        });
      } catch (error) {
        if (operationId !== resolutionId) return;
        current = {
          status: 'unavailable',
          code: modelAccessErrorCode(error),
          ...(resolvedMode === undefined
            ? {}
            : { mode: resolvedMode })
        };
      }
    },
    async signOut() {
      resolutionId += 1;
      current = { status: 'resolving' };
      await runTransition(() => input.deactivate());
    },
    async configure(request) {
      if (
        'mode' in current
        && current.mode === 'platform_managed'
      ) {
        throw new ModelServiceConfigurationError(
          'model_configuration_managed_by_platform',
          'model configuration is managed by the platform'
        );
      }
      if (
        current.status !== 'configuration_required'
        || current.mode !== 'enterprise_managed'
      ) {
        throw new ModelServiceConfigurationError(
          'MODEL_SERVICE_CONFIGURATION_BUSY',
          'model access mode is not ready for manual configuration'
        );
      }
      if (configuring) {
        throw new ModelServiceConfigurationError(
          'MODEL_SERVICE_CONFIGURATION_BUSY',
          'model service configuration is already being verified'
        );
      }
      configuring = true;
      const operationId = ++resolutionId;
      try {
        let previousApiKey: string | undefined;
        try {
          previousApiKey = await input.credentialStore.read();
        } catch (error) {
          throw new ModelServiceConfigurationError(
            'MODEL_SERVICE_SECURE_STORAGE_UNAVAILABLE',
            error instanceof Error ? error.message : String(error)
          );
        }
        const validated = await input.validate(request);
        if (operationId !== resolutionId) {
          throw new ModelServiceConfigurationError(
            'MODEL_SERVICE_CONFIGURATION_BUSY',
            'model service configuration was superseded'
          );
        }
        await runTransition(async () => {
          if (operationId !== resolutionId) {
            throw new ModelServiceConfigurationError(
              'MODEL_SERVICE_CONFIGURATION_BUSY',
              'model service configuration was superseded'
            );
          }
          try {
            await input.credentialStore.write(validated.apiKey);
          } catch (error) {
            await restoreCredential(input.credentialStore, previousApiKey);
            throw new ModelServiceConfigurationError(
              'MODEL_SERVICE_SECURE_STORAGE_UNAVAILABLE',
              error instanceof Error ? error.message : String(error)
            );
          }
          try {
            if (operationId !== resolutionId) {
              throw new ModelServiceConfigurationError(
                'MODEL_SERVICE_CONFIGURATION_BUSY',
                'model service configuration was superseded'
              );
            }
            await input.activate(
              validated.configuration,
              validated.apiKey,
              { mode: 'enterprise_managed' }
            );
          } catch (error) {
            await restoreCredential(input.credentialStore, previousApiKey);
            throw error;
          }
          if (operationId !== resolutionId) {
            await input.deactivate();
            await restoreCredential(input.credentialStore, previousApiKey);
            throw new ModelServiceConfigurationError(
              'MODEL_SERVICE_CONFIGURATION_BUSY',
              'model service configuration was superseded'
            );
          }
          publishReady('enterprise_managed', validated.configuration);
        });
        return {
          status: 'ready',
          configuration: validated.configuration,
          apiKeyConfigured: true
        };
      } finally {
        configuring = false;
      }
    },
    subscribeReady(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

async function restoreCredential(
  store: ModelServiceCredentialStore,
  apiKey: string | undefined
): Promise<void> {
  try {
    if (apiKey === undefined) {
      await store.delete();
    } else {
      await store.write(apiKey);
    }
  } catch (error) {
    throw new ModelServiceConfigurationError(
      'MODEL_SERVICE_SECURE_STORAGE_UNAVAILABLE',
      error instanceof Error ? error.message : String(error)
    );
  }
}

function modelAccessErrorCode(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    return error.code;
  }
  return 'MODEL_CONFIGURATION_UNAVAILABLE';
}

export async function validateModelServiceConfiguration(input: {
  codexBin: string;
  dataDir: string;
  request: ConfigureModelServiceRequest;
  timeoutMs?: number;
  probe?(input: CodexProbeInput): Promise<CodexProbeResult>;
}): Promise<{
  configuration: ModelServiceConfiguration;
  apiKey: string;
}> {
  const validated = parseConfigureRequest(input.request);
  const validationRoot = await mkdtemp(
    join(input.dataDir, 'model-service-validation-')
  );
  const codexHome = join(validationRoot, 'codex-home');
  const cwd = join(validationRoot, 'workspace');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const env = {
    [CLAWEE_MODEL_API_KEY_ENV]: validated.apiKey
  };
  try {
    const prepared = await prepareCodexRuntimeConfiguration({
      codexBin: input.codexBin,
      codexHome,
      cwd,
      requestTimeoutMs: 15_000,
      env,
      modelService: validated.configuration
    });
    await prepared.client.close();
    const result = await (input.probe ?? probeCodex)({
      codexBin: input.codexBin,
      codexHome,
      cwd,
      timeoutMs: input.timeoutMs ?? CODEX_PROBE_TIMEOUT_MS,
      env
    });
    if (!result.ready) {
      throw new ModelServiceConfigurationError(
        'MODEL_SERVICE_VALIDATION_FAILED',
        '模型服务验证失败，请检查 Base URL、API Key 和模型名称',
        {
          responseReceived: result.responseReceived,
          terminationReason: result.terminationReason,
          ...(result.errorCode === undefined
            ? {}
            : { errorCode: result.errorCode }),
          ...(result.stderrSummary === undefined
            ? {}
            : { message: result.stderrSummary })
        }
      );
    }
    return validated;
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

function parseConfigureRequest(
  value: ConfigureModelServiceRequest
): {
  configuration: ModelServiceConfiguration;
  apiKey: string;
} {
  if (!isRecord(value)) invalid('请求必须是对象');
  const baseUrl = normalizeBaseUrl(value.baseUrl);
  const model = normalizedString(value.model);
  const apiKey = normalizedString(value.apiKey);
  if (
    model === undefined
    || model.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)
  ) {
    invalid('模型名称格式无效');
  }
  if (
    apiKey === undefined
    || Buffer.byteLength(apiKey) > 64 * 1024
  ) {
    invalid('API Key 不能为空或超过允许长度');
  }
  return {
    configuration: { baseUrl, model },
    apiKey
  };
}

function parseStoredConfiguration(
  value: unknown
): ModelServiceConfiguration | undefined {
  if (!isRecord(value) || !isRecord(value.config)) return undefined;
  const config = value.config;
  if (
    config.model_provider !== CLAWEE_MODEL_PROVIDER_ID
    || typeof config.model !== 'string'
    || !isRecord(config.model_providers)
    || !isRecord(config.model_providers[CLAWEE_MODEL_PROVIDER_ID])
  ) {
    return undefined;
  }
  const provider = config.model_providers[CLAWEE_MODEL_PROVIDER_ID];
  if (
    provider.name !== 'Clawee'
    || typeof provider.base_url !== 'string'
    || provider.wire_api !== 'responses'
    || provider.requires_openai_auth !== false
    || provider.env_key !== CLAWEE_MODEL_API_KEY_ENV
  ) {
    return undefined;
  }
  try {
    return {
      baseUrl: normalizeBaseUrl(provider.base_url),
      model: parseStoredModel(config.model)
    };
  } catch {
    return undefined;
  }
}

function normalizeBaseUrl(value: unknown): string {
  const normalized = normalizedString(value);
  if (normalized === undefined || normalized.length > 2_048) {
    invalid('Base URL 不能为空或超过允许长度');
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    invalid('Base URL 必须是有效的 HTTP 或 HTTPS 地址');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    invalid('Base URL 必须是无凭据、查询参数和片段的 HTTP 或 HTTPS 地址');
  }
  return url.toString().replace(/\/+$/, '');
}

function parseStoredModel(value: string): string {
  const model = normalizedString(value);
  if (
    model === undefined
    || model.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)
  ) {
    throw new Error('invalid model');
  }
  return model;
}

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function invalid(message: string): never {
  throw new ModelServiceConfigurationError(
    'MODEL_SERVICE_CONFIGURATION_INVALID',
    message
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
