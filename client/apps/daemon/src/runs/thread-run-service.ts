import type {
  AttachmentResponse,
  RunRequest,
  RunResponse,
  RuntimeErrorCode
} from '@clawee/protocol';
import { realpathSync } from 'node:fs';
import {
  AttachmentServiceError,
  type AttachmentService
} from '../attachments/service.js';
import {
  isResumeExecutionSupported,
  type RuntimeCapabilityMatrix
} from '../codex/capabilities.js';
import type { MemoryService } from '../memory/service.js';
import type { ThreadManager } from '../threads/types.js';
import { ThreadManagerError } from '../threads/types.js';
import type { RunManager } from './manager.js';

export type ThreadRunManager = Pick<RunManager, 'startRun' | 'cancelRun'>;

export type ProfileValidator = {
  validateProfileForRun(name: string):
    | { ok: true }
    | { ok: false; code: string; message: string };
};

export type ThreadRunServiceOptions = {
  threadManager?: ThreadManager;
  profileValidator?: ProfileValidator;
  attachmentService?: AttachmentService;
  capabilities?: RuntimeCapabilityMatrix;
  memoryService?: MemoryService;
};

export class ThreadRunServiceError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ThreadRunServiceError';
  }
}

export async function startThreadRun(input: {
  request: RunRequest & { threadId: string };
  manager: ThreadRunManager;
  options: ThreadRunServiceOptions;
}): Promise<RunResponse & { attachments: AttachmentResponse[] }> {
  const { request, manager, options } = input;
  let thread = options.threadManager?.getPublicThread(request.threadId);
  if (thread === undefined) {
    throw new ThreadRunServiceError('THREAD_NOT_FOUND', 'Thread not found', 404);
  }
  try {
    thread = options.threadManager?.assertRunnableThread(request.threadId) ?? thread;
  } catch (error) {
    throw mapThreadManagerError(error);
  }
  if (thread.status === 'archived') {
    throw new ThreadRunServiceError('THREAD_ARCHIVED', 'Thread is archived', 409);
  }

  const immutable = overridesThreadConfig(request, thread);
  if (!immutable.ok) {
    throw new ThreadRunServiceError('VALIDATION_FAILED', immutable.message, 400);
  }
  if (immutable.value) {
    throw new ThreadRunServiceError(
      'THREAD_CONFIG_IMMUTABLE',
      'Thread run config is immutable',
      409
    );
  }

  const validation = options.profileValidator?.validateProfileForRun(thread.profile);
  if (validation !== undefined && !validation.ok) {
    const statusCode = validation.code === 'CODEX_PROFILE_NOT_FOUND' ? 404 : 422;
    throw new ThreadRunServiceError(
      validation.code as RuntimeErrorCode,
      validation.message,
      statusCode
    );
  }

  const attachments = await resolveRunAttachments(request, thread, options);
  const context = options.memoryService?.prepareRunContext({
    prompt: request.prompt,
    threadId: thread.id,
    projectKey: thread.purpose === 'conversation' ? thread.projectId ?? '' : ''
  });
  const run = manager.startRun({
    prompt: request.prompt,
    executionPrompt: prependAttachmentContext(
      context?.executionPrompt ?? request.prompt,
      attachments.textContext
    ),
    contextItems: context?.items,
    cwd: thread.cwd,
    profile: thread.profile,
    sandbox: thread.sandbox,
    threadId: thread.id,
    resumeMode: request.resumeMode ?? 'auto',
    model: request.model === undefined
      ? thread.model ?? undefined
      : request.model ?? undefined,
    reasoning: request.reasoning === undefined
      ? thread.reasoning ?? undefined
      : request.reasoning ?? undefined,
    imagePaths: attachments.imagePaths,
    attachmentIds: request.attachmentIds,
    submissionMode: request.submissionMode
  });

  try {
    const attachments = await commitRunAttachments(
      request,
      thread.id,
      run.id,
      options
    );
    return { ...run, attachments };
  } catch (error) {
    manager.cancelRun(run.id);
    throw mapAttachmentError(error);
  }
}

type RuntimeThread = NonNullable<ReturnType<ThreadManager['getPublicThread']>>;
type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function overridesThreadConfig(
  body: RunRequest,
  thread: RuntimeThread
): ParseResult<boolean> {
  let cwdChanged = false;
  if (body.cwd !== undefined) {
    try {
      cwdChanged = realpathSync(body.cwd) !== thread.canonicalCwd;
    } catch {
      return { ok: false, message: 'cwd must exist' };
    }
  }
  return {
    ok: true,
    value:
      cwdChanged
      || (body.profile !== undefined && body.profile !== thread.profile)
      || (body.sandbox !== undefined && body.sandbox !== thread.sandbox)
  };
}

async function resolveRunAttachments(
  body: RunRequest,
  thread: RuntimeThread,
  options: Pick<
    ThreadRunServiceOptions,
    'attachmentService' | 'capabilities'
  >
): Promise<{ imagePaths: string[]; textContext?: string }> {
  const ids = body.attachmentIds ?? [];
  if (ids.length === 0) return { imagePaths: [] };
  if (body.draftId === undefined) {
    throw new ThreadRunServiceError(
      'VALIDATION_FAILED',
      'draftId is required when attachmentIds are provided',
      400
    );
  }
  if (options.attachmentService === undefined) {
    throw new ThreadRunServiceError(
      'ATTACHMENT_STORAGE_FAILED',
      'Attachment service is unavailable',
      503
    );
  }

  try {
    const resolved = await options.attachmentService.resolveForRun({
      ids,
      draftId: body.draftId
    });
    if (resolved.imagePaths.length > 0) {
      const usesResume = body.resumeMode === 'resume_thread'
        || (
          (body.resumeMode === undefined || body.resumeMode === 'auto')
          && thread.codexThreadId !== undefined
          && thread.codexThreadId !== null
          && options.capabilities !== undefined
          && isResumeExecutionSupported(options.capabilities)
        );
      const supported = usesResume
        ? options.capabilities?.resumeImages === true
        : options.capabilities?.execImages === true;
      if (!supported) {
        throw new ThreadRunServiceError(
          'CODEX_IMAGE_INPUT_UNSUPPORTED',
          'Current Codex version does not support image input',
          409
        );
      }
    }
    return resolved;
  } catch (error) {
    throw mapAttachmentError(error);
  }
}

function prependAttachmentContext(prompt: string, textContext?: string): string {
  return textContext === undefined ? prompt : `${textContext}\n\n${prompt}`;
}

async function commitRunAttachments(
  body: RunRequest,
  threadId: string,
  runId: string,
  options: Pick<ThreadRunServiceOptions, 'attachmentService'>
): Promise<AttachmentResponse[]> {
  const ids = body.attachmentIds ?? [];
  if (ids.length === 0) return [];
  if (body.draftId === undefined || options.attachmentService === undefined) {
    throw new ThreadRunServiceError(
      'ATTACHMENT_STORAGE_FAILED',
      'Attachment service is unavailable',
      503
    );
  }
  return options.attachmentService.commit({
    ids,
    draftId: body.draftId,
    threadId,
    runId
  });
}

function mapAttachmentError(error: unknown): ThreadRunServiceError {
  if (error instanceof ThreadRunServiceError) return error;
  if (error instanceof AttachmentServiceError) {
    return new ThreadRunServiceError(
      error.code,
      error.message,
      error.statusCode,
      error.details
    );
  }
  throw error;
}

function mapThreadManagerError(error: unknown): ThreadRunServiceError {
  if (!(error instanceof ThreadManagerError)) throw error;
  if (error.code === 'THREAD_NOT_FOUND' || error.code === 'PROJECT_NOT_FOUND') {
    return new ThreadRunServiceError(error.code, error.message, 404);
  }
  if (error.code === 'PROJECT_DIRECTORY_UNAVAILABLE') {
    return new ThreadRunServiceError(error.code, error.message, 422);
  }
  return new ThreadRunServiceError(error.code, error.message, 409);
}
