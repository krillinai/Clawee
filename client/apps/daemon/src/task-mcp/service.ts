import { sharedDriveDelivery } from '../storage/shared-drive.js';
import { relative, resolve, sep } from 'node:path';
import type {
  AgentEventEnvelope,
  ProjectResponse,
  PublicRunStatus,
  TaskMcpHealthResponse,
  TaskItemStatus
} from '@clawee/protocol';
import type { ProjectManager } from '../projects/types.js';
import { ProjectManagerError } from '../projects/types.js';
import type { RunManager } from '../runs/manager.js';
import {
  startThreadRun,
  type ThreadRunServiceOptions
} from '../runs/thread-run-service.js';
import type { TaskService } from '../tasks/service.js';
import type { ThreadManager } from '../threads/types.js';
import { ThreadManagerError } from '../threads/types.js';

export type TaskMcpFinalResult = ReturnType<typeof sharedDriveDelivery> & {
  task_id: string;
  thread_id: string;
  project_id: string;
  project_name: string;
  status: PublicRunStatus;
  result: string;
  last_event_seq: number;
  error_code?: string;
  error_message?: string;
  termination_reason?: string;
};

export class TaskMcpServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'TaskMcpServiceError';
  }
}

export type TaskMcpSubmitInput = {
  prompt: string;
  threadId?: string;
  projectId?: string;
  projectName?: string;
  initiatorUserId?: string;
  initiatorAgentId?: string;
};

export function createTaskMcpService(input: {
  projects: Pick<
    ProjectManager,
    'ensureDefaultProject' | 'getProject' | 'findProjectsByName'
  >;
  threads: Pick<ThreadManager, 'createConversationThread' | 'getThread'>;
  runs: Pick<
    RunManager,
    'getRun' | 'listRunsByThread' | 'getLastEventSeq' | 'listEvents' | 'subscribe' | 'startRun' | 'cancelRun'
  >;
  tasks: Pick<TaskService, 'getByRunId'>;
  threadRunOptions: ThreadRunServiceOptions;
  serverSkillInputGuard?(prompt: string): boolean;
  canRunAgent?(): boolean;
  runtimeReady?(): boolean;
  deliverOutputFiles?(taskId: string, paths: string[]): Promise<void>;
}) {
  const resolveProject = (selector: Pick<TaskMcpSubmitInput, 'projectId' | 'projectName'>) => {
    const projectId = selector.projectId?.trim();
    const projectName = selector.projectName?.trim();
    let project: ProjectResponse | undefined;

    if (projectId !== undefined) {
      project = input.projects.getProject(projectId);
      if (
        project !== undefined
        && projectName !== undefined
        && project.name !== projectName
      ) {
        throw new TaskMcpServiceError(
          'PROJECT_SELECTOR_MISMATCH',
          'Project id and project name refer to different projects',
          {
            project_id: project.id,
            expected_project_name: project.name,
            provided_project_name: projectName
          }
        );
      }
    } else if (projectName !== undefined) {
      const activeMatches = input.projects.findProjectsByName(projectName, 'active');
      if (activeMatches.length > 1) {
        throw new TaskMcpServiceError(
          'PROJECT_NAME_AMBIGUOUS',
          'Multiple active projects have this name; use project_id to select one',
          {
            candidates: activeMatches.map(candidate => ({
              project_id: candidate.id,
              project_name: candidate.name,
              cwd: candidate.cwd
            }))
          }
        );
      }
      project = activeMatches[0];
      if (
        project === undefined
        && input.projects.findProjectsByName(projectName, 'archived').length > 0
      ) {
        throw new TaskMcpServiceError('PROJECT_ARCHIVED', 'Project is archived');
      }
      if (project === undefined && isDefaultProjectDirectoryAlias(projectName)) {
        project = input.projects.ensureDefaultProject();
      }
    } else {
      project = input.projects.ensureDefaultProject();
    }

    if (project === undefined) {
      throw new TaskMcpServiceError('PROJECT_NOT_FOUND', 'Project not found');
    }
    if (project.status === 'archived') {
      throw new TaskMcpServiceError('PROJECT_ARCHIVED', 'Project is archived');
    }
    if (project.directoryState !== 'available' || project.canonicalCwd === null) {
      throw new TaskMcpServiceError(
        'PROJECT_DIRECTORY_UNAVAILABLE',
        'Project directory does not exist or is not accessible'
      );
    }
    return project;
  };

  const getRequiredTask = (taskId: string) => {
    const task = input.tasks.getByRunId(taskId);
    if (task === undefined) {
      throw new TaskMcpServiceError('TASK_NOT_FOUND', 'Task not found');
    }
    return task;
  };

  const getTaskIdentity = (taskId: string) => {
    const task = getRequiredTask(taskId);
    const thread = task.threadId === undefined
      ? undefined
      : input.threads.getThread(task.threadId);
    if (thread === undefined || thread.projectId === null) {
      throw new TaskMcpServiceError('TASK_NOT_FOUND', 'Task not found');
    }
    const project = input.projects.getProject(thread.projectId);
    if (project === undefined) {
      throw new TaskMcpServiceError('TASK_NOT_FOUND', 'Task not found');
    }
    return { task, thread, project };
  };

  const resolveResumeThread = (request: TaskMcpSubmitInput) => {
    if (request.threadId === undefined) return undefined;
    const thread = input.threads.getThread(request.threadId);
    if (
      thread === undefined || thread.projectId === null
      || thread.enterpriseSubjectId !== null || thread.purpose !== 'conversation'
    ) {
      throw new TaskMcpServiceError('THREAD_NOT_FOUND', '会话不存在或不支持继续执行');
    }
    const previousRun = input.runs.listRunsByThread(thread.id, 1)[0];
    const previousTask = previousRun === undefined ? undefined : input.tasks.getByRunId(previousRun.id);
    if (
      !request.initiatorUserId || !request.initiatorAgentId
      || previousTask?.initiatorUserId !== request.initiatorUserId
      || previousTask?.initiatorAgentId !== request.initiatorAgentId
    ) {
      throw new TaskMcpServiceError('THREAD_ACCESS_DENIED', '无法继续来源不完整或来源不符的会话');
    }
    if (thread.status === 'archived') {
      throw new TaskMcpServiceError('THREAD_ARCHIVED', '会话已归档，无法继续执行');
    }
    if (!thread.codexThreadId) {
      throw new TaskMcpServiceError(
        'CODEX_THREAD_ID_MISSING',
        '原 Runtime 会话尚未建立或已丢失，请先查询上一轮任务状态'
      );
    }
    if (request.projectId !== undefined && request.projectId.trim() !== thread.projectId) {
      throw new TaskMcpServiceError('PROJECT_SELECTOR_MISMATCH', '项目参数与原会话不一致');
    }
    return thread;
  };

  return {
    getHealth(): TaskMcpHealthResponse {
      return {
        runtime: input.runtimeReady === undefined ? 'unknown'
          : input.runtimeReady() ? 'ready' : 'unavailable',
        model: input.canRunAgent === undefined ? 'unknown'
          : input.canRunAgent() ? 'configured' : 'configuration_required'
      };
    },

    async submit(request: TaskMcpSubmitInput) {
      try {
        if (input.canRunAgent?.() === false) {
          throw new TaskMcpServiceError(
            'MODEL_SERVICE_CONFIGURATION_REQUIRED',
            '请先配置并验证 Codex 模型服务'
          );
        }
        if (input.serverSkillInputGuard?.(request.prompt) === true) {
          throw new TaskMcpServiceError(
            'SERVER_SKILL_DISCLOSURE_FORBIDDEN',
            '该请求涉及服务端受保护内容，无法执行'
          );
        }
        const resumeThread = resolveResumeThread(request);
        const project = resolveProject({
          projectId: resumeThread?.projectId ?? request.projectId,
          projectName: request.projectName
        });
        const thread = resumeThread ?? input.threads.createConversationThread({
          projectId: project.id,
          title: createTaskTitle(request.prompt),
          purpose: 'conversation'
        });
        const run = await startThreadRun({
          request: {
            prompt: request.prompt,
            threadId: thread.id,
            ...(resumeThread === undefined ? {} : { resumeMode: 'resume_thread' as const })
          },
          initiatorUserId: request.initiatorUserId,
          initiatorAgentId: request.initiatorAgentId,
          manager: input.runs,
          options: input.threadRunOptions
        });
        return {
          taskId: run.id,
          threadId: thread.id,
          projectId: project.id,
          projectName: project.name,
          status: run.status
        };
      } catch (error) {
        if (error instanceof TaskMcpServiceError) throw error;
        if (error instanceof ProjectManagerError || error instanceof ThreadManagerError) {
          throw new TaskMcpServiceError(error.code, error.message);
        }
        if (isCodedError(error)) {
          throw new TaskMcpServiceError(error.code, error.message);
        }
        throw error;
      }
    },

    getTask(taskId: string, afterSeq = 0) {
      const { task } = getTaskIdentity(taskId);
      const events = input.runs.listEvents(taskId, afterSeq).slice(0, 100);
      return {
        task_id: taskId,
        thread_id: task.threadId!,
        status: task.status,
        queue_position: task.queuePosition ?? null,
        last_event_seq: input.runs.getLastEventSeq(taskId),
        events,
        result_available: isTerminalStatus(task.runStatus)
      };
    },

    async getTaskResult(taskId: string): Promise<
      | { task_id: string; ready: false; status: TaskItemStatus }
      | ({ ready: true } & TaskMcpFinalResult)
    > {
      const { task } = getTaskIdentity(taskId);
      if (!isTerminalStatus(task.runStatus)) {
        return { task_id: taskId, ready: false, status: task.status };
      }
      await ensureFinalDelivery(taskId);
      return { ready: true, ...buildFinalResult(taskId) };
    },

    buildFinalResult,

    listEvents(taskId: string, afterSeq = 0): AgentEventEnvelope[] {
      getRequiredTask(taskId);
      return input.runs.listEvents(taskId, afterSeq);
    },

    subscribe(taskId: string, listener: (event: AgentEventEnvelope) => void) {
      getRequiredTask(taskId);
      return input.runs.subscribe(taskId, listener);
    }
  };

  function buildFinalResult(taskId: string): TaskMcpFinalResult {
    const { task, thread, project } = getTaskIdentity(taskId);
    if (!isTerminalStatus(task.runStatus)) {
      throw new TaskMcpServiceError('TASK_NOT_READY', 'Task is not finished');
    }
    const events = input.runs.listEvents(taskId, 0);
    let finalMessage: Extract<
      AgentEventEnvelope,
      { type: 'assistant_message' }
    > | undefined;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (
        event?.type === 'assistant_message'
        && event.payload.delivery === 'message'
      ) {
        finalMessage = event;
        break;
      }
    }
    return {
      ...sharedDriveDelivery(input.runs.getRun(taskId)?.sharedDriveState),
      task_id: taskId,
      thread_id: thread.id,
      project_id: project.id,
      project_name: project.name,
      status: task.runStatus,
      result: finalMessage?.payload.text ?? '',
      last_event_seq: input.runs.getLastEventSeq(taskId),
      ...(task.errorCode === undefined ? {} : { error_code: task.errorCode }),
      ...(task.errorMessage === undefined ? {} : { error_message: task.errorMessage }),
      ...(task.terminationReason === undefined
        ? {}
        : { termination_reason: task.terminationReason })
    };
  }

  async function ensureFinalDelivery(taskId: string): Promise<void> {
    const { thread } = getTaskIdentity(taskId);
    const outputPaths = collectOutputPaths(
      input.runs.listEvents(taskId, 0),
      thread.canonicalCwd ?? thread.cwd
    );
    if (outputPaths.length === 0) return;

    const state = input.runs.getRun(taskId)?.sharedDriveState;
    const uploadedPaths = new Set(
      state?.uploads.filter(item => item.status === 'uploaded').map(item => item.path) ?? []
    );
    const pendingPaths = outputPaths.filter(path => !uploadedPaths.has(path));
    if (pendingPaths.length > 0) {
      if (input.deliverOutputFiles === undefined) {
        throw new TaskMcpServiceError(
          'TASK_DELIVERY_INCOMPLETE',
          '任务生成了文件，但服务端未配置网盘交付'
        );
      }
      try {
        await input.deliverOutputFiles(taskId, pendingPaths);
      } catch (error) {
        throw new TaskMcpServiceError(
          'TASK_DELIVERY_INCOMPLETE',
          '任务生成的文件未能上传到网盘',
          { cause: error instanceof Error ? error.message : String(error) }
        );
      }
    }

    const delivery = sharedDriveDelivery(input.runs.getRun(taskId)?.sharedDriveState);
    if (delivery.delivery_status !== 'complete') {
      throw new TaskMcpServiceError(
        'TASK_DELIVERY_INCOMPLETE',
        '任务生成的文件未全部上传到网盘',
        { delivery_status: delivery.delivery_status, delivery_errors: delivery.delivery_errors }
      );
    }
  }
}

function isDefaultProjectDirectoryAlias(value: string): boolean {
  const basename = value.replaceAll('\\', '/').split('/').pop() ?? value;
  return basename === 'DefaultProject' || basename === 'Default Project';
}

export type TaskMcpService = ReturnType<typeof createTaskMcpService>;

function createTaskTitle(prompt: string): string {
  return Array.from(prompt.replace(/\s+/g, ' ').trim()).slice(0, 80).join('');
}

function isTerminalStatus(status: PublicRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function isCodedError(error: unknown): error is Error & { code: string } {
  return error instanceof Error
    && typeof (error as Error & { code?: unknown }).code === 'string';
}

function collectOutputPaths(events: AgentEventEnvelope[], root: string): string[] {
  const paths = new Set<string>();
  for (const event of events) {
    if (event.type !== 'file_change' || event.payload.status !== 'completed') continue;
    for (const change of event.payload.changes) {
      if (change.kind === 'delete' || change.path.trim().length === 0) continue;
      const absolute = resolve(root, change.path);
      const relativePath = relative(root, absolute).split(sep).join('/');
      if (
        relativePath === 'outputs'
        || relativePath.startsWith('../')
        || relativePath === '..'
        || relativePath.startsWith('/')
        || !relativePath.startsWith('outputs/')
      ) continue;
      paths.add(relativePath);
    }
  }
  return [...paths].sort();
}
