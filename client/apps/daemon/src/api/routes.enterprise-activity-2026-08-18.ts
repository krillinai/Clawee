import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  EnterpriseActivityManager
} from '../enterprise/activity-manager-2026-08-18.js';
import {
  EnterpriseActivityManagerError
} from '../enterprise/activity-manager-2026-08-18.js';
import { apiError } from './errors.js';

const rangeSchema = z.enum(['today', '7d', '30d']);
const statisticsQuerySchema = z.object({
  range: rangeSchema
}).strict();
const detailQuerySchema = statisticsQuerySchema.extend({
  collectorId: z.string().trim().min(1).max(512),
  agentId: z.string().trim().min(1).max(512)
}).strict();

export async function registerEnterpriseActivityRoutes(
  server: FastifyInstance,
  manager: EnterpriseActivityManager
): Promise<void> {
  server.get('/enterprise/activity/capability', async (_request, reply) => {
    try {
      return await manager.getCapability();
    } catch (error) {
      return sendActivityError(reply, error);
    }
  });

  server.get<{ Querystring: unknown }>(
    '/enterprise/activity/statistics',
    async (request, reply) => {
      const parsed = statisticsQuerySchema.safeParse(request.query);
      if (!parsed.success) return invalidRequest(reply);
      try {
        return await manager.getStatistics(parsed.data.range);
      } catch (error) {
        return sendActivityError(reply, error);
      }
    }
  );

  server.get<{ Querystring: unknown }>(
    '/enterprise/activity/detail',
    async (request, reply) => {
      const parsed = detailQuerySchema.safeParse(request.query);
      if (!parsed.success) return invalidRequest(reply);
      try {
        return await manager.getDetail(parsed.data);
      } catch (error) {
        return sendActivityError(reply, error);
      }
    }
  );
}

function invalidRequest(reply: FastifyReply) {
  return reply
    .code(400)
    .send(apiError('VALIDATION_FAILED', 'activity request is invalid'));
}

function sendActivityError(reply: FastifyReply, error: unknown) {
  if (error instanceof EnterpriseActivityManagerError) {
    return reply
      .code(error.statusCode)
      .send(apiError(
        error.code,
        activityErrorMessage(error.code),
        error.details
      ));
  }
  throw error;
}

function activityErrorMessage(code: string): string {
  switch (code) {
    case 'ENTERPRISE_SESSION_EXPIRED':
    case 'ENTERPRISE_UNAUTHORIZED':
      return 'Enterprise session expired';
    case 'ENTERPRISE_DATA_VIEW_FORBIDDEN':
      return 'Enterprise activity access is forbidden';
    case 'ENTERPRISE_DATA_AUTHORIZATION_UNAVAILABLE':
      return 'Enterprise activity authorization is unavailable';
    case 'ENTERPRISE_ACTIVITY_UNAVAILABLE':
      return 'Enterprise activity is unavailable';
    case 'ENTERPRISE_ACTIVITY_NOT_FOUND':
      return 'Enterprise activity agent was not found';
    case 'ENTERPRISE_ACTIVITY_PROVIDER_ERROR':
      return 'Enterprise activity provider is unavailable';
    default:
      return 'Enterprise activity operation failed';
  }
}
