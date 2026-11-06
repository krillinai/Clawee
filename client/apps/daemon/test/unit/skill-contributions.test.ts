import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { httpFailureDetails, incidentErrorDiagnostics, isIncidentDiagnostics } from '@clawee/protocol';
import { createSkillContributionsManager } from '../../src/enterprise/skill-contributions-manager.js';
import { createEnterpriseHttpClient, EnterpriseHttpError, type EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import { EnterpriseSessionError, type EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';
import { registerSkillContributionRoutes } from '../../src/api/routes.skill-contributions.js';
import { contributionExecutionPrompt } from '../../src/enterprise/skill-contributions-conversation.js';

describe('贡献企业访问边界', () => {
  it('使用当前登录令牌，过期后清理会话', async () => {
    const sessionManager = { requireAccessToken: vi.fn(async () => 'current-token'), invalidateUnauthorized: vi.fn() } as unknown as EnterpriseSessionManager;
    const httpClient = { getSkillContributions: vi.fn().mockRejectedValue(new EnterpriseHttpError('ENTERPRISE_UNAUTHORIZED', 'response', 401)) } as unknown as EnterpriseHttpClient;
    const manager = createSkillContributionsManager({ sessionManager, httpClient });
    await expect(manager.query('records', {})).rejects.toMatchObject({ code: 'ENTERPRISE_SESSION_EXPIRED', statusCode: 401 });
    expect(httpClient.getSkillContributions).toHaveBeenCalledWith('current-token', 'records', {});
    expect(sessionManager.invalidateUnauthorized).toHaveBeenCalled();
  });
  it('拒绝未知条件并保留403', async () => {
    const server = Fastify();
    const manager = { capability: vi.fn(async () => ({ allowed: true })), requireRead: vi.fn(), query: vi.fn().mockRejectedValue(new EnterpriseSessionError('ENTERPRISE_DATA_VIEW_FORBIDDEN', 403)), export: vi.fn() };
    try {
      await registerSkillContributionRoutes(server, manager);
      const invalid = await server.inject({ method: 'GET', url: '/enterprise/skill-contributions/records?department_id=guessed' });
      expect(invalid.statusCode).toBe(400);
      expect(manager.query).not.toHaveBeenCalled();
      const forbidden = await server.inject({ method: 'GET', url: '/enterprise/skill-contributions/records?report=uploads' });
      expect(forbidden.statusCode).toBe(403);
    } finally { await server.close(); }
  });
  it('默认条件注入执行输入，禁止自造参数', () => {
    const input = contributionExecutionPrompt('本月首次通过有哪些', { prompt: '本月首次通过有哪些', query: { report: 'first_approvals', start_date: '2026-10-01', end_date: '2026-10-13' } });
    expect(input).toContain('skill_contributions_query');
    expect(input).toContain('"report":"first_approvals"');
    expect(() => contributionExecutionPrompt('查询', { query: { department_id: 'guess' } })).toThrow();
  });
  it('接收 Gateway 的概览与详情条件，不放宽查询请求', async () => {
    const metadata = {
      timezone: 'Asia/Shanghai', generated_at: '2026-10-13T02:00:00Z', total: 0,
      coverage: { first_approvals_from: '2026-10-13T00:00:00Z', uploads_from: null, notice: '历史不完整' }
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...metadata,
        query: { start_date: '2026-10-01', end_date: '2026-10-13', report: '' },
        summary: { uploads: 0, first_approvals: 0, contributors: 0, scored_count: 0, average_score: null }
      } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...metadata,
        query: { start_date: '', end_date: '', report: '' }, items: []
      } })));
    const client = createEnterpriseHttpClient({ origin: 'https://gateway.example', fetch });
    await expect(client.getSkillContributions?.('token', 'summary', {})).resolves.toMatchObject({
      query: { start_date: '2026-10-01', end_date: '2026-10-13' }, summary: { uploads: 0 }
    });
    await expect(client.getSkillContributions?.('token', 'detail', { skill_id: 'skill' })).resolves.toMatchObject({ query: {}, items: [] });
  });
  it('上游200协议异常不得变成成功响应', async () => {
    const sessionManager = { requireAccessToken: vi.fn(async () => 'token') } as unknown as EnterpriseSessionManager;
    const httpClient = createEnterpriseHttpClient({ origin: 'https://gateway.example', fetch: vi.fn(async () => new Response('{}')) });
    const manager = createSkillContributionsManager({ sessionManager, httpClient });
    const server = Fastify();
    try {
      await registerSkillContributionRoutes(server, manager);
      const response = await server.inject({ method: 'GET', url: '/enterprise/skill-contributions/summary' });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: { code: 'ENTERPRISE_PROTOCOL_ERROR' } });
    } finally { await server.close(); }
  });

  it.each(['capability', 'summary', 'records', 'detail', 'export'] as const)('%s 保留连接超时诊断并沿用现有脱敏与异常上报', async endpoint => {
    const sessionManager = { requireAccessToken: vi.fn(async () => 'private-credential') } as unknown as EnterpriseSessionManager;
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect timed out Bearer private-value'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    });
    const manager = createSkillContributionsManager({ sessionManager, httpClient: createEnterpriseHttpClient({ origin: 'https://gateway.test', fetch }) });
    const server = Fastify();
    try {
      await registerSkillContributionRoutes(server, manager);
      const method = endpoint === 'export' ? 'POST' : 'GET';
      const query = endpoint === 'capability' || endpoint === 'export' ? '' : endpoint === 'detail' ? '?skill_id=private-skill' : '?employee_id=private-person';
      const response = await server.inject({ method, url: `/enterprise/skill-contributions/${endpoint}${query}`, ...(endpoint === 'export' ? { payload: { employee_id: 'private-person' } } : {}) });
      const { error } = response.json();
      expect(response.statusCode).toBe(502);
      expect(error).toMatchObject({ code: 'ENTERPRISE_SERVICE_UNAVAILABLE', details: {
        failureKind: 'timeout', causeCode: 'UND_ERR_CONNECT_TIMEOUT', stage: 'request', requestMethod: method,
        requestUrl: endpoint === 'capability' ? 'https://gateway.test/api/v1/app/data-views' : `https://gateway.test/api/v1/app/skill-contributions/${endpoint}`,
        timeoutMs: endpoint === 'export' ? 120000 : 15000, durationMs: expect.any(Number), attempts: 1, maxAttempts: 1
      } });
      expect(error.message).toContain('连接超时');
      const diagnostics = incidentErrorDiagnostics({ name: 'ApiClientError', ...error });
      expect(diagnostics.cause_code).toBe('UND_ERR_CONNECT_TIMEOUT');
      expect(diagnostics.additional_details).toContain(error.details.requestUrl);
      expect(isIncidentDiagnostics(diagnostics)).toBe(true);
      expect(JSON.stringify({ error, diagnostics })).not.toContain('private');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await server.close(); }
  });

  it.each([
    { status: 401, upstreamCode: 'unauthorized', code: 'ENTERPRISE_SESSION_EXPIRED' },
    { status: 403, upstreamCode: 'data_view_forbidden', code: 'ENTERPRISE_DATA_VIEW_FORBIDDEN' },
    { status: 503, upstreamCode: 'data_unavailable', code: 'ENTERPRISE_SERVICE_UNAVAILABLE' }
  ])('上游 HTTP $status 保留状态、错误码、请求标识和重试提示', async ({ status, upstreamCode, code }) => {
    const sessionManager = { requireAccessToken: vi.fn(async () => 'private-credential'), invalidateUnauthorized: vi.fn() } as unknown as EnterpriseSessionManager;
    const httpClient = createEnterpriseHttpClient({ origin: 'https://gateway.test', fetch: async () => Response.json({
      error: { code: upstreamCode, message: 'private response body', request_id: 'req_gateway' }
    }, { status, headers: { 'Retry-After': '2' } }) });
    const server = Fastify();
    try {
      await registerSkillContributionRoutes(server, createSkillContributionsManager({ sessionManager, httpClient }));
      const response = await server.inject({ method: 'GET', url: '/enterprise/skill-contributions/capability' });
      const { error } = response.json();
      expect(response.statusCode).toBe(status);
      expect(error).toMatchObject({ code, details: {
        failureKind: 'response', stage: 'response', statusCode: status, upstreamCode, requestId: 'req_gateway', retryAfterMs: 2000,
        requestMethod: 'GET', requestUrl: 'https://gateway.test/api/v1/app/data-views'
      } });
      expect(error.message).toContain(`上游 HTTP ${status}`);
      const diagnostics = incidentErrorDiagnostics({ name: 'ApiClientError', ...error });
      expect(diagnostics.request_id).toBe('req_gateway');
      expect(diagnostics.additional_details).toContain(upstreamCode);
      expect(isIncidentDiagnostics(diagnostics)).toBe(true);
      expect(JSON.stringify({ error, diagnostics })).not.toContain('private');
      expect(sessionManager.invalidateUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    } finally { await server.close(); }
  });

  it('令牌获取失败时透传已有会话诊断', async () => {
    const details = httpFailureDetails(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND gateway.test'), { code: 'ENOTFOUND' }) }), {
      requestMethod: 'GET', requestUrl: 'https://gateway.test/api/v1/auth/me', stage: 'request', timeoutMs: 15000
    });
    const sessionManager = { requireAccessToken: vi.fn().mockRejectedValue(new EnterpriseSessionError('ENTERPRISE_SERVICE_UNAVAILABLE', 503, details)) } as unknown as EnterpriseSessionManager;
    const server = Fastify();
    try {
      await registerSkillContributionRoutes(server, createSkillContributionsManager({ sessionManager, httpClient: {} as EnterpriseHttpClient }));
      const response = await server.inject({ method: 'GET', url: '/enterprise/skill-contributions/capability' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { details, message: expect.stringContaining('DNS 解析失败') } });
    } finally { await server.close(); }
  });
});
