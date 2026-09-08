import type {
  ConversationSearchQuery,
  ConversationSearchSnippetSegment,
  ThreadHistoryItem
} from '@clawee/protocol';
import type { CodexAppServerRequestClient } from '../app-server-client.js';
import { CodexAppServerResponseError } from '../app-server-client.js';
import {
  mapCodexTurnsPage,
  type CodexTurnsListResponse,
  unixSecondsToIso
} from './app-server-history-mapper.js';

export type { CodexAppServerRequestClient } from '../app-server-client.js';

export type CodexConversationSearchResult = {
  codexThreadId: string;
  title: string;
  cwd: string;
  itemType: 'title';
  createdAt: string;
  snippet: ConversationSearchSnippetSegment[];
};

export type CodexConversationSearchPage = {
  results: CodexConversationSearchResult[];
  hasMore: boolean;
  nextCursor?: string;
};

export type CodexSessionProvider = {
  listTurns(input: {
    codexThreadId: string;
    limit: number;
    cursor?: string;
  }): Promise<CodexThreadHistoryPage>;
  search(query: ConversationSearchQuery): Promise<CodexConversationSearchPage>;
  close(): Promise<void>;
};

export type CodexThreadHistoryPage = {
  items: ThreadHistoryItem[];
  hasMore: boolean;
  nextCursor?: string;
  oldestItemAt?: string;
};

export type CreateCodexSessionProviderInput = {
  client: CodexAppServerRequestClient;
  historyCacheTtlMs?: number;
  now?: () => number;
};

type CodexThread = {
  id: string;
  preview: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  cwd: string;
};

type CodexThreadListResponse = {
  data: CodexThread[];
  nextCursor: string | null;
};

type CodexThreadSearchResponse = {
  data: Array<{
    thread: CodexThread;
    snippet: string;
  }>;
  nextCursor: string | null;
};

type CachedHistoryPage = {
  expiresAt: number;
  page: Promise<CodexThreadHistoryPage>;
};

const INTERACTIVE_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer'] as const;
const DEFAULT_HISTORY_CACHE_TTL_MS = 5_000;
const MAX_HISTORY_CACHE_ENTRIES = 100;

export function createCodexSessionProvider(
  input: CreateCodexSessionProviderInput
): CodexSessionProvider {
  const now = input.now ?? Date.now;
  const historyCacheTtlMs = input.historyCacheTtlMs ?? DEFAULT_HISTORY_CACHE_TTL_MS;
  const historyCache = new Map<string, CachedHistoryPage>();

  return {
    listTurns(options) {
      const key = JSON.stringify([
        options.codexThreadId,
        options.cursor ?? null,
        options.limit
      ]);
      if (options.cursor !== undefined) {
        const cached = historyCache.get(key);
        if (cached !== undefined && cached.expiresAt > now()) return cached.page;
        if (cached !== undefined) historyCache.delete(key);
      }

      const page = requestTurns(input.client, options)
        .then(mapCodexTurnsPage);
      if (options.cursor === undefined) return page;

      historyCache.set(key, {
        expiresAt: now() + historyCacheTtlMs,
        page
      });
      while (historyCache.size > MAX_HISTORY_CACHE_ENTRIES) {
        const oldestKey = historyCache.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        historyCache.delete(oldestKey);
      }
      void page.catch(() => {
        if (historyCache.get(key)?.page === page) historyCache.delete(key);
      });
      return page;
    },

    async search(query) {
      const response = await input.client.request<CodexThreadSearchResponse>('thread/search', {
        searchTerm: query.query,
        limit: query.limit ?? 20,
        cursor: query.cursor ?? null,
        archived: false,
        sourceKinds: [...INTERACTIVE_SOURCE_KINDS],
        sortKey: 'recency_at',
        sortDirection: 'desc'
      });
      const results = response.data.flatMap(result => {
        if (
          query.itemTypes !== undefined
          && query.itemTypes.length > 0
          && !query.itemTypes.includes('title')
        ) {
          return [];
        }
        if (query.cwd !== undefined && result.thread.cwd !== query.cwd) return [];
        const createdAt = unixSecondsToIso(
          result.thread.recencyAt ?? result.thread.updatedAt
        );
        if (
          query.createdAfter !== undefined
          && Date.parse(createdAt) < Date.parse(query.createdAfter)
        ) {
          return [];
        }
        if (
          query.createdBefore !== undefined
          && Date.parse(createdAt) > Date.parse(query.createdBefore)
        ) {
          return [];
        }
        return [{
          codexThreadId: result.thread.id,
          title: result.thread.name?.trim()
            || result.thread.preview?.trim()
            || '未命名对话',
          cwd: result.thread.cwd,
          itemType: 'title' as const,
          createdAt,
          snippet: buildSnippet(result.snippet, query.query)
        }];
      });
      return {
        results,
        hasMore: response.nextCursor !== null,
        ...(response.nextCursor === null ? {} : { nextCursor: response.nextCursor })
      };
    },

    async close() {
      historyCache.clear();
      await input.client.close();
    }
  };
}

async function requestTurns(
  client: CodexAppServerRequestClient,
  options: { codexThreadId: string; limit: number; cursor?: string }
): Promise<CodexTurnsListResponse> {
  const params = {
    threadId: options.codexThreadId,
    cursor: options.cursor ?? null,
    limit: options.limit,
    sortDirection: 'desc',
    itemsView: 'full'
  };
  try {
    return await client.request<CodexTurnsListResponse>('thread/turns/list', params);
  } catch (error) {
    if (!isThreadNotLoadedError(error)) throw error;
    await client.request('thread/resume', {
      threadId: options.codexThreadId
    });
    return client.request<CodexTurnsListResponse>('thread/turns/list', params);
  }
}

function isThreadNotLoadedError(error: unknown): boolean {
  return error instanceof CodexAppServerResponseError
    && error.code === -32600
    && error.message.startsWith('thread not loaded:');
}

function buildSnippet(
  source: string,
  query: string
): ConversationSearchSnippetSegment[] {
  const normalizedSource = normalizeSearchText(source);
  const normalizedQuery = normalizeSearchText(query);
  const index = normalizedSource.toLocaleLowerCase().indexOf(
    normalizedQuery.toLocaleLowerCase()
  );
  if (index < 0 || normalizedQuery.length === 0) {
    return normalizedSource.length === 0
      ? []
      : [{ text: normalizedSource.slice(0, 160), highlighted: false }];
  }

  const start = Math.max(0, index - 72);
  const end = Math.min(
    normalizedSource.length,
    index + normalizedQuery.length + 72
  );
  const segments: ConversationSearchSnippetSegment[] = [];
  if (start > 0) segments.push({ text: '…', highlighted: false });
  if (index > start) {
    segments.push({
      text: normalizedSource.slice(start, index),
      highlighted: false
    });
  }
  segments.push({
    text: normalizedSource.slice(index, index + normalizedQuery.length),
    highlighted: true
  });
  if (index + normalizedQuery.length < end) {
    segments.push({
      text: normalizedSource.slice(index + normalizedQuery.length, end),
      highlighted: false
    });
  }
  if (end < normalizedSource.length) segments.push({ text: '…', highlighted: false });
  return segments;
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}
