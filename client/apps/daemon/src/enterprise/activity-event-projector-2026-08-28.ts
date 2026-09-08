import type { AgentEventEnvelope } from '@clawee/protocol';
import { redactText } from '../security/redaction.js';

export const ENTERPRISE_ACTIVITY_SCHEMA_VERSION = 'clawee.activity.v1' as const;
export const ENTERPRISE_ACTIVITY_MAX_EVENT_BYTES = 128 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024;
const TRUNCATION_SUFFIX = '\n...[TRUNCATED]';

export type EnterpriseActivityEventType =
  | 'run_started'
  | 'status'
  | 'reasoning_summary'
  | 'assistant_message'
  | 'tool_use'
  | 'tool_result'
  | 'file_change'
  | 'approval'
  | 'diagnostic'
  | 'error'
  | 'done';

export type EnterpriseActivityEvent = {
  event_id: string;
  run_id: string;
  session_id: string;
  turn_id: string;
  sequence: number;
  occurred_at: string;
  event_type: EnterpriseActivityEventType;
  normalizer_version: number;
  payload: Record<string, unknown>;
};

export type EnterpriseActivityEventsRequest = {
  schema_version: typeof ENTERPRISE_ACTIVITY_SCHEMA_VERSION;
  client_version: string;
  sent_at: string;
  events: EnterpriseActivityEvent[];
};

export type EnterpriseActivityRunContext = {
  sessionId: string;
  turnId: string;
};

const supportedTypes = new Set<EnterpriseActivityEventType>([
  'status', 'reasoning_summary', 'assistant_message', 'tool_use', 'tool_result',
  'file_change', 'approval', 'diagnostic', 'error', 'done', 'run_started'
]);

const secretKeys = new Set([
  'authorization', 'cookie', 'token', 'secret', 'password', 'passwd', 'api_key',
  'apikey', 'credential', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken'
]);

export function projectRunStarted(input: {
  runId: string;
  threadId?: string;
  prompt: string;
  createdBy: 'api' | 'schedule';
  workspaceName: string;
  createdAt: string;
}): EnterpriseActivityEvent {
  return fitEvent({
    event_id: `evt_${input.runId}_created`,
    run_id: input.runId,
    session_id: input.threadId ?? input.runId,
    turn_id: input.runId,
    sequence: 0,
    occurred_at: input.createdAt,
    event_type: 'run_started',
    normalizer_version: 1,
    payload: sanitizePayload({
      prompt: input.prompt,
      created_by: input.createdBy,
      workspace_name: input.workspaceName
    })
  });
}

export function projectActivityEvent(
  event: AgentEventEnvelope,
  context: EnterpriseActivityRunContext
): EnterpriseActivityEvent | undefined {
  if (!supportedTypes.has(event.type as EnterpriseActivityEventType)) return undefined;
  const eventType = event.type as EnterpriseActivityEventType;
  const payload = projectPayload(event);
  if (payload === undefined) return undefined;
  return fitEvent({
    event_id: event.id,
    run_id: event.runId,
    session_id: context.sessionId,
    turn_id: context.turnId,
    sequence: event.seq,
    occurred_at: event.ts,
    event_type: eventType,
    normalizer_version: event.normalizerVersion,
    payload: sanitizePayload(payload)
  });
}

function projectPayload(event: AgentEventEnvelope): Record<string, unknown> | undefined {
  const payload = event.payload as Record<string, any>;
  switch (event.type) {
    case 'status':
      return pick(payload, ['label', 'threadId', 'codexThreadId']);
    case 'assistant_message':
    case 'reasoning_summary':
      return pick(payload, ['text', 'format', 'delivery']);
    case 'tool_use': {
      const input = isRecord(payload.input) ? { ...payload.input } : {};
      delete input.raw;
      return { toolCallId: payload.toolCallId, name: payload.name, input };
    }
    case 'tool_result':
      return pick(payload, ['toolCallId', 'output', 'response', 'exitCode', 'isError', 'durationMs']);
    case 'file_change':
      return {
        changes: (payload.changes as Array<{ path: string; kind: string }>).map(change => ({ path: change.path, kind: change.kind })),
        status: payload.status
      };
    case 'approval':
      return { approval: payload.approval };
    case 'diagnostic':
      return pick(payload, ['code', 'severity', 'message', 'details']);
    case 'error':
      return pick(payload, ['code', 'message', 'details']);
    case 'done':
      return pick(payload, ['status', 'terminationReason']);
    default:
      return undefined;
  }
}

function fitEvent(event: EnterpriseActivityEvent): EnterpriseActivityEvent {
  let limit = MAX_CONTENT_BYTES;
  let payload = truncateStrings(event.payload, limit);
  let candidate = markTruncated(event, payload);
  while (encodedBytes(candidate) > ENTERPRISE_ACTIVITY_MAX_EVENT_BYTES && limit > 512) {
    limit = Math.floor(limit / 2);
    payload = truncateStrings(event.payload, limit);
    candidate = markTruncated(event, payload);
  }
  if (encodedBytes(candidate) > ENTERPRISE_ACTIVITY_MAX_EVENT_BYTES) {
    candidate = { ...candidate, payload: fallbackPayload(candidate) };
  }
  return candidate;
}

function fallbackPayload(event: EnterpriseActivityEvent): Record<string, unknown> {
  const payload = event.payload;
  switch (event.event_type) {
    case 'run_started':
      return { ...pick(payload, ['prompt', 'created_by', 'workspace_name']), truncated: true };
    case 'status':
      return { ...pick(payload, ['label']), truncated: true };
    case 'assistant_message':
    case 'reasoning_summary':
      return { ...pick(payload, ['text', 'format', 'delivery']), truncated: true };
    case 'tool_use':
      return { ...pick(payload, ['toolCallId', 'name']), truncated: true };
    case 'tool_result':
      return { ...pick(payload, ['toolCallId', 'exitCode', 'isError', 'durationMs']), truncated: true };
    case 'file_change':
      return { changes: [], ...pick(payload, ['status']), truncated: true };
    case 'approval': {
      const approval = isRecord(payload.approval)
        ? pick(payload.approval, ['id', 'status', 'risk', 'title', 'summary'])
        : {};
      return { approval, truncated: true };
    }
    case 'diagnostic':
      return { ...pick(payload, ['code', 'severity', 'message']), truncated: true };
    case 'error':
      return { ...pick(payload, ['code', 'message']), truncated: true };
    case 'done':
      return { ...pick(payload, ['status', 'terminationReason']), truncated: true };
  }
}

function markTruncated(
  event: EnterpriseActivityEvent,
  payload: Record<string, unknown>
): EnterpriseActivityEvent {
  return {
    ...event,
    payload: containsTruncation(payload) ? { ...payload, truncated: true } : payload
  };
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue('', payload) as Record<string, unknown>;
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (secretKeys.has(normalizeKey(key))) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(item => sanitizeValue('', item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        sanitizeValue(childKey, child)
      ])
    );
  }
  return value;
}

function truncateStrings(value: unknown, limit: number): any {
  if (typeof value === 'string') return truncateUtf8(value, limit);
  if (Array.isArray(value)) return value.map(item => truncateStrings(item, limit));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, truncateStrings(child, limit)])
    );
  }
  return value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, 'utf8');
  const buffer = Buffer.from(value, 'utf8').subarray(0, Math.max(0, maxBytes - suffixBytes));
  return buffer.toString('utf8').replace(/\uFFFD+$/u, '') + TRUNCATION_SUFFIX;
}

function pick(value: object, keys: string[]): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  return Object.fromEntries(keys.flatMap(key => key in record ? [[key, record[key]]] : []));
}

function normalizeKey(key: string): string {
  return key.replace(/-/g, '_').replace(/\s/g, '_').toLowerCase();
}

function containsTruncation(value: unknown): boolean {
  if (typeof value === 'string') return value.endsWith(TRUNCATION_SUFFIX);
  if (Array.isArray(value)) return value.some(containsTruncation);
  if (isRecord(value)) return Object.values(value).some(containsTruncation);
  return false;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
