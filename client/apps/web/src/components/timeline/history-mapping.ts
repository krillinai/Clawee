import type { ThreadHistoryItem } from '@clawee/protocol';
import type { TimelineItem } from './timeline-model.js';

export function mapHistoryItemsToTimelineItems(items: ThreadHistoryItem[]): TimelineItem[] {
  let currentRunId: string | undefined;
  let currentTurnId: string | undefined;
  const runsByTurn = new Map(items.flatMap(item => item.turnId !== undefined && item.runId !== undefined
    ? [[item.turnId, item.runId] as const] : []));
  const timelineItems: TimelineItem[] = [];

  for (const item of items) {
    if (item.type === 'user_message' || item.type === 'schedule_trigger') {
      currentRunId = item.runId !== undefined
        ? item.runId
        : item.turnId === undefined
          ? `history_item_${item.id}`
          : `history_${item.turnId}`;
      currentTurnId = item.turnId;
      timelineItems.push(mapHistoryItemToTimelineItem(item, runsByTurn.get(item.turnId ?? '') ?? currentRunId));
      continue;
    }

    if (item.type === 'done') {
      timelineItems.push(mapHistoryItemToTimelineItem(item, item.turnId === undefined ? currentRunId : runsByTurn.get(item.turnId)));
      currentRunId = undefined;
      currentTurnId = undefined;
      continue;
    }

    timelineItems.push(mapHistoryItemToTimelineItem(
      item,
      item.turnId === undefined || item.turnId === currentTurnId ? currentRunId : runsByTurn.get(item.turnId)
    ));
  }

  return timelineItems;
}

function mapHistoryItemToTimelineItem(item: ThreadHistoryItem, fallbackRunId?: string): TimelineItem {
  const runId = item.runId ?? fallbackRunId
      ?? (item.turnId === undefined ? undefined : `history_${item.turnId}`);
  const base = {
    id: item.id,
    timestamp: item.createdAt,
    turnId: item.turnId,
    rawEventId: item.rawEventId ?? (item.eventId === undefined && ['assistant_message', 'reasoning_summary', 'tool_use', 'tool_result', 'file_change'].includes(item.type) ? item.id.replace(/:(use|result)$/, '') : undefined),
    eventId: item.eventId,
    eventSeq: item.eventSeq,
    historyIds: [item.id],
    ...(item.type === 'done' ? { terminalSource: item.terminalSource } : {}),
    historyOnly: item.runId === undefined && (runId === undefined || runId.startsWith('history_')),
    ...(runId === undefined ? {} : { runId })
  };

  switch (item.type) {
    case 'workflow_start':
      return {
        ...base, kind: 'workflow_start', runId: item.runId, taskId: item.taskId,
        instanceId: item.instanceId, workflowName: item.workflowName,
        nodeTitle: item.nodeTitle, nodeOrder: item.nodeOrder,
        instruction: item.instruction, input: item.input,
        customInput: item.customInput, source: 'runtime'
      };
    case 'workflow_status':
      return {
        ...base, kind: 'workflow_status', runId: item.runId, taskId: item.taskId,
        status: item.status, completion: item.completion, source: 'runtime'
      };
    case 'user_message':
      return {
        ...base,
        kind: 'user_message',
        text: item.text,
        ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
        source: 'runtime'
      };
    case 'schedule_trigger':
      return {
        ...base,
        kind: 'schedule_trigger',
        runId: item.runId ?? runId ?? `history_item_${item.id}`,
        prompt: item.prompt,
        triggeredAt: item.triggeredAt,
        source: 'runtime'
      };
    case 'assistant_message':
      return {
        ...base,
        id: runId === undefined ? item.id : item.eventId !== undefined && base.rawEventId === undefined ? item.eventId : `${runId}:${base.rawEventId ?? item.id}`,
        kind: 'assistant_message',
        text: item.text,
        messageState: item.messageState ?? 'complete',
        content: JSON.stringify(item),
        source: 'runtime'
      };
    case 'reasoning_summary':
      return {
        ...base,
        id: runId === undefined ? item.id : item.eventId !== undefined && base.rawEventId === undefined ? item.eventId : `${runId}:${base.rawEventId ?? item.id}`,
        kind: 'reasoning_summary',
        text: item.text,
        content: JSON.stringify(item),
        source: 'runtime'
      };
    case 'tool_use':
      return {
        ...base,
        id: runId === undefined ? item.id : item.eventId !== undefined && base.rawEventId === undefined ? item.eventId : `${runId}:${base.rawEventId}:use`,
        kind: 'tool_step',
        name: item.name,
        content: JSON.stringify({ type: 'tool_use', toolCallId: base.rawEventId, name: item.name, input: item.input }),
        source: 'runtime'
      };
    case 'tool_result':
      return {
        ...base,
        id: runId === undefined ? item.id : item.eventId !== undefined && base.rawEventId === undefined ? item.eventId : `${runId}:${base.rawEventId}:result`,
        kind: 'tool_step',
        name: item.name,
        content: JSON.stringify({ type: 'tool_result', toolCallId: base.rawEventId, name: item.name, output: item.output, isError: item.isError }),
        source: 'runtime'
      };
    case 'file_change':
      return {
        ...base,
        id: runId === undefined ? item.id : item.eventId !== undefined && base.rawEventId === undefined ? item.eventId : `${runId}:${base.rawEventId ?? item.id}`,
        kind: 'change_card',
        title: formatHistoryFileChangeTitle(item.changes),
        path: item.changes.find(change => change.path.length > 0)?.path ?? '文件变更',
        delta: `${item.changes.length} 项变更`,
        source: 'runtime'
      };
    case 'done':
      if (item.terminalSource !== 'daemon' && (item.terminalSource !== 'runtime_turn' || !base.historyOnly)) {
        return { ...base, kind: 'run_status', label: item.terminalSource === 'runtime_turn' ? 'finalizing' : 'status_pending', source: 'runtime' };
      }
      return {
        ...base,
        kind: 'done',
        runId: item.runId ?? runId,
        status: item.status,
        ...(item.terminationReason ? { terminationReason: item.terminationReason } : {}),
        content: JSON.stringify(item),
        source: 'runtime'
      };
    case 'diagnostic':
      return {
        ...base,
        kind: 'diagnostic',
        runId: item.runId,
        severity: item.severity,
        message: item.message,
        modelResponse: item.modelResponse,
        content: JSON.stringify(item),
        source: 'runtime'
      };
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

function formatHistoryFileChangeTitle(
  changes: Array<{ kind: 'add' | 'modify' | 'delete' | 'unknown' }>
): string {
  if (changes.length === 0) return '文件变更';

  const counts = new Map<'add' | 'modify' | 'delete' | 'unknown', number>();
  for (const change of changes) counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);

  return (['add', 'modify', 'delete', 'unknown'] as const)
    .map(kind => {
      const count = counts.get(kind) ?? 0;
      if (count === 0) return undefined;
      if (kind === 'add') return `新增 ${count} 个文件`;
      if (kind === 'modify') return `修改 ${count} 个文件`;
      if (kind === 'delete') return `删除 ${count} 个文件`;
      return `变更 ${count} 个文件`;
    })
    .filter((part): part is string => part !== undefined)
    .join('，');
}
