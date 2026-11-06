import type { TimelineItem } from '../../components/timeline/timeline-model.js';

export function groupTimelineItemsByRun(items: TimelineItem[]): TimelineItem[] {
  const groups: TimelineItem[][] = [];
  const groupsByRunId = new Map<string, TimelineItem[]>();
  for (const item of items) {
    // 用每轮首次出现的位置作锚点，晚到的收尾输出仍回到原轮次。
    // 尚无 runId 的新输入单独成段，其余无归属项保留在原段内。
    const group = item.runId === undefined
      ? item.kind === 'user_message' ? undefined : groups.at(-1)
      : groupsByRunId.get(item.runId);
    if (group !== undefined) {
      group.push(item);
    } else {
      const nextGroup = [item];
      groups.push(nextGroup);
      if (item.runId !== undefined) groupsByRunId.set(item.runId, nextGroup);
    }
  }
  const grouped = groups.flat();
  return grouped.every((item, index) => item === items[index]) ? items : grouped;
}
