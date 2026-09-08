import type { ClaweeConversation } from '../projects/project-model.js';
import type { SidebarTaskSummary } from './sidebar-task-model.js';

export type SidebarRecentItem =
  | {
      key: string;
      kind: 'conversation';
      threadId: string;
      title: string;
      updatedAt?: string;
      updatedLabel: string;
      conversation: ClaweeConversation;
    }
  | {
      key: string;
      kind: 'task';
      threadId: string;
      title: string;
      updatedAt: string;
      updatedLabel: string;
      task: SidebarTaskSummary;
    };

export function createSidebarRecentItems(
  conversations: ClaweeConversation[],
  tasks: SidebarTaskSummary[],
  now = new Date()
): SidebarRecentItem[] {
  const itemsByThreadId = new Map<string, SidebarRecentItem>();

  for (const conversation of conversations) {
    upsertRecentItem(itemsByThreadId, {
      key: `conversation:${conversation.id}`,
      kind: 'conversation',
      threadId: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      updatedLabel: conversation.updatedLabel,
      conversation
    });
  }

  for (const task of tasks) {
    if (task.threadId === undefined) continue;
    upsertRecentItem(itemsByThreadId, {
      key: `task:${task.id}`,
      kind: 'task',
      threadId: task.threadId,
      title: task.name,
      updatedAt: task.updatedAt,
      updatedLabel: formatSidebarRecentTime(task.updatedAt, now),
      task
    });
  }

  return [...itemsByThreadId.values()].sort(compareRecentItems);
}

export function formatSidebarRecentTime(value: string, now = new Date()): string {
  const timestamp = parseTimestamp(value);
  if (!Number.isFinite(timestamp)) return '';
  const diffMs = Math.max(0, now.getTime() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return '刚刚';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}分钟`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}小时`;
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}天`;
  return `${Math.floor(diffMs / (7 * day))}周`;
}

function compareRecentItems(left: SidebarRecentItem, right: SidebarRecentItem): number {
  const leftPinnedAt = pinnedTimestampForSort(left);
  const rightPinnedAt = pinnedTimestampForSort(right);
  const leftPinned = Number.isFinite(leftPinnedAt);
  const rightPinned = Number.isFinite(rightPinnedAt);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  if (leftPinned && rightPinned && leftPinnedAt !== rightPinnedAt) {
    return rightPinnedAt - leftPinnedAt;
  }
  const leftTimestamp = timestampForSort(left.updatedAt);
  const rightTimestamp = timestampForSort(right.updatedAt);
  return leftTimestamp === rightTimestamp
    ? left.threadId.localeCompare(right.threadId)
    : rightTimestamp - leftTimestamp;
}

function upsertRecentItem(
  itemsByThreadId: Map<string, SidebarRecentItem>,
  candidate: SidebarRecentItem
): void {
  const current = itemsByThreadId.get(candidate.threadId);
  if (
    current === undefined
    || timestampForSort(candidate.updatedAt) > timestampForSort(current.updatedAt)
    || (
      timestampForSort(candidate.updatedAt) === timestampForSort(current.updatedAt)
      && candidate.kind === 'task'
      && current.kind === 'conversation'
    )
  ) {
    itemsByThreadId.set(candidate.threadId, candidate);
  }
}

function pinnedTimestampForSort(item: SidebarRecentItem): number {
  return item.kind === 'conversation'
    ? timestampForSort(item.conversation.pinnedAt)
    : Number.NEGATIVE_INFINITY;
}

function timestampForSort(value: string | null | undefined): number {
  if (value === undefined || value === null) return Number.NEGATIVE_INFINITY;
  const timestamp = parseTimestamp(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function parseTimestamp(value: string): number {
  const sqliteUtc = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/.exec(
    value
  );
  return Date.parse(
    sqliteUtc === null
      ? value
      : `${sqliteUtc[1]}T${sqliteUtc[2]}${sqliteUtc[3] ?? ''}Z`
  );
}
