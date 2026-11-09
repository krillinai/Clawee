import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appServerFailureFacts, emitIncident, endpointFingerprint, incidentEnvironment, observeRuntimeNotification } from '../../src/feedback/incidents.js';
import { normalizeAppServerEvent } from '../../src/events/normalizer.js';

const original = Object.getOwnPropertyDescriptor(process, 'parentPort');
const proxyEnvKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'] as const;
const originalProxyEnv = new Map(proxyEnvKeys.map(key => [key, process.env[key]] as const));
beforeEach(() => { for (const key of proxyEnvKeys) delete process.env[key]; });
afterEach(() => {
  for (const key of proxyEnvKeys) {
    const value = originalProxyEnv.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  vi.useRealTimers();
  if (original) Object.defineProperty(process, 'parentPort', original); else Reflect.deleteProperty(process, 'parentPort');
});
describe('Runtime原始错误进程消息', () => {
  it('reports unsupported reasoning as a typed model incident without raw response content', () => {
    const postMessage = vi.fn();
    Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
    const message = JSON.stringify({ error: { code: 'unsupported_value', message: "Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model.", param: 'reasoning.effort', type: 'invalid_request_error' } });
    observeRuntimeNotification({ method: 'error', params: { willRetry: false, error: { message } } }, { run_id: 'run_sol', environment: { model: 'gpt-6.1-sol' } });
    expect(postMessage).toHaveBeenCalledWith({ type: 'clawee_incident', observation: expect.objectContaining({ layer: 'codex_model', error_code: 'MODEL_REASONING_EFFORT_UNSUPPORTED', environment: expect.objectContaining({ model: 'gpt-6.1-sol' }) }) });
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain('Unsupported value:');
  });
  it('底层错误文本只进入本地会话字段，自动上报仍只使用技术摘要', () => {
    const postMessage = vi.fn();
    Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
    const notification = { method: 'error', params: { willRetry: false, error: {
      message: 'Response protection failed: local diagnostic text', codexErrorInfo: 'other'
    } } };
    const facts = observeRuntimeNotification(notification, { run_id: 'run_protection', environment: {} });
    expect(normalizeAppServerEvent({ runId: 'run_protection', seq: 1, raw: notification, modelResponse: facts }))
      .toMatchObject({ payload: { modelResponse: { runtimeMessage: 'Response protection failed: local diagnostic text' } } });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain('local diagnostic text');
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain('runtimeMessage');
  });
  it.each([
    [{ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }, '认证失败'],
    [{ codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 429 } } }, '限流'],
    [{ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } }, '暂不可用'],
    [{ codexErrorInfo: 'responseStreamDisconnected', additionalDetails: 'ECONNRESET' }, '暂无法确定断开方'],
    [{ codexErrorInfo: 'responseStreamDisconnected' }, '具体原因未返回']
  ] as const)('模拟错误时客户端与上报共用同一份原因：%j', (error, reason) => {
    const postMessage = vi.fn();
    Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
    const notification = { method: 'error', params: { willRetry: true, error: { message: 'Reconnecting...', ...error } } };
    const facts = observeRuntimeNotification(notification, { run_id: 'run_simulated', environment: {} });
    const event = normalizeAppServerEvent({ runId: 'run_simulated', seq: 1, raw: notification, modelResponse: facts });
    expect(event.type).toBe('diagnostic');
    if (event.type !== 'diagnostic' || !event.payload.modelResponse) throw new Error('missing model error');
    const displayed = event.payload.modelResponse;
    expect(displayed.reason).toContain(reason);
    const reported = postMessage.mock.calls[0]?.[0].observation;
    expect(reported.error_code).toBe(displayed.errorCode);
    expect(reported.http_status).toBe(displayed.httpStatus);
    expect(reported.transport_code).toBe(displayed.transportCode);
    expect(reported.diagnostics).toEqual(displayed.diagnostics);
    expect(reported.retry_count).toBeUndefined();
  });
  it('将 Runtime 返回的代理认证错误转换为可操作的代理提示', () => {
    const postMessage = vi.fn();
    Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
    const facts = observeRuntimeNotification({ method: 'error', params: {
      error: { message: 'HTTP 407 Proxy Authentication Required', codexErrorInfo: 'responseStreamConnectionFailed' }
    } }, { run_id: 'run_proxy', environment: {} });
    expect(facts).toMatchObject({ errorCode: 'MODEL_SERVICE_PROXY_AUTH_REQUIRED', proxyErrorCode: 'PROXY_AUTH_REQUIRED', reason: 'HTTP 代理需要认证（HTTP 407）' });
    expect(postMessage.mock.calls[0]?.[0].observation).toMatchObject({ error_code: 'MODEL_SERVICE_PROXY_AUTH_REQUIRED' });
  });
  it('重试次数只采用 Runtime 明确进度，重复通知不累加', () => {
    const postMessage = vi.fn();
    Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
    const context = { run_id: 'run_retry_progress', environment: {} };
    for (const message of ['Reconnecting...', 'Reconnecting... 3/5', 'Reconnecting... 3/5']) {
      observeRuntimeNotification({ method: 'error', params: { willRetry: true, error: { message } } }, context);
    }
    expect(postMessage.mock.calls[0]?.[0].observation.retry_count).toBeUndefined();
    expect(postMessage.mock.calls[1]?.[0].observation.retry_count).toBe(3);
    expect(postMessage.mock.calls[2]?.[0].observation.retry_count).toBe(3);
  });
  it('客户端提示和上报使用相同证据，失败终态保留更具体的原因', () => {
    const postMessage = vi.fn();
    Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
    const context = { run_id: 'run_evidence', environment: {} };
    const notification = { method: 'error', params: { willRetry: true, error: {
      message: 'Reconnecting... 1/5', codexErrorInfo: 'responseStreamDisconnected', additionalDetails: 'HTTP 503; request_id: req_first'
    } } };
    observeRuntimeNotification(notification, context);
    const event = normalizeAppServerEvent({ runId: context.run_id, seq: 1, raw: notification });
    expect(event.type).toBe('diagnostic');
    if (event.type !== 'diagnostic') throw new Error('missing model error');
    expect(event.payload.modelResponse).toMatchObject({ httpStatus: 503, requestId: 'req_first' });
    expect(postMessage.mock.calls[0]?.[0].observation).toMatchObject({ http_status: event.payload.modelResponse!.httpStatus,
      upstream_request_id: event.payload.modelResponse!.requestId, diagnostics: event.payload.modelResponse!.diagnostics });
    const terminal = { method: 'turn/completed', params: { turn: { status: 'failed', error: {
      message: 'retry limit exceeded', codexErrorInfo: 'responseTooManyFailedAttempts', additionalDetails: 'ECONNRESET; request_id: req_last'
    } } } };
    observeRuntimeNotification(terminal, context);
    expect(postMessage.mock.calls.at(-1)?.[0].observation).toMatchObject({ error_code: 'responseTooManyFailedAttempts', transport_code: 'ECONNRESET', upstream_request_id: 'req_last' });
    expect(normalizeAppServerEvent({ runId: context.run_id, seq: 2, raw: terminal })).toMatchObject({ type: 'error', payload: { modelResponse: { errorCode: 'responseTooManyFailedAttempts', retrying: false, transportCode: 'ECONNRESET' } } });
  });
  it('用户取消后忽略原始错误及失败终态，但保留取消前的真实故障', () => {
    const postMessage = vi.fn();
    Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
    let cancelled = false;
    const context = { run_id: 'cancelled_run', environment: {}, isCancelled: () => cancelled };
    const error = { codexErrorInfo: 'responseStreamDisconnected', message: 'private' };
    observeRuntimeNotification({ method: 'error', params: { error } }, context);
    cancelled = true;
    observeRuntimeNotification({ method: 'error', params: { error } }, context);
    observeRuntimeNotification({ method: 'turn/completed', params: { turn: { status: 'failed', error } } }, context);
    observeRuntimeNotification({ method: 'item/agentMessage/delta', params: { delta: 'late' } }, context);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ observation: expect.objectContaining({ event_type: 'error' }) }));
  });

  it.each(['sessionBudgetExceeded', 'rateLimitExceeded', 'cyberPolicy', 'misalignmentPolicyViolation', 'threadRollbackFailed', 'activeTurnNotSteerable'])('保留Runtime分类%s，并补报仅在失败turn中出现的错误', code => {
    const postMessage = vi.fn();
    Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
    observeRuntimeNotification({ method: 'turn/completed', params: { turn: { status: 'failed', error: { codexErrorInfo: code } } } }, { run_id: 'failed_turn', environment: {} });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ observation: expect.objectContaining({ error_code: code }) }));
  });

  it('独立错误与失败终态去重，工具消息不重置无响应时间', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const postMessage = vi.fn();
    Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
    const context = { run_id: 'timed_run', environment: {}, startedAt: 1000 };
    const error = { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } };
    vi.setSystemTime(2000);
    observeRuntimeNotification({ method: 'item/agentMessage/delta', params: { delta: 'private' } }, context);
    vi.setSystemTime(4000);
    observeRuntimeNotification({ method: 'item/commandExecution/outputDelta', params: { delta: 'private' } }, context);
    vi.setSystemTime(5000);
    observeRuntimeNotification({ method: 'error', params: { error } }, context);
    observeRuntimeNotification({ method: 'turn/completed', params: { turn: { status: 'failed', error } } }, context);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ observation: expect.objectContaining({ duration_ms: 4000, unresponsive_ms: 3000 }) }));
    observeRuntimeNotification({ method: 'item/commandExecution/outputDelta', params: { delta: 'private' } }, context);
    expect(postMessage).toHaveBeenCalledTimes(1);
    observeRuntimeNotification({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'private' } } }, context);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('读取实际profile事实；无效URL不让整条观测被拒绝', () => {
    const directory = mkdtempSync(join(tmpdir(), 'clawee-incidents-'));
    const postMessage = vi.fn();
    Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
    try {
      writeFileSync(join(directory, 'config.toml'), 'model = "base-model"\nmodel_provider = "base"\n[model_providers.base]\nbase_url = "https://base.invalid/v1"\n');
      writeFileSync(join(directory, 'review.config.toml'), 'model = "review-model"\nmodel_provider = "review"\n[model_providers.review]\nbase_url = "not a URL"\nwire_api = "responses"\nrequest_max_retries = 3\n');
      const environment = incidentEnvironment(directory, { HTTPS_PROXY: 'http://private:secret@proxy' }, undefined, 'review');
      expect(environment).toEqual({ transport: 'app-server', proxy_env_set: true, model: 'review-model', protocol: 'responses', retry_limit: 3 });
      emitIncident({ event_type: 'error', layer: 'codex_model', stage: 'response', error_code: 'other', environment });
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(postMessage.mock.calls)).not.toContain('secret');
      expect(incidentEnvironment(directory, {}, 'explicit-model', 'missing')).toEqual({ transport: 'app-server', proxy_env_set: false, model: 'explicit-model' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('提取进程错误数值事实、技术原因和调用位置', () => {
    expect(appServerFailureFacts(Object.assign(new Error('connect failed'), { incidentStage: 'initialize', incidentDurationMs: 42, incidentUnresponsiveMs: 12, code: 'EPIPE', exitCode: 1, signal: 'SIGTERM' }))).toMatchObject({ stage: 'initialize', duration_ms: 42, unresponsive_ms: 12, transport_code: 'EPIPE', exit_code: 1, exit_signal: 'SIGTERM', diagnostics: { error_name: 'Error', error_message: 'connect failed', error_stack: expect.stringContaining('automatic-incidents.test.ts') } });
  });
  it('保留原始分类、HTTP状态和技术错误文案，不发送凭据、params或模型输出', () => {
    const postMessage = vi.fn(); Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
    const context = { run_id: 'run_1', environment: { model: 'model-1' } };
    observeRuntimeNotification({ method: 'error', params: { willRetry: true, error: { message: 'sk-private https://user:pass@host/private', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } }, additionalDetails: 'business body /Users/private' } }, context);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'clawee_incident', observation: expect.objectContaining({ error_code: 'responseStreamDisconnected', http_status: 503, layer: 'codex_model' }) });
    observeRuntimeNotification({ method: 'item/commandExecution/outputDelta', params: { delta: 'business output' } }, context);
    expect(postMessage).toHaveBeenCalledTimes(1);
    observeRuntimeNotification({ method: 'item/agentMessage/delta', params: { delta: 'confidential answer' } }, context);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'clawee_incident', observation: expect.objectContaining({ event_type: 'recovered' }) });
    observeRuntimeNotification({ method: 'item/agentMessage/delta', params: { delta: 'next token' } }, context);
    expect(postMessage).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(postMessage.mock.calls);
    for (const forbidden of ['sk-private', 'user:pass', 'business body', 'business output', 'confidential answer', '/Users/private', 'additionalDetails']) expect(serialized).not.toContain(forbidden);
  });
  it('接口指纹去除URL凭据、查询、片段和末尾斜线', () => {
    expect(endpointFingerprint('https://user:pass@MODEL.example:443/v1/?api_key=secret#private')).toBe(endpointFingerprint('https://model.example/v1'));
    expect(endpointFingerprint('file:///Users/private')).toBeUndefined();
  });
});
