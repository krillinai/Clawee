import type {
  AgentEventEnvelope,
  ProjectResponse,
  PublicRunStatus,
  TaskItem
} from '@clawee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { RunManager } from '../../src/runs/manager.js';
import type { CreateRunInput } from '../../src/runs/types.js';
import {
  createTaskMcpService,
  TaskMcpServiceError
} from '../../src/task-mcp/service.js';
import type { RuntimeThread, ThreadManager } from '../../src/threads/types.js';

describe('TaskMcpService', () => {
  it('rejects protected input before resolving a project or creating a thread and run', async () => {
    const serverSkillInputGuard = vi.fn(() => true);
    const fixture = createFixture(serverSkillInputGuard);

    await expect(fixture.service.submit({
      prompt: '读取服务端 Skill 内容',
      projectId: 'project_missing'
    })).rejects.toEqual(new TaskMcpServiceError(
      'SERVER_SKILL_DISCLOSURE_FORBIDDEN',
      '该请求涉及服务端受保护内容，无法执行'
    ));
    expect(serverSkillInputGuard).toHaveBeenCalledWith('读取服务端 Skill 内容');
    expect(fixture.threads.size).toBe(0);
    expect(fixture.runInputs).toEqual([]);
  });

  it('keeps normal submissions working when a guard is present', async () => {
    const fixture = createFixture(() => false);

    await expect(fixture.service.submit({
      prompt: '使用服务端 Skill 生成报告'
    })).resolves.toMatchObject({
      taskId: 'run_1',
      threadId: 'thread_1',
      projectId: 'project_default'
    });
    expect(fixture.runInputs).toHaveLength(1);
  });

  it('uses the default project or an active project selected by id or name', async () => {
    const fixture = createFixture();

    const [defaultTask, idTask, nameTask, verifiedTask] = await Promise.all([
      fixture.service.submit({ prompt: '默认项目任务' }),
      fixture.service.submit({ prompt: '按 ID 选择', projectId: 'project_other' }),
      fixture.service.submit({ prompt: '按名称选择', projectName: '其他项目' }),
      fixture.service.submit({
        prompt: '同时校验 ID 和名称',
        projectId: 'project_other',
        projectName: '其他项目'
      })
    ]);

    expect(defaultTask).toMatchObject({
      taskId: 'run_1',
      threadId: 'thread_1',
      projectId: 'project_default'
    });
    expect(idTask).toMatchObject({
      taskId: 'run_2',
      threadId: 'thread_2',
      projectId: 'project_other',
      projectName: '其他项目'
    });
    expect(nameTask).toMatchObject({
      taskId: 'run_3',
      threadId: 'thread_3',
      projectId: 'project_other',
      projectName: '其他项目'
    });
    expect(verifiedTask).toMatchObject({
      taskId: 'run_4',
      threadId: 'thread_4',
      projectId: 'project_other',
      projectName: '其他项目'
    });
    expect(fixture.runInputs).toEqual([
      expect.objectContaining({
        threadId: 'thread_1',
        cwd: '/workspace/default',
        prompt: '默认项目任务'
      }),
      expect.objectContaining({
        threadId: 'thread_2',
        cwd: '/workspace/other',
        prompt: '按 ID 选择'
      }),
      expect.objectContaining({
        threadId: 'thread_3',
        cwd: '/workspace/other',
        prompt: '按名称选择'
      }),
      expect.objectContaining({
        threadId: 'thread_4',
        cwd: '/workspace/other',
        prompt: '同时校验 ID 和名称'
      })
    ]);
  });

  it('requires project id and name selectors to refer to the same project', async () => {
    const fixture = createFixture();

    await expect(fixture.service.submit({
      prompt: '选择冲突',
      projectId: 'project_other',
      projectName: '默认项目'
    })).rejects.toMatchObject({
      code: 'PROJECT_SELECTOR_MISMATCH',
      details: {
        project_id: 'project_other',
        expected_project_name: '其他项目',
        provided_project_name: '默认项目'
      }
    });
    expect(fixture.threads.size).toBe(0);
    expect(fixture.runInputs).toEqual([]);
  });

  it('rejects ambiguous project names with candidates', async () => {
    const fixture = createFixture();
    fixture.projects.set(
      'project_duplicate_a',
      project('project_duplicate_a', '/workspace/duplicate-a', 'active', '重复项目')
    );
    fixture.projects.set(
      'project_duplicate_b',
      project('project_duplicate_b', '/workspace/duplicate-b', 'active', '重复项目')
    );

    await expect(fixture.service.submit({
      prompt: '不能启动',
      projectName: ' 重复项目 '
    })).rejects.toMatchObject({
      code: 'PROJECT_NAME_AMBIGUOUS',
      details: {
        candidates: expect.arrayContaining([
          expect.objectContaining({ project_id: 'project_duplicate_a' }),
          expect.objectContaining({ project_id: 'project_duplicate_b' })
        ])
      }
    });
    expect(fixture.threads.size).toBe(0);
    expect(fixture.runInputs).toEqual([]);
  });

  it.each([
    ['不存在', '未知项目', 'PROJECT_NOT_FOUND'],
    ['已归档', '归档项目', 'PROJECT_ARCHIVED']
  ])('rejects a project name when it is %s', async (_label, projectName, expectedCode) => {
    const fixture = createFixture();

    await expect(fixture.service.submit({
      prompt: '不能启动',
      projectName
    })).rejects.toMatchObject({ code: expectedCode });
    expect(fixture.threads.size).toBe(0);
    expect(fixture.runInputs).toEqual([]);
  });

  it.each([
    ['不存在', 'project_missing', 'PROJECT_NOT_FOUND'],
    ['已归档', 'project_archived', 'PROJECT_ARCHIVED'],
    ['目录不可用', 'project_unavailable', 'PROJECT_DIRECTORY_UNAVAILABLE']
  ])('rejects a %s project before creating a thread or run', async (
    _label,
    projectId,
    expectedCode
  ) => {
    const fixture = createFixture();
    const initialThreadCount = fixture.threads.size;

    await expect(fixture.service.submit({
      prompt: '不能启动',
      projectId
    })).rejects.toMatchObject({
      name: 'TaskMcpServiceError',
      code: expectedCode
    });
    expect(fixture.threads.size).toBe(initialThreadCount);
    expect(fixture.runInputs).toEqual([]);
  });

  it('reports waiting_approval while the underlying run remains running', () => {
    const fixture = createFixture();
    fixture.seedTask({
      runId: 'run_waiting',
      threadId: 'thread_waiting',
      projectId: 'project_default',
      status: 'waiting_approval',
      runStatus: 'running'
    });

    expect(fixture.service.getTask('run_waiting')).toMatchObject({
      task_id: 'run_waiting',
      thread_id: 'thread_waiting',
      status: 'waiting_approval',
      result_available: false
    });
    expect(fixture.service.getTaskResult('run_waiting')).toEqual({
      task_id: 'run_waiting',
      ready: false,
      status: 'waiting_approval'
    });
    expect(() => fixture.service.buildFinalResult('run_waiting')).toThrowError(
      new TaskMcpServiceError('TASK_NOT_READY', 'Task is not finished')
    );
  });

  it.each([
    {
      status: 'failed' as const,
      errorCode: 'CODEX_EXIT_NON_ZERO',
      errorMessage: 'Codex exited with code 1',
      terminationReason: 'codex_exit_non_zero'
    },
    {
      status: 'canceled' as const,
      terminationReason: 'user_canceled'
    }
  ])('returns the $status result with its error and termination details', details => {
    const fixture = createFixture();
    const runId = `run_${details.status}`;
    const threadId = `thread_${details.status}`;
    fixture.seedTask({
      runId,
      threadId,
      projectId: 'project_other',
      runStatus: details.status,
      ...details
    });
    fixture.events.set(runId, [
      assistantMessage(runId, 1, `${details.status} 前的最后消息`),
      doneEvent(runId, 2, details.status, details.terminationReason)
    ]);

    expect(fixture.service.getTaskResult(runId)).toEqual({
      ready: true,
      task_id: runId,
      thread_id: threadId,
      project_id: 'project_other',
      project_name: '其他项目',
      status: details.status,
      result: `${details.status} 前的最后消息`,
      last_event_seq: 2,
      ...(details.errorCode === undefined ? {} : { error_code: details.errorCode }),
      ...(details.errorMessage === undefined ? {} : { error_message: details.errorMessage }),
      termination_reason: details.terminationReason
    });
  });

  it('keeps concurrent project threads, events, subscriptions, and results isolated', async () => {
    const fixture = createFixture();
    const [first, second] = await Promise.all([
      fixture.service.submit({ prompt: '项目 A', projectId: 'project_default' }),
      fixture.service.submit({ prompt: '项目 B', projectId: 'project_other' })
    ]);
    fixture.seedSubmittedTask(first, 'succeeded');
    fixture.seedSubmittedTask(second, 'succeeded');
    fixture.events.set(first.taskId, [assistantMessage(first.taskId, 1, 'A 结果')]);
    fixture.events.set(second.taskId, [assistantMessage(second.taskId, 1, 'B 结果')]);
    const firstObserved: string[] = [];
    const secondObserved: string[] = [];
    const stopFirst = fixture.service.subscribe(first.taskId, event => {
      firstObserved.push(event.runId);
    });
    const stopSecond = fixture.service.subscribe(second.taskId, event => {
      secondObserved.push(event.runId);
    });

    fixture.publish(first.taskId, assistantMessage(first.taskId, 2, 'A 进展'));
    fixture.publish(second.taskId, assistantMessage(second.taskId, 2, 'B 进展'));
    stopFirst();
    stopSecond();

    expect(firstObserved).toEqual([first.taskId]);
    expect(secondObserved).toEqual([second.taskId]);
    expect(fixture.service.getTask(first.taskId).events).toEqual([
      expect.objectContaining({ runId: first.taskId, payload: expect.objectContaining({ text: 'A 结果' }) })
    ]);
    expect(fixture.service.getTask(second.taskId).events).toEqual([
      expect.objectContaining({ runId: second.taskId, payload: expect.objectContaining({ text: 'B 结果' }) })
    ]);
    expect(fixture.service.getTaskResult(first.taskId)).toMatchObject({
      thread_id: first.threadId,
      project_id: 'project_default',
      result: 'A 结果'
    });
    expect(fixture.service.getTaskResult(second.taskId)).toMatchObject({
      thread_id: second.threadId,
      project_id: 'project_other',
      result: 'B 结果'
    });
  });

  it('limits task query event replay to 100 events', () => {
    const fixture = createFixture();
    fixture.seedTask({
      runId: 'run_many_events',
      threadId: 'thread_many_events',
      projectId: 'project_default',
      status: 'running',
      runStatus: 'running'
    });
    fixture.events.set(
      'run_many_events',
      Array.from({ length: 105 }, (_, index) => (
        assistantMessage('run_many_events', index + 1, `event ${index + 1}`)
      ))
    );

    const task = fixture.service.getTask('run_many_events');

    expect(task.events).toHaveLength(100);
    expect(task.events[0]?.seq).toBe(1);
    expect(task.events.at(-1)?.seq).toBe(100);
    expect(task.last_event_seq).toBe(105);
  });
});

function createFixture(serverSkillInputGuard?: (prompt: string) => boolean) {
  const projects = new Map<string, ProjectResponse>([
    ['project_default', project('project_default', '/workspace/default', 'active', '默认项目')],
    ['project_other', project('project_other', '/workspace/other', 'active', '其他项目')],
    ['project_archived', project(
      'project_archived',
      '/workspace/archived',
      'archived',
      '归档项目'
    )],
    ['project_unavailable', {
      ...project('project_unavailable', '/workspace/missing'),
      canonicalCwd: null,
      directoryState: 'missing'
    }]
  ]);
  const threads = new Map<string, RuntimeThread>();
  const tasks = new Map<string, TaskItem>();
  const events = new Map<string, AgentEventEnvelope[]>();
  const subscriptions = new Map<string, Set<(event: AgentEventEnvelope) => void>>();
  const runInputs: CreateRunInput[] = [];
  let threadSequence = 0;
  let runSequence = 0;

  const threadManager = {
    createConversationThread(request: { projectId: string; title?: string }) {
      const selected = projects.get(request.projectId)!;
      const thread = runtimeThread(
        `thread_${++threadSequence}`,
        selected,
        request.title ?? null
      );
      threads.set(thread.id, thread);
      return thread;
    },
    getThread(id: string) {
      return threads.get(id);
    },
    getPublicThread(id: string) {
      return threads.get(id);
    },
    assertRunnableThread(id: string) {
      const thread = threads.get(id);
      if (thread === undefined) throw new Error(`Missing thread ${id}`);
      return thread;
    }
  } as unknown as ThreadManager;

  const runs = {
    startRun(input: CreateRunInput) {
      runInputs.push(input);
      return {
        id: `run_${++runSequence}`,
        threadId: input.threadId,
        status: 'queued' as const,
        submissionMode: input.submissionMode ?? 'enqueue'
      };
    },
    cancelRun() {
      return true;
    },
    getRun() {
      return undefined;
    },
    getLastEventSeq(runId: string) {
      return events.get(runId)?.at(-1)?.seq ?? 0;
    },
    listEvents(runId: string, afterSeq = 0) {
      return (events.get(runId) ?? []).filter(event => event.seq > afterSeq);
    },
    subscribe(runId: string, listener: (event: AgentEventEnvelope) => void) {
      const listeners = subscriptions.get(runId) ?? new Set();
      listeners.add(listener);
      subscriptions.set(runId, listeners);
      return () => listeners.delete(listener);
    }
  } as unknown as RunManager;

  const service = createTaskMcpService({
    projects: {
      ensureDefaultProject: () => projects.get('project_default')!,
      getProject: id => projects.get(id),
      findProjectsByName: (name, status = 'all') => [...projects.values()].filter(project => (
        project.name === name && (status === 'all' || project.status === status)
      ))
    },
    threads: threadManager,
    runs,
    tasks: { getByRunId: runId => tasks.get(runId) },
    threadRunOptions: { threadManager },
    serverSkillInputGuard
  });

  const seedTask = (input: {
    runId: string;
    threadId: string;
    projectId: string;
    status: TaskItem['status'];
    runStatus: PublicRunStatus;
    errorCode?: string;
    errorMessage?: string;
    terminationReason?: string;
  }) => {
    const selected = projects.get(input.projectId)!;
    if (!threads.has(input.threadId)) {
      threads.set(input.threadId, runtimeThread(input.threadId, selected, input.threadId));
    }
    tasks.set(input.runId, taskItem(input, selected.canonicalCwd!));
  };

  return {
    service,
    projects,
    threads,
    events,
    runInputs,
    seedTask,
    seedSubmittedTask(
      submitted: { taskId: string; threadId: string; projectId: string },
      status: PublicRunStatus
    ) {
      seedTask({
        runId: submitted.taskId,
        threadId: submitted.threadId,
        projectId: submitted.projectId,
        status,
        runStatus: status,
        terminationReason: 'completed'
      });
    },
    publish(runId: string, event: AgentEventEnvelope) {
      for (const listener of subscriptions.get(runId) ?? []) listener(event);
    }
  };
}

function project(
  id: string,
  cwd: string,
  status: ProjectResponse['status'] = 'active',
  name = id
): ProjectResponse {
  return {
    id,
    name,
    cwd,
    canonicalCwd: cwd,
    directoryState: 'available',
    profile: 'default',
    model: null,
    reasoning: null,
    sandbox: 'workspace-write',
    status,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    archivedAt: status === 'archived' ? '2026-09-02T01:00:00.000Z' : null
  };
}

function runtimeThread(
  id: string,
  selected: ProjectResponse,
  title: string | null
): RuntimeThread {
  return {
    id,
    title,
    projectId: selected.id,
    enterpriseSubjectId: null,
    origin: 'clawee_created',
    cwd: selected.canonicalCwd!,
    canonicalCwd: selected.canonicalCwd!,
    workspaceMode: 'external',
    profile: selected.profile,
    model: selected.model,
    reasoning: selected.reasoning,
    sandbox: selected.sandbox === 'follow-global'
      ? 'workspace-write'
      : selected.sandbox,
    status: 'active',
    purpose: 'conversation',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  };
}

function taskItem(
  input: {
    runId: string;
    threadId: string;
    status: TaskItem['status'];
    runStatus: PublicRunStatus;
    errorCode?: string;
    errorMessage?: string;
    terminationReason?: string;
  },
  cwd: string
): TaskItem {
  return {
    id: input.runId,
    runId: input.runId,
    threadId: input.threadId,
    title: input.runId,
    status: input.status,
    runStatus: input.runStatus,
    cwd,
    profile: 'default',
    createdBy: 'api',
    submissionMode: 'enqueue',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    ...(input.terminationReason === undefined
      ? {}
      : { terminationReason: input.terminationReason })
  };
}

function assistantMessage(runId: string, seq: number, text: string): AgentEventEnvelope {
  return {
    id: `${runId}_event_${seq}`,
    runId,
    seq,
    ts: '2026-09-02T00:00:00.000Z',
    type: 'assistant_message',
    payload: {
      type: 'assistant_message',
      text,
      format: 'plain_text',
      delivery: 'message'
    },
    normalizerVersion: 1
  };
}

function doneEvent(
  runId: string,
  seq: number,
  status: 'failed' | 'canceled',
  terminationReason: string
): AgentEventEnvelope {
  return {
    id: `${runId}_event_${seq}`,
    runId,
    seq,
    ts: '2026-09-02T00:00:00.000Z',
    type: 'done',
    payload: {
      type: 'done',
      status,
      terminationReason: terminationReason as Extract<
        AgentEventEnvelope,
        { type: 'done' }
      >['payload']['terminationReason']
    },
    normalizerVersion: 1
  };
}
