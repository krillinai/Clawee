import type { ThreadHistoryResponse } from '@clawee/protocol';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useThreadHistory } from './use-thread-history.js';

describe('useThreadHistory', () => {
  it('最新页无重叠时保留旧窗口，先填补缺口再恢复旧前缀游标', async () => {
    let refreshed = false;
    const getThreadHistory = vi.fn(async (threadId: string, query?: { before?: string }): Promise<ThreadHistoryResponse> => {
      const pages: Record<string, { ids: string[]; cursor: string }> = {
        initial: { ids: ['old-latest'], cursor: 'before-old-latest' },
        'before-old-latest': { ids: ['old-prefix', 'old-latest'], cursor: 'before-old-prefix' },
        latest: { ids: ['new-latest'], cursor: 'before-new-latest' },
        'before-new-latest': { ids: ['gap-new'], cursor: 'before-gap-new' },
        'before-gap-new': { ids: ['old-latest', 'gap-old'], cursor: 'before-old-latest' },
        'before-old-prefix': { ids: ['oldest'], cursor: 'before-oldest' }
      };
      const page = pages[query?.before ?? (refreshed ? 'latest' : 'initial')]!;
      return { threadId, items: page.ids.map(id => historyMessage(id, id)), hasMore: true, nextCursor: page.cursor };
    });
    const { result, rerender } = renderHook(({ reloadKey }) => useThreadHistory({
      threadId: 'gap-thread', enabled: true, service: { getThreadHistory }, reloadKey
    }), { initialProps: { reloadKey: 0 } });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(() => result.current.loadOlder());
    expect(result.current.nextCursor).toBe('before-old-prefix');
    refreshed = true;
    rerender({ reloadKey: 1 });
    await waitFor(() => expect(result.current.initialLoading).toBe(false));
    expect(result.current.items.map(item => item.id)).toEqual(['old-prefix', 'old-latest', 'new-latest']);
    expect(result.current.nextCursor).toBe('before-new-latest');
    await act(() => result.current.loadOlder());
    expect(result.current.items.map(item => item.id)).toEqual(['old-prefix', 'old-latest', 'gap-new', 'new-latest']);
    expect(result.current.nextCursor).toBe('before-gap-new');
    rerender({ reloadKey: 2 });
    await waitFor(() => expect(result.current.initialLoading).toBe(false));
    expect(result.current.items.map(item => item.id)).toEqual(['old-prefix', 'old-latest', 'gap-new', 'new-latest']);
    expect(result.current.nextCursor).toBe('before-gap-new');
    await act(() => result.current.loadOlder());
    expect(result.current.items.map(item => item.id)).toEqual(['old-prefix', 'old-latest', 'gap-old', 'gap-new', 'new-latest']);
    expect(result.current.nextCursor).toBe('before-old-prefix');
    await act(() => result.current.loadOlder());
    expect(result.current.items[0]?.id).toBe('oldest');
    expect(getThreadHistory.mock.calls.at(-1)?.[1]?.before).toBe('before-old-prefix');
  });

  it('搜索窗口独立保存，返回普通历史时仍恢复其旧前缀和游标', async () => {
    const getThreadHistory = vi.fn(async (threadId: string, query?: { before?: string; targetItemId?: string }): Promise<ThreadHistoryResponse> => {
      if (query?.targetItemId) return { threadId, items: [historyMessage('search-result', '搜索')], hasMore: true, nextCursor: 'before-search' };
      return query?.before
        ? { threadId, items: [historyMessage('older', '旧页')], hasMore: true, nextCursor: 'before-older' }
        : { threadId, items: [historyMessage('latest', '最新页')], hasMore: true, nextCursor: 'before-latest' };
    });
    const { result, rerender } = renderHook(({ targetItemId }) => useThreadHistory({
      threadId: 'search-thread', targetItemId, enabled: true, service: { getThreadHistory }
    }), { initialProps: { targetItemId: undefined as string | undefined } });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(() => result.current.loadOlder());
    rerender({ targetItemId: 'search-result' });
    await waitFor(() => expect(result.current.initialLoading).toBe(false));
    expect(result.current.items.map(item => item.id)).toEqual(['search-result']);
    expect(result.current.nextCursor).toBe('before-search');
    rerender({ targetItemId: undefined });
    await waitFor(() => expect(result.current.initialLoading).toBe(false));
    expect(result.current.items.map(item => item.id)).toEqual(['older', 'latest']);
    expect(result.current.nextCursor).toBe('before-older');
  });

  it('已加载旧页后刷新最新页仍保留旧前缀的服务端游标', async () => {
    const getThreadHistory = vi.fn(async (threadId: string, query?: { before?: string }): Promise<ThreadHistoryResponse> => query?.before
      ? { threadId, items: [historyMessage('older', '旧页'), historyMessage('latest', '最新页')], hasMore: true, nextCursor: 'before-older' }
      : { threadId, items: [historyMessage('latest', '最新页')], hasMore: true, nextCursor: 'before-latest' });
    const { result, rerender } = renderHook(({ reloadKey }) => useThreadHistory({ threadId: 'thread', enabled: true, service: { getThreadHistory }, reloadKey }),
      { initialProps: { reloadKey: 0 } });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(() => result.current.loadOlder());
    expect(result.current.nextCursor).toBe('before-older');
    rerender({ reloadKey: 1 });
    await waitFor(() => expect(result.current.initialLoading).toBe(false));
    expect(result.current.items.map(item => item.id)).toEqual(['older', 'latest']);
    expect(result.current.nextCursor).toBe('before-older');
  });
  it('loads only the latest page first and prepends older pages without duplicates', async () => {
    const getThreadHistory = vi.fn(async (
      threadId: string,
      query?: { limit?: number; before?: string }
    ): Promise<ThreadHistoryResponse> => {
      if (query?.before === 'cursor_older') {
        return {
          threadId,
          codexThreadId: 'codex_thread_1',
          items: [
            historyMessage('history_1', '更早的消息'),
            historyMessage('history_2', '分页边界消息')
          ],
          hasMore: false
        };
      }
      return {
        threadId,
        codexThreadId: 'codex_thread_1',
        items: [
          historyMessage('history_2', '分页边界消息'),
          historyMessage('history_3', '最新消息')
        ],
        hasMore: true,
        nextCursor: 'cursor_older'
      };
    });
    const { result } = renderHook(() => useThreadHistory({
      threadId: 'thread_1',
      enabled: true,
      service: { getThreadHistory }
    }));

    await waitFor(() => expect(result.current.initialLoading).toBe(false));

    expect(getThreadHistory).toHaveBeenNthCalledWith(
      1,
      'thread_1',
      { limit: 10 },
      { signal: expect.any(AbortSignal) }
    );
    expect(result.current.items.map(item => item.id)).toEqual(['history_2', 'history_3']);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(getThreadHistory).toHaveBeenNthCalledWith(
      2,
      'thread_1',
      {
        limit: 10,
        before: 'cursor_older'
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(result.current.items.map(item => item.id)).toEqual([
      'history_1',
      'history_2',
      'history_3'
    ]);
    expect(result.current.hasMore).toBe(false);
  });

  it('ignores a slower response after switching threads', async () => {
    let resolveThreadA: ((response: ThreadHistoryResponse) => void) | undefined;
    let threadASignal: AbortSignal | undefined;
    const getThreadHistory = vi.fn((
      threadId: string,
      _query?: unknown,
      options?: { signal?: AbortSignal }
    ): Promise<ThreadHistoryResponse> => {
      if (threadId === 'thread_a') {
        threadASignal = options?.signal;
        return new Promise(resolve => {
          resolveThreadA = resolve;
        });
      }
      return Promise.resolve({
        threadId,
        items: [historyMessage('thread_b_message', '会话 B')]
      });
    });
    const { result, rerender } = renderHook(
      ({ threadId }) => useThreadHistory({
        threadId,
        enabled: true,
        service: { getThreadHistory }
      }),
      { initialProps: { threadId: 'thread_a' } }
    );

    rerender({ threadId: 'thread_b' });
    expect(threadASignal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.items[0]?.id).toBe('thread_b_message'));

    await act(async () => {
      resolveThreadA?.({
        threadId: 'thread_a',
        items: [historyMessage('thread_a_message', '会话 A')]
      });
      await Promise.resolve();
    });

    expect(result.current.threadId).toBe('thread_b');
    expect(result.current.items.map(item => item.id)).toEqual(['thread_b_message']);
  });

  it('loads a bounded window around a search target item', async () => {
    const getThreadHistory = vi.fn(async (
      threadId: string
    ): Promise<ThreadHistoryResponse> => ({
      threadId,
      items: [historyMessage('target-item', '目标消息')],
      hasMore: true,
      nextCursor: 'older-cursor',
      targetItemId: 'target-item'
    }));
    const { result } = renderHook(() => useThreadHistory({
      threadId: 'thread_1',
      targetItemId: 'target-item',
      enabled: true,
      service: { getThreadHistory }
    }));

    await waitFor(() => expect(result.current.initialLoading).toBe(false));

    expect(getThreadHistory).toHaveBeenCalledWith(
      'thread_1',
      {
        limit: 10,
        targetItemId: 'target-item'
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(result.current.items.map(item => item.id)).toEqual(['target-item']);
    expect(result.current.hasMore).toBe(true);
  });
});

function historyMessage(id: string, text: string) {
  return {
    id,
    type: 'user_message' as const,
    text,
    createdAt: '2026-07-12T00:00:00.000Z'
  };
}
