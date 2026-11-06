import type { IncidentDiagnostics } from './incidents.js';

export type ModelResponseError = {
  errorCode: string;
  reason: string;
  suggestion: string;
  retrying: boolean;
  retryAttempt?: number;
  retryLimit?: number;
  httpStatus?: number;
  transportCode?: string;
  requestId?: string;
  networkPath?: 'direct' | 'http_proxy' | 'system_proxy' | 'unknown';
  proxyStage?: 'resolve' | 'connect' | 'tunnel' | 'response_headers' | 'response_body' | 'stream';
  proxyErrorCode?: 'PROXY_AUTH_REQUIRED' | 'PROXY_CONNECT_FAILED' | 'PROXY_CONNECT_TIMEOUT' | 'PROXY_TUNNEL_FAILED' | 'PROXY_POLICY_DENIED' | 'PROXY_STREAM_INTERRUPTED';
  // 本地会话展示的脱敏错误文本，不作为自动上报的技术摘要。
  runtimeMessage?: string;
  runtimeDetails?: string;
  diagnostics: IncidentDiagnostics;
};

export type PublicRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export type TerminationReason =
  | 'completed'
  | 'user_canceled'
  | 'timeout'
  | 'spawn_timeout'
  | 'inactivity_timeout'
  | 'spawn_failed'
  | 'codex_exit_non_zero'
  | 'stream_error'
  | 'daemon_restart'
  | 'process_kill_failed';

export type AgentEventType =
  | 'status'
  | 'schedule_trigger'
  | 'reasoning_summary'
  | 'assistant_message'
  | 'tool_use'
  | 'tool_result'
  | 'file_change'
  | 'usage'
  | 'diagnostic'
  | 'approval'
  | 'error'
  | 'unknown_event'
  | 'done';

export type AgentEventPayload =
  | {
      type: 'status';
      label: 'queued' | 'initializing' | 'running' | 'canceling' | 'finalizing';
      threadId?: string;
      codexThreadId?: string;
    }
  | { type: 'schedule_trigger'; prompt: string; triggeredAt: string }
  | { type: 'reasoning_summary'; text: string; format: 'plain_text'; delivery: 'summary' | 'delta' }
  | { type: 'assistant_message'; text: string; format: 'plain_text'; delivery: 'message' | 'delta' }
  | { type: 'tool_use'; toolCallId: string; name: string; input: { command?: string; args?: string[]; arguments?: unknown; raw?: unknown } }
  | { type: 'tool_result'; toolCallId: string; output: string; response?: unknown; exitCode?: number | null; isError: boolean; durationMs?: number }
  | {
      type: 'file_change';
      changes: Array<{ path: string; kind: 'add' | 'modify' | 'delete' | 'unknown' }>;
      status: 'in_progress' | 'completed' | 'failed' | 'unknown';
    }
  | {
      type: 'usage';
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      reasoningOutputTokens?: number;
      source: 'stream_cumulative' | 'rollout_best_effort';
    }
  | { type: 'diagnostic'; code: string; severity: 'info' | 'warning' | 'error'; message: string; details?: Record<string, unknown>; modelResponse?: ModelResponseError }
  | {
      type: 'approval';
      approval: {
        id: string;
        runId: string;
        threadId?: string | null;
        codexThreadId?: string | null;
        turnId: string;
        itemId: string;
        requestId: string;
        kind: 'command_execution' | 'file_change' | 'permissions';
        status: 'pending' | 'approved' | 'rejected' | 'expired' | 'canceled';
        risk: 'medium' | 'high';
        title: string;
        summary: string;
        details: Record<string, unknown>;
        requestedAt: string;
        expiresAt: string;
        resolvedAt?: string | null;
        resolutionReason?: string | null;
      };
    }
  | { type: 'error'; code: string; message: string; details?: Record<string, unknown>; modelResponse?: ModelResponseError }
  | { type: 'unknown_event'; rawEventId: string; codexType?: string }
  | { type: 'done'; status: 'succeeded' | 'failed' | 'canceled'; terminationReason: TerminationReason };

export type AgentEventEnvelope = {
  [Type in AgentEventType]: {
    id: string;
    runId: string;
    seq: number;
    ts: string;
    type: Type;
    payload: Extract<AgentEventPayload, { type: Type }>;
    normalizerVersion: number;
    rawEventId?: string;
    turnId?: string;
  };
}[AgentEventType];

export function isModelResponseEvent(event: AgentEventEnvelope): boolean {
  if (event.type === 'assistant_message' || event.type === 'reasoning_summary') {
    return event.payload.text.trim().length > 0;
  }
  return event.type === 'tool_use'
    && event.payload.toolCallId.trim().length > 0
    && event.payload.name.trim().length > 0;
}
