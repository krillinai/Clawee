import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeRuntimeResponseError } from '../../src/codex/runtime-response-error.js';

const proxyEnvKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'] as const;
const originalProxyEnv = new Map(proxyEnvKeys.map(key => [key, process.env[key]] as const));
beforeEach(() => { for (const key of proxyEnvKeys) delete process.env[key]; });
afterEach(() => {
  for (const key of proxyEnvKeys) {
    const value = originalProxyEnv.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('Runtime 响应错误原因', () => {
  it('classifies a structured unsupported reasoning effort without reporting the raw response', () => {
    const message = JSON.stringify({ error: { code: 'unsupported_value', message: "Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model.", param: 'reasoning.effort', type: 'invalid_request_error' } });
    const result = describeRuntimeResponseError({ error: { message, codexErrorInfo: 'other' } });
    expect(result.errorCode).toBe('MODEL_REASONING_EFFORT_UNSUPPORTED');
    expect(result.reason).toContain('推理强度');
    expect(result.diagnostics).toEqual({});
  });
  it('保留 response protection 等未分类错误供本地会话展示', () => {
    const result = describeRuntimeResponseError({ willRetry: false, error: {
      message: 'Response protection failed: could not validate the response',
      additionalDetails: 'The upstream response was rejected by response protection.',
      codexErrorInfo: 'other'
    } });
    expect(result).toMatchObject({ reason: 'Codex Runtime 返回错误', retrying: false,
      runtimeMessage: 'Response protection failed: could not validate the response',
      runtimeDetails: 'The upstream response was rejected by response protection.', diagnostics: {} });
  });

  it('本地错误文本保留未知原因，同时脱敏凭据、地址并移除请求响应正文', () => {
    const result = describeRuntimeResponseError({ error: {
      message: 'Unsupported response event; Authorization: Basic dXNlcjpwYXNz; api_key="private-key"; sk-private-value',
      additionalDetails: 'Response protection failed at https://user:pass@model.test/v1?token=private; response body: private business text'
    } });
    expect(result.runtimeMessage).toContain('Unsupported response event');
    expect(result.runtimeDetails).toContain('Response protection failed');
    for (const text of ['dXNlcjpwYXNz', 'private-key', 'sk-private-value', 'user:pass', 'model.test', 'private business text']) {
      expect(JSON.stringify(result)).not.toContain(text);
    }
  });

  it.each([
    [401, '认证失败', 'API Key'],
    [403, '拒绝访问', '权限'],
    [429, '限流', '稍后'],
    [503, '暂不可用', '稍后']
  ])('按实际 HTTP %s 解释原因，不把重试当作断网', (status, reason, suggestion) => {
    const result = describeRuntimeResponseError({ willRetry: true, error: {
      message: 'Reconnecting... 2/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: status } }
    } });
    expect(result).toMatchObject({ httpStatus: status, retrying: true, retryAttempt: 2, retryLimit: 5 });
    expect(result.reason).toContain(reason);
    expect(result.suggestion).toContain(suggestion);
  });

  it('结构化状态优先于错误文本中的旧状态', () => {
    const result = describeRuntimeResponseError({ error: {
      message: 'unexpected status 503', codexErrorInfo: { unauthorized: { httpStatusCode: 401 } }
    } });
    expect(result.httpStatus).toBe(401);
    expect(result.reason).toContain('认证失败');
  });

  it.each([
    ['ECONNRESET', '连接被重置'],
    ['CERT_HAS_EXPIRED', '证书校验失败'],
    ['ENOTFOUND', '域名解析失败'],
    ['ETIMEDOUT', '连接超时']
  ])('从 additionalDetails 提取 %s 和请求标识', (code, reason) => {
    const result = describeRuntimeResponseError({ willRetry: true, error: {
      message: 'Reconnecting... 1/5', codexErrorInfo: 'responseStreamDisconnected',
      additionalDetails: `request failed: ${code}; request_id: req_1234`
    } });
    expect(result).toMatchObject({ transportCode: code, requestId: 'req_1234', diagnostics: { cause_code: code, request_id: 'req_1234' } });
    expect(result.reason).toContain(reason);
  });

  it('未知断流不归因于用户网络，未提供次数不补造进度', () => {
    const result = describeRuntimeResponseError({ willRetry: true, error: {
      message: 'Reconnecting...', codexErrorInfo: 'responseStreamDisconnected', additionalDetails: 'private business text'
    } });
    expect(result.reason).toBe('模型响应连接中断，具体原因未返回');
    expect(result.retryAttempt).toBeUndefined();
    expect(result.diagnostics.additional_details).toBeUndefined();
    expect(result.reason).not.toContain('客户网络');
  });

  it('从 HTTP 技术详情提取状态，不读取响应正文、Prompt 或凭据', () => {
    const result = describeRuntimeResponseError({ error: {
      message: 'Reconnecting... 1/5', codexErrorInfo: 'responseStreamDisconnected',
      additionalDetails: 'unexpected status 503 Service Unavailable https://alice:private@host/v1?api_key=private\nresponse body: {"prompt":"business input","token":"private"}'
    } });
    expect(result.httpStatus).toBe(503);
    expect(result.diagnostics.additional_details).toContain('503');
    for (const value of ['alice', 'private', 'business input', 'response body']) expect(JSON.stringify(result)).not.toContain(value);
  });

  it('失败终态不会被错误文案中的 Reconnecting 重新标记为重试', () => {
    expect(describeRuntimeResponseError({ willRetry: false, error: { message: 'Reconnecting... 5/5' } }).retrying).toBe(false);
  });
  it('结构化底层错误优先于文案，不从正文、地址或栈提取原因', () => {
    const result = describeRuntimeResponseError({ error: {
      message: 'ECONNRESET; confidential business text', cause: { code: 'CERT_HAS_EXPIRED' },
      additionalDetails: 'HTTP 503; "response_body": "HTTP 401; request_id: req_body"',
      stack: 'private business stack'
    } });
    expect(result.transportCode).toBe('CERT_HAS_EXPIRED');
    expect(result.httpStatus).toBe(503);
    expect(result.requestId).toBeUndefined();
    for (const text of ['confidential', 'private business', 'req_body', '401']) expect(JSON.stringify(result.diagnostics)).not.toContain(text);
    expect(result.runtimeMessage).toContain('ECONNRESET; confidential business text');
    expect(result.runtimeDetails).not.toContain('req_body');
    const url = describeRuntimeResponseError({ error: { message: 'failed https://host/HTTP:401/request_id:req_url' } });
    expect(url.httpStatus).toBeUndefined();
    expect(url.requestId).toBeUndefined();
  });
  it('技术错误摘要不保留自由正文，并在脱敏后提取技术片段', () => {
    const result = describeRuntimeResponseError({ error: {
      message: 'unexpected status 503 confidential customer order; request_id: sk-private-value',
      additionalDetails: 'HTTP 503; prompt: connection reset; request_id: req_prompt'
    } });
    expect(result.httpStatus).toBe(503);
    for (const text of ['confidential', 'customer order', 'private-value', 'req_prompt']) expect(JSON.stringify(result.diagnostics)).not.toContain(text);
    expect(result.runtimeMessage).toContain('confidential customer order');
    for (const text of ['private-value', 'req_prompt']) expect(JSON.stringify(result)).not.toContain(text);
    expect(result.requestId).toBeUndefined();
  });
  it.each([
    ['invalid peer certificate: UnknownIssuer', '证书校验失败'],
    ['dns error: failed to lookup address information', '域名解析失败'],
    ['An existing connection was forcibly closed by the remote host (os error 10054)', '连接被重置']
  ])('识别 Rust/Windows Runtime 原始技术原因：%s', (details, reason) => {
    const result = describeRuntimeResponseError({ willRetry: true, error: { message: 'Reconnecting... 1/5', additionalDetails: details } });
    expect(result.reason).toContain(reason);
    expect(result.diagnostics.additional_details).toBeTruthy();
  });

  it('识别 Chromium 网络栈挂起并给出 Runtime 链路建议', () => {
    const result = describeRuntimeResponseError({
      willRetry: false,
      error: { code: 'ERR_NETWORK_IO_SUSPENDED', message: 'ERR_NETWORK_IO_SUSPENDED' }
    });
    expect(result.errorCode).toBe('RUNTIME_NETWORK_IO_SUSPENDED');
    expect(result.transportCode).toBe('ERR_NETWORK_IO_SUSPENDED');
    expect(result.reason).toContain('Runtime');
    expect(result.diagnostics.cause_code).toBe('ERR_NETWORK_IO_SUSPENDED');
  });
});
