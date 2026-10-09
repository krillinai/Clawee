import type { CreateScheduleRequest, CreateWorkflowScheduleRequest, UpdateScheduleRequest, UpdateWorkflowScheduleRequest } from '@clawee/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ScheduleCoordinator } from '../scheduler/coordinator.js';
import { SchedulerError, type SchedulerService } from '../scheduler/service.js';
import { apiError } from './errors.js';

export async function registerScheduleRoutes(
  server: FastifyInstance,
  coordinator: ScheduleCoordinator,
  scheduler: SchedulerService,
  canRunAgent: () => boolean = () => true
): Promise<void> {
  server.get<{ Querystring: { action?: unknown } }>('/schedules', async (request, reply) => {
    try {
      const action = request.query.action;
      if (action !== undefined && action !== 'workflow_start') return reply.code(400).send(apiError('VALIDATION_FAILED', '计划动作筛选无效'));
      return scheduler.listSchedules(!canRunAgent() || action === 'workflow_start');
    } catch (error) {
      return sendSchedulerError(error, reply);
    }
  });

  server.post<{ Body: unknown }>('/schedules', async (request, reply) => {
    const body = parseBodyObject(request.body);
    if (!body.ok) return reply.code(400).send(apiError('VALIDATION_FAILED', body.message));

    try {
      if (blockAgentAction(body.value.action, reply)) return reply;
      if (body.value.action === 'workflow_start' && !coordinator.createWorkflow) throw new SchedulerError('ENTERPRISE_SERVICE_UNAVAILABLE', '工作流服务不可用');
      const schedule = body.value.action === 'workflow_start'
        ? await coordinator.createWorkflow!(body.value as CreateWorkflowScheduleRequest)
        : coordinator.createManual(body.value as CreateScheduleRequest);
      return reply.code(201).send(schedule);
    } catch (error) {
      return sendSchedulerError(error, reply);
    }
  });

  server.get<{ Params: { id: string } }>('/schedules/:id', async (request, reply) => {
    try {
      const schedule = scheduler.getSchedule(request.params.id);
      if (schedule === undefined) {
        return reply.code(404).send(apiError('SCHEDULE_NOT_FOUND', 'Schedule not found'));
      }
      if (blockAgentAction(schedule.action, reply)) return reply;
      return schedule;
    } catch (error) {
      return sendSchedulerError(error, reply);
    }
  });

  server.patch<{ Params: { id: string }; Body: unknown }>(
    '/schedules/:id',
    async (request, reply) => {
      const body = parseBodyObject(request.body);
      if (!body.ok) return reply.code(400).send(apiError('VALIDATION_FAILED', body.message));

      try {
        const schedule = scheduler.getSchedule(request.params.id);
        if (!canRunAgent() && schedule === undefined) return reply.code(404).send(apiError('SCHEDULE_NOT_FOUND', 'Schedule not found'));
        if (blockAgentAction(schedule?.action, reply)) return reply;
        if (schedule?.action === 'workflow_start') {
          if (!coordinator.updateWorkflow) throw new SchedulerError('ENTERPRISE_SERVICE_UNAVAILABLE', '工作流服务不可用');
          return await coordinator.updateWorkflow(request.params.id, body.value as UpdateWorkflowScheduleRequest);
        }
        return coordinator.update(request.params.id, body.value as UpdateScheduleRequest);
      } catch (error) {
        return sendSchedulerError(error, reply);
      }
    }
  );

  server.delete<{ Params: { id: string } }>('/schedules/:id', async (request, reply) => {
    try {
      if (!canRunAgent()) {
        const schedule = scheduler.getSchedule(request.params.id);
        if (schedule === undefined) return reply.code(404).send(apiError('SCHEDULE_NOT_FOUND', 'Schedule not found'));
        if (blockAgentAction(schedule.action, reply)) return reply;
      }
      coordinator.delete(request.params.id);
      return { deleted: true };
    } catch (error) {
      return sendSchedulerError(error, reply);
    }
  });

  server.post<{ Params: { id: string }; Body: unknown }>('/schedules/:id/run-now', async (request, reply) => {
    try {
      const schedule = scheduler.getSchedule(request.params.id);
      if (!canRunAgent() && schedule === undefined) return reply.code(404).send(apiError('SCHEDULE_NOT_FOUND', 'Schedule not found'));
      if (blockAgentAction(schedule?.action, reply)) return reply;
      let triggerId: string | undefined;
      if (request.body !== undefined) {
        if (!isPlainObject(request.body) || Object.keys(request.body).some(key => key !== 'triggerId') || (request.body.triggerId !== undefined && (typeof request.body.triggerId !== 'string' || !request.body.triggerId.trim()))) {
          return reply.code(400).send(apiError('VALIDATION_FAILED', '触发记录无效'));
        }
        triggerId = request.body.triggerId as string | undefined;
      }
      if (triggerId && schedule?.action !== 'workflow_start') return reply.code(400).send(apiError('VALIDATION_FAILED', '普通任务不支持工作流触发重试'));
      if (schedule?.action === 'workflow_start' && !scheduler.runWorkflowNow) throw new SchedulerError('ENTERPRISE_SERVICE_UNAVAILABLE', '工作流服务不可用');
      const result = schedule?.action === 'workflow_start'
        ? await scheduler.runWorkflowNow!(request.params.id, triggerId)
        : scheduler.runNow(request.params.id);
      return reply.code(202).send(result);
    } catch (error) {
      return sendSchedulerError(error, reply);
    }
  });

  server.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/schedules/:id/operations',
    async (request, reply) => {
      const limit = parseLimitQuery(request.query);

      try {
        if (!canRunAgent()) {
          const schedule = scheduler.getSchedule(request.params.id);
          if (schedule === undefined) return reply.code(404).send(apiError('SCHEDULE_NOT_FOUND', 'Schedule not found'));
          if (blockAgentAction(schedule.action, reply)) return reply;
        }
        return scheduler.listOperations(request.params.id, limit);
      } catch (error) {
        return sendSchedulerError(error, reply);
      }
    }
  );

  function blockAgentAction(action: unknown, reply: FastifyReply): boolean {
    if (canRunAgent() || action === 'workflow_start') return false;
    reply.code(428).send(apiError('MODEL_SERVICE_CONFIGURATION_REQUIRED', '请先配置并验证 Codex 模型服务'));
    return true;
  }
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function parseBodyObject(body: unknown): ParseResult<Record<string, unknown>> {
  if (!isPlainObject(body)) return { ok: false, message: 'body must be an object' };
  return { ok: true, value: body };
}

function parseLimitQuery(query: unknown): number | undefined {
  if (!isPlainObject(query)) return undefined;

  const rawLimit = query.limit;
  if (typeof rawLimit !== 'string') return undefined;

  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(200, Math.max(1, Math.trunc(parsed)));
}

function sendSchedulerError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof SchedulerError)) {
    return reply.code(500).send(apiError('INTERNAL_ERROR', 'Internal error'));
  }

  if (error.code === 'ENTERPRISE_UNAUTHORIZED' || error.code === 'ENTERPRISE_FORBIDDEN' || error.code === 'ENTERPRISE_SERVICE_UNAVAILABLE') {
    const status = error.code === 'ENTERPRISE_UNAUTHORIZED' ? 401 : error.code === 'ENTERPRISE_FORBIDDEN' ? 403 : 503;
    return reply.code(status).send(apiError(error.code, error.message, error.details));
  }

  if (error.code === 'VALIDATION_FAILED') {
    return reply.code(400).send(apiError(error.code, error.message));
  }
  if (error.code === 'SCHEDULE_INVALID') {
    return reply.code(422).send(apiError(error.code, error.message));
  }
  if (error.code === 'SCHEDULE_NOT_FOUND' || error.code === 'CODEX_PROFILE_NOT_FOUND') {
    return reply.code(404).send(apiError(error.code, error.message));
  }
  if (
    error.code === 'SCHEDULE_HAS_ACTIVE_RUN'
    || error.code === 'SCHEDULE_THREAD_MISSING'
    || error.code === 'SCHEDULE_THREAD_ARCHIVED'
  ) {
    return reply.code(409).send(apiError(error.code, error.message));
  }
  if (error.code === 'CODEX_PROFILE_INVALID' || error.code === 'CODEX_CONFIG_INVALID') {
    return reply.code(422).send(apiError(error.code, error.message));
  }
  if (error.code === 'INTERNAL_ERROR') {
    return reply.code(500).send(apiError(error.code, 'Internal error'));
  }

  return reply.code(500).send(apiError('INTERNAL_ERROR', 'Internal error'));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
