import type { AgentEventEnvelope } from '@clawee/protocol';
import { describe, expect, it } from 'vitest';
import {
  ENTERPRISE_ACTIVITY_MAX_EVENT_BYTES,
  projectActivityEvent,
  projectRunStarted
} from '../../src/enterprise/activity-event-projector-2026-08-28.js';
import { normalizeAppServerEvent } from '../../src/events/normalizer.js';

describe('enterprise activity event projector', () => {
  it('projects run content with a stable id, basename and redaction', () => {
    const event = projectRunStarted({
      runId: 'run_1',
      threadId: 'thread_1',
      prompt: 'use Authorization: Bearer secret-token and sk-standalone-secret-value',
      createdBy: 'api',
      workspaceName: 'claw-mcp',
      createdAt: '2026-08-28T10:00:00.000Z'
    });

    expect(event).toMatchObject({
      event_id: 'evt_run_1_created',
      session_id: 'thread_1',
      turn_id: 'run_1',
      sequence: 0,
      payload: { workspace_name: 'claw-mcp' }
    });
    expect(JSON.stringify(event)).not.toContain('secret-token');
    expect(JSON.stringify(event)).not.toContain('sk-standalone-secret-value');
  });

  it('drops raw tool data and recursively redacts secret fields', () => {
    const event = projectActivityEvent(envelope({
      type: 'tool_use',
      toolCallId: 'tool_1',
      name: 'crm__lookup',
      input: {
        arguments: {
          customer: 'A',
          apiKey: 'secret',
          nested: { cookie: 'session=1', accessToken: 'access-secret', refreshToken: 'refresh-secret' }
        },
        raw: { token: 'raw-secret' }
      }
    }), { sessionId: 'thread_1', turnId: 'run_1' });

    const encoded = JSON.stringify(event);
    expect(encoded).not.toContain('raw-secret');
    expect(encoded).not.toContain('session=1');
    expect(encoded).not.toContain('access-secret');
    expect(encoded).not.toContain('refresh-secret');
    expect(encoded).not.toContain('"raw"');
    expect(encoded).toContain('[REDACTED]');
  });

  it('ignores non-v1 events and limits one encoded event', () => {
    const usage = projectActivityEvent(envelope({
      type: 'usage',
      inputTokens: 1,
      source: 'stream_cumulative'
    }), { sessionId: 'thread_1', turnId: 'run_1' });
    expect(usage).toBeUndefined();

    const large = projectActivityEvent(envelope({
      type: 'assistant_message',
      text: '中'.repeat(100_000),
      format: 'plain_text',
      delivery: 'message'
    }), { sessionId: 'thread_1', turnId: 'run_1' });
    expect(Buffer.byteLength(JSON.stringify(large), 'utf8')).toBeLessThanOrEqual(
      ENTERPRISE_ACTIVITY_MAX_EVENT_BYTES
    );
    expect(large?.payload.truncated).toBe(true);
  });

  it('normalizes MCP text and structured result without binary blocks', () => {
    const started = normalizeAppServerEvent({
      runId: 'run_1',
      seq: 1,
      raw: {
        method: 'item/started',
        params: { item: { type: 'mcpToolCall', id: 'mcp_1', server: 'crm', tool: 'lookup', arguments: { id: 1 } } }
      }
    });
    expect(started).toMatchObject({
      type: 'tool_use',
      payload: { name: 'crm__lookup', input: { arguments: { id: 1 } } }
    });

    const completed = normalizeAppServerEvent({
      runId: 'run_1',
      seq: 2,
      raw: {
        method: 'item/completed',
        params: {
          item: {
            type: 'mcpToolCall', id: 'mcp_1', status: 'completed', durationMs: 12,
            result: {
              structuredContent: { count: 1 },
              content: [{ type: 'text', text: 'done' }, { type: 'image', data: 'binary' }]
            }
          }
        }
      }
    });
    expect(completed).toMatchObject({
      type: 'tool_result',
      payload: { output: 'done', response: { count: 1 }, isError: false, durationMs: 12 }
    });
    expect(JSON.stringify(completed)).not.toContain('binary');

    for (const [seq, status] of [[3, 'unknown'], [4, 'inProgress']] as const) {
      const unknown = normalizeAppServerEvent({
        runId: 'run_1',
        seq,
        raw: {
          method: 'item/completed',
          params: { item: { type: 'mcpToolCall', id: 'mcp_1', status } }
        }
      });
      expect(unknown.type).toBe('unknown_event');
      expect(projectActivityEvent(unknown, { sessionId: 'thread_1', turnId: 'run_1' }))
        .toBeUndefined();
    }
  });

  it('keeps required fields when a structured result exceeds the event limit', () => {
    const event = projectActivityEvent(envelope({
      type: 'tool_result',
      toolCallId: 'mcp_oversized',
      output: 'done',
      response: { values: Array.from({ length: 70_000 }, (_, index) => index) },
      isError: false
    }), { sessionId: 'thread_1', turnId: 'run_1' });

    expect(Buffer.byteLength(JSON.stringify(event), 'utf8')).toBeLessThanOrEqual(
      ENTERPRISE_ACTIVITY_MAX_EVENT_BYTES
    );
    expect(event?.payload).toMatchObject({
      toolCallId: 'mcp_oversized',
      isError: false,
      truncated: true
    });
  });
});

function envelope(payload: AgentEventEnvelope['payload']): AgentEventEnvelope {
  return {
    id: 'evt_run_1_1',
    runId: 'run_1',
    seq: 1,
    ts: '2026-08-28T10:00:00.000Z',
    type: payload.type,
    payload,
    normalizerVersion: 1
  } as AgentEventEnvelope;
}
