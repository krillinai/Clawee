import { createHash } from 'node:crypto';
import { canonicalFeedbackJSON, type CreateWorkflowScheduleRequest, type RunScheduleNowResponse, type UpdateWorkflowScheduleRequest } from '@clawee/protocol';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { EnterpriseHttpError, type EnterpriseHttpClient } from '../enterprise/http-client-2026-07-30.js';
import { EnterpriseSessionError, type EnterpriseSessionManager } from '../enterprise/session-manager-2026-07-30.js';
import { computeNextRunAt, getDefaultTimezone, isValidTimezone, validateCronExpression } from './cron.js';
import type { ScheduleRepository } from './repository.js';
import { SchedulerError, toScheduleResponse } from './service.js';
import { scheduleOperationActors, type ScheduleOperationActor, type ScheduleRecord, type SchedulerClock, type WorkflowScheduleOwner, type WorkflowScheduleTrigger } from './types.js';

const workflowSchema = z.object({
  templateId: z.string().trim().min(1).max(200),
  initialInput: z.record(z.string(), z.unknown()).refine(input => {
    try { return Buffer.byteLength(JSON.stringify(input)) <= 1024 * 1024; } catch { return false; }
  })
}).strict();
const createSchema = z.object({
  action: z.literal('workflow_start'),
  requestId: z.string().uuid().transform(value => value.toLowerCase()).optional(),
  name: z.string().trim().min(1),
  cron: z.string().trim().min(1),
  timezone: z.string().optional(),
  enabled: z.boolean().optional(),
  workflow: workflowSchema
}).strict();
const updateSchema = createSchema.omit({ requestId: true }).partial();

export type WorkflowSchedules = ReturnType<typeof createWorkflowSchedules>;

export function createWorkflowSchedules(options: {
  db: Database.Database;
  repository: ScheduleRepository;
  session: Pick<EnterpriseSessionManager, 'getSnapshot' | 'requireAccessToken'>;
  http: Pick<EnterpriseHttpClient, 'workflowRequest'>;
  origin(): string;
  clock?: SchedulerClock;
}) {
  const { db, repository, session, http } = options;
  const clock = options.clock ?? { now: () => new Date() };
  const inFlight = new Map<string, Promise<RunScheduleNowResponse>>();

  function currentOwner(): WorkflowScheduleOwner {
    const snapshot = session.getSnapshot();
    if (snapshot.status !== 'signed_in' || !snapshot.account?.subjectId || !snapshot.agentId) {
      throw new SchedulerError('ENTERPRISE_UNAUTHORIZED', '企业会话不可用，请重新登录');
    }
    return { origin: new URL(options.origin()).origin, subjectId: snapshot.account.subjectId, agentId: snapshot.agentId };
  }

  function assertOwner(owner: WorkflowScheduleOwner | undefined): void {
    const current = currentOwner();
    if (!owner || current.origin !== owner.origin || current.subjectId !== owner.subjectId || current.agentId !== owner.agentId) {
      throw new SchedulerError('ENTERPRISE_FORBIDDEN', '该计划不属于当前企业账号、Agent 或服务');
    }
  }

  function assertSchedule(schedule: ScheduleRecord): void {
    assertOwner(schedule.owner);
  }

  function canRead(schedule: ScheduleRecord): boolean {
    try { assertSchedule(schedule); return true; } catch { return false; }
  }

  function requireSchedule(id: string): ScheduleRecord {
    const schedule = repository.getById(id);
    if (!schedule) throw new SchedulerError('SCHEDULE_NOT_FOUND', '计划不存在');
    if (schedule.action !== 'workflow_start') throw new SchedulerError('VALIDATION_FAILED', '不是工作流计划');
    assertSchedule(schedule);
    return schedule;
  }

  function validateTiming(cron: string, timezone: string): void {
    if (!isValidTimezone(timezone) || !validateCronExpression(cron).ok) {
      throw new SchedulerError('SCHEDULE_INVALID', 'Cron 或时区无效');
    }
  }

  async function accessToken(owner: WorkflowScheduleOwner): Promise<string> {
    assertOwner(owner);
    const token = await session.requireAccessToken();
    assertOwner(owner);
    return token;
  }

  function safeError(error: unknown, triggerId?: string): SchedulerError {
    if (error instanceof SchedulerError) return new SchedulerError(error.code, error.message, triggerId ? { triggerId } : undefined);
    const status = error instanceof EnterpriseHttpError || error instanceof EnterpriseSessionError ? error.statusCode : undefined;
    const code = status === 401 ? 'ENTERPRISE_UNAUTHORIZED' : status === 403 ? 'ENTERPRISE_FORBIDDEN' : 'ENTERPRISE_SERVICE_UNAVAILABLE';
    const message = status === 401 ? '企业会话已失效，请重新登录' : status === 403 ? '没有工作流发起权限' : '工作流请求失败或结果未知，可使用原触发记录重试';
    return new SchedulerError(code, message, triggerId ? { triggerId } : undefined);
  }

  async function checkTemplate(owner: WorkflowScheduleOwner, templateId: string): Promise<void> {
    try {
      const token = await accessToken(owner);
      if (!http.workflowRequest) throw new Error('unavailable');
      const response = await http.workflowRequest(token, 'GET', `/api/v1/app/workflow-templates/${encodeURIComponent(templateId)}`);
      assertOwner(owner);
      if ((response.data as { status?: string } | null)?.status !== 'enabled') {
        throw new SchedulerError('VALIDATION_FAILED', '工作流模板未启用');
      }
    } catch (error) { throw safeError(error); }
  }

  async function create(input: CreateWorkflowScheduleRequest) {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) throw new SchedulerError('VALIDATION_FAILED', '工作流计划内容无效');
    const timezone = parsed.data.timezone ?? getDefaultTimezone();
    validateTiming(parsed.data.cron, timezone);
    const owner = currentOwner();
    const { requestId, ...fields } = parsed.data;
    const content = { ...fields, timezone, enabled: fields.enabled ?? true };
    const id = requestId === undefined ? undefined : `wf_${createHash('sha256').update(JSON.stringify([owner.origin, owner.subjectId, owner.agentId, requestId])).digest('hex')}`;
    const createFingerprint = id === undefined ? null : createHash('sha256').update(canonicalFeedbackJSON(content)).digest('hex');
    function existingCreation(): ScheduleRecord | null {
      if (id === undefined) return null;
      const schedule = repository.getById(id, true);
      if (!schedule) return null;
      assertSchedule(schedule);
      if (schedule.action !== 'workflow_start' || schedule.createFingerprint !== createFingerprint) {
        throw new SchedulerError('VALIDATION_FAILED', '该创建标识已用于不同的计划内容，请使用原请求重试');
      }
      if (schedule.deletedAt != null) throw new SchedulerError('SCHEDULE_NOT_FOUND', '原计划已删除，不能通过创建重试恢复');
      return schedule;
    }
    const existing = db.transaction(existingCreation)();
    if (existing) return toScheduleResponse(existing);
    await checkTemplate(owner, parsed.data.workflow.templateId);
    assertOwner(owner);
    return db.transaction(() => {
      const existing = existingCreation();
      if (existing) return toScheduleResponse(existing);
      const schedule = repository.create({
        ...content, owner, createFingerprint,
        threadId: null, prompt: '', promptHash: '', promptPreviewRedacted: '',
        profile: '', cwd: '', canonicalCwd: '', sandbox: 'read-only',
        concurrencyPolicy: 'skip', misfirePolicy: 'skip',
        nextRunAt: parsed.data.enabled === false ? null : computeNextRunAt({ cron: parsed.data.cron, timezone, from: clock.now() })
      }, id);
      repository.insertOperation({ scheduleId: schedule.id, operation: 'create', status: 'succeeded' }, scheduleOperationActors.user);
      return toScheduleResponse(schedule);
    }).immediate();
  }

  async function update(id: string, input: UpdateWorkflowScheduleRequest) {
    const schedule = requireSchedule(id);
    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) throw new SchedulerError('VALIDATION_FAILED', '工作流计划内容无效，不能切换动作');
    validateTiming(parsed.data.cron ?? schedule.cron, parsed.data.timezone ?? schedule.timezone);
    const owner = schedule.owner!;
    await accessToken(owner);
    if (parsed.data.workflow) await checkTemplate(owner, parsed.data.workflow.templateId);
    assertOwner(owner);
    const current = requireSchedule(id);
    const cron = parsed.data.cron ?? current.cron;
    const timezone = parsed.data.timezone ?? current.timezone;
    return db.transaction(() => {
      const { action: _action, ...fields } = parsed.data;
      const timingChanged = fields.cron !== undefined || fields.timezone !== undefined || fields.enabled !== undefined;
      const updated = repository.update(id, {
        ...fields,
        ...(timingChanged ? { nextRunAt: (fields.enabled ?? current.enabled) ? computeNextRunAt({ cron, timezone, from: clock.now() }) : null } : {})
      });
      if (!updated) throw new SchedulerError('SCHEDULE_NOT_FOUND', '计划不存在');
      repository.insertOperation({ scheduleId: id, operation: 'update', status: 'succeeded' }, scheduleOperationActors.user);
      return toScheduleResponse(updated);
    })();
  }

  function remove(id: string): void {
    requireSchedule(id);
    db.transaction(() => {
      repository.update(id, { enabled: false, nextRunAt: null });
      repository.softDelete(id);
      repository.insertOperation({ scheduleId: id, operation: 'delete', status: 'succeeded' }, scheduleOperationActors.user);
    })();
  }

  function result(schedule: ScheduleRecord, trigger: WorkflowScheduleTrigger): RunScheduleNowResponse {
    return { run: null, schedule: toScheduleResponse(schedule), skipped: false, queued: false, triggerId: trigger.id,
      ...(trigger.workflowInstanceId ? { workflowInstanceId: trigger.workflowInstanceId } : {}) };
  }

  async function send(schedule: ScheduleRecord, trigger: WorkflowScheduleTrigger, actor: ScheduleOperationActor): Promise<RunScheduleNowResponse> {
    try {
      const token = await accessToken(trigger.owner);
      if (!http.workflowRequest) throw new Error('unavailable');
      const response = await http.workflowRequest(token, 'POST', `/api/v1/app/workflow-templates/${encodeURIComponent(trigger.workflow.templateId)}/instances`, {
        initial_input: trigger.workflow.initialInput, idempotency_key: `clawee:${schedule.id}:${trigger.id}`
      });
      const instanceId = (response.data as { instance_id?: unknown } | null)?.instance_id;
      if (typeof instanceId !== 'string' || !instanceId) throw new Error('invalid response');
      db.transaction(() => {
        repository.completeWorkflowTrigger(trigger.id, 'succeeded', instanceId);
        repository.update(schedule.id, { lastRunAt: clock.now().toISOString(), lastWorkflowInstanceId: instanceId, lastStatus: 'succeeded' });
        repository.insertOperation({ scheduleId: schedule.id, operation: actor.type === 'timer' ? 'timer_trigger' : 'run_now', status: 'succeeded', triggerId: trigger.id, workflowInstanceId: instanceId }, actor);
      })();
      assertOwner(trigger.owner);
      return result(repository.getById(schedule.id) ?? schedule, repository.getWorkflowTrigger(trigger.id)!);
    } catch (error) {
      const safe = safeError(error, trigger.id);
      if (repository.getWorkflowTrigger(trigger.id)?.status !== 'succeeded') {
        db.transaction(() => {
          repository.completeWorkflowTrigger(trigger.id, 'failed', null);
          repository.update(schedule.id, { lastRunAt: clock.now().toISOString(), lastStatus: 'failed' });
          repository.insertOperation({ scheduleId: schedule.id, operation: actor.type === 'timer' ? 'timer_trigger' : 'run_now', status: 'failed', triggerId: trigger.id, errorCode: safe.code, errorMessage: safe.message }, actor);
        })();
      }
      throw safe;
    }
  }

  function trigger(schedule: ScheduleRecord, actor: ScheduleOperationActor, scheduledAt: string | null = null, retryId?: string): Promise<RunScheduleNowResponse> {
    if (actor.type === 'agent') throw new SchedulerError('ENTERPRISE_FORBIDDEN', 'Agent 定时工具不能发起工作流');
    if (actor.type !== 'timer') assertSchedule(schedule);
    const record = retryId ? repository.getWorkflowTrigger(retryId) : db.transaction(() => repository.createWorkflowTrigger(schedule, scheduledAt, actor))();
    if (!record || record.scheduleId !== schedule.id) throw new SchedulerError('VALIDATION_FAILED', '触发记录不存在或不属于该计划');
    if (actor.type !== 'timer') assertOwner(record.owner);
    if (record.status === 'succeeded') return Promise.resolve(result(schedule, record));
    const existing = inFlight.get(record.id);
    if (existing) return existing;
    const request = send(schedule, record, actor).finally(() => inFlight.delete(record.id));
    inFlight.set(record.id, request);
    return request;
  }

  return { create, update, delete: remove, assertSchedule, canRead, trigger };
}
