import type { AgentEventEnvelope } from '@clawee/protocol';
import { EnterpriseHttpError } from './http-client-2026-07-30.js';
import {
  ENTERPRISE_ACTIVITY_SCHEMA_VERSION,
  projectActivityEvent,
  projectRunStarted,
  type EnterpriseActivityEvent,
  type EnterpriseActivityEventsRequest,
  type EnterpriseActivityRunContext
} from './activity-event-projector-2026-08-28.js';

const MAX_BATCH_EVENTS = 20;
const MAX_BATCH_BYTES = 512 * 1024;
const MAX_QUEUE_EVENTS = 500;
const MAX_QUEUE_BYTES = 5 * 1024 * 1024;
const FLUSH_DELAY_MS = 500;
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;
const MAX_BATCH_AGE_MS = 60_000;
const CLOSE_TIMEOUT_MS = 2_000;

type QueuedEvent = {
  event: EnterpriseActivityEvent;
  bytes: number;
  enqueuedAt: number;
};

export type EnterpriseActivityReporter = {
  registerRun(input: {
    runId: string;
    threadId?: string;
    prompt: string;
    createdBy: 'api' | 'schedule';
    workspaceName: string;
    createdAt: string;
  }): void;
  enqueue(event: AgentEventEnvelope): void;
  resume(): void;
  clear(reason: string): void;
  close(): Promise<void>;
};

export function createEnterpriseActivityReporter(input: {
  httpClient: {
    reportAgentActivity(
      accessToken: string,
      request: EnterpriseActivityEventsRequest
    ): Promise<void>;
  };
  requireAccessToken(): Promise<string>;
  clientVersion?: string;
  now?: () => number;
  onDiagnostic?: (diagnostic: {
    code: string;
    statusCode?: number;
    eventCount?: number;
    byteCount?: number;
    droppedEvents?: number;
  }) => void;
}): EnterpriseActivityReporter {
  const clientVersion = input.clientVersion ?? '0.1.0';
  const now = input.now ?? Date.now;
  const contexts = new Map<string, EnterpriseActivityRunContext>();
  const queue: QueuedEvent[] = [];
  let queueBytes = 0;
  let droppedEvents = 0;
  let paused = true;
  let closed = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushWork: Promise<void> | undefined;

  function enqueueProjected(event: EnterpriseActivityEvent): void {
    if (paused || closed) return;
    const bytes = encodedBytes(event);
    queue.push({ event, bytes, enqueuedAt: now() });
    queueBytes += bytes;
    let droppedThisEnqueue = false;
    while (queue.length > MAX_QUEUE_EVENTS || queueBytes > MAX_QUEUE_BYTES) {
      const dropped = queue.shift();
      if (dropped === undefined) break;
      queueBytes -= dropped.bytes;
      droppedEvents += 1;
      droppedThisEnqueue = true;
    }
    if (droppedThisEnqueue) {
      input.onDiagnostic?.({ code: 'ACTIVITY_QUEUE_OVERFLOW', droppedEvents });
    }
    if (queue.length >= MAX_BATCH_EVENTS || queueBytes >= MAX_BATCH_BYTES) {
      scheduleFlush(0);
      return;
    }
    scheduleFlush(FLUSH_DELAY_MS);
  }

  function scheduleFlush(delayMs: number): void {
    if (paused || closed) return;
    if (flushTimer !== undefined) {
      if (delayMs !== 0) return;
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, delayMs);
  }

  function flush(): Promise<void> {
    flushWork ??= drain().finally(() => {
      flushWork = undefined;
      if (queue.length > 0 && !paused && !closed) scheduleFlush(FLUSH_DELAY_MS);
    });
    return flushWork;
  }

  async function drain(): Promise<void> {
    while (queue.length > 0 && !paused) {
      const batch = nextBatch(queue, clientVersion);
      const request = buildRequest(batch.map(item => item.event), clientVersion);
      const byteCount = encodedBytes(request);
      let retry = 0;
      while (!paused) {
        try {
          const accessToken = await input.requireAccessToken();
          await input.httpClient.reportAgentActivity(accessToken, request);
          removeBatch(batch);
          break;
        } catch (error) {
          if (paused || closed) return;
          const statusCode = error instanceof EnterpriseHttpError
            ? error.statusCode
            : undefined;
          if (statusCode === 401 || statusCode === 403) {
            input.onDiagnostic?.({ code: 'ACTIVITY_AUTH_REJECTED', statusCode, eventCount: batch.length, byteCount });
            clearQueue();
            paused = true;
            return;
          }
          if (statusCode === 400 || statusCode === 413) {
            input.onDiagnostic?.({ code: 'ACTIVITY_BATCH_REJECTED', statusCode, eventCount: batch.length, byteCount });
            removeBatch(batch);
            break;
          }
          const retryable = statusCode === undefined || statusCode === 429 || statusCode >= 500;
          const oldestAt = batch[0]?.enqueuedAt ?? now();
          if (!retryable || now() - oldestAt >= MAX_BATCH_AGE_MS) {
            input.onDiagnostic?.({ code: 'ACTIVITY_BATCH_DROPPED', statusCode, eventCount: batch.length, byteCount });
            removeBatch(batch);
            break;
          }
          const delayMs = RETRY_DELAYS_MS[Math.min(retry, RETRY_DELAYS_MS.length - 1)] ?? 10_000;
          retry += 1;
          await delay(delayMs);
        }
      }
    }
  }

  function removeBatch(batch: QueuedEvent[]): void {
    for (const item of batch) {
      const index = queue.indexOf(item);
      if (index === -1) continue;
      queue.splice(index, 1);
      queueBytes -= item.bytes;
    }
  }

  function clearQueue(): void {
    queue.length = 0;
    queueBytes = 0;
    contexts.clear();
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
  }

  return {
    registerRun(run) {
      if (paused || closed) return;
      const context = { sessionId: run.threadId ?? run.runId, turnId: run.runId };
      contexts.set(run.runId, context);
      enqueueProjected(projectRunStarted(run));
    },

    enqueue(event) {
      const context = contexts.get(event.runId);
      if (context === undefined || paused || closed) return;
      const projected = projectActivityEvent(event, context);
      if (projected !== undefined) enqueueProjected(projected);
      if (event.type === 'done') contexts.delete(event.runId);
    },

    resume() {
      if (closed) return;
      paused = false;
      if (queue.length > 0) scheduleFlush(0);
    },

    clear(_reason) {
      paused = true;
      clearQueue();
    },

    async close() {
      if (closed) return;
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flushTimer = undefined;
      await Promise.race([flush(), delay(CLOSE_TIMEOUT_MS)]);
      paused = true;
      closed = true;
      clearQueue();
    }
  };
}

function nextBatch(queue: QueuedEvent[], clientVersion: string): QueuedEvent[] {
  const batch: QueuedEvent[] = [];
  for (const item of queue) {
    if (batch.length >= MAX_BATCH_EVENTS) break;
    const candidate = [...batch, item];
    if (
      batch.length > 0
      && encodedBytes(buildRequest(candidate.map(entry => entry.event), clientVersion)) > MAX_BATCH_BYTES
    ) {
      break;
    }
    batch.push(item);
  }
  return batch;
}

function buildRequest(
  events: EnterpriseActivityEvent[],
  clientVersion: string
): EnterpriseActivityEventsRequest {
  return {
    schema_version: ENTERPRISE_ACTIVITY_SCHEMA_VERSION,
    client_version: clientVersion,
    sent_at: new Date().toISOString(),
    events
  };
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
