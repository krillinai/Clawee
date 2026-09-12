import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  EnterpriseBusinessDashboardManager
} from '../enterprise/business-dashboard-manager-2026-08-30.js';
import {
  EnterpriseBusinessDashboardManagerError
} from '../enterprise/business-dashboard-manager-2026-08-30.js';
import { apiError } from './errors.js';

const dashboardQuerySchema = z.object({
  range: z.enum(['today', '7d', '30d']).optional().default('7d'),
  sourceId: z.string().trim().min(1).max(512).optional()
}).strict();

export async function registerEnterpriseBusinessDashboardRoutes(
  server: FastifyInstance,
  manager: EnterpriseBusinessDashboardManager
): Promise<void> {
  server.get<{ Querystring: unknown }>(
    '/enterprise/business-dashboards/bilibili-operation',
    async (request, reply) => {
      const parsed = dashboardQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send(apiError(
          'VALIDATION_FAILED',
          'Bilibili dashboard request is invalid'
        ));
      }
      try {
        return await manager.getBilibiliDashboard(parsed.data);
      } catch (error) {
        return sendDashboardError(reply, error);
      }
    }
  );
}

function sendDashboardError(reply: FastifyReply, error: unknown) {
  if (error instanceof EnterpriseBusinessDashboardManagerError) {
    return reply.code(error.statusCode).send(apiError(
      error.code,
      dashboardErrorMessage(error.code)
    ));
  }
  throw error;
}

function dashboardErrorMessage(code: string): string {
  switch (code) {
    case 'ENTERPRISE_SESSION_EXPIRED':
    case 'ENTERPRISE_UNAUTHORIZED':
      return 'Enterprise session expired';
    case 'ENTERPRISE_DATA_VIEW_FORBIDDEN':
      return 'Enterprise Bilibili dashboard access is forbidden';
    case 'ENTERPRISE_PROTOCOL_ERROR':
      return 'Enterprise Bilibili dashboard response is invalid';
    default:
      return 'Enterprise Bilibili dashboard is unavailable';
  }
}
