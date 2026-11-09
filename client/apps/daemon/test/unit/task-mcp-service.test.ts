import type {
  AgentEventEnvelope,
  ProjectResponse,
  PublicRunStatus,
  SharedDriveState,
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
  it('健康检查只读取执行条件，模型配置恢复后立即反映，不创建任务', () => {
    let ready = false;
    const fixture = createFixture(undefined, () => ready);
    expect(fixture.service.getHealth()).toEqual({
      runtime: 'unknown', model: 'configuration_required'
    });
    ready = true;
    expect(fixture.service.getHealth()).toEqual({
      runtime: 'unknown', model: 'configured'
    });
    expect(fixture.threads.size).toBe(0);
    expect(fixture.runInputs).toEqual([]);
  });

  it('模型未就绪时拒绝提交且不创建对话，恢复后可以执行', async () => {
    let ready = false;
    const fixture = createFixture(undefined, () => ready);

    await expect(fixture.service.submit({ prompt: '执行任务' })).rejects.toMatchObject({
      code: 'MODEL_SERVICE_CONFIGURATION_REQUIRED'
    });
    expect(fixture.threads.size).toBe(0);
    expect(fixture.runInputs).toEqual([]);

    ready = true;
    await expect(fixture.service.submit({ prompt: '执行任务' })).resolves.toMatchObject({
      taskId: 'run_1', threadId: 'thread_1'
    });
    expect(fixture.runInputs).toHaveLength(1);
  });

  it('将可选发起身份传入任务创建，不修改模型提示词', async () => {
    const fixture = createFixture();
    await fixture.service.submit({
      prompt: '执行任务', initiatorUserId: 'user_1', initiatorAgentId: 'agent_1'
    });
    expect(fixture.runInputs[0]).toMatchObject({
      prompt: '执行任务', executionPrompt: '执行任务',
      initiatorUserId: 'user_1', initiatorAgentId: 'agent_1'
    });
    await fixture.service.submit({ prompt: '直连任务' });
    expect(fixture.runInputs[1]?.initiatorUserId).toBeUndefined();
    expect(fixture.runInputs[1]?.initiatorAgentId).toBeUndefined();
  });

  it('继续原任务时保留会话与项目，每轮创建独立任务并明确恢复 Runtime 会话', async () => {
    const fixture = createFixture();
    const caller = { initiatorUserId: 'user_1', initiatorAgentId: 'agent_1' };
    const first = await fixture.service.submit({
      prompt: '生成商品海报', projectId: 'project_other', ...caller
    });
    fixture.seedSubmittedTask(first, 'succeeded');
    fixture.threads.get(first.threadId)!.codexThreadId = 'codex_original';
    fixture.events.set(first.taskId, [assistantMessage(first.taskId, 1, '海报第一版')]);

    const second = await fixture.service.submit({
      prompt: '编辑上一版海报，把背景改成蓝色', threadId: first.threadId, ...caller
    });

    expect(second).toMatchObject({
      threadId: first.threadId, projectId: first.projectId, projectName: first.projectName
    });
    expect(second.taskId).not.toBe(first.taskId);
    expect(fixture.threads.size).toBe(1);
    expect(fixture.runInputs[1]).toMatchObject({
      prompt: '编辑上一版海报，把背景改成蓝色',
      threadId: first.threadId,
      cwd: '/workspace/other',
      resumeMode: 'resume_thread',
      ...caller
    });
    expect(await fixture.service.getTaskResult(first.taskId)).toMatchObject({
      task_id: first.taskId, thread_id: first.threadId, result: '海报第一版'
    });
  });

  it.each([
    { initiatorUserId: 'other_user', initiatorAgentId: 'agent_1' },
    { initiatorUserId: 'user_1', initiatorAgentId: 'other_agent' },
    { initiatorUserId: 'user_1' },
    { initiatorAgentId: 'agent_1' },
    {}
  ])('拒绝来源不符或不完整的续聊调用 %j', async caller => {
    const fixture = createContinuationFixture();
    await expect(fixture.service.submit({
      prompt: '修改海报', threadId: 'thread_previous', ...caller
    })).rejects.toMatchObject({ code: 'THREAD_ACCESS_DENIED' });
    expect(fixture.threads.size).toBe(1);
    expect(fixture.runInputs).toEqual([]);
  });

  it.each([
    { initiatorUserId: undefined },
    { initiatorAgentId: undefined }
  ])('不开放来源记录不完整的历史会话 %j', async missing => {
    const fixture = createContinuationFixture();
    Object.assign(fixture.tasks.get('run_previous')!, missing);
    await expect(fixture.service.submit({
      prompt: '修改海报', threadId: 'thread_previous',
      initiatorUserId: 'user_1', initiatorAgentId: 'agent_1'
    })).rejects.toMatchObject({ code: 'THREAD_ACCESS_DENIED' });
    expect(fixture.runInputs).toEqual([]);
  });

  it.each([
    { projectId: 'project_default' },
    { projectName: '默认项目' }
  ])('续聊项目参数必须与原会话一致 %j', async selector => {
    const fixture = createContinuationFixture();
    await expect(fixture.service.submit({
      prompt: '修改海报', threadId: 'thread_previous',
      initiatorUserId: 'user_1', initiatorAgentId: 'agent_1', ...selector
    })).rejects.toMatchObject({ code: 'PROJECT_SELECTOR_MISMATCH' });
    expect(fixture.runInputs).toEqual([]);
  });

  it('续聊允许传入与原项目一致的名称和 ID', async () => {
    const fixture = createContinuationFixture();
    await expect(fixture.service.submit({
      prompt: '修改海报', threadId: 'thread_previous',
      projectId: 'project_other', projectName: '其他项目',
      initiatorUserId: 'user_1', initiatorAgentId: 'agent_1'
    })).resolves.toMatchObject({ threadId: 'thread_previous', projectId: 'project_other' });
  });

  it.each([
    { state: '项目已删除', code: 'PROJECT_NOT_FOUND' },
    { state: '项目已归档', code: 'PROJECT_ARCHIVED' },
    { state: '目录不可用', code: 'PROJECT_DIRECTORY_UNAVAILABLE' }
  ])('续聊时$state则拒绝执行', async ({ state, code }) => {
    const fixture = createContinuationFixture();
    const project = fixture.projects.get('project_other')!;
    if (state === '项目已删除') fixture.projects.delete(project.id);
    if (state === '项目已归档') project.status = 'archived';
    if (state === '目录不可用') project.directoryState = 'missing';
    await expect(fixture.service.submit({
      prompt: '修改海报', threadId: 'thread_previous',
      initiatorUserId: 'user_1', initiatorAgentId: 'agent_1'
    })).rejects.toMatchObject({ code });
    expect(fixture.runInputs).toEqual([]);
  });

  it.each([
    { state: '不存在', code: 'THREAD_NOT_FOUND' },
    { state: '已归档', code: 'THREAD_ARCHIVED' },
    { state: '未建立 Runtime 会话', code: 'CODEX_THREAD_ID_MISSING' },
    { state: '企业专用会话', code: 'THREAD_NOT_FOUND' }
  ])('原会话$state时不回退新建会话', async ({ state, code }) => {
    const fixture = createContinuationFixture();
    const thread = fixture.threads.get('thread_previous')!;
    if (state === '不存在') fixture.threads.delete(thread.id);
    if (state === '已归档') thread.status = 'archived';
    if (state === '未建立 Runtime 会话') thread.codexThreadId = null;
    if (state === '企业专用会话') thread.enterpriseSubjectId = 'enterprise_subject';
    const threadCount = fixture.threads.size;

    await expect(fixture.service.submit({
      prompt: '修改海报', threadId: 'thread_previous',
      initiatorUserId: 'user_1', initiatorAgentId: 'agent_1'
    })).rejects.toMatchObject({ code });
    expect(fixture.threads.size).toBe(threadCount);
    expect(fixture.runInputs).toEqual([]);
  });

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

  it.each(['DefaultProject', 'Default Project', '/workspace/DefaultProject'])(
    'treats the default project directory alias %s as the default project',
    async projectName => {
      const fixture = createFixture();

      await expect(fixture.service.submit({
        prompt: '默认目录别名任务',
        projectName
      })).resolves.toMatchObject({
        projectId: 'project_default',
        projectName: '默认项目'
      });
      expect(fixture.runInputs).toHaveLength(1);
    }
  );

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

  it('reports waiting_approval while the underlying run remains running', async () => {
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
    await expect(fixture.service.getTaskResult('run_waiting')).resolves.toEqual({
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
  ])('returns the $status result with its error and termination details', async details => {
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

    await expect(fixture.service.getTaskResult(runId)).resolves.toEqual({
      ready: true,
      task_id: runId,
      thread_id: threadId,
      project_id: 'project_other',
      project_name: '其他项目',
      status: details.status,
      result: `${details.status} 前的最后消息`,
      last_event_seq: 2,
      delivery_status: 'none',
      files: [],
      delivery_errors: [],
      ...(details.errorCode === undefined ? {} : { error_code: details.errorCode }),
      ...(details.errorMessage === undefined ? {} : { error_message: details.errorMessage }),
      termination_reason: details.terminationReason
    });
  });

  it('在终态查询时自动上传 outputs 文件并返回文件回执', async () => {
    const runStates = new Map<string, SharedDriveState>();
    const deliverOutputFiles = vi.fn(async (taskId: string, paths: string[]) => {
      runStates.set(taskId, {
        uploads: paths.map(path => ({
          path,
          logicalPath: `tasks/${taskId}/${path}`,
          status: 'uploaded' as const,
          artifact: {
            space_id: 'space_1',
            file_id: `file_${path.replaceAll('/', '_')}`,
            logical_path: `tasks/${taskId}/${path}`,
            file_name: path.split('/').at(-1)!,
            content_type: 'text/plain',
            size_bytes: 3,
            revision: 1,
            sha256: 'a'.repeat(64)
          }
        })),
        downloads: []
      });
    });
    const fixture = createFixture(undefined, undefined, deliverOutputFiles, runStates);
    fixture.seedTask({
      runId: 'run_output',
      threadId: 'thread_output',
      projectId: 'project_default',
      status: 'succeeded',
      runStatus: 'succeeded'
    });
    fixture.events.set('run_output', [
      fileChangeEvent('run_output', 1, ['/workspace/default/outputs/report.txt'])
    ]);

    await expect(fixture.service.getTaskResult('run_output')).resolves.toMatchObject({
      delivery_status: 'complete',
      files: [expect.objectContaining({ file_id: 'file_outputs_report.txt' })]
    });
    expect(deliverOutputFiles).toHaveBeenCalledWith('run_output', ['outputs/report.txt']);
  });

  it('网盘上传未完成时返回交付错误，不返回成功结果', async () => {
    const deliverOutputFiles = vi.fn(async () => undefined);
    const fixture = createFixture(undefined, undefined, deliverOutputFiles);
    fixture.seedTask({
      runId: 'run_delivery_failed',
      threadId: 'thread_delivery_failed',
      projectId: 'project_default',
      status: 'succeeded',
      runStatus: 'succeeded'
    });
    fixture.events.set('run_delivery_failed', [
      fileChangeEvent('run_delivery_failed', 1, ['/workspace/default/outputs/report.txt'])
    ]);

    await expect(fixture.service.getTaskResult('run_delivery_failed')).rejects.toMatchObject({
      code: 'TASK_DELIVERY_INCOMPLETE'
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
    await expect(fixture.service.getTaskResult(first.taskId)).resolves.toMatchObject({
      thread_id: first.threadId,
      project_id: 'project_default',
      result: 'A 结果'
    });
    await expect(fixture.service.getTaskResult(second.taskId)).resolves.toMatchObject({
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

function createFixture(
  serverSkillInputGuard?: (prompt: string) => boolean,
  canRunAgent?: () => boolean,
  deliverOutputFiles?: (taskId: string, paths: string[]) => Promise<void>,
  runStates = new Map<string, SharedDriveState>()
) {
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
      const runId = `run_${++runSequence}`;
      tasks.set(runId, taskItem({
        runId, threadId: input.threadId!, status: 'queued', runStatus: 'queued',
        initiatorUserId: input.initiatorUserId, initiatorAgentId: input.initiatorAgentId
      }, input.cwd!));
      return {
        id: runId,
        threadId: input.threadId,
        status: 'queued' as const,
        submissionMode: input.submissionMode ?? 'enqueue'
      };
    },
    cancelRun() {
      return true;
    },
    getRun(runId: string) {
      return { sharedDriveState: runStates.get(runId) ?? { uploads: [], downloads: [] } };
    },
    listRunsByThread(threadId: string, limit = 50) {
      return [...tasks.values()].filter(task => task.threadId === threadId).reverse().slice(0, limit);
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
    serverSkillInputGuard,
    canRunAgent,
    deliverOutputFiles
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
    initiatorUserId?: string;
    initiatorAgentId?: string;
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
    runStates,
    runInputs,
    tasks,
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
        terminationReason: 'completed',
        initiatorUserId: tasks.get(submitted.taskId)?.initiatorUserId,
        initiatorAgentId: tasks.get(submitted.taskId)?.initiatorAgentId
      });
    },
    publish(runId: string, event: AgentEventEnvelope) {
      for (const listener of subscriptions.get(runId) ?? []) listener(event);
    }
  };
}

function createContinuationFixture() {
  const fixture = createFixture();
  fixture.seedTask({
    runId: 'run_previous', threadId: 'thread_previous', projectId: 'project_other',
    status: 'succeeded', runStatus: 'succeeded',
    initiatorUserId: 'user_1', initiatorAgentId: 'agent_1'
  });
  fixture.threads.get('thread_previous')!.codexThreadId = 'codex_original';
  return fixture;
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

function fileChangeEvent(runId: string, seq: number, paths: string[]): AgentEventEnvelope {
  return {
    id: `${runId}:file_change:${seq}`,
    runId,
    seq,
    ts: '2026-11-05T00:00:00.000Z',
    type: 'file_change',
    payload: {
      type: 'file_change',
      status: 'completed',
      changes: paths.map(path => ({ path, kind: 'add' as const }))
    },
    normalizerVersion: 2
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
    initiatorUserId?: string;
    initiatorAgentId?: string;
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
    initiatorUserId: input.initiatorUserId,
    initiatorAgentId: input.initiatorAgentId,
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
