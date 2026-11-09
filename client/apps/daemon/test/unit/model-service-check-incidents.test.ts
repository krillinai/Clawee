import type { CodexAvailabilityProbe, ConfigureModelServiceRequest } from '@clawee/protocol';
import { isIncidentObservation } from '@clawee/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelServiceRuntime } from '../../src/codex/model-service-configuration.js';
import { endpointFingerprint } from '../../src/feedback/incidents.js';

const configuration = { baseUrl: 'https://model.example.test/v1', model: 'model-1', apiKey: 'saved-model-key' };
const failed: CodexAvailabilityProbe = {
  status: 'failed', headersReceived: true, responseReceived: false, stage: 'model_text',
  errorCode: 'MODEL_SERVICE_CONNECTION_RESET', transportCode: 'ECONNRESET', httpStatus: 200, durationMs: 42,
  message: '模型接口连接中断', diagnostic: 'private upstream response'
};
const originalParentPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
const postMessage = vi.fn();

beforeEach(() => {
  postMessage.mockReset();
  Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
});
afterEach(() => {
  if (originalParentPort) Object.defineProperty(process, 'parentPort', originalParentPort);
  else Reflect.deleteProperty(process, 'parentPort');
});

async function fixture(checkConnection: (request: ConfigureModelServiceRequest) => Promise<CodexAvailabilityProbe> = async () => failed, platformManaged = false) {
  const runtime = createModelServiceRuntime({
    credentialStore: { async read() { return configuration.apiKey; }, async write() {}, async delete() {} },
    async loadStored() {
      return { status: { status: 'ready', configuration, apiKeyConfigured: true }, configuration, apiKey: configuration.apiKey };
    },
    async validate(request) { return { configuration: { baseUrl: request.baseUrl, model: request.model }, apiKey: request.apiKey }; },
    checkConnection,
    async activate() {},
    async deactivate() {}
  });
  await runtime.resolve('enterprise-session', async () => platformManaged
    ? { mode: 'platform_managed', ...configuration, credentialVersion: 1 }
    : { mode: 'enterprise_managed' });
  return runtime;
}

describe('手动模型检测异常上报', () => {
  it.each([false, true])('当前生效配置检测失败后通过既有进程通道发送异常（平台托管：%s）', async platformManaged => {
    const runtime = await fixture(undefined, platformManaged);
    expect(await runtime.check()).toBe(failed);
    expect(postMessage).toHaveBeenCalledOnce();
    const message = postMessage.mock.calls[0]![0];
    expect(message).toMatchObject({ type: 'clawee_incident', observation: {
      source: 'daemon', event_type: 'error', layer: 'codex_model', stage: 'model_check.model_text',
      scope_id: expect.stringMatching(/^model-check:[a-f0-9]{64}$/),
      error_code: 'MODEL_SERVICE_CONNECTION_RESET', transport_code: 'ECONNRESET', http_status: 200, duration_ms: 42,
      environment: { model: 'model-1', endpoint_fingerprint: endpointFingerprint(configuration.baseUrl), protocol: 'responses', transport: 'fetch' },
      diagnostics: { error_name: 'ManualModelCheck', error_message: expect.stringContaining('手动模型检测失败'), request_method: 'POST', request_path: '/runtime/model-service/check' }
    } });
    expect(isIncidentObservation(message.observation)).toBe(true);
    expect(message.observation.run_id).toBeUndefined();
    expect(message.observation.thread_id).toBeUndefined();
    for (const value of [configuration.apiKey, configuration.baseUrl, 'enterprise-session', 'private upstream response']) {
      expect(JSON.stringify(message)).not.toContain(value);
    }
  });

  it('界面传入与生效配置一致的标准化草稿时仍上报', async () => {
    const runtime = await fixture();
    await runtime.check({ ...configuration, baseUrl: `${configuration.baseUrl}/` });
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it.each([
    { model: 'draft-model' }, { baseUrl: 'https://draft.example.test/v1' }, { apiKey: 'draft-model-key' }
  ])('未保存草稿检测失败不上报：%j', async patch => {
    const runtime = await fixture();
    expect(await runtime.check({ ...configuration, ...patch })).toBe(failed);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it.each(['succeeded', 'pending', 'skipped'] as const)('检测结果为 %s 时不制造异常或任务恢复事件', async status => {
    const runtime = await fixture(async () => ({ status }));
    await runtime.check();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it.each(['sign_out', 'configure', 'resolve'] as const)('检测期间发生 %s 后丢弃旧配置的上报', async action => {
    let finish!: (result: CodexAvailabilityProbe) => void;
    const runtime = await fixture(() => new Promise(resolve => { finish = resolve; }));
    const checking = runtime.check();
    if (action === 'sign_out') await runtime.signOut();
    else if (action === 'configure') await runtime.configure({ ...configuration, apiKey: 'replacement-model-key' });
    else await runtime.resolve('another-session', async () => ({ mode: 'enterprise_managed' }));
    finish(failed);
    expect(await checking).toBe(failed);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('相同配置的检测失败使用稳定范围，不同模型的记录不合并', async () => {
    const runtime = await fixture();
    await runtime.check();
    await runtime.check();
    await runtime.configure({ ...configuration, model: 'model-2' });
    await runtime.check();
    const observations = postMessage.mock.calls.map(call => call[0].observation);
    expect(observations[0].scope_id).toBe(observations[1].scope_id);
    expect(observations[0].event_id).not.toBe(observations[1].event_id);
    expect(observations[2].scope_id).not.toBe(observations[0].scope_id);
  });

  it('无效配置不产生故障上报，进程通道失效不改变检测结果', async () => {
    const runtime = await fixture();
    await expect(runtime.check({ ...configuration, baseUrl: 'not-a-url' })).rejects.toMatchObject({ code: 'MODEL_SERVICE_CONFIGURATION_INVALID' });
    expect(postMessage).not.toHaveBeenCalled();
    postMessage.mockImplementation(() => { throw new Error('parent unavailable'); });
    expect(await runtime.check()).toBe(failed);
  });
});
