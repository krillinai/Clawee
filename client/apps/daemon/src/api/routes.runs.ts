import type { AttachmentResponse, RunRequest, RunResponse } from '@clawee/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AttachmentService } from '../attachments/service.js';
import type { RuntimeCapabilityMatrix } from '../codex/capabilities.js';
import type { RunManager } from '../runs/manager.js';
import type { ThreadManager } from '../threads/types.js';
import type { MemoryService } from '../memory/service.js';
import {
  startThreadRun,
  ThreadRunServiceError,
  type ProfileValidator
} from '../runs/thread-run-service.js';
import { apiError } from './errors.js';
import { formatSseEvent } from './sse.js';

export async function registerRunRoutes(
  server: FastifyInstance,
  manager: RunManager,
  options: {
    sseHeartbeatMs?: number;
    threadManager?: ThreadManager;
    profileValidator?: ProfileValidator;
    attachmentService?: AttachmentService;
    capabilities?: RuntimeCapabilityMatrix;
    memoryService?: MemoryService;
  } = {}
): Promise<void> {
  const sseHeartbeatMs = options.sseHeartbeatMs ?? 15_000;
  server.post<{ Body: unknown }>('/runs', async (request, reply) => {
    const parsedBody = parseRunRequest(request.body);
    if (!parsedBody.ok) {
      return reply.code(400).send(apiError('VALIDATION_FAILED', parsedBody.message));
    }
    const body = parsedBody.value;

    if (body.threadId !== undefined) {
      try {
        const run = await startThreadRun({
          request: { ...body, threadId: body.threadId },
          manager,
          options
        });
        return reply.code(202).send(run);
      } catch (error) {
        if (!(error instanceof ThreadRunServiceError)) throw error;
        return reply
          .code(error.statusCode)
          .send(apiError(error.code, error.message, error.details));
      }
    }

    if ((body.attachmentIds?.length ?? 0) > 0) {
      return reply
        .code(400)
        .send(apiError('VALIDATION_FAILED', 'threadId is required when attachmentIds are provided'));
    }
    if (body.submissionMode === 'interrupt_and_enqueue') {
      return reply
        .code(400)
        .send(apiError('VALIDATION_FAILED', 'interrupt_and_enqueue requires threadId'));
    }

    if (body.profile !== undefined) {
      const validation = options.profileValidator?.validateProfileForRun(body.profile);
      if (validation !== undefined && !validation.ok) {
        return sendProfileValidationError(reply, validation);
      }
    }

    const run = manager.startRun({
      prompt: body.prompt,
      cwd: body.cwd ?? process.cwd(),
      profile: body.profile ?? 'default',
      sandbox: body.sandbox ?? 'workspace-write',
      threadId: body.threadId,
      resumeMode: body.resumeMode,
      model: body.model ?? undefined,
      reasoning: body.reasoning ?? undefined,
      submissionMode: body.submissionMode
    });

    return reply.code(202).send(withAttachments(run, []));
  });

  server.get('/runs', async request => {
    const query = request.query as { limit?: string } | undefined;
    const limit = query?.limit === undefined ? undefined : Number(query.limit);
    return {
      runs: manager.listRuns(Number.isFinite(limit) ? limit : undefined).map(run =>
        withAttachments(run, options.attachmentService?.listByRun(run.id) ?? [])
      )
    };
  });

  server.get('/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = manager.getRun(id);
    if (run === undefined) return reply.code(404).send(apiError('RUN_NOT_FOUND', 'Run not found'));
    return withAttachments(run, options.attachmentService?.listByRun(run.id) ?? []);
  });

  server.post('/runs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = manager.getRun(id);
    if (run === undefined) {
      return reply.code(404).send(apiError('RUN_NOT_FOUND', 'Run not found'));
    }
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'canceled') {
      return reply
        .code(409)
        .send(apiError('RUN_ALREADY_TERMINAL', 'Run is already terminal'));
    }
    const canceled = manager.cancelRun(id);
    return reply.code(canceled ? 202 : 409).send({ id, canceled });
  });

  server.post('/runs/:id/steer', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = manager.getRun(id);
    if (run === undefined) {
      return reply.code(404).send(apiError('RUN_NOT_FOUND', 'Run not found'));
    }
    if (run.status !== 'queued') {
      return reply
        .code(409)
        .send(apiError('VALIDATION_FAILED', 'Only queued runs can be steered'));
    }
    const steered = manager.steerRun?.(id) ?? false;
    return reply.code(steered ? 202 : 409).send({ id, steered });
  });

  server.get('/runs/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = manager.getRun(id);
    if (run === undefined) {
      return reply.code(404).send(apiError('RUN_NOT_FOUND', 'Run not found'));
    }

    const replayAfterSeq = getReplayAfterSeq(request.headers['last-event-id'], request.query);
    if (!replayAfterSeq.ok) {
      return reply.code(400).send(apiError('VALIDATION_FAILED', replayAfterSeq.message));
    }

    for (const [header, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(header, value);
    }
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    });

    const writeEvent = (event: ReturnType<RunManager['listEvents']>[number]) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(formatSseEvent({ id: String(event.seq), event: event.type, data: event }));
      if (event.type === 'done') closeSse(reply);
    };

    for (const event of manager.listEvents(id, replayAfterSeq.value)) writeEvent(event);
    if (reply.raw.destroyed || reply.raw.writableEnded) return reply;
    if (isTerminalRunStatus(run.status)) {
      closeSse(reply);
      return reply;
    }

    const unsubscribe = manager.subscribe(id, writeEvent);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(': heartbeat\n\n');
    }, sseHeartbeatMs);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);

    return reply;
  });
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };
type ProfileValidationResult = { ok: true } | { ok: false; code: string; message: string };

const RESUME_MODES = ['auto', 'new_thread', 'resume_thread'] as const;
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const REASONING_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh'] as const;

function parseRunRequest(body: unknown): ParseResult<RunRequest> {
  if (body === undefined) return { ok: false, message: 'prompt is required' };
  if (!isPlainObject(body)) return { ok: false, message: 'body must be an object' };

  const input = body as Record<string, unknown>;
  const prompt = input.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { ok: false, message: 'prompt is required' };
  }

  const value: RunRequest = { prompt };
  for (const key of ['threadId', 'draftId', 'cwd', 'profile'] as const) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== 'string') return { ok: false, message: `${key} must be a string` };
    value[key] = field;
  }
  if (input.model !== undefined) {
    if (
      input.model !== null
      && (typeof input.model !== 'string' || input.model.trim().length === 0)
    ) {
      return { ok: false, message: 'model must be a non-empty string or null' };
    }
    value.model = typeof input.model === 'string' ? input.model.trim() : null;
  }

  if (input.resumeMode !== undefined) {
    if (!isOneOf(input.resumeMode, RESUME_MODES)) {
      return { ok: false, message: 'resumeMode must be auto, new_thread, or resume_thread' };
    }
    value.resumeMode = input.resumeMode;
  }

  if (input.sandbox !== undefined) {
    if (!isOneOf(input.sandbox, SANDBOX_MODES)) {
      return { ok: false, message: 'sandbox must be a valid sandbox mode' };
    }
    value.sandbox = input.sandbox;
  }

  if (input.reasoning !== undefined) {
    if (
      input.reasoning !== null
      && !isOneOf(input.reasoning, REASONING_EFFORTS)
    ) {
      return {
        ok: false,
        message: 'reasoning must be a valid reasoning effort or null'
      };
    }
    value.reasoning = input.reasoning;
  }

  if (
    input.submissionMode !== undefined
    && input.submissionMode !== 'enqueue'
    && input.submissionMode !== 'interrupt_and_enqueue'
  ) {
    return {
      ok: false,
      message: 'submissionMode must be enqueue or interrupt_and_enqueue'
    };
  }
  if (input.submissionMode !== undefined) value.submissionMode = input.submissionMode;

  if (input.attachmentIds !== undefined) {
    if (!Array.isArray(input.attachmentIds)) {
      return { ok: false, message: 'attachmentIds must be an array' };
    }
    if (input.attachmentIds.length > 8) {
      return { ok: false, message: 'attachmentIds must contain at most 8 items' };
    }
    if (
      input.attachmentIds.some(
        id => typeof id !== 'string' || id.trim().length === 0
      )
    ) {
      return { ok: false, message: 'attachmentIds must contain non-empty strings' };
    }
    value.attachmentIds = input.attachmentIds as string[];
    if (value.attachmentIds.length > 0 && value.draftId === undefined) {
      return { ok: false, message: 'draftId is required when attachmentIds are provided' };
    }
  }

  return { ok: true, value };
}

function withAttachments<T extends RunResponse>(
  run: T,
  attachments: AttachmentResponse[]
): T & { attachments: AttachmentResponse[] } {
  return { ...run, attachments };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<const T extends readonly string[]>(value: unknown, options: T): value is T[number] {
  return typeof value === 'string' && options.includes(value);
}

function sendProfileValidationError(
  reply: FastifyReply,
  validation: Extract<ProfileValidationResult, { ok: false }>
) {
  if (validation.code === 'CODEX_PROFILE_NOT_FOUND') {
    return reply.code(404).send(apiError('CODEX_PROFILE_NOT_FOUND', validation.message));
  }
  if (validation.code === 'CODEX_CONFIG_INVALID') {
    return reply.code(422).send(apiError('CODEX_CONFIG_INVALID', validation.message));
  }
  return reply.code(422).send(apiError('CODEX_PROFILE_INVALID', validation.message));
}

function getReplayAfterSeq(
  lastEventId: string | string[] | undefined,
  query: unknown
): ParseResult<number> {
  if (isPlainObject(query)) {
    if (Object.hasOwn(query, 'fromSeq')) return parseReplaySeq(query.fromSeq, 'fromSeq');
    if (Object.hasOwn(query, 'afterSeq')) return parseReplaySeq(query.afterSeq, 'afterSeq');
  }
  const header = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  return header === undefined
    ? { ok: true, value: 0 }
    : parseReplaySeq(header, 'Last-Event-ID');
}

function parseReplaySeq(value: unknown, field: string): ParseResult<number> {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return { ok: false, message: `${field} must be a non-negative integer` };
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? { ok: true, value: parsed }
    : { ok: false, message: `${field} must be a non-negative integer` };
}

function isTerminalRunStatus(
  status: NonNullable<ReturnType<RunManager['getRun']>>['status']
): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function closeSse(reply: FastifyReply): void {
  setImmediate(() => {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  });
}
