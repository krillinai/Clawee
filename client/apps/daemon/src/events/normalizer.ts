import type { AgentEventEnvelope, ModelResponseError } from '@clawee/protocol';
import { describeRuntimeResponseError } from '../codex/runtime-response-error.js';

export const normalizerVersion = 2;

export type NormalizeInput = {
  runId: string;
  seq: number;
  raw: unknown;
  modelResponse?: ModelResponseError;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstStringValue(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return undefined;
}

function normalizeFileChangeKind(value: unknown): 'add' | 'modify' | 'delete' | 'unknown' {
  if (value === 'add' || value === 'modify' || value === 'delete') return value;
  return 'unknown';
}

function normalizeFileChangeStatus(value: unknown): 'in_progress' | 'completed' | 'failed' | 'unknown' {
  if (value === 'in_progress' || value === 'completed' || value === 'failed') return value;
  return 'unknown';
}

function extractFileChanges(value: unknown): Array<{ path: string; kind: 'add' | 'modify' | 'delete' | 'unknown' }> {
  if (!Array.isArray(value)) return [];
  return value.map(change => {
    const record = isRecord(change) ? change : {};
    return {
      path: stringValue(record.path) ?? '',
      kind: normalizeFileChangeKind(record.kind)
    };
  });
}

function extractReasoningSummary(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map(part => extractReasoningSummary(part))
      .filter((part): part is string => part !== undefined && part.length > 0);
    return parts.length === 0 ? undefined : parts.join('\n\n');
  }

  if (!isRecord(value)) return undefined;

  const direct = firstStringValue(value, ['text', 'summary_text', 'content', 'message']);
  if (direct !== undefined) return direct;

  return extractReasoningSummary(value.summary ?? value.summaries ?? value.content ?? value.parts);
}

function fallbackEventId(input: NormalizeInput): string {
  return `${input.runId}:${input.seq}`;
}

function baseEnvelope(input: NormalizeInput) {
  return {
    id: `evt_${input.runId}_${input.seq}`,
    runId: input.runId,
    seq: input.seq,
    ts: new Date().toISOString(),
    normalizerVersion
  };
}

function codexType(raw: JsonRecord | undefined): string | undefined {
  return stringValue(raw?.type);
}

export function normalizeCodexEvent(input: NormalizeInput): AgentEventEnvelope {
  const raw = isRecord(input.raw) ? input.raw : undefined;
  const type = codexType(raw);
  const rawEventId = stringValue(raw?.id) ?? stringValue(raw?.thread_id) ?? fallbackEventId(input);
  const base = baseEnvelope(input);

  if (type === 'thread.started') {
    return {
      ...base,
      type: 'status',
      rawEventId,
      payload: {
        type: 'status',
        label: 'initializing'
      }
    };
  }

  if (type === 'turn.started') {
    return {
      ...base,
      type: 'status',
      rawEventId,
      payload: {
        type: 'status',
        label: 'running'
      }
    };
  }

  if (type === 'error') {
    const message = firstStringValue(raw ?? {}, ['message', 'error']) ?? 'Codex stream error';
    return {
      ...base,
      type: 'error',
      rawEventId,
      payload: {
        type: 'error',
        code: 'CODEX_STREAM_ERROR',
        message,
        details: {
          raw
        }
      }
    };
  }

  const item = isRecord(raw?.item) ? raw.item : undefined;
  const itemType = stringValue(item?.type);

  if (type === 'item.completed' && item !== undefined && itemType === 'error') {
    const message = firstStringValue(item, ['message', 'text', 'content']) ?? 'Codex item error';
    return {
      ...base,
      type: 'diagnostic',
      rawEventId,
      payload: {
        type: 'diagnostic',
        code: 'CODEX_ITEM_ERROR',
        severity: 'warning',
        message,
        details: {
          raw: item
        }
      }
    };
  }

  if (type === 'item.completed' && item !== undefined && isReasoningItemType(itemType)) {
    const text = extractReasoningSummary(item.summary ?? item.summaries ?? item.text ?? item.content ?? item.parts);
    if (text !== undefined) {
      return {
        ...base,
        type: 'reasoning_summary',
        rawEventId,
        payload: {
          type: 'reasoning_summary',
          text,
          format: 'plain_text',
          delivery: 'summary'
        }
      };
    }
  }

  if (type === 'item.completed' && item !== undefined && itemType === 'agent_message') {
    return {
      ...base,
      type: 'assistant_message',
      rawEventId,
      payload: {
        type: 'assistant_message',
        text: stringValue(item.text) ?? '',
        format: 'plain_text',
        delivery: 'message'
      }
    };
  }

  if (type === 'item.started' && item !== undefined && itemType === 'command_execution') {
    const toolCallId = stringValue(item.id) ?? fallbackEventId(input);
    const command = stringValue(item.command);

    return {
      ...base,
      type: 'tool_use',
      rawEventId,
      payload: {
        type: 'tool_use',
        toolCallId,
        name: 'command_execution',
        input: {
          ...(command === undefined ? {} : { command }),
          raw: item
        }
      }
    };
  }

  if (type === 'item.completed' && item !== undefined && itemType === 'command_execution') {
    const toolCallId = stringValue(item.id) ?? fallbackEventId(input);
    const exitCode = numberValue(item.exit_code) ?? null;

    return {
      ...base,
      type: 'tool_result',
      rawEventId,
      payload: {
        type: 'tool_result',
        toolCallId,
        output: stringValue(item.aggregated_output) ?? '',
        exitCode,
        isError: exitCode !== 0
      }
    };
  }

  if (type === 'item.completed' && item !== undefined && itemType === 'file_change') {
    return {
      ...base,
      type: 'file_change',
      rawEventId,
      payload: {
        type: 'file_change',
        changes: extractFileChanges(item.changes),
        status: normalizeFileChangeStatus(item.status)
      }
    };
  }

  if (type === 'turn.completed') {
    return {
      ...base,
      type: 'status',
      rawEventId,
      payload: {
        type: 'status',
        label: 'finalizing'
      }
    };
  }

  return {
    ...base,
    type: 'unknown_event',
    rawEventId,
    payload: {
      type: 'unknown_event',
      rawEventId: fallbackEventId(input),
      ...(type === undefined ? {} : { codexType: type })
    }
  };
}

export function normalizeAppServerEvent(input: NormalizeInput): AgentEventEnvelope {
  const raw = isRecord(input.raw) ? input.raw : undefined;
  const method = stringValue(raw?.method);
  const params = isRecord(raw?.params) ? raw.params : undefined;
  const item = isRecord(params?.item) ? params.item : undefined;
  const itemType = stringValue(item?.type);
  const rawEventId =
    stringValue(item?.id)
    ?? firstStringValue(params ?? {}, ['itemId', 'turnId', 'threadId'])
    ?? fallbackEventId(input);
  const turn = isRecord(params?.turn) ? params.turn : undefined;
  const turnId = firstStringValue(params ?? {}, ['turnId']) ?? firstStringValue(turn ?? {}, ['id']);
  const base = { ...baseEnvelope(input), ...(turnId === undefined ? {} : { turnId }) };

  if (method === 'item/agentMessage/delta' && firstStringValue(params ?? {}, ['itemId']) !== undefined
    && typeof params?.delta === 'string' && params.delta.length > 0) {
    return {
      ...base, type: 'assistant_message', rawEventId: params.itemId as string,
      payload: { type: 'assistant_message', text: params.delta, format: 'plain_text', delivery: 'delta' }
    };
  }

  const reasoningDelta = method === 'item/reasoning/summaryTextDelta' ? stringValue(params?.delta)
    : method === 'item/reasoning/summaryPartAdded' && (numberValue(params?.summaryIndex) ?? 0) > 0 ? '\n\n' : undefined;
  if (reasoningDelta !== undefined && reasoningDelta.length > 0
    && firstStringValue(params ?? {}, ['itemId']) !== undefined) {
    return {
      ...base, type: 'reasoning_summary', rawEventId: params!.itemId as string,
      payload: { type: 'reasoning_summary', text: reasoningDelta, format: 'plain_text', delivery: 'delta' }
    };
  }

  if (method === 'turn/started') {
    return {
      ...base,
      type: 'status',
      rawEventId,
      payload: { type: 'status', label: 'running' }
    };
  }

  if (method === 'turn/completed' && !(isRecord(params?.turn) && params.turn.status === 'failed')) {
    return {
      ...base,
      type: 'status',
      rawEventId,
      payload: { type: 'status', label: 'finalizing' }
    };
  }

  if (method === 'item/completed' && itemType === 'agentMessage') {
    return {
      ...base,
      type: 'assistant_message',
      rawEventId,
      payload: {
        type: 'assistant_message',
        text: stringValue(item?.text) ?? '',
        format: 'plain_text',
        delivery: 'message'
      }
    };
  }

  if (method === 'item/completed' && itemType === 'reasoning') {
    return {
      ...base,
      type: 'reasoning_summary',
      rawEventId,
      payload: {
        type: 'reasoning_summary',
        text: extractReasoningSummary(item?.summary) ?? '',
        format: 'plain_text',
        delivery: 'summary'
      }
    };
  }

  if (method === 'item/started' && itemType === 'commandExecution') {
    const toolCallId = stringValue(item?.id) ?? fallbackEventId(input);
    return {
      ...base,
      type: 'tool_use',
      rawEventId,
      payload: {
        type: 'tool_use',
        toolCallId,
        name: 'command_execution',
        input: {
          ...(stringValue(item?.command) === undefined ? {} : { command: stringValue(item?.command) }),
          raw: item
        }
      }
    };
  }

  if (method === 'item/completed' && itemType === 'commandExecution') {
    const toolCallId = stringValue(item?.id) ?? fallbackEventId(input);
    const exitCode = numberValue(item?.exitCode) ?? null;
    return {
      ...base,
      type: 'tool_result',
      rawEventId,
      payload: {
        type: 'tool_result',
        toolCallId,
        output: stringValue(item?.aggregatedOutput) ?? '',
        exitCode,
        isError: exitCode !== 0
      }
    };
  }

  if ((method === 'item/started' || method === 'item/completed') && itemType === 'mcpToolCall') {
    const toolCallId = stringValue(item?.id) ?? fallbackEventId(input);
    const server = stringValue(item?.server) ?? 'mcp';
    const tool = stringValue(item?.tool) ?? 'unknown';
    const status = stringValue(item?.status);
    if (method === 'item/started') {
      return {
        ...base,
        type: 'tool_use',
        rawEventId,
        payload: {
          type: 'tool_use',
          toolCallId,
          name: `${server}__${tool}`,
          input: { arguments: item?.arguments }
        }
      };
    }
    if (status === 'completed' || status === 'failed') {
      const result = isRecord(item?.result) ? item.result : undefined;
      const error = isRecord(item?.error) ? item.error : undefined;
      const failed = status === 'failed' || result?.isError === true;
      return {
        ...base,
        type: 'tool_result',
        rawEventId,
        payload: {
          type: 'tool_result',
          toolCallId,
          output: failed
            ? extractMcpErrorMessage(error, result)
            : extractMcpTextContent(result?.content),
          response: result?.structuredContent,
          isError: failed,
          durationMs: numberValue(item?.durationMs)
        }
      };
    }
  }

  if (method === 'item/mcpToolCall/progress') {
    return {
      ...base,
      type: 'diagnostic',
      rawEventId,
      payload: {
        type: 'diagnostic',
        code: 'MCP_TOOL_PROGRESS',
        severity: 'info',
        message: stringValue(params?.message) ?? 'MCP 工具正在执行',
        details: {
          itemId: stringValue(params?.itemId),
          threadId: stringValue(params?.threadId),
          turnId: stringValue(params?.turnId)
        }
      }
    };
  }

  if (
    method === 'item/completed'
    && itemType === 'fileChange'
  ) {
    return {
      ...base,
      type: 'file_change',
      rawEventId,
      payload: {
        type: 'file_change',
        changes: extractAppServerFileChanges(item?.changes),
        status: normalizeAppServerFileChangeStatus(item?.status)
      }
    };
  }

  if (method === 'thread/tokenUsage/updated') {
    const tokenUsage = isRecord(params?.tokenUsage) ? params.tokenUsage : undefined;
    const total = isRecord(tokenUsage?.total) ? tokenUsage.total : undefined;
    return {
      ...base,
      type: 'usage',
      rawEventId,
      payload: {
        type: 'usage',
        inputTokens: numberValue(total?.inputTokens),
        cachedInputTokens: numberValue(total?.cachedInputTokens),
        outputTokens: numberValue(total?.outputTokens),
        reasoningOutputTokens: numberValue(total?.reasoningOutputTokens),
        source: 'stream_cumulative'
      }
    };
  }

  if (method === 'warning' || method === 'configWarning' || method === 'guardianWarning') {
    return {
      ...base,
      type: 'diagnostic',
      rawEventId,
      payload: {
        type: 'diagnostic',
        code: 'CODEX_WARNING',
        severity: 'warning',
        message: firstStringValue(params ?? {}, ['message', 'summary']) ?? 'Codex warning',
        details: { raw: params }
      }
    };
  }

  if (method === 'error' || (method === 'turn/completed' && isRecord(params?.turn) && params.turn.status === 'failed')) {
    const modelResponse = input.modelResponse ?? describeRuntimeResponseError(method === 'error' ? params ?? {}
      : { error: isRecord(params?.turn) ? params.turn.error : undefined, willRetry: false });
    if (modelResponse.retrying) {
      return {
        ...base,
        type: 'diagnostic',
        rawEventId,
        payload: {
          type: 'diagnostic',
          code: 'CODEX_STREAM_RETRYING',
          severity: 'warning',
          message: `${modelResponse.reason}，正在重试${modelResponse.retryAttempt === undefined ? '' : `（${modelResponse.retryAttempt}/${modelResponse.retryLimit}）`}`,
          modelResponse
        }
      };
    }
    return {
      ...base,
      type: 'error',
      rawEventId,
      payload: {
        type: 'error',
        code: 'CODEX_STREAM_ERROR',
        message: modelResponse.reason,
        modelResponse
      }
    };
  }

  return {
    ...base,
    type: 'unknown_event',
    rawEventId,
    payload: {
      type: 'unknown_event',
      rawEventId,
      ...(method === undefined ? {} : { codexType: method })
    }
  };
}

function extractAppServerFileChanges(
  value: unknown
): Array<{ path: string; kind: 'add' | 'modify' | 'delete' | 'unknown' }> {
  if (!Array.isArray(value)) return [];
  return value.map(change => {
    const record = isRecord(change) ? change : {};
    const kind = stringValue(record.kind);
    return {
      path: firstStringValue(record, ['path', 'filePath']) ?? '',
      kind: kind === 'add' || kind === 'modify' || kind === 'delete' ? kind : 'unknown'
    };
  });
}

function normalizeAppServerFileChangeStatus(
  value: unknown
): 'in_progress' | 'completed' | 'failed' | 'unknown' {
  if (value === 'inProgress') return 'in_progress';
  if (value === 'completed') return 'completed';
  if (value === 'failed' || value === 'declined') return 'failed';
  return 'unknown';
}

function extractMcpErrorMessage(error: JsonRecord | undefined, result: JsonRecord | undefined): string {
  const message = firstStringValue(error ?? {}, ['message']);
  if (message !== undefined) return message;

  const structured = isRecord(result?.structuredContent) ? result.structuredContent : {};
  const structuredMessage = firstStringValue(structured, ['message']);
  if (structuredMessage !== undefined) {
    const code = firstStringValue(structured, ['code']);
    return code === undefined ? structuredMessage : `${structuredMessage}（${code}）`;
  }

  const text = extractMcpTextContent(result?.content);
  return text.trim().length > 0 ? text : '工具调用失败，未返回具体原因';
}

function extractMcpTextContent(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .flatMap(block => {
      if (!isRecord(block) || block.type !== 'text') return [];
      const text = stringValue(block.text);
      return text === undefined ? [] : [text];
    })
    .join('\n');
}

function isReasoningItemType(itemType: string | undefined): boolean {
  return itemType === 'reasoning'
    || itemType === 'reasoning_summary'
    || itemType === 'agent_reasoning'
    || itemType === 'thinking';
}
