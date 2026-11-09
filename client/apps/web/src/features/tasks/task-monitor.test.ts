import type { TaskItem } from '@clawee/protocol';
import { describe, expect, it } from 'vitest';
import {
  collectTaskTransitions,
  createTaskNotification,
  shouldAutoSubscribeTask,
  shouldSendSystemNotification
} from './task-monitor.js';

function createTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'run_1',
    runId: 'run_1',
    threadId: 'thread_1',
    title: '整理发布说明',
    status: 'running',
    runStatus: 'running',
    cwd: '/workspace',
    profile: 'default',
    createdBy: 'api',
    submissionMode: 'enqueue',
    createdAt: '2026-07-12T10:00:00.000Z',
    updatedAt: '2026-07-12T10:01:00.000Z',
    ...overrides
  };
}

describe('task monitor', () => {
  const observedSince = Date.parse('2026-07-12T10:00:00.000Z');

  it('uses the first snapshot as a silent baseline', () => {
    const result = collectTaskTransitions(new Map(), [
      createTask({ status: 'succeeded', runStatus: 'succeeded' })
    ], false, observedSince);

    expect(result.transitions).toEqual([]);
    expect(result.statuses.get('run_1')).toBe('succeeded');
  });

  it('reports only actionable or terminal status transitions after the baseline', () => {
    const previous = new Map<string, TaskItem['status']>([
      ['run_1', 'running'],
      ['run_2', 'queued']
    ]);
    const result = collectTaskTransitions(previous, [
      createTask({ status: 'succeeded', runStatus: 'succeeded' }),
      createTask({
        id: 'run_2',
        runId: 'run_2',
        status: 'running',
        runStatus: 'running'
      }),
      createTask({
        id: 'run_3',
        runId: 'run_3',
        status: 'waiting_approval',
        runStatus: 'running'
      })
    ], true, observedSince);

    expect(result.transitions.map(task => task.id)).toEqual(['run_1', 'run_3']);
  });

  it.each(['succeeded', 'failed', 'canceled'] as const)('does not treat a historical %s task loaded after an empty baseline as newly completed', status => {
    const baseline = collectTaskTransitions(new Map(), [], false, observedSince);
    const result = collectTaskTransitions(baseline.statuses, [createTask({
      status,
      runStatus: status,
      createdAt: '2026-07-10T10:00:00.000Z',
      endedAt: '2026-07-11T10:01:00.000Z',
      updatedAt: '2026-07-12T10:01:00.000Z'
    })], true, observedSince);

    expect(result.transitions).toEqual([]);
  });

  it('remembers completed tasks when they leave and re-enter the polled page', () => {
    const task = createTask({ status: 'succeeded', runStatus: 'succeeded' });
    const baseline = collectTaskTransitions(new Map(), [task], false, observedSince);
    const missing = collectTaskTransitions(baseline.statuses, [], true, observedSince);
    const returned = collectTaskTransitions(missing.statuses, [task], true, observedSince);

    expect(missing.statuses.get(task.id)).toBe('succeeded');
    expect(returned.transitions).toEqual([]);
  });

  it('detects a known running task completing after it leaves the polled page', () => {
    const task = createTask();
    const baseline = collectTaskTransitions(new Map(), [task], false, observedSince);
    const missing = collectTaskTransitions(baseline.statuses, [], true, observedSince);
    const result = collectTaskTransitions(missing.statuses, [createTask({
      status: 'succeeded', runStatus: 'succeeded'
    })], true, observedSince);

    expect(result.transitions.map(task => task.id)).toEqual(['run_1']);
  });

  it.each(['succeeded', 'failed'] as const)('detects an unseen task that reaches %s between polls', status => {
    const task = createTask({
      status, runStatus: status, createdAt: '2026-07-11T10:00:00.000Z',
      endedAt: '2026-07-12T10:00:01.000Z'
    });
    const baseline = collectTaskTransitions(new Map(), [], false, observedSince);
    const result = collectTaskTransitions(baseline.statuses, [task], true, observedSince);

    expect(result.transitions).toEqual([task]);
    expect(collectTaskTransitions(result.statuses, [task], true, observedSince).transitions).toEqual([]);
  });

  it('uses updatedAt for older task responses without an end time', () => {
    const historical = createTask({
      id: 'old_run', status: 'succeeded', runStatus: 'succeeded',
      updatedAt: '2026-07-11T10:01:00.000Z'
    });
    const recent = createTask({ status: 'succeeded', runStatus: 'succeeded' });

    expect(collectTaskTransitions(new Map(), [historical, recent], true, observedSince)
      .transitions).toEqual([recent]);
  });

  it('keeps newly discovered pending approvals actionable regardless of their age', () => {
    const task = createTask({
      status: 'waiting_approval', updatedAt: '2026-07-11T10:00:00.000Z'
    });

    expect(collectTaskTransitions(new Map(), [task], true, observedSince).transitions).toEqual([task]);
  });

  it('auto-subscribes live tasks and newly transitioned terminal tasks', () => {
    for (const status of ['queued', 'running', 'waiting_approval'] as const) {
      expect(shouldAutoSubscribeTask(createTask({
        status,
        runStatus: status === 'waiting_approval' ? 'running' : status
      }))).toBe(true);
    }

    for (const status of ['succeeded', 'failed', 'canceled'] as const) {
      expect(shouldAutoSubscribeTask(createTask({
        status,
        runStatus: status
      }))).toBe(false);
      expect(shouldAutoSubscribeTask(createTask({
        status,
        runStatus: status
      }), true)).toBe(true);
    }
  });

  it('creates concise Chinese notification copy for each transition', () => {
    expect(createTaskNotification(
      createTask({
        status: 'failed',
        runStatus: 'failed',
        errorMessage: 'spawn ENOENT /private/path',
        failureSummary: '项目目录不存在或无法访问，请编辑项目后重试。'
      })
    )).toEqual({
      title: '任务失败',
      body: '整理发布说明：项目目录不存在或无法访问，请编辑项目后重试。',
      threadId: 'thread_1',
      runId: 'run_1'
    });
  });

  it('uses the schedule name and persisted result summary for completed scheduled tasks', () => {
    expect(createTaskNotification(
      createTask({
        createdBy: 'schedule',
        status: 'succeeded',
        runStatus: 'succeeded',
        title: '喝水提醒',
        cwd: '/workspace',
        resultSummary: '该喝水了。'
      })
    )).toEqual({
      title: '喝水提醒',
      body: '该喝水了。',
      threadId: 'thread_1',
      runId: 'run_1'
    });
  });

  it('uses safe status summaries and stable routes for failed and approval notifications', () => {
    expect(createTaskNotification(
      createTask({
        createdBy: 'schedule',
        status: 'failed',
        runStatus: 'failed',
        title: '每日总结',
        errorMessage: 'Authorization: Bearer private-token'
      })
    )).toEqual({
      title: '每日总结失败',
      body: '任务未完成，请打开会话查看详情。',
      threadId: 'thread_1',
      runId: 'run_1'
    });

    expect(createTaskNotification(
      createTask({
        createdBy: 'schedule',
        status: 'waiting_approval',
        runStatus: 'running',
        title: '每日总结',
        pendingApproval: {
          id: 'approval_1',
          runId: 'run_1',
          threadId: 'thread_1',
          codexThreadId: null,
          turnId: 'turn_1',
          itemId: 'item_1',
          requestId: 'request_1',
          kind: 'file_change',
          status: 'pending',
          risk: 'medium',
          title: '允许修改文件',
          summary: '需要允许写入 docs/daily',
          details: {},
          requestedAt: '2026-07-14T10:00:00.000Z',
          expiresAt: '2026-07-14T10:10:00.000Z',
          resolvedAt: null,
          resolutionReason: null
        }
      })
    )).toEqual({
      title: '每日总结等待审批',
      body: '需要允许写入 docs/daily',
      threadId: 'thread_1',
      runId: 'run_1',
      approvalId: 'approval_1'
    });
  });

  it('suppresses system notifications only for the visible current conversation', () => {
    const task = createTask();

    expect(shouldSendSystemNotification(task, 'conversation', 'thread_1')).toBe(false);
    expect(shouldSendSystemNotification(task, 'tasks', 'thread_1')).toBe(true);
    expect(shouldSendSystemNotification(task, 'conversation', 'thread_2')).toBe(true);
  });
});
