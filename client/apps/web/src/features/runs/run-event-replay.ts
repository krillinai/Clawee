import type { TimelineItem } from '../../components/timeline/timeline-model.js';
import { groupTimelineItemsByRun } from './timeline-order.js';

export type RunReplayDeduper = { shouldAppend(item: TimelineItem): boolean };
export type HistoryMergeMode = 'latest' | 'older' | 'search';

export function createRunReplayDeduper(timelineItems: TimelineItem[], runId?: string): RunReplayDeduper {
  const existingIds = new Set(timelineItems.map(identity));
  const remaining = new Map<string, number>();
  for (const item of timelineItems) {
    if (runId === undefined || item.runId !== runId || item.rawEventId !== undefined) continue;
    const key = timelineReplayMergeKey(item);
    if (key !== undefined) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return {
    shouldAppend(item) {
      if (item.kind === 'done') return true;
      const key = timelineReplayMergeKey(item);
      const count = key === undefined ? 0 : remaining.get(key) ?? 0;
      const known = existingIds.has(identity(item));
      if (count > 0 && key !== undefined) remaining.set(key, count - 1);
      if (known || count > 0) return false;
      existingIds.add(identity(item));
      return true;
    }
  };
}

function identity(item: TimelineItem): string {
  if (item.kind === 'approval') return `approval:${item.approval.id}`;
  if ((item.kind === 'user_message' || item.kind === 'schedule_trigger' || item.kind === 'done') && item.runId !== undefined) {
    return `${item.kind}:${item.runId}`;
  }
  return `${item.runId ?? item.turnId ?? ''}:${item.kind}:${item.rawEventId ?? item.id}${toolPhase(item)}`;
}

export function mergeTimelineHistoryWithCache(
  historyItems: TimelineItem[], cachedItems: TimelineItem[], mode: HistoryMergeMode = 'latest'
): TimelineItem[] {
  const runsByTurn = new Map([...cachedItems, ...historyItems].flatMap(item =>
    item.turnId !== undefined && item.runId !== undefined && !item.historyOnly ? [[item.turnId, item.runId] as const] : []));
  const normalize = (item: TimelineItem, preserveId = false): TimelineItem => {
    const runId = item.turnId === undefined ? undefined : runsByTurn.get(item.turnId);
    if (runId === undefined || item.runId === runId) return item;
    if (item.kind === 'done' && item.terminalSource === 'runtime_turn') {
      return { ...item, kind: 'run_status', label: 'finalizing', runId, historyOnly: false };
    }
    return {
      ...item, runId, historyOnly: false,
      id: preserveId || item.rawEventId === undefined ? item.id : `${runId}:${item.rawEventId}${toolPhase(item)}`
    };
  };
  const history = historyItems.map(item => normalize(item));
  const merged = cachedItems.map(item => normalize(item, true));
  const identities = new WeakMap<TimelineItem, string>();
  const replayKeys = new WeakMap<TimelineItem, string | undefined>();
  const identityOf = (item: TimelineItem): string => {
    let key = identities.get(item);
    if (key === undefined) {
      key = identity(item);
      identities.set(item, key);
    }
    return key;
  };
  const replayKeyOf = (item: TimelineItem): string | undefined => {
    if (replayKeys.has(item)) return replayKeys.get(item);
    const key = timelineReplayMergeKey(item);
    replayKeys.set(item, key);
    return key;
  };
  const matchingIndices = new Map<string, number>();
  const refreshMatchingIndices = () => {
    matchingIndices.clear();
    merged.forEach((item, index) => {
      const key = identityOf(item);
      if (!matchingIndices.has(key)) matchingIndices.set(key, index);
    });
  };
  refreshMatchingIndices();
  let previousId: string | undefined;
  const usedIds = new Set<string>();
  for (let offset = 0; offset < history.length; offset += 1) {
    const item = history[offset]!;
    const itemIdentity = identityOf(item);
    let index = matchingIndices.get(itemIdentity) ?? -1;
    if (index < 0 && item.runId !== undefined && item.rawEventId === undefined) {
      const key = replayKeyOf(item);
      index = merged.findIndex(existing => !usedIds.has(existing.id) && existing.rawEventId === undefined
        && key !== undefined && replayKeyOf(existing) === key);
    }
    if (index >= 0) {
      const cached = merged[index]!;
      const stale = cached.eventSeq !== undefined && (item.eventSeq === undefined
        ? cached.kind === 'assistant_message' && cached.messageState === 'streaming'
        : cached.eventSeq > item.eventSeq);
      let updated: TimelineItem = { ...cached, ...item, id: cached.id,
        historyIds: [...new Set([...(cached.historyIds ?? []), ...(item.historyIds ?? []), item.id])] };
      if (stale) updated = { ...updated, ...cached, historyIds: updated.historyIds };
      if (cached.kind === 'user_message' && updated.kind === 'user_message' && item.kind === 'user_message') {
        updated = { ...updated, attachments: item.attachments ?? cached.attachments,
          attachmentPreviewUrls: { ...cached.attachmentPreviewUrls, ...item.attachmentPreviewUrls },
          runStatus: cached.runStatus ?? item.runStatus };
      }
      merged[index] = updated;
      refreshMatchingIndices();
    } else {
      let nextAnchor: number | undefined;
      for (let next = offset + 1; next < history.length; next += 1) {
        nextAnchor = matchingIndices.get(identityOf(history[next]!));
        if (nextAnchor !== undefined) break;
      }
      const previousIndex = previousId === undefined ? -1 : merged.findIndex(existing => existing.id === previousId);
      const sameRunStart = item.runId === undefined ? -1 : merged.findIndex(existing => existing.runId === item.runId);
      if ((item.kind === 'user_message' || item.kind === 'schedule_trigger') && sameRunStart >= 0) index = sameRunStart;
      else if (nextAnchor !== undefined) index = nextAnchor;
      else if (previousIndex >= 0) index = previousIndex + 1;
      else {
        const time = timestamp(item);
        const scopes = new Set<string>();
        index = Number.isFinite(time) ? merged.findIndex(existing => {
          const scope = existing.runId ?? existing.turnId;
          if (scope !== undefined && scopes.has(scope)) return false;
          if (scope !== undefined) scopes.add(scope);
          return timestamp(existing) > time;
        }) : -1;
        if (index < 0) index = mode === 'older' ? 0 : merged.length;
      }
      merged.splice(index, 0, item);
      refreshMatchingIndices();
    }
    previousId = merged[index]!.id;
    usedIds.add(previousId);
  }
  return groupTimelineItemsByRun(merged);
}

function timestamp(item: TimelineItem): number {
  return Date.parse('timestamp' in item ? item.timestamp ?? '' : item.kind === 'schedule_trigger' ? item.triggeredAt : '');
}

function toolPhase(item: TimelineItem): string {
  if (item.kind !== 'tool_step') return '';
  try { return JSON.parse(item.content).type === 'tool_result' ? ':result' : ':use'; } catch { return ''; }
}

export function timelineReplayMergeKey(item: TimelineItem): string | undefined {
  const scope = item.runId ?? item.turnId;
  if (scope === undefined) return undefined;
  let key: string;
  switch (item.kind) {
    case 'user_message': key = `user:${item.text}`; break;
    case 'schedule_trigger': key = `schedule:${item.prompt}:${item.triggeredAt}`; break;
    case 'assistant_message': key = `assistant:${item.text}`; break;
    case 'reasoning_summary': key = `reasoning:${item.text}`; break;
    case 'tool_step': {
      try {
        const payload = JSON.parse(item.content);
        key = payload.type === 'tool_use' ? `use:${payload.name ?? item.name}:${JSON.stringify(payload.input)}`
          : `result:${JSON.stringify(payload.output)}:${payload.isError ?? false}`;
      } catch { key = `tool:${item.name}:${item.content}`; }
      break;
    }
    case 'change_card': key = `change:${item.title}:${item.path}:${item.delta}`; break;
    case 'done': return undefined;
    case 'approval': return `approval:${item.approval.id}`;
    default: return undefined;
  }
  return `${scope}:${key}`;
}
