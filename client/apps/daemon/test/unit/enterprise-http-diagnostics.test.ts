import { describe, expect, it, vi } from 'vitest';
import { incidentErrorDiagnostics } from '@clawee/protocol';
import { apiError } from '../../src/api/errors.js';
import { createEnterpriseHttpClient, EnterpriseHttpError, enterpriseHttpErrorDetails } from '../../src/enterprise/http-client-2026-07-30.js';

describe('企业请求失败诊断', () => {
  it.each(['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET'])('将 %s 原因和重试信息传入 API 错误及异常上报', async code => {
    const fetch = vi.fn(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error(`${code} gateway.test Bearer private-value`), { code }) }); });
    const client = createEnterpriseHttpClient({ origin: 'https://gateway.test', fetch, retryDelayMs: 0 });
    const error = await client.getMe('private-credential').catch(error => error as EnterpriseHttpError);
    expect(error).toBeInstanceOf(EnterpriseHttpError);
    expect(fetch).toHaveBeenCalledTimes(2);
    const details = enterpriseHttpErrorDetails(error as EnterpriseHttpError);
    expect(details).toMatchObject({ causeCode: code, requestUrl: 'https://gateway.test/api/v1/auth/me', requestMethod: 'GET', timeoutMs: 15000, attempts: 2, maxAttempts: 2, stage: 'request' });
    const payload = apiError('ENTERPRISE_SERVICE_UNAVAILABLE', 'Enterprise service is unavailable', details);
    expect(payload.error.message).toContain(code);
    const diagnostics = incidentErrorDiagnostics({ name: 'ApiClientError', ...payload.error });
    expect(diagnostics).toMatchObject({ cause_code: code });
    expect(diagnostics.additional_details).toContain('2/2');
    expect(JSON.stringify(payload)).not.toContain('private');
    expect(JSON.stringify(diagnostics)).not.toContain('private');
  });

  it('HTTP 503 保留上游错误码、请求标识和目标接口，排除响应正文', async () => {
    const client = createEnterpriseHttpClient({ origin: 'https://gateway.test', fetch: async () => Response.json({
      error: { code: 'upstream_unavailable', message: 'upstream timed out Bearer private-value', request_id: 'req_gateway' }
    }, { status: 503 }) });
    const error = await client.getMe('private').catch(error => error as EnterpriseHttpError);
    const details = enterpriseHttpErrorDetails(error as EnterpriseHttpError);
    expect(details).toMatchObject({ failureKind: 'response', statusCode: 503, upstreamCode: 'upstream_unavailable', requestId: 'req_gateway', requestUrl: 'https://gateway.test/api/v1/auth/me', attempts: 1 });
    expect(apiError('ENTERPRISE_SERVICE_UNAVAILABLE', '', details).error.message).toContain('上游 HTTP 503');
    expect(JSON.stringify(details)).not.toContain('private');
  });

  it('Skill 上传冲突透传 Gateway 返回的 Skill 和空间提示', async () => {
    const message = '技能“functional-competency-model”已存在于“人力资源部”空间，请选择该空间或修改 Skill 名称';
    const client = createEnterpriseHttpClient({ origin: 'https://gateway.test', fetch: async () => Response.json({
      code: 'conflict', error: message
    }, { status: 409 }) });
    const error = await client.uploadSkillVersion({
      accessToken: 'private', spaceId: 'skillspace_default', version: '1.0.0', changelog: '', package: Buffer.from('ZIP')
    }).catch(error => error as EnterpriseHttpError);
    const details = enterpriseHttpErrorDetails(error as EnterpriseHttpError);

    expect(details).toMatchObject({ upstreamMessage: message });
    expect(apiError('ENTERPRISE_SKILL_SOURCE_CONFLICT', 'fallback', details).error.message).toBe(message);
  });

  it('真实 AbortSignal 超时记录配置值，非幂等请求保持不重试', async () => {
    const client = createEnterpriseHttpClient({ origin: 'https://gateway.test', jsonTimeoutMs: 10,
      fetch: vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      })) });
    await expect(client.login({ email: 'private@example.com', password: 'private' }, 'agent')).rejects.toMatchObject({
      details: { failureKind: 'timeout', causeCode: 'TimeoutError', timeoutMs: 10, attempts: 1, maxAttempts: 1, requestMethod: 'POST' }
    });
  });

  it('成功响应后的正文连接中断也保留底层错误，不误判为解析失败', async () => {
    const client = createEnterpriseHttpClient({ origin: 'https://gateway.test', fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('terminated', { cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }) })); }
    })) });
    await expect(client.getMe('private')).rejects.toMatchObject({ code: 'ENTERPRISE_SERVICE_UNAVAILABLE', details: { causeCode: 'UND_ERR_SOCKET', failureKind: 'connection_reset', statusCode: 200 } });
  });
});
