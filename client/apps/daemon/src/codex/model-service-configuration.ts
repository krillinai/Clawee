import { isModelResponseEvent, safeIncidentIdentifier } from '@clawee/protocol';
import type {
  AgentEventEnvelope,
  CodexAvailabilityProbe,
  ConfigureModelServiceRequest,
  ConfigureModelServiceResponse,
  ModelAccessMode,
  ModelAccessState,
  ModelServiceConfiguration,
  ModelServiceConfigurationStatusResponse
} from '@clawee/protocol';
import { createHash, randomUUID } from 'node:crypto';
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
import { checkModelServiceConnection } from './model-service-connection.js';
import { classifyProxyFailure, describeProxyEnvironment, proxyErrorMessage } from './network-diagnostics.js';
import { emitIncident, endpointFingerprint } from '../feedback/incidents.js';
import type { GatewayProfileStore } from '../enterprise/gateway-profile-store.js';

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
    ) => Promise<EnterpriseModelConfiguration>,
    gateway?: string
  ): Promise<void>;
  signOut(): Promise<void>;
  configure(
    input: ConfigureModelServiceRequest
  ): Promise<ConfigureModelServiceResponse>;
  check(input?: ConfigureModelServiceRequest): Promise<CodexAvailabilityProbe>;
  checkRuntime?(): Promise<CodexAvailabilityProbe>;
  createResponseObserver?(model?: string | null): ((event: AgentEventEnvelope) => void) | undefined;
  readApiKey(): Promise<string | null>;
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
  gatewayProfiles?: GatewayProfileStore;
  legacyGateway?: string;
  loadStored(): Promise<ResolvedModelServiceConfiguration>;
  validate(
    request: ConfigureModelServiceRequest
  ): Promise<{
    configuration: ModelServiceConfiguration;
    apiKey: string;
  }>;
  checkConnection?(request: ConfigureModelServiceRequest): Promise<CodexAvailabilityProbe>;
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
  onAvailabilityChange?(probe: CodexAvailabilityProbe): void;
  onPerformanceEvent?(details: Record<string, unknown>): void;
}): ModelServiceRuntime {
  let current: ModelAccessState = { status: 'resolving' };
  let configuring = false;
  let resolutionId = 0;
  let checkId = 0;
  let activeRequest: ConfigureModelServiceRequest | undefined;
  let activeGateway: string | undefined;
  let legacyPending = true;
  let transition = Promise.resolve();
  const listeners = new Set<() => void>();
  const reportPerformance = (details: Record<string, unknown>): void => {
    try {
      input.onPerformanceEvent?.(details);
    } catch {
      // 诊断记录失败不能影响 Runtime 检测结果。
    }
  };

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
    configuration: ModelServiceConfiguration,
    apiKey: string
  ): void {
    activeRequest = { ...configuration, apiKey };
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
      publishReady(mode, configuration, apiKey);
    });
  }

  async function checkRuntimeAvailability(): Promise<CodexAvailabilityProbe> {
    const target = activeRequest;
    if (target === undefined || current.status === 'resolving' || configuring) {
      throw new ModelServiceConfigurationError(
        'MODEL_SERVICE_CONFIGURATION_BUSY', '模型配置尚未就绪，请稍后重试'
      );
    }
    const operationId = resolutionId;
    const detectionId = ++checkId;
    const publish = (probe: CodexAvailabilityProbe) => {
      if (detectionId === checkId && operationId === resolutionId) {
        input.onAvailabilityChange?.(probe);
      }
    };
    publish({ status: 'pending' });
    const startedAt = Date.now();
    const fingerprint = endpointFingerprint(target.baseUrl);
    const model = safeIncidentIdentifier(target.model);
    const requestId = randomUUID();
    const network = describeProxyEnvironment(target.baseUrl);
    reportPerformance({
      component: 'model_service',
      event: 'runtime_check_started',
      request_path: '/runtime/model-service/check-runtime',
      ...(fingerprint === undefined ? {} : { endpoint_fingerprint: fingerprint }),
      ...(model === undefined ? {} : { model }),
      request_id: requestId,
      network_path: network.networkPath,
      proxy_env_keys: network.proxyEnvKeys,
      proxy_applies: network.proxyApplies
    });
    let result: CodexAvailabilityProbe;
    try {
      await input.validate(target);
      result = { status: 'succeeded', responseReceived: true };
    } catch (error) {
      const details = error instanceof ModelServiceConfigurationError ? error.details : undefined;
      const timedOut = typeof details?.terminationReason === 'string' && details.terminationReason.includes('timeout');
      const diagnostic = typeof details?.message === 'string' ? details.message : '';
      const proxyErrorCode = typeof details?.proxyErrorCode === 'string' ? details.proxyErrorCode : undefined;
      const proxyCopy = proxyErrorCode !== undefined && isProxyErrorCode(proxyErrorCode) ? proxyErrorMessage(proxyErrorCode) : undefined;
      const message = proxyCopy?.message ?? (timedOut ? '模型检测超时，请检查网络后重试'
        : /\b401\b|unauthorized|invalid.?api.?key/i.test(diagnostic) ? '模型服务认证失败，请检查 API Key'
        : /\b403\b|forbidden/i.test(diagnostic) ? '模型服务拒绝访问，请检查密钥权限'
        : /model[^\n]*(?:not found|does not exist)/i.test(diagnostic) ? '模型不存在或不可访问，请检查模型名称'
        : '模型检测失败，请检查网络、Base URL、API Key 和模型名称');
      result = {
        status: 'failed',
        errorCode: proxyErrorCode !== undefined && isProxyErrorCode(proxyErrorCode)
          ? `MODEL_SERVICE_${proxyErrorCode}`
          : error instanceof ModelServiceConfigurationError ? error.code : 'MODEL_SERVICE_VALIDATION_FAILED',
        message,
        ...(details?.responseReceived === undefined ? {} : { responseReceived: details.responseReceived === true }),
        ...(typeof details?.terminationReason === 'string' ? { terminationReason: details.terminationReason } : {}),
        ...(typeof details?.stderrSummary === 'string' ? { diagnostic: details.stderrSummary.slice(0, 1024) } : {}),
        requestId,
        networkPath: typeof details?.networkPath === 'string' ? details.networkPath as CodexAvailabilityProbe['networkPath'] : network.networkPath,
        proxyEnvKeys: Array.isArray(details?.proxyEnvKeys) ? details.proxyEnvKeys.filter((value): value is string => typeof value === 'string') : network.proxyEnvKeys,
        proxyApplies: typeof details?.proxyApplies === 'boolean' ? details.proxyApplies : network.proxyApplies,
        ...(proxyErrorCode !== undefined && isProxyErrorCode(proxyErrorCode) ? { proxyErrorCode } : {}),
        ...(typeof details?.proxyStage === 'string' ? { proxyStage: details.proxyStage as CodexAvailabilityProbe['proxyStage'] } : {}),
        ...(typeof details?.failureOrigin === 'string' ? { failureOrigin: details.failureOrigin as CodexAvailabilityProbe['failureOrigin'] } : {}),
        ...(proxyCopy === undefined ? {} : { suggestion: proxyCopy.suggestion, retryable: proxyCopy.retryable })
      };
      emitIncident({
        event_type: 'error',
        layer: 'codex_model',
        stage: 'runtime_check',
        scope_id: `runtime-check:${createHash('sha256').update(JSON.stringify([fingerprint, target.model])).digest('hex')}`,
        error_code: safeIncidentIdentifier(result.errorCode) ?? 'MODEL_SERVICE_VALIDATION_FAILED',
        environment: {
          protocol: 'responses',
          transport: 'codex_probe',
          ...(fingerprint === undefined ? {} : { endpoint_fingerprint: fingerprint }),
          ...(model === undefined ? {} : { model }),
          network_path: result.networkPath ?? network.networkPath,
          proxy_env_keys: result.proxyEnvKeys ?? network.proxyEnvKeys,
          proxy_applies: result.proxyApplies ?? network.proxyApplies,
          ...(result.proxyStage === undefined ? {} : { proxy_stage: result.proxyStage }),
          ...(result.proxyErrorCode === undefined ? {} : { proxy_error_code: result.proxyErrorCode }),
          ...(result.failureOrigin === undefined ? {} : { failure_origin: result.failureOrigin })
        },
        diagnostics: {
          error_name: error instanceof Error ? error.name : 'RuntimeCheckError',
          request_method: 'POST',
          request_path: '/runtime/model-service/check-runtime',
          error_message: `Runtime 链路检测失败；响应头：${result.responseReceived ? '已收到' : '未收到'}；终止原因：${details?.terminationReason ?? '未知'}`,
          request_id: requestId,
          ...(typeof details?.stderrSummary === 'string' ? { additional_details: `Runtime stderr：${details.stderrSummary.slice(-1536)}` } : {})
        }
      });
    }
    result.checkedAt = new Date().toISOString();
    result.durationMs = Date.now() - startedAt;
    reportPerformance({
      component: 'model_service',
      event: 'runtime_check_completed',
      request_path: '/runtime/model-service/check-runtime',
      status: result.status,
      duration_ms: result.durationMs,
      ...(result.errorCode === undefined ? {} : { error_code: result.errorCode }),
      ...(result.responseReceived === undefined ? {} : { response_received: result.responseReceived }),
      ...(typeof result.terminationReason === 'string' ? { termination_reason: result.terminationReason } : {}),
      ...(result.requestId === undefined ? {} : { request_id: result.requestId }),
      ...(result.networkPath === undefined ? {} : { network_path: result.networkPath }),
      ...(result.proxyEnvKeys === undefined ? {} : { proxy_env_keys: result.proxyEnvKeys }),
      ...(result.proxyApplies === undefined ? {} : { proxy_applies: result.proxyApplies }),
      ...(result.proxyStage === undefined ? {} : { proxy_stage: result.proxyStage }),
      ...(result.proxyErrorCode === undefined ? {} : { proxy_error_code: result.proxyErrorCode }),
      ...(fingerprint === undefined ? {} : { endpoint_fingerprint: fingerprint }),
      ...(model === undefined ? {} : { model })
    });
    publish(result);
    return result;
  }

  return {
    status() {
      return structuredClone(current);
    },
    ready() {
      return current.status === 'ready';
    },
    async resolve(accessToken, fetchConfiguration, gateway) {
      const operationId = ++resolutionId;
      activeGateway = gateway;
      const loadLegacy = legacyPending && gateway === input.legacyGateway;
      if (gateway !== input.legacyGateway) legacyPending = false;
      activeRequest = undefined;
      input.onAvailabilityChange?.({ status: 'skipped' });
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
            const saved = gateway === undefined ? undefined : await input.gatewayProfiles?.readModel(gateway);
            if (saved !== undefined) {
              const validated = parseConfigureRequest(saved);
              stored = { status: { status: 'ready', configuration: validated.configuration, apiKeyConfigured: true }, ...validated };
            } else if (input.gatewayProfiles === undefined || loadLegacy) {
              stored = await input.loadStored();
              if (operationId !== resolutionId) return;
              if (gateway !== undefined && stored.configuration !== undefined && stored.apiKey !== undefined) {
                await input.gatewayProfiles?.writeModel(gateway, { ...stored.configuration, apiKey: stored.apiKey });
              }
            } else {
              stored = { status: { status: 'configuration_required', configuration: null, apiKeyConfigured: false } };
            }
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
            await activateResolved(
              operationId,
              remote.mode,
              stored.configuration,
              stored.apiKey
            );
            if (operationId === resolutionId) void checkRuntimeAvailability().catch(() => undefined);
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

        legacyPending = false;
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
        if (operationId !== resolutionId) return;
        await runTransition(async () => {
          if (operationId !== resolutionId) return;
          await input.credentialStore.delete();
          if (operationId !== resolutionId) return;
          await input.activate(platformConfiguration, remote.apiKey, {
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
          publishReady(remote.mode, platformConfiguration, remote.apiKey);
        });
        if (operationId === resolutionId) void checkRuntimeAvailability().catch(() => undefined);
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
      activeRequest = undefined;
      input.onAvailabilityChange?.({ status: 'skipped' });
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
        (current.status !== 'configuration_required' && current.status !== 'ready')
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
      const operationId = resolutionId;
      const gateway = activeGateway;
      try {
        const validated = parseConfigureRequest(request);
        const previousModel = gateway === undefined ? undefined : await input.gatewayProfiles?.readModel(gateway);
        let previousApiKey: string | undefined;
        try {
          previousApiKey = await input.credentialStore.read();
        } catch (error) {
          throw new ModelServiceConfigurationError(
            'MODEL_SERVICE_SECURE_STORAGE_UNAVAILABLE',
            error instanceof Error ? error.message : String(error)
          );
        }
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
            if (gateway !== undefined) {
              await input.gatewayProfiles?.writeModel(gateway, { ...validated.configuration, apiKey: validated.apiKey });
            }
            await input.activate(
              validated.configuration,
              validated.apiKey,
              { mode: 'enterprise_managed' }
            );
          } catch (error) {
            await restoreCredential(input.credentialStore, previousApiKey);
            if (gateway !== undefined) await input.gatewayProfiles?.writeModel(gateway, previousModel);
            throw error;
          }
          if (operationId !== resolutionId) {
            await input.deactivate();
            await restoreCredential(input.credentialStore, previousApiKey);
            if (gateway !== undefined) await input.gatewayProfiles?.writeModel(gateway, previousModel);
            throw new ModelServiceConfigurationError(
              'MODEL_SERVICE_CONFIGURATION_BUSY',
              'model service configuration was superseded'
            );
          }
          resolutionId += 1;
          publishReady('enterprise_managed', validated.configuration, validated.apiKey);
          input.onAvailabilityChange?.({ status: 'skipped' });
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
    async check(request) {
      if (request !== undefined && 'mode' in current && current.mode === 'platform_managed') {
        throw new ModelServiceConfigurationError(
          'model_configuration_managed_by_platform', '平台托管模型不允许修改检测配置'
        );
      }
      const target = request ?? activeRequest;
      if (target === undefined || current.status === 'resolving' || configuring) {
        throw new ModelServiceConfigurationError(
          'MODEL_SERVICE_CONFIGURATION_BUSY', '模型配置尚未就绪，请稍后重试'
        );
      }
      const validated = parseConfigureRequest(target);
      const normalized = { ...validated.configuration, apiKey: validated.apiKey };
      const operationId = resolutionId;
      const active = activeRequest;
      const checksActive = active !== undefined && (target === active || (
        normalized.baseUrl === active.baseUrl && normalized.model === active.model && normalized.apiKey === active.apiKey
      ));
      const result = await (input.checkConnection === undefined
        ? checkModelServiceConnection({ request: normalized })
        : input.checkConnection(normalized));
      reportPerformance({
        component: 'model_service',
        event: 'model_check_completed',
        request_path: '/runtime/model-service/check',
        status: result.status,
        ...(result.durationMs === undefined ? {} : { duration_ms: result.durationMs }),
        ...(result.errorCode === undefined ? {} : { error_code: result.errorCode }),
        ...(result.httpStatus === undefined ? {} : { http_status: result.httpStatus }),
        ...(result.headersReceived === undefined ? {} : { headers_received: result.headersReceived }),
        ...(result.responseReceived === undefined ? {} : { response_received: result.responseReceived }),
        ...(result.requestId === undefined ? {} : { request_id: result.requestId }),
        ...(result.networkPath === undefined ? {} : { network_path: result.networkPath }),
        ...(result.proxyEnvKeys === undefined ? {} : { proxy_env_keys: result.proxyEnvKeys }),
        ...(result.proxyApplies === undefined ? {} : { proxy_applies: result.proxyApplies }),
        ...(result.proxyStage === undefined ? {} : { proxy_stage: result.proxyStage }),
        ...(result.proxyErrorCode === undefined ? {} : { proxy_error_code: result.proxyErrorCode })
      });
      if (result.status === 'failed' && checksActive && operationId === resolutionId && active === activeRequest && !configuring) {
        const fingerprint = endpointFingerprint(normalized.baseUrl);
        const model = safeIncidentIdentifier(normalized.model);
        const transportCode = safeIncidentIdentifier(result.transportCode);
        emitIncident({
          event_type: 'error', layer: 'codex_model', stage: `model_check.${result.stage ?? 'request'}`,
          scope_id: `model-check:${createHash('sha256').update(JSON.stringify([fingerprint, normalized.model])).digest('hex')}`,
          error_code: safeIncidentIdentifier(result.errorCode) ?? 'MODEL_SERVICE_CHECK_FAILED',
          ...(transportCode ? { transport_code: transportCode } : {}),
          ...(result.httpStatus !== undefined && Number.isInteger(result.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599 ? { http_status: result.httpStatus } : {}),
          ...(result.durationMs !== undefined && Number.isSafeInteger(result.durationMs) && result.durationMs >= 0 ? { duration_ms: result.durationMs } : {}),
          environment: {
            protocol: 'responses', transport: 'fetch',
            ...(fingerprint ? { endpoint_fingerprint: fingerprint } : {}), ...(model ? { model } : {}),
            ...(result.networkPath === undefined ? {} : { network_path: result.networkPath }),
            ...(result.proxyEnvKeys === undefined ? {} : { proxy_env_keys: result.proxyEnvKeys }),
            ...(result.proxyApplies === undefined ? {} : { proxy_applies: result.proxyApplies }),
            ...(result.proxyStage === undefined ? {} : { proxy_stage: result.proxyStage }),
            ...(result.proxyErrorCode === undefined ? {} : { proxy_error_code: result.proxyErrorCode }),
            ...(result.failureOrigin === undefined ? {} : { failure_origin: result.failureOrigin })
          },
          diagnostics: {
            error_name: 'ManualModelCheck', request_method: 'POST', request_path: '/runtime/model-service/check',
            ...(result.requestId === undefined ? {} : { request_id: result.requestId }),
            error_message: `手动模型检测失败；响应头：${result.headersReceived === undefined ? '未知' : result.headersReceived ? '已收到' : '未收到'}；有效模型文本：${result.responseReceived === undefined ? '未知' : result.responseReceived ? '已收到' : '未收到'}`
          }
        });
      }
      return result;
    },
    checkRuntime: checkRuntimeAvailability,
    createResponseObserver(model) {
      const target = activeRequest;
      if (target === undefined || current.status !== 'ready' || configuring
        || (model != null && model !== target.model)) return undefined;
      const operationId = resolutionId;
      let observedCheckId: number | undefined;
      return event => {
        if (operationId !== resolutionId || target !== activeRequest || configuring
          || current.status !== 'ready' || observedCheckId === checkId
          || !isModelResponseEvent(event)) return;
        // 真实响应优先于此前尚未结束的探测，防止迟到的超时重新覆盖恢复状态。
        observedCheckId = ++checkId;
        input.onAvailabilityChange?.({
          status: 'succeeded', responseReceived: true, checkedAt: new Date().toISOString()
        });
      };
    },
    async readApiKey() {
      if (!('mode' in current) || current.mode !== 'enterprise_managed') return null;
      const operationId = resolutionId;
      const apiKey = input.gatewayProfiles !== undefined && activeGateway !== undefined
        ? (await input.gatewayProfiles.readModel(activeGateway))?.apiKey
        : await input.credentialStore.read();
      return operationId === resolutionId ? apiKey ?? null : null;
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
  const requestId = randomUUID();
  const network = describeProxyEnvironment(validated.configuration.baseUrl);
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
      const proxy = classifyProxyFailure({
        transportCode: result.terminationReason === 'timeout' ? 'ETIMEDOUT' : undefined,
        text: result.stderrSummary,
        stage: result.timings.firstEventMs === undefined ? 'response_headers' : 'stream',
        proxyApplies: network.proxyApplies
      });
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
            : { message: result.stderrSummary }),
          durationMs: result.durationMs,
          timings: result.timings,
          exitCode: result.exitCode,
          signal: result.signal,
          markerMatched: result.markerMatched,
          ...(result.stderrSummary === undefined ? {} : { stderrSummary: result.stderrSummary }),
          requestId,
          networkPath: network.networkPath,
          proxyEnvKeys: network.proxyEnvKeys,
          proxyApplies: network.proxyApplies,
          ...(proxy === undefined ? {} : {
            proxyErrorCode: proxy.proxyErrorCode,
            failureOrigin: proxy.failureOrigin,
            proxyStage: proxy.proxyErrorCode === 'PROXY_STREAM_INTERRUPTED' ? 'stream' : proxy.proxyErrorCode === 'PROXY_TUNNEL_FAILED' ? 'tunnel' : 'connect',
            retryable: proxyErrorMessage(proxy.proxyErrorCode).retryable
          })
        }
      );
    }
    return validated;
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

function isProxyErrorCode(value: string): value is NonNullable<ReturnType<typeof classifyProxyFailure>>['proxyErrorCode'] {
  return ['PROXY_AUTH_REQUIRED', 'PROXY_CONNECT_FAILED', 'PROXY_CONNECT_TIMEOUT', 'PROXY_TUNNEL_FAILED', 'PROXY_POLICY_DENIED', 'PROXY_STREAM_INTERRUPTED'].includes(value);
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
