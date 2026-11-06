import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { EnterpriseSkillManager } from '../enterprise/skill-manager-2026-07-30.js';
import { EnterpriseSkillManagerError } from '../enterprise/skill-manager-2026-07-30.js';
import { EnterpriseSessionError } from '../enterprise/session-manager-2026-07-30.js';
import { EnterpriseHttpError, enterpriseHttpErrorDetails } from '../enterprise/http-client-2026-07-30.js';
import type { RuntimeThread, ThreadManager } from '../threads/types.js';
import { AgentCapabilityTokenError, type AgentCapabilityTokenStore } from './capability-token.js';
import { readBearerToken } from './internal-routes.js';
import { packageLocalSkill, SkillPackageError } from './skill-package.js';
import { skillUploadSchema } from './skill-tools.js';

export async function registerAgentSkillRoutes(server: FastifyInstance, input: {
  capabilities: AgentCapabilityTokenStore;
  skills: Pick<EnterpriseSkillManager, 'listSpaces' | 'uploadSkill'>;
  threads: Pick<ThreadManager, 'getThread'>;
  codexHome: string;
  enabled(thread: RuntimeThread): boolean;
}): Promise<void> {
  for (const operation of ['spaces', 'upload'] as const) {
    server.route<{ Body: unknown }>({
      method: operation === 'spaces' ? 'GET' : 'POST',
      url: `/internal/agent-tools/skills/${operation}`,
      async handler(request, reply) {
        try {
          const grant = input.capabilities.authorize(readBearerToken(request.headers.authorization), {
            scope: operation === 'spaces' ? 'skill:list_spaces' : 'skill:upload'
          });
          const thread = input.threads.getThread(grant.threadId);
          if (grant.createdBy !== 'api' || thread === undefined || !input.enabled(thread)) {
            return reply.code(403).send({ error: { code: 'SKILL_TOOLS_UNAVAILABLE', message: '请登录企业账号并在普通用户对话中上传技能。' } });
          }
          const { spaces } = await input.skills.listSpaces();
          const writable = spaces.filter(space => space.actions.includes('write'));
          if (operation === 'spaces') return { spaces: writable };
          const body = skillUploadSchema.parse(request.body);
          if (!writable.some(space => space.spaceId === body.spaceId)) {
            return reply.code(403).send({ error: { code: 'SKILL_SPACE_FORBIDDEN', message: '目标空间不可写，请重新查询并让用户确认技能空间。' } });
          }
          const archive = await packageLocalSkill({ directory: body.directory, cwd: thread.canonicalCwd, codexHome: input.codexHome });
          // 打包后再核对会话和权限，避免失效的运行继续上传。
          input.capabilities.authorize(readBearerToken(request.headers.authorization), { scope: 'skill:upload', threadId: thread.id, runId: grant.runId });
          if (!input.enabled(thread)) throw new SkillPackageError('当前会话无法上传技能，请重新登录后重试。');
          return await input.skills.uploadSkill({ spaceId: body.spaceId, version: body.version, changelog: body.changelog, package: archive });
        } catch (error) {
          if (error instanceof AgentCapabilityTokenError) {
            return reply.code(error.statusCode).send({ error: { code: error.code, message: '本地工具授权已失效或不允许此操作。' } });
          }
          if (error instanceof ZodError || error instanceof SkillPackageError) {
            return reply.code(400).send({ error: { code: 'SKILL_UPLOAD_INVALID', message: error instanceof SkillPackageError ? error.message : '请提供技能目录、已确认的空间和版本。' } });
          }
          if (error instanceof EnterpriseSessionError || error instanceof EnterpriseSkillManagerError || error instanceof EnterpriseHttpError) {
            return reply.code(error.statusCode ?? 502).send({ error: {
              code: error.code,
              message: '企业技能请求失败，请检查登录状态、空间权限及企业 Skills 列表；上传结果不明时请先核对，勿重复上传。',
              ...(error instanceof EnterpriseHttpError ? { details: enterpriseHttpErrorDetails(error) } : {})
            } });
          }
          return reply.code(400).send({ error: { code: 'SKILL_UPLOAD_FAILED', message: '无法读取或打包技能目录，请检查目录与文件。' } });
        }
      }
    });
  }
}
