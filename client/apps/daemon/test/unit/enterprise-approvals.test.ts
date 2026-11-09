import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerEnterpriseApprovalRoutes } from '../../src/api/routes.enterprise-approvals.js';
import { createEnterpriseHttpClient, EnterpriseHttpError, type EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import { EnterpriseSessionError, type EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';
import type { ApprovalTrialManager } from '../../src/enterprise/approval-trial-manager.js';

const item = { kind: 'skill', id: 'request-1', type: 'skill', title: '测试 Skill', business_status: 'pending', my_status: 'pending', created_at: '2026-10-27T00:00:00Z', can_process: true };
const meta = { next_cursor: '', has_next: false };
const scores = { scenario_value: 4, result_effectiveness: 4, ease_of_use: 4, reuse_value: 4 };

async function fixture(http?: EnterpriseHttpClient, trial?: ApprovalTrialManager) {
  let status = 'signed_in';
  let user = 'user-1';
  const session = { getSnapshot: () => ({ status, agentId: 'agent-1', account: { subjectId: user } }), requireAccessToken: vi.fn(async () => 'current-token') } as unknown as EnterpriseSessionManager;
  const client = http ?? { approvalRequest: vi.fn(async () => ({ data: [item], meta })) } as unknown as EnterpriseHttpClient;
  const server = Fastify();
  await registerEnterpriseApprovalRoutes(server, { session, http: client, origin: () => 'https://gateway.example', trial });
  return { server, session, client, signOut: () => { status = 'signed_out'; }, changeUser: () => { user = 'user-2'; } };
}

describe('企业审批访问边界', () => {
  it('使用当前登录令牌和固定用户侧接口，不接受用户指定身份或任意路径', async () => {
    const { server, client, signOut } = await fixture();
    try {
      expect((await server.inject('/enterprise/approvals?view=initiated&type=skill&status=pending')).statusCode).toBe(200);
      expect(client.approvalRequest).toHaveBeenCalledWith('current-token', 'GET', '/api/v1/app/approvals?view=initiated&type=skill&status=pending&cursor=&limit=20', undefined);
      expect((await server.inject('/enterprise/approvals?user_id=another')).statusCode).toBe(400);
      expect((await server.inject('/enterprise/approvals/admin/request-1')).statusCode).toBe(400);
      expect((await server.inject('/enterprise/approvals/skill/request-1/file?path=..%2Fsecret')).statusCode).toBe(400);
      vi.mocked(client.approvalRequest!).mockClear(); signOut();
      expect((await server.inject('/enterprise/approvals')).statusCode).toBe(401);
      expect(client.approvalRequest).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
  it.each([
    { decision: 'approved', comment: '', scores: {} },
    { decision: 'approved', comment: '', scores: { ...scores, reuse_value: 6 } },
    { decision: 'rejected', comment: '  ', scores: {} },
    { decision: 'approved', comment: '', scores, user_id: 'another' }
  ])('无效审核输入在转发前被拒绝：%j', async payload => {
    const { server, client } = await fixture();
    try {
      expect((await server.inject({ method: 'POST', url: '/enterprise/approvals/skill/request-1/decision', payload })).statusCode).toBe(400);
      expect(client.approvalRequest).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
  it('通过完整评分、驳回部分评分，均保持原审核轮次', async () => {
    const { server, client } = await fixture();
    try {
      for (const payload of [{ decision: 'approved', comment: '', scores }, { decision: 'rejected', comment: '缺少说明', scores: {} }]) {
        expect((await server.inject({ method: 'POST', url: '/enterprise/approvals/skill/request-1/decision', payload })).statusCode).toBe(200);
        expect(client.approvalRequest).toHaveBeenLastCalledWith('current-token', 'POST', '/api/v1/app/approvals/skill/request-1/decision', payload);
      }
    } finally { await server.close(); }
  });
  it.each([401, 403, 404, 409])('保留上游状态 %s', async status => {
    const { server } = await fixture({ approvalRequest: vi.fn().mockRejectedValue(new EnterpriseHttpError('ENTERPRISE_SERVICE_UNAVAILABLE', 'response', status)) } as unknown as EnterpriseHttpClient);
    try { expect((await server.inject('/enterprise/approvals')).statusCode).toBe(status); }
    finally { await server.close(); }
  });
  it('令牌续期失败时保留登录失效状态', async () => {
    const { server, session, client } = await fixture();
    vi.mocked(session.requireAccessToken).mockRejectedValueOnce(new EnterpriseSessionError('ENTERPRISE_UNAUTHORIZED', 401));
    try {
      expect((await server.inject('/enterprise/approvals')).statusCode).toBe(401);
      expect(client.approvalRequest).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
  it('令牌获取或请求期间身份变化时丢弃旧身份结果', async () => {
    const context = await fixture();
    try {
      vi.mocked(context.session.requireAccessToken).mockImplementationOnce(async () => { context.changeUser(); return 'old-token'; });
      expect((await context.server.inject('/enterprise/approvals')).statusCode).toBe(409);
      expect(context.client.approvalRequest).not.toHaveBeenCalled();
      vi.mocked(context.client.approvalRequest!).mockImplementationOnce(async () => { context.signOut(); return { data: [item], meta }; });
      const result = await context.server.inject('/enterprise/approvals');
      expect(result.statusCode).toBe(409); expect(result.body).not.toContain('测试 Skill');
    } finally { await context.server.close(); }
  });
  it('试用路由使用当前令牌和所选项目，并拒绝无效参数', async () => {
    const trial = { start: vi.fn(async () => ({ trialId: 'trial-1', projectId: 'project-1', skillName: 'weekly-report', version: '1.0', expiresAt: '2026-10-27T02:00:00Z' })) } as unknown as ApprovalTrialManager;
    const context = await fixture(undefined, trial);
    try {
      const result = await context.server.inject({ method: 'POST', url: '/enterprise/approvals/skill/request-1/trial', payload: { projectId: 'project-1' } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ trialId: 'trial-1', projectId: 'project-1' });
      expect(trial.start).toHaveBeenCalledWith({ accessToken: 'current-token', requestId: 'request-1', projectId: 'project-1' });
      expect((await context.server.inject({ method: 'POST', url: '/enterprise/approvals/skill/request-1/trial', payload: { projectId: '../secret' } })).statusCode).toBe(400);
      expect(trial.start).toHaveBeenCalledOnce();
    } finally { await context.server.close(); }
  });
  it('解析实际列表、详情和文件信封，拒绝畸形成功响应', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ data: [item], meta }))
      .mockResolvedValueOnce(Response.json({ data: { item, skill: { skill: { name: '测试', description: '' }, versions: [] } } }))
      .mockResolvedValueOnce(Response.json({ items: [{ path: 'SKILL.md', size: 12 }] }))
      .mockResolvedValueOnce(Response.json({ data: { path: 'SKILL.md', size: 12, content: '# 内容' } }))
      .mockResolvedValueOnce(Response.json({ data: [{ ...item, can_process: 'yes' }], meta }));
    const http = createEnterpriseHttpClient({ origin: 'https://gateway.example', fetch });
    await expect(http.approvalRequest!('token', 'GET', '/api/v1/app/approvals')).resolves.toEqual({ data: [item], meta });
    await expect(http.approvalRequest!('token', 'GET', '/api/v1/app/approvals/skill/request-1')).resolves.toMatchObject({ data: { item } });
    await expect(http.approvalRequest!('token', 'GET', '/api/v1/app/approvals/skill/request-1/files')).resolves.toEqual({ items: [{ path: 'SKILL.md', size: 12 }] });
    await expect(http.approvalRequest!('token', 'GET', '/api/v1/app/approvals/skill/request-1/file?path=SKILL.md')).resolves.toMatchObject({ data: { content: '# 内容' } });
    await expect(http.approvalRequest!('token', 'GET', '/api/v1/app/approvals')).rejects.toMatchObject({ code: 'ENTERPRISE_PROTOCOL_ERROR' });
    expect(fetch.mock.calls.every(([, input]) => (input?.headers as Record<string, string>).Authorization === 'Bearer token')).toBe(true);
  });
  it('已通过详情允许正式评分汇总为多人平均小数分', async () => {
    const summary = { scenario_value: 3.5, result_effectiveness: 4, ease_of_use: 4.5, reuse_value: 3.5, total: 15.5 };
    const data = { item: { ...item, business_status: 'approved', can_process: false }, skill: {
      skill: { name: '测试', description: '' }, versions: [{ version_id: 'version-1', version: '1.0', description: '', changelog: '', local_approval: {
        request_id: item.id, status: 'approved', total: 2, approved: 2, approvers: [], score_summary: summary
      } }]
    } };
    const client = createEnterpriseHttpClient({ origin: 'https://gateway.example', fetch: vi.fn(async () => Response.json({ data })) });
    await expect(client.approvalRequest!('token', 'GET', `/api/v1/app/approvals/skill/${item.id}`)).resolves.toMatchObject({ data: { skill: { versions: [{ local_approval: { score_summary: summary } }] } } });
  });
});
