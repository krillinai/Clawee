import type { ThreadHistoryItem } from '@clawee/protocol';
import { extractPublicConversationInput } from '../../threads/conversation-title.js';

export type CodexTurn = {
  id: string;
  items: CodexThreadItem[];
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  startedAt: number | null;
  completedAt: number | null;
};

export type CodexTurnsListResponse = {
  data: CodexTurn[];
  nextCursor: string | null;
};

type CodexThreadItem = Record<string, unknown> & {
  type: string;
  id?: string;
};

export function mapCodexTurnsPage(
  response: CodexTurnsListResponse
): {
  items: ThreadHistoryItem[];
  hasMore: boolean;
  nextCursor?: string;
  oldestItemAt?: string;
} {
  const items = [...response.data]
    .reverse()
    .flatMap(mapTurn);
  return {
    items,
    hasMore: response.nextCursor !== null,
    ...(response.nextCursor === null
      ? {}
      : { nextCursor: response.nextCursor }),
    ...(items[0] === undefined
      ? {}
      : { oldestItemAt: items[0].createdAt })
  };
}

export function unixSecondsToIso(value: number): string {
  if (!Number.isFinite(value)) return new Date(0).toISOString();
  return new Date(value * 1_000).toISOString();
}

function mapTurn(turn: CodexTurn): ThreadHistoryItem[] {
  const startedAt = unixSecondsToIso(
    turn.startedAt ?? turn.completedAt ?? 0
  );
  const completedAt = unixSecondsToIso(
    turn.completedAt ?? turn.startedAt ?? 0
  );
  const items = turn.items.flatMap(item => mapTurnItem(
    item,
    turn.id,
    startedAt,
    completedAt
  ));

  if (turn.status !== 'inProgress') {
    items.push({
      id: `history_done_${turn.id}`,
      type: 'done',
      status:
        turn.status === 'completed'
          ? 'succeeded'
          : turn.status === 'interrupted'
            ? 'canceled'
            : 'failed',
      createdAt: completedAt,
      turnId: turn.id
    });
  }
  return items;
}

function mapTurnItem(
  item: CodexThreadItem,
  turnId: string,
  startedAt: string,
  completedAt: string
): ThreadHistoryItem[] {
  if (isUserMessageItem(item)) {
    const rawText = item.content
      .flatMap(content => (
        isRecord(content)
        && content.type === 'text'
        && typeof content.text === 'string'
          ? [content.text]
          : []
      ))
      .join('\n')
      .trim();
    const text = extractPublicConversationInput(rawText);
    if (text === undefined) return [];
    const scheduleTrigger = parseScheduleExecutionPrompt(text);
    return [scheduleTrigger === undefined
      ? {
          id: item.id,
          type: 'user_message',
          text,
          createdAt: startedAt,
          turnId
        }
      : {
          id: item.id,
          type: 'schedule_trigger',
          prompt: scheduleTrigger.prompt,
          triggeredAt: scheduleTrigger.triggeredAt,
          createdAt: startedAt,
          turnId
        }];
  }

  if (isAgentMessageItem(item) && item.text.trim().length > 0) {
    return [{
      id: item.id,
      type: 'assistant_message',
      text: item.text,
      createdAt: completedAt,
      turnId
    }];
  }

  if (isReasoningItem(item)) {
    const text = item.summary
      .filter(part => typeof part === 'string' && part.trim().length > 0)
      .join('\n');
    return text.length === 0
      ? []
      : [{
          id: item.id,
          type: 'reasoning_summary',
          text,
          createdAt: completedAt,
          turnId
        }];
  }

  if (isCommandExecutionItem(item)) {
    const mapped: ThreadHistoryItem[] = [{
      id: `${item.id}:use`,
      type: 'tool_use',
      name: 'command_execution',
      input: {
        command: item.command,
        cwd: item.cwd
      },
      createdAt: startedAt,
      turnId
    }];
    if (item.status !== 'inProgress') {
      mapped.push({
        id: `${item.id}:result`,
        type: 'tool_result',
        name: 'command_execution',
        output: typeof item.aggregatedOutput === 'string'
          ? item.aggregatedOutput
          : '',
        isError:
          item.status !== 'completed'
          || item.exitCode !== 0,
        createdAt: completedAt,
        turnId
      });
    }
    return mapped;
  }

  if (isFileChangeItem(item)) {
    return [{
      id: item.id,
      type: 'file_change',
      changes: item.changes.map(change => ({
        path: typeof change.path === 'string' ? change.path : '',
        kind: fileChangeKind(change.kind)
      })),
      status: fileChangeStatus(item.status),
      createdAt: completedAt,
      turnId
    }];
  }

  return [];
}

function isUserMessageItem(
  item: CodexThreadItem
): item is CodexThreadItem & { id: string; content: unknown[] } {
  return item.type === 'userMessage'
    && typeof item.id === 'string'
    && Array.isArray(item.content);
}

function isAgentMessageItem(
  item: CodexThreadItem
): item is CodexThreadItem & { id: string; text: string } {
  return item.type === 'agentMessage'
    && typeof item.id === 'string'
    && typeof item.text === 'string';
}

function isReasoningItem(
  item: CodexThreadItem
): item is CodexThreadItem & { id: string; summary: unknown[] } {
  return item.type === 'reasoning'
    && typeof item.id === 'string'
    && Array.isArray(item.summary);
}

function isCommandExecutionItem(
  item: CodexThreadItem
): item is CodexThreadItem & {
  id: string;
  command: string;
  cwd: string;
  status: string;
  aggregatedOutput?: unknown;
  exitCode?: unknown;
} {
  return item.type === 'commandExecution'
    && typeof item.id === 'string'
    && typeof item.command === 'string'
    && typeof item.cwd === 'string'
    && typeof item.status === 'string';
}

function isFileChangeItem(
  item: CodexThreadItem
): item is CodexThreadItem & {
  id: string;
  changes: Array<Record<string, unknown>>;
  status: unknown;
} {
  return item.type === 'fileChange'
    && typeof item.id === 'string'
    && Array.isArray(item.changes)
    && item.changes.every(isRecord);
}

function fileChangeKind(
  value: unknown
): 'add' | 'modify' | 'delete' | 'unknown' {
  const type = isRecord(value) ? value.type : value;
  if (type === 'add') return 'add';
  if (type === 'update' || type === 'modify') return 'modify';
  if (type === 'delete' || type === 'remove') return 'delete';
  return 'unknown';
}

function fileChangeStatus(
  value: unknown
): 'in_progress' | 'completed' | 'failed' | 'unknown' {
  if (value === 'inProgress') return 'in_progress';
  if (value === 'completed') return 'completed';
  if (value === 'failed' || value === 'declined') return 'failed';
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}

const SCHEDULE_EXECUTION_PREFIX =
  '这是 Clawee 已经触发的一次计划任务执行。';
const SCHEDULE_TRIGGER_MARKER = '\n本次触发时间：';
const SCHEDULE_CONTENT_MARKER = '\n任务内容：\n';

function parseScheduleExecutionPrompt(
  text: string
): { prompt: string; triggeredAt: string } | undefined {
  const normalized = text.trimEnd();
  if (
    !normalized.startsWith(
      `${SCHEDULE_EXECUTION_PREFIX}\n\n执行规则：\n`
    )
  ) {
    return undefined;
  }

  const contentIndex = normalized.lastIndexOf(SCHEDULE_CONTENT_MARKER);
  if (contentIndex < 0) return undefined;
  const metadata = normalized.slice(0, contentIndex);
  const triggerIndex = metadata.lastIndexOf(SCHEDULE_TRIGGER_MARKER);
  if (triggerIndex < 0) return undefined;

  const triggeredAt = metadata
    .slice(triggerIndex + SCHEDULE_TRIGGER_MARKER.length)
    .trim();
  const prompt = normalized
    .slice(contentIndex + SCHEDULE_CONTENT_MARKER.length)
    .trimEnd();
  if (triggeredAt.length === 0 || prompt.trim().length === 0) {
    return undefined;
  }
  return { prompt, triggeredAt };
}
