import type {
  AgentEventEnvelope,
  ProjectResponse,
  PublicRunStatus,
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

export type TaskMcpFinalResult = {
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
  projectId?: string;
  projectName?: string;
};

export function createTaskMcpService(input: {
  projects: Pick<
    ProjectManager,
    'ensureDefaultProject' | 'getProject' | 'findProjectsByName'
  >;
  threads: Pick<ThreadManager, 'createConversationThread' | 'getThread'>;
  runs: Pick<
    RunManager,
    'getRun' | 'getLastEventSeq' | 'listEvents' | 'subscribe' | 'startRun' | 'cancelRun'
  >;
  tasks: Pick<TaskService, 'getByRunId'>;
  threadRunOptions: ThreadRunServiceOptions;
  serverSkillInputGuard?(prompt: string): boolean;
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

  return {
    async submit(request: TaskMcpSubmitInput) {
      try {
        if (input.serverSkillInputGuard?.(request.prompt) === true) {
          throw new TaskMcpServiceError(
            'SERVER_SKILL_DISCLOSURE_FORBIDDEN',
            '该请求涉及服务端受保护内容，无法执行'
          );
        }
        const project = resolveProject(request);
        const thread = input.threads.createConversationThread({
          projectId: project.id,
          title: createTaskTitle(request.prompt),
          purpose: 'conversation'
        });
        const run = await startThreadRun({
          request: { prompt: request.prompt, threadId: thread.id },
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

    getTaskResult(taskId: string):
      | { task_id: string; ready: false; status: TaskItemStatus }
      | ({ ready: true } & TaskMcpFinalResult) {
      const { task } = getTaskIdentity(taskId);
      if (!isTerminalStatus(task.runStatus)) {
        return { task_id: taskId, ready: false, status: task.status };
      }
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
