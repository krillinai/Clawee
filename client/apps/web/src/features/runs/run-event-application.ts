import type { AgentEventEnvelope } from '@clawee/protocol';
import { eventToTimelineItem, type TimelineItem } from '../../components/timeline/timeline-model.js';
import { groupTimelineItemsByRun } from './timeline-order.js';

export function applyRunEventToTimeline(items: TimelineItem[], event: AgentEventEnvelope): TimelineItem[] {
  const item = eventToTimelineItem(event);
  return item === null ? items : applyTimelineItems(items, [item]);
}

export function applyTimelineItems(items: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  let next = items;
  for (const item of incoming) {
    const index = next.findIndex(existing => existing.id === item.id
      || ((item.kind === 'assistant_message' || item.kind === 'reasoning_summary') && existing.kind === item.kind && item.runId !== undefined
        && item.runId === existing.runId && item.rawEventId !== undefined && item.rawEventId === existing.rawEventId)
      || (item.kind === 'approval' && existing.kind === 'approval' && existing.approval.id === item.approval.id)
      || (item.kind === 'done' && existing.kind === 'done' && item.runId !== undefined && existing.runId === item.runId));
    const existing = next[index];
    if (existing !== undefined && item.eventSeq !== undefined && existing.eventSeq !== undefined
      && item.runId === existing.runId && item.eventSeq <= existing.eventSeq) continue;
    let updated = item;
    if (item.kind === 'assistant_message' || item.kind === 'reasoning_summary') {
      if (item.delivery === 'delta' && item.text.length === 0) continue;
      const previous = existing?.kind === item.kind ? existing : undefined;
      // 旧历史没有覆盖水位时，从重放的首个 delta 重建，避免重复拼接。
      const prefix = previous?.eventSeq === undefined ? '' : previous.text;
      updated = { ...previous, ...item, id: previous?.id ?? item.id,
        timestamp: previous?.timestamp ?? item.timestamp,
        historyIds: previous?.historyIds ?? item.historyIds,
        text: item.delivery === 'delta' ? prefix + item.text : item.text };
    }
    if (index < 0) next = [...next, updated];
    else next = next.map((value, i) => i === index ? { ...updated, id: value.id } : value);
    if (item.kind === 'done') {
      next = next.map(value => value.kind === 'assistant_message' && value.runId === item.runId
        && value.messageState === 'streaming' ? { ...value, messageState: 'interrupted' } : value);
    }
  }
  return groupTimelineItemsByRun(next);
}
