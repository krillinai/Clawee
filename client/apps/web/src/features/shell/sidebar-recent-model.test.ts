import { describe, expect, it } from 'vitest';
import type { ClaweeConversation } from '../projects/project-model.js';
import type { SidebarTaskSummary } from './sidebar-task-model.js';
import {
  createSidebarRecentItems,
  formatSidebarRecentTime
} from './sidebar-recent-model.js';

const NOW = new Date('2026-08-20T12:00:00.000Z');

describe('sidebar recent model', () => {
  it('keeps pinned conversations above newer ordinary conversations and tasks', () => {
    const conversations: ClaweeConversation[] = [
      conversation({
        id: 'pinned-old',
        title: '较早的置顶会话',
        updatedAt: '2026-07-01T10:00:00.000Z',
        pinnedAt: '2026-08-01T10:00:00.000Z'
      }),
      conversation({
        id: 'recent',
        title: '最近普通会话',
        updatedAt: '2026-08-20T10:00:00.000Z'
      })
    ];
    const tasks: SidebarTaskSummary[] = [
      task({
        id: 'latest-task',
        name: '最近任务会话',
        updatedAt: '2026-08-20T11:00:00.000Z'
      })
    ];

    expect(createSidebarRecentItems(conversations, tasks, NOW).map(item => item.title)).toEqual([
      '较早的置顶会话',
      '最近任务会话',
      '最近普通会话'
    ]);
  });

  it('orders pinned conversations by their latest pin time', () => {
    const items = createSidebarRecentItems([
      conversation({
        id: 'pinned-old',
        title: '先置顶',
        pinnedAt: '2026-08-19T10:00:00.000Z'
      }),
      conversation({
        id: 'pinned-new',
        title: '后置顶',
        pinnedAt: '2026-08-20T10:00:00.000Z'
      })
    ], [], NOW);

    expect(items.map(item => item.title)).toEqual(['后置顶', '先置顶']);
  });

  it('deduplicates thread ids and omits tasks without an openable thread', () => {
    const items = createSidebarRecentItems(
      [
        conversation({
          id: 'shared-thread',
          title: '旧会话标题',
          updatedAt: '2026-08-20T08:00:00.000Z'
        }),
        conversation({
          id: 'ordinary-thread',
          title: '普通会话',
          updatedAt: '2026-08-20T09:00:00.000Z'
        })
      ],
      [
        task({
          id: 'shared-task',
          threadId: 'shared-thread',
          name: '更新后的任务标题',
          updatedAt: '2026-08-20T11:00:00.000Z'
        }),
        task({
          id: 'missing-thread',
          threadId: undefined,
          name: '不可打开任务',
          updatedAt: '2026-08-20T11:30:00.000Z',
          status: 'repair_required'
        })
      ],
      NOW
    );

    expect(items.map(item => item.title)).toEqual([
      '更新后的任务标题',
      '普通会话'
    ]);
    expect(items.filter(item => item.threadId === 'shared-thread')).toHaveLength(1);
  });

  it('puts invalid timestamps last with deterministic ordering', () => {
    const items = createSidebarRecentItems(
      [
        conversation({ id: 'z-thread', title: 'Z', updatedAt: 'invalid' }),
        conversation({ id: 'a-thread', title: 'A', updatedAt: undefined }),
        conversation({
          id: 'valid-thread',
          title: '有效时间',
          updatedAt: '2026-08-20T10:00:00.000Z'
        })
      ],
      [],
      NOW
    );

    expect(items.map(item => item.threadId)).toEqual([
      'valid-thread',
      'a-thread',
      'z-thread'
    ]);
  });

  it('formats compact relative time labels', () => {
    expect(formatSidebarRecentTime('2026-08-20T11:59:30.000Z', NOW)).toBe('刚刚');
    expect(formatSidebarRecentTime('2026-08-20T11:30:00.000Z', NOW)).toBe('30分钟');
    expect(formatSidebarRecentTime('2026-08-20T09:00:00.000Z', NOW)).toBe('3小时');
    expect(formatSidebarRecentTime('2026-08-18T12:00:00.000Z', NOW)).toBe('2天');
  });
});

function conversation(overrides: Partial<ClaweeConversation> = {}): ClaweeConversation {
  return {
    id: 'conversation',
    projectId: 'project',
    title: '会话',
    updatedAt: '2026-08-20T10:00:00.000Z',
    updatedLabel: '2小时',
    ...overrides
  };
}

function task(overrides: Partial<SidebarTaskSummary> = {}): SidebarTaskSummary {
  return {
    id: 'task',
    threadId: 'task-thread',
    name: '任务',
    updatedAt: '2026-08-20T10:00:00.000Z',
    status: 'idle',
    unread: false,
    ...overrides
  };
}
