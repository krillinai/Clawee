import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SkillContributionsManager } from '../enterprise/skill-contributions-manager.js';
import { contributionQuerySchema } from '../enterprise/skill-contributions-schema.js';
import { EnterpriseSessionError } from '../enterprise/session-manager-2026-07-30.js';
import { apiError } from './errors.js';

export async function registerSkillContributionRoutes(server: FastifyInstance, manager: SkillContributionsManager): Promise<void> {
  await server.register(async scoped => {
    scoped.setErrorHandler((error, _request, reply) => {
      if (error instanceof EnterpriseSessionError) return reply.code(error.statusCode).send(apiError(error.code, error.statusCode === 400 ? '查询条件无效或导出超过10,000行，请缩小范围' : 'Skill 贡献服务暂不可用', error.details));
      throw error;
    });
    scoped.get('/capability', () => manager.capability());
    for (const endpoint of ['summary', 'records', 'detail'] as const) {
      scoped.get(`/${endpoint}`, async (request, reply) => {
        const schema = endpoint === 'detail' ? z.object({ skill_id: z.string().min(1).optional(), version_id: z.string().min(1).optional() }).strict() : contributionQuerySchema;
        const parsed = schema.safeParse(request.query);
        if (!parsed.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '查询条件无效'));
        return manager.query(endpoint, parsed.data);
      });
    }
    scoped.post('/export', async (request, reply) => {
      const parsed = contributionQuerySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send(apiError('VALIDATION_FAILED', '导出条件无效'));
      return manager.export(parsed.data);
    });
  }, { prefix: '/enterprise/skill-contributions' });
}
