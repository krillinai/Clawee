import { describe, expect, it, vi } from 'vitest';
import type { ScheduleResponse } from '@clawee/protocol';
import type { RuntimeClient } from '../runtime/client.js';
import { createScheduleService } from './schedule-service.js';

describe('ScheduleService', () => {
  it('R3 defaults to the legacy list and explicitly scopes workflow lists when requested', async () => {
    const get = vi.fn(async (_path: string) => ({ schedules: [] }));
    const service = createScheduleService(createClient({ get, post: vi.fn(), patch: vi.fn(), remove: vi.fn() }));
    await service.listSchedules();
    await service.listSchedules(false);
    await service.listSchedules(true);
    expect(get.mock.calls.map(call => call[0])).toEqual(['/schedules', '/schedules', '/schedules?action=workflow_start']);
  });
  it('creates and updates a workflow plan without fake Agent settings', async () => {
    const post = vi.fn(async (_path: string, _body?: unknown) => createScheduleResponse());
    const patch = vi.fn(async () => createScheduleResponse());
    const service = createScheduleService(createClient({ get: vi.fn(), post, patch, remove: vi.fn() }));
    const input = { action: 'workflow_start' as const, requestId: '11111111-1111-4111-8111-111111111111', name: '每日审批', cron: '0 9 * * *', timezone: 'Asia/Shanghai', enabled: true,
      workflow: { templateId: 'template-a', initialInput: { text: '审核' } } };
    await service.createWorkflowSchedule(input);
    await service.updateSchedule('workflow/中文', { workflow: input.workflow, enabled: false });
    expect(post).toHaveBeenCalledWith('/schedules', input);
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('prompt');
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('model');
    expect(patch).toHaveBeenCalledWith('/schedules/workflow%2F%E4%B8%AD%E6%96%87', { workflow: input.workflow, enabled: false });
  });

  it('preserves workflow trigger metadata and retries the original trigger', async () => {
    const response = { run: null, schedule: createScheduleResponse(), skipped: false, queued: false, triggerId: 'trigger/中文', workflowInstanceId: 'instance-a' };
    const post = vi.fn(async () => response);
    const service = createScheduleService(createClient({ get: vi.fn(), post, patch: vi.fn(), remove: vi.fn() }));
    expect(await service.runNow('workflow/中文')).toEqual(response);
    expect(await service.runNow('workflow/中文', { triggerId: 'trigger/中文' })).toEqual(response);
    expect(post).toHaveBeenLastCalledWith('/schedules/workflow%2F%E4%B8%AD%E6%96%87/run-now', { triggerId: 'trigger/中文' });
  });

  it('keeps daemon validation errors intact without retrying or creating another trigger', async () => {
    const error = new Error('Cron 表达式无效');
    const post = vi.fn(async () => { throw error; });
    const service = createScheduleService(createClient({ get: vi.fn(), post, patch: vi.fn(), remove: vi.fn() }));
    await expect(service.createWorkflowSchedule({ action: 'workflow_start', name: '审核', cron: 'invalid', workflow: { templateId: '', initialInput: {} } })).rejects.toBe(error);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('maps schedule CRUD and detail requests to runtime endpoints', async () => {
    const schedule = createScheduleResponse();
    const get = vi.fn(async (_path: string) => ({ schedules: [] }));
    const post = vi.fn(async (_path: string, _body?: unknown) => schedule);
    const patch = vi.fn(async (_path: string, _body: unknown) => schedule);
    const remove = vi.fn(async (_path: string) => ({ deleted: true }));
    const service = createScheduleService(createClient({ get, post, patch, remove }));

    await service.listSchedules();
    await service.getSchedule('schedule/中文');
    const created = await service.createSchedule({
      name: '每日总结',
      cron: '0 18 * * *',
      prompt: '总结今天的工作'
    });
    await service.updateSchedule('schedule/中文', { enabled: false });
    await service.deleteSchedule('schedule/中文');

    expect(get).toHaveBeenNthCalledWith(1, '/schedules');
    expect(get).toHaveBeenNthCalledWith(
      2,
      '/schedules/schedule%2F%E4%B8%AD%E6%96%87'
    );
    expect(post).toHaveBeenCalledWith('/schedules', {
      name: '每日总结',
      cron: '0 18 * * *',
      prompt: '总结今天的工作'
    });
    expect(created.threadId).toBe('thread-schedule-1');
    expect(patch).toHaveBeenCalledWith(
      '/schedules/schedule%2F%E4%B8%AD%E6%96%87',
      { enabled: false }
    );
    expect(remove).toHaveBeenCalledWith(
      '/schedules/schedule%2F%E4%B8%AD%E6%96%87'
    );
  });

  it('runs a schedule and loads bounded operation history', async () => {
    const get = vi.fn(async (_path: string) => ({ operations: [] }));
    const post = vi.fn(async (_path: string) => ({
      run: null,
      schedule: { id: 'schedule-1' },
      skipped: true,
      queued: false
    }));
    const service = createScheduleService(createClient({
      get,
      post,
      patch: vi.fn(),
      remove: vi.fn()
    }));

    await service.runNow('schedule/中文');
    await service.listOperations('schedule/中文', 25);

    expect(post).toHaveBeenCalledWith(
      '/schedules/schedule%2F%E4%B8%AD%E6%96%87/run-now'
    );
    expect(get).toHaveBeenCalledWith(
      '/schedules/schedule%2F%E4%B8%AD%E6%96%87/operations?limit=25'
    );
  });
});

function createScheduleResponse(): ScheduleResponse {
  return {
    id: 'schedule-1',
    threadId: 'thread-schedule-1',
    name: '每日总结',
    cron: '0 18 * * *',
    timezone: 'Asia/Shanghai',
    enabled: true,
    promptPreviewRedacted: '总结今天的工作',
    profile: 'default',
    cwd: '/workspace/project',
    canonicalCwd: '/workspace/project',
    model: null,
    reasoning: null,
    sandbox: 'workspace-write',
    timeoutMs: null,
    concurrencyPolicy: 'queue',
    misfirePolicy: 'skip',
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    lastStatus: null,
    pendingTrigger: false,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z'
  };
}

function createClient(input: {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body?: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  remove: (path: string) => Promise<unknown>;
}): RuntimeClient {
  return {
    get<T>(path: string): Promise<T> {
      return input.get(path) as Promise<T>;
    },
    post<T>(path: string, body?: unknown): Promise<T> {
      return (
        body === undefined
          ? input.post(path)
          : input.post(path, body)
      ) as Promise<T>;
    },
    patch<T>(path: string, body: unknown): Promise<T> {
      return input.patch(path, body) as Promise<T>;
    },
    delete<T>(path: string): Promise<T> {
      return input.remove(path) as Promise<T>;
    }
  } as RuntimeClient;
}
