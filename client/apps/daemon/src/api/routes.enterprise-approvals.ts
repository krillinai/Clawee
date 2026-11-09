import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { apiError } from './errors.js';
import { approvalFiltersSchema, approvalKindSchema, skillDecisionSchema } from '../enterprise/approvals-schema.js';
import { EnterpriseHttpError, enterpriseHttpErrorDetails, type EnterpriseHttpClient } from '../enterprise/http-client-2026-07-30.js';
import { EnterpriseSessionError, type EnterpriseSessionManager } from '../enterprise/session-manager-2026-07-30.js';
import { isSkillAIReviewPath } from '../enterprise/skill-ai-review-schema.js';
import { ApprovalTrialError, type ApprovalTrialManager } from '../enterprise/approval-trial-manager.js';

const idSchema = z.string().min(1).max(256).refine(value => value !== '.' && value !== '..' && !/[/?#\\\0]/.test(value));

export async function registerEnterpriseApprovalRoutes(server: FastifyInstance, options: {
  session: EnterpriseSessionManager; http: EnterpriseHttpClient; origin(): string;
  trial?: ApprovalTrialManager;
}) {
  const { session, http } = options;
  function identity() {
    const snapshot = session.getSnapshot();
    return JSON.stringify([options.origin(), snapshot.status, snapshot.account?.subjectId, snapshot.agentId]);
  }
  async function forward(reply: FastifyReply, method: 'GET' | 'POST', path: string, body?: unknown) {
    if (session.getSnapshot().status !== 'signed_in') return reply.code(401).send(apiError('ENTERPRISE_UNAUTHORIZED', '请先登录企业账户'));
    const owner = identity();
    try {
      const token = await session.requireAccessToken();
      if (owner !== identity()) return reply.code(409).send(apiError('ENTERPRISE_UNAUTHORIZED', '企业账户已变化，请刷新'));
      if (!http.approvalRequest) throw new Error('审批服务不可用');
      const result = await http.approvalRequest(token, method, `/api/v1/app/${path}`, body);
      if (owner !== identity()) return reply.code(409).send(apiError('ENTERPRISE_UNAUTHORIZED', '企业账户已变化，请刷新'));
      return result;
    } catch (error) {
      if (error instanceof EnterpriseSessionError) {
        return reply.code(error.statusCode).send(apiError(error.code, error.statusCode === 401 ? '登录已失效，请重新登录' : '企业会话暂不可用'));
      }
      if (error instanceof EnterpriseHttpError) {
        const message = error.statusCode === 403 ? '暂无审批权限，请联系管理员'
          : error.statusCode === 404 ? '审批记录不可见或已不存在'
          : error.statusCode === 409 ? '审批状态已变化，请刷新后查看'
          : error.statusCode === 401 ? '登录已失效，请重新登录'
          : '审批请求失败，请稍后重试';
        return reply.code(error.stage === 'decode' ? 502 : error.statusCode ?? 503).send(apiError(error.code, message, enterpriseHttpErrorDetails(error)));
      }
      return reply.code(503).send(apiError('ENTERPRISE_SERVICE_UNAVAILABLE', '审批服务暂不可用'));
    }
  }
  server.get('/enterprise/approvals', (request, reply) => {
    const query = approvalFiltersSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '审批筛选条件无效'));
    return forward(reply, 'GET', `approvals?${new URLSearchParams({ ...query.data, cursor: query.data.cursor ?? '', limit: '20' })}`);
  });
  server.get<{ Params: { kind: string; id: string } }>('/enterprise/approvals/:kind/:id', (request, reply) => {
    const kind = approvalKindSchema.safeParse(request.params.kind);
    const id = idSchema.safeParse(request.params.id);
    if (!kind.success || !id.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '审批地址无效'));
    return forward(reply, 'GET', `approvals/${kind.data}/${encodeURIComponent(id.data)}`);
  });
  server.post<{ Params: { id: string } }>('/enterprise/approvals/skill/:id/decision', (request, reply) => {
    const body = skillDecisionSchema.safeParse(request.body);
    const id = idSchema.safeParse(request.params.id);
    if (!body.success || !id.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '请填写完整评分；驳回时需填写意见'));
    return forward(reply, 'POST', `approvals/skill/${encodeURIComponent(id.data)}/decision`, body.data);
  });
  server.get<{ Params: { id: string } }>('/enterprise/approvals/skill/:id/files', (request, reply) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '审批地址无效'));
    return forward(reply, 'GET', `approvals/skill/${encodeURIComponent(id.data)}/files`);
  });
  server.get<{ Params: { id: string } }>('/enterprise/approvals/skill/:id/file', (request, reply) => {
    const id = idSchema.safeParse(request.params.id);
    const query = z.object({ path: z.string().max(2048).refine(isSkillAIReviewPath) }).strict().safeParse(request.query);
    if (!id.success || !query.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '文件路径无效'));
    return forward(reply, 'GET', `approvals/skill/${encodeURIComponent(id.data)}/file?${new URLSearchParams(query.data)}`);
  });
  server.post<{ Params: { id: string }; Body: unknown }>('/enterprise/approvals/skill/:id/trial', async (request, reply) => {
    const id = idSchema.safeParse(request.params.id);
    const body = trialSchema.safeParse(request.body);
    if (!id.success || !body.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '试用参数无效'));
    if (session.getSnapshot().status !== 'signed_in') return reply.code(401).send(apiError('ENTERPRISE_UNAUTHORIZED', '请先登录企业账户'));
    if (options.trial === undefined) return reply.code(503).send(apiError('ENTERPRISE_SERVICE_UNAVAILABLE', '试用服务暂不可用'));
    const owner = identity();
    try {
      const token = await session.requireAccessToken();
      if (owner !== identity()) return reply.code(409).send(apiError('ENTERPRISE_UNAUTHORIZED', '企业账户已变化，请刷新'));
      const result = await options.trial.start({ accessToken: token, requestId: id.data, projectId: body.data.projectId });
      if (owner !== identity()) return reply.code(409).send(apiError('ENTERPRISE_UNAUTHORIZED', '企业账户已变化，请刷新'));
      return result;
    } catch (error) {
      if (error instanceof ApprovalTrialError) return reply.code(error.statusCode).send(apiError(error.code, error.message));
      if (error instanceof EnterpriseSessionError) return reply.code(error.statusCode).send(apiError(error.code, error.statusCode === 401 ? '登录已失效，请重新登录' : '企业会话暂不可用'));
      if (error instanceof EnterpriseHttpError) {
        const message = error.statusCode === 403 ? '暂无审批权限，请联系管理员'
          : error.statusCode === 404 ? '审批记录不可见或已不存在'
          : error.statusCode === 409 ? '审批状态已变化，请刷新后查看'
          : error.statusCode === 401 ? '登录已失效，请重新登录'
          : '审批 Skill 试用失败，请稍后重试';
        return reply.code(error.stage === 'decode' ? 502 : error.statusCode ?? 503).send(apiError(error.code, message, enterpriseHttpErrorDetails(error)));
      }
      return reply.code(503).send(apiError('ENTERPRISE_SERVICE_UNAVAILABLE', '审批 Skill 试用失败，请稍后重试'));
    }
  });
}

const trialSchema = z.object({ projectId: idSchema }).strict();
