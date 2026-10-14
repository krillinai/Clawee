import type { ThreadHistoryItem } from '@clawee/protocol';
import type { TimelineItem } from './timeline-model.js';

export function mapHistoryItemsToTimelineItems(items: ThreadHistoryItem[]): TimelineItem[] {
  let currentRunId: string | undefined;
  let currentRunHasDone = false;
  let currentRunHasPersistedId = false;
  const timelineItems: TimelineItem[] = [];

  function closeCurrentRun() {
    if (currentRunId === undefined || currentRunHasDone) return;
    timelineItems.push({
      id: `${currentRunId}_done`,
      runId: currentRunId,
      kind: 'done',
      status: 'succeeded',
      content: JSON.stringify({ type: 'done', status: 'succeeded' }),
      source: 'runtime'
    });
    currentRunHasDone = true;
  }

  for (const item of items) {
    if (item.type === 'user_message' || item.type === 'schedule_trigger') {
      closeCurrentRun();
      currentRunId = item.runId !== undefined
        ? item.runId
        : item.turnId === undefined
          ? `history_item_${item.id}`
          : `history_${item.turnId}`;
      currentRunHasDone = false;
      currentRunHasPersistedId = item.runId !== undefined;
      timelineItems.push(mapHistoryItemToTimelineItem(item, currentRunId));
      continue;
    }

    if (item.type === 'done') {
      timelineItems.push(mapHistoryItemToTimelineItem(item, currentRunId));
      currentRunHasDone = true;
      currentRunId = undefined;
      currentRunHasPersistedId = false;
      continue;
    }

    timelineItems.push(mapHistoryItemToTimelineItem(
      item,
      item.turnId === undefined || currentRunHasPersistedId ? currentRunId : undefined
    ));
  }

  closeCurrentRun();
  return timelineItems;
}

function mapHistoryItemToTimelineItem(item: ThreadHistoryItem, fallbackRunId?: string): TimelineItem {
  const runId = (
    item.type === 'user_message'
    || item.type === 'schedule_trigger'
  ) && item.runId !== undefined
    ? item.runId
    : fallbackRunId
      ?? (item.turnId === undefined ? undefined : `history_${item.turnId}`);
  const base = {
    id: item.id,
    timestamp: item.createdAt,
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
        status: item.status, source: 'runtime'
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
        kind: 'assistant_message',
        text: item.text,
        content: JSON.stringify(item),
        source: 'runtime'
      };
    case 'reasoning_summary':
      return {
        ...base,
        kind: 'reasoning_summary',
        text: item.text,
        content: JSON.stringify(item),
        source: 'runtime'
      };
    case 'tool_use':
      return {
        ...base,
        kind: 'tool_step',
        name: item.name,
        content: JSON.stringify({ type: 'tool_use', name: item.name, input: item.input }),
        source: 'runtime'
      };
    case 'tool_result':
      return {
        ...base,
        kind: 'tool_step',
        name: item.name,
        content: JSON.stringify({ type: 'tool_result', name: item.name, output: item.output, isError: item.isError }),
        source: 'runtime'
      };
    case 'file_change':
      return {
        ...base,
        kind: 'change_card',
        title: formatHistoryFileChangeTitle(item.changes),
        path: item.changes.find(change => change.path.length > 0)?.path ?? '文件变更',
        delta: `${item.changes.length} 项变更`,
        source: 'runtime'
      };
    case 'done':
      return {
        ...base,
        kind: 'done',
        status: item.status,
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
