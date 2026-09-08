import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  EnterpriseBillingManagerError,
  type EnterpriseBillingManager
} from '../enterprise/billing-manager-2026-08-28.js';
import { apiError } from './errors.js';

const overviewQuerySchema = z.object({
  range: z.enum(['today', '7d', '30d'])
}).strict();
const emptyQuerySchema = z.object({}).strict();
const ordersQuerySchema = z.object({
  page: z.coerce.number().int().safe().positive()
}).strict();

export async function registerEnterpriseBillingRoutes(
  server: FastifyInstance,
  manager: EnterpriseBillingManager
): Promise<void> {
  server.get<{ Querystring: unknown }>(
    '/enterprise/billing/overview',
    async (request, reply) => {
      const parsed = overviewQuerySchema.safeParse(request.query);
      if (!parsed.success) return invalidRequest(reply);
      try {
        return await manager.getOverview(parsed.data.range);
      } catch (error) {
        return sendBillingError(reply, error);
      }
    }
  );

  server.post<{ Querystring: unknown; Body: unknown }>(
    '/enterprise/billing/recharge-session',
    async (request, reply) => {
      const query = emptyQuerySchema.safeParse(request.query);
      if (!query.success || request.body !== undefined) {
        return invalidRequest(reply);
      }
      try {
        return await manager.createRechargeSession();
      } catch (error) {
        return sendBillingError(reply, error);
      }
    }
  );

  server.get<{ Querystring: unknown }>(
    '/enterprise/billing/recharge-orders',
    async (request, reply) => {
      const parsed = ordersQuerySchema.safeParse(request.query);
      if (!parsed.success) return invalidRequest(reply);
      try {
        return await manager.listRechargeOrders({ page: parsed.data.page });
      } catch (error) {
        return sendBillingError(reply, error);
      }
    }
  );
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send(apiError(
    'ENTERPRISE_INVALID_REQUEST',
    'billing request is invalid'
  ));
}

function sendBillingError(reply: FastifyReply, error: unknown) {
  if (error instanceof EnterpriseBillingManagerError) {
    return reply.code(error.statusCode).send(apiError(
      error.code,
      billingErrorMessage(error.code),
      error.details
    ));
  }
  return reply.code(500).send(apiError(
    'INTERNAL_ERROR',
    'Enterprise billing operation failed'
  ));
}

function billingErrorMessage(code: string): string {
  switch (code) {
    case 'ENTERPRISE_SESSION_EXPIRED':
    case 'ENTERPRISE_UNAUTHORIZED':
      return 'Enterprise session expired';
    case 'ENTERPRISE_DATA_VIEW_FORBIDDEN':
      return 'Enterprise billing access is forbidden';
    case 'ENTERPRISE_BILLING_NOT_MANAGED':
      return 'Enterprise billing is not managed by platform';
    case 'ENTERPRISE_BILLING_UNAVAILABLE':
      return 'Enterprise billing is unavailable';
    case 'ENTERPRISE_INVALID_REQUEST':
      return 'Enterprise billing request is invalid';
    case 'ENTERPRISE_PROTOCOL_ERROR':
      return 'Enterprise billing response is invalid';
    default:
      return 'Enterprise billing operation failed';
  }
}
