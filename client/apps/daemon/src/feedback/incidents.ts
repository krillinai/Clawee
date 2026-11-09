import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { incidentErrorDiagnostics, isIncidentObservation, parseCodexRuntimeLaunchContextJson, safeIncidentIdentifier, type IncidentEnvironment, type IncidentObservation } from '@clawee/protocol';
import { describeRuntimeResponseError } from '../codex/runtime-response-error.js';
import { describeProxyEnvironment } from '../codex/network-diagnostics.js';

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function postIncidentMessage(message: unknown) {
  try { (process as NodeJS.Process & { parentPort?: { postMessage(value: unknown): void } }).parentPort?.postMessage(message); } catch { }
}
export function emitIncident(observation: Omit<IncidentObservation, 'event_id' | 'source'>) {
  let versions: IncidentEnvironment = {};
  try { const runtime = parseCodexRuntimeLaunchContextJson(process.env.CLAWEE_CODEX_RUNTIME_DESCRIPTOR!); versions = { daemon_version: runtime.claweeVersion, runtime_version: runtime.candidate.codexVersion }; } catch { }
  const value = { ...observation, environment: { ...versions, ...observation.environment }, source: 'daemon', event_id: randomUUID() };
  if (isIncidentObservation(value)) postIncidentMessage({ type: 'clawee_incident', observation: value });
}
export function endpointFingerprint(value: string): string | undefined {
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return createHash('sha256').update(url.origin + url.pathname.replace(/\/+$/, '')).digest('hex');
  } catch { return undefined; }
}
export function appServerFailureFacts(error: unknown): Pick<IncidentObservation, 'stage' | 'transport_code' | 'exit_code' | 'exit_signal' | 'duration_ms' | 'unresponsive_ms' | 'diagnostics'> {
  type FailureFacts = { code?: unknown; exitCode?: unknown; signal?: unknown; incidentStage?: unknown; incidentDurationMs?: unknown; incidentUnresponsiveMs?: unknown };
  const value: FailureFacts = error instanceof Error ? error as Error & FailureFacts : {};
  const result: ReturnType<typeof appServerFailureFacts> = {
    diagnostics: incidentErrorDiagnostics(error),
    stage: ['initialize', 'communication', 'process_exit', 'execution'].includes(String(value.incidentStage)) ? String(value.incidentStage) : 'execution'
  };
  if (typeof value.code === 'string' && ['ERR_NETWORK_IO_SUSPENDED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOENT', 'EACCES', 'ENOTFOUND', 'EAI_AGAIN'].includes(value.code)) result.transport_code = value.code;
  if (Number.isSafeInteger(value.exitCode) && Math.abs(Number(value.exitCode)) <= 2147483647) result.exit_code = Number(value.exitCode);
  if (typeof value.signal === 'string' && /^SIG[A-Z0-9]+$/.test(value.signal)) result.exit_signal = value.signal;
  if (Number.isSafeInteger(value.incidentDurationMs) && Number(value.incidentDurationMs) >= 0) result.duration_ms = Number(value.incidentDurationMs);
  if (Number.isSafeInteger(value.incidentUnresponsiveMs) && Number(value.incidentUnresponsiveMs) >= 0) result.unresponsive_ms = Number(value.incidentUnresponsiveMs);
  return result;
}
export function incidentEnvironment(home: string, env: NodeJS.ProcessEnv, model?: string, profile = 'default'): IncidentEnvironment {
  const result: IncidentEnvironment = { transport: 'app-server', proxy_env_set: ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'].some(key => Boolean(env[key])) };
  if (safeIncidentIdentifier(model)) result.model = model;
  try {
    let config = TOML.parse(readFileSync(join(home, 'config.toml'), 'utf8'));
    if (profile && profile !== 'default') {
      if (!/^[A-Za-z0-9_.-]+$/.test(profile)) return result;
      let overlay: unknown;
      try { overlay = TOML.parse(readFileSync(join(home, `${profile}.config.toml`), 'utf8')); }
      catch { overlay = record(config.profiles) ? config.profiles[profile] : undefined; }
      if (!record(overlay)) return result;
      config = { ...config, ...overlay } as typeof config;
    }
    if (!result.model && safeIncidentIdentifier(config.model)) result.model = String(config.model);
    const providers = record(config.model_providers) ? config.model_providers : {};
    const provider = typeof config.model_provider === 'string' ? providers[config.model_provider] : undefined;
    if (record(provider)) {
      const fingerprint = typeof provider.base_url === 'string' ? endpointFingerprint(provider.base_url) : undefined;
      if (fingerprint) result.endpoint_fingerprint = fingerprint;
      if (fingerprint !== undefined && typeof provider.base_url === 'string') {
        const network = describeProxyEnvironment(provider.base_url, env);
        if (network.proxyEnvKeys.length > 0) {
          result.network_path = network.networkPath;
          result.proxy_env_keys = network.proxyEnvKeys;
          result.proxy_applies = network.proxyApplies;
        }
      }
      if (safeIncidentIdentifier(provider.wire_api)) result.protocol = String(provider.wire_api);
      if (Number.isSafeInteger(provider.request_max_retries) && Number(provider.request_max_retries) >= 0) result.retry_limit = Number(provider.request_max_retries);
    }
  } catch { }
  return result;
}
type RuntimeIncidentContext = { run_id: string; thread_id?: string; environment: IncidentEnvironment; startedAt?: number; isCancelled?(): boolean };
const modelIncidentStates = new WeakMap<object, { startedAt: number; lastResponseAt: number; pending: boolean; lastError?: string }>();
export function observeRuntimeNotification(notification: Record<string, unknown>, context: RuntimeIncidentContext) {
  if (context.isCancelled?.()) return;
  const now = Date.now();
  let state = modelIncidentStates.get(context);
  if (!state) {
    const startedAt = context.startedAt ?? now;
    state = { startedAt, lastResponseAt: startedAt, pending: false };
    modelIncidentStates.set(context, state);
  }
  const params = record(notification.params) ? notification.params : {};
  const turn = record(params.turn) ? params.turn : undefined;
  if (notification.method === 'turn/started') state.lastError = undefined;
  if (notification.method === 'error' || (notification.method === 'turn/completed' && turn?.status === 'failed')) {
    const error = notification.method === 'error' ? record(params.error) ? params.error : {} : record(turn?.error) ? turn.error : {};
    const facts = describeRuntimeResponseError(notification.method === 'error' ? params : { error, willRetry: false });
    const errorKey = JSON.stringify([facts.errorCode, facts.httpStatus, facts.transportCode, facts.requestId, facts.diagnostics]);
    if (notification.method === 'turn/completed' && state.lastError === errorKey) return facts;
    state.lastError = errorKey;
    state.pending = true;
    emitIncident({ run_id: context.run_id, thread_id: context.thread_id, environment: context.environment, event_type: 'error', layer: 'codex_model', stage: 'response', error_code: facts.errorCode,
      diagnostics: facts.diagnostics,
      duration_ms: Math.max(0, now - state.startedAt), unresponsive_ms: Math.max(0, now - state.lastResponseAt),
      ...(facts.httpStatus ? { http_status: facts.httpStatus } : {}),
      ...(facts.transportCode ? { transport_code: facts.transportCode } : {}),
      ...(facts.requestId ? { upstream_request_id: facts.requestId } : {}),
      ...(facts.retryAttempt === undefined ? {} : { retry_count: facts.retryAttempt }) });
    return facts;
  } else if ((notification.method === 'item/agentMessage/delta' && typeof params.delta === 'string' && params.delta.length > 0)
    || (notification.method === 'item/completed' && record(params.item) && params.item.type === 'agentMessage' && typeof params.item.text === 'string' && params.item.text.length > 0)) {
    state.lastResponseAt = now;
    if (!state.pending) return;
    state.pending = false;
    emitIncident({ run_id: context.run_id, thread_id: context.thread_id, environment: context.environment, event_type: 'recovered', layer: 'codex_model', stage: 'response', error_code: 'MODEL_RESPONSE_RESUMED' });
  }
}
