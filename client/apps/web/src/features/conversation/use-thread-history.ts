import type {
  ThreadHistoryItem,
  ThreadHistoryQuery,
  ThreadHistoryResponse
} from '@clawee/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

const HISTORY_PAGE_SIZE = 10;

export type ThreadHistoryService = {
  getThreadHistory(
    threadId: string,
    query?: ThreadHistoryQuery,
    options?: { signal?: AbortSignal }
  ): Promise<ThreadHistoryResponse>;
};

type ThreadHistoryState = {
  threadId?: string;
  items: ThreadHistoryItem[];
  initialLoading: boolean;
  loadingOlder: boolean;
  loaded: boolean;
  hasMore: boolean;
  nextCursor?: string;
  codexThreadId?: string | null;
  error?: string;
  loadedOlder?: boolean;
  targetItemId?: string;
  windows?: HistoryWindow[];
};

export type HistoryWindow = Pick<ThreadHistoryState, 'items' | 'hasMore' | 'nextCursor'>;

export function useThreadHistory(input: {
  threadId?: string;
  targetItemId?: string;
  enabled: boolean;
  service: ThreadHistoryService | null;
  reloadKey?: number;
  consumeSkipInitialLoad?(threadId: string): boolean;
}) {
  const [state, setState] = useState<ThreadHistoryState>(() => emptyState(input.threadId));
  const stateRef = useRef(state);
  const requestGenerationRef = useRef(0);
  const windowsRef = useRef(new Map<string, ThreadHistoryState>());
  const olderRequestControllerRef = useRef<AbortController>();
  const getThreadHistory = input.service?.getThreadHistory;
  stateRef.current = state;

  useEffect(() => {
    const previousState = stateRef.current;
    if (previousState.threadId !== undefined && previousState.loaded) {
      windowsRef.current.set(historyScope(previousState.threadId, previousState.targetItemId), previousState);
    }
    requestGenerationRef.current += 1;
    const generation = requestGenerationRef.current;
    const threadId = input.threadId;
    olderRequestControllerRef.current?.abort();
    olderRequestControllerRef.current = undefined;

    if (!input.enabled || threadId === undefined || getThreadHistory === undefined) {
      const next = emptyState(threadId);
      stateRef.current = next;
      setState(next);
      return;
    }

    if (input.consumeSkipInitialLoad?.(threadId) === true) {
      const next: ThreadHistoryState = {
        ...emptyState(threadId),
        loaded: true
      };
      stateRef.current = next;
      setState(next);
      return;
    }

    const loading: ThreadHistoryState = {
      ...emptyState(threadId),
      initialLoading: true
    };
    stateRef.current = loading;
    setState(loading);

    let canceled = false;
    const controller = new AbortController();
    const previousWindow = windowsRef.current.get(historyScope(threadId, input.targetItemId));
    void getThreadHistory(
      threadId,
      {
        limit: HISTORY_PAGE_SIZE,
        ...(input.targetItemId === undefined ? {} : { targetItemId: input.targetItemId })
      },
      { signal: controller.signal }
    )
      .then(response => {
        if (
          canceled
          || generation !== requestGenerationRef.current
          || response.threadId !== threadId
        ) {
          return;
        }
        const windows = mergeHistoryWindows(previousWindow === undefined ? [] : knownWindows(previousWindow), response, 'latest');
        const newestWindow = windows.at(-1)!;
        const next: ThreadHistoryState = {
          threadId,
          items: windows.flatMap(window => window.items),
          windows,
          initialLoading: false,
          loadingOlder: false,
          loaded: true,
          hasMore: newestWindow.hasMore,
          nextCursor: newestWindow.nextCursor,
          loadedOlder: previousWindow?.loadedOlder,
          targetItemId: input.targetItemId,
          ...(response.codexThreadId === undefined
            ? {}
            : { codexThreadId: response.codexThreadId })
        };
        stateRef.current = next;
        setState(next);
      })
      .catch(error => {
        if (isAbortError(error)) return;
        if (canceled || generation !== requestGenerationRef.current) return;
        const next: ThreadHistoryState = {
          ...(previousWindow ?? emptyState(threadId)),
          initialLoading: false,
          loadingOlder: false,
          loaded: true,
          targetItemId: input.targetItemId,
          error: '无法加载聊天历史'
        };
        stateRef.current = next;
        setState(next);
      });

    return () => {
      canceled = true;
      controller.abort();
    };
  }, [
    getThreadHistory,
    input.consumeSkipInitialLoad,
    input.enabled,
    input.reloadKey,
    input.threadId,
    input.targetItemId
  ]);

  const loadOlder = useCallback(async () => {
    const current = stateRef.current;
    const threadId = current.threadId;
    const before = current.nextCursor;
    if (
      threadId === undefined
      || before === undefined
      || current.loadingOlder
      || !current.hasMore
      || getThreadHistory === undefined
    ) {
      return;
    }

    const generation = requestGenerationRef.current;
    const loading = {
      ...current,
      loadingOlder: true,
      error: undefined
    };
    stateRef.current = loading;
    setState(loading);
    olderRequestControllerRef.current?.abort();
    const controller = new AbortController();
    olderRequestControllerRef.current = controller;

    try {
      const response = await getThreadHistory(
        threadId,
        {
          limit: HISTORY_PAGE_SIZE,
          before
        },
        { signal: controller.signal }
      );
      if (
        generation !== requestGenerationRef.current
        || response.threadId !== threadId
      ) {
        return;
      }
      const latest = stateRef.current;
      const joined = mergeHistoryWindows(knownWindows(latest), response, 'older');
      const newestWindow = joined.at(-1)!;
      const next: ThreadHistoryState = {
        ...latest,
        items: joined.flatMap(window => window.items),
        windows: joined,
        loadingOlder: false,
        loadedOlder: true,
        hasMore: newestWindow.hasMore,
        nextCursor: newestWindow.nextCursor,
        ...(response.codexThreadId === undefined
          ? {}
          : { codexThreadId: response.codexThreadId })
      };
      stateRef.current = next;
      setState(next);
    } catch (error) {
      if (isAbortError(error)) return;
      if (generation !== requestGenerationRef.current) return;
      const next = {
        ...stateRef.current,
        loadingOlder: false,
        error: '无法加载更早的聊天历史'
      };
      stateRef.current = next;
      setState(next);
    } finally {
      if (olderRequestControllerRef.current === controller) {
        olderRequestControllerRef.current = undefined;
      }
    }
  }, [getThreadHistory]);

  return {
    ...state,
    loadOlder
  };
}

function historyIdentity(item: ThreadHistoryItem): string {
  return `${item.turnId ?? item.runId ?? ''}:${item.type}:${item.rawEventId ?? item.id}`;
}

function historyScope(threadId: string, targetItemId?: string): string {
  return JSON.stringify([threadId, targetItemId ?? null]);
}

function historyWindow(value: Pick<ThreadHistoryResponse, 'items' | 'hasMore' | 'nextCursor'>): HistoryWindow {
  return { items: value.items, hasMore: value.hasMore === true, nextCursor: value.nextCursor };
}

function knownWindows(state: ThreadHistoryState): HistoryWindow[] {
  return state.windows ?? [historyWindow(state)];
}

export function mergeHistoryWindows(
  windows: readonly HistoryWindow[],
  response: Pick<ThreadHistoryResponse, 'items' | 'hasMore' | 'nextCursor'>,
  mode: 'latest' | 'older'
): HistoryWindow[] {
  const incoming = historyWindow(response);
  if (mode === 'latest' || windows.length === 0) return joinHistoryWindows([...windows, incoming]);
  const active = windows.at(-1)!;
  const existingIds = new Set(active.items.map(historyIdentity));
  const olderItems = incoming.items.filter(item => !existingIds.has(historyIdentity(item)));
  return joinHistoryWindows([...windows.slice(0, -1), { ...incoming, items: [...olderItems, ...active.items] }]);
}

function joinHistoryWindows(windows: HistoryWindow[]): HistoryWindow[] {
  const joined: HistoryWindow[] = [];
  for (const window of windows) {
    let current = window;
    while (joined.length > 0) {
      const older = joined.at(-1)!;
      const identities = new Set(current.items.map(historyIdentity));
      const overlap = older.items.findIndex(item => identities.has(historyIdentity(item)));
      if (overlap < 0) break;
      joined.pop();
      // 只有窗口连通后，才能继续使用旧前缀之前的游标；否则先补齐窗口间的缺口。
      current = { ...current, items: [...older.items.slice(0, overlap), ...current.items],
        ...(overlap === 0 ? {} : { hasMore: older.hasMore, nextCursor: older.nextCursor }) };
    }
    joined.push(current);
  }
  return joined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function emptyState(threadId?: string): ThreadHistoryState {
  return {
    ...(threadId === undefined ? {} : { threadId }),
    items: [],
    initialLoading: false,
    loadingOlder: false,
    loaded: false,
    hasMore: false
  };
}
