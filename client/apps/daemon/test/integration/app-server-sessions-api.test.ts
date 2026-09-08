import type {
  AgentEventEnvelope,
  ConversationSearchQuery
} from '@clawee/protocol';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../helpers/build-server.js';
import { createAttachmentService } from '../../src/attachments/service.js';
import type {
  CodexConversationSearchPage,
  CodexSessionProvider,
  CodexThreadHistoryPage
} from '../../src/codex/sessions/app-server-provider.js';
import { CodexAppServerResponseError } from '../../src/codex/app-server-client.js';
import { SearchCursorError } from '../../src/search/service.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import {
  createProjectRepository,
  createRunRepository,
  createThreadRepository
} from '../../src/storage/repositories.js';

let server: FastifyInstance | undefined;
let db: Database.Database | undefined;
let tempDir = '';
type TestInjectPayload = string | object;

afterEach(async () => {
  await server?.close();
  server = undefined;
  db?.close();
  db = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('app-server session API', () => {
  it('lists only local owned threads without calling Codex thread list', async () => {
    const setup = createSetup();
    insertProject(setup.db, 'project-owned');
    const listRecent = vi.fn(async () => {
      throw new Error('thread/list must not be called');
    });
    const provider = Object.assign(fakeProvider(), { listRecent });
    createThreadRepository(setup.db).insertThread({
      id: 'thread-owned',
      title: '已归属会话',
      codexThreadId: 'codex-owned',
      projectId: 'project-owned',
      origin: 'clawee_created',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      profile: 'default',
      sandbox: 'read-only',
      status: 'active',
      purpose: 'conversation',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z'
    });
    createThreadRepository(setup.db).insertThread({
      id: 'thread-unassigned',
      title: '待归属会话',
      codexThreadId: 'codex-unassigned',
      projectId: null,
      origin: 'clawee_created',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      profile: 'default',
      sandbox: 'read-only',
      status: 'active',
      purpose: 'conversation',
      createdAt: '2026-07-15T01:00:00.000Z',
      updatedAt: '2026-07-15T01:00:00.000Z'
    });
    createThreadRepository(setup.db).insertThread({
      id: 'thread-discovered',
      title: '外部会话',
      codexThreadId: 'codex-discovered',
      projectId: null,
      origin: 'codex_discovered',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      profile: 'default',
      sandbox: 'read-only',
      status: 'active',
      purpose: 'conversation',
      createdAt: '2026-07-15T02:00:00.000Z',
      updatedAt: '2026-07-15T02:00:00.000Z'
    });
    createThreadRepository(setup.db).insertThread({
      id: 'thread-local-draft',
      title: '本地草稿',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      profile: 'default',
      sandbox: 'read-only',
      status: 'active',
      purpose: 'schedule_draft',
      createdAt: '2026-07-15T02:00:00.000Z',
      updatedAt: '2026-07-15T02:00:00.000Z'
    });
    server = await buildServer({
      token: 'secret',
      dataDir: tempDir,
      db: setup.db,
      codexSessionProvider: provider
    });

    const response = await authGet('/threads?status=active&excludePurpose=schedule_task&limit=50');
    const unassigned = await authGet(
      '/threads?status=active&purpose=conversation&assignment=unassigned&limit=50'
    );

    expect(response.statusCode).toBe(200);
    expect(listRecent).not.toHaveBeenCalled();
    expect(response.json().threads.map((thread: { id: string }) => thread.id)).toEqual([
      'thread-local-draft',
      'thread-owned'
    ]);
    expect(response.body).not.toContain('thread-unassigned');
    expect(response.body).not.toContain('thread-discovered');
    expect(unassigned.statusCode).toBe(200);
    expect(unassigned.json().threads.map((thread: { id: string }) => thread.id)).toEqual([
      'thread-unassigned'
    ]);
    for (const url of [
      '/threads/thread-discovered',
      '/threads/thread-discovered/runs',
      '/threads/thread-discovered/history',
      '/workspace/files/directory?threadId=thread-discovered&path='
    ]) {
      const hidden = await authGet(url);
      expect(hidden.statusCode, url).toBe(404);
      expect(hidden.json().error.code, url).toBe('THREAD_NOT_FOUND');
    }
    const hiddenRun = await authPost('/runs', {
      threadId: 'thread-discovered',
      prompt: 'hidden'
    });
    expect(hiddenRun.statusCode).toBe(404);
    expect(hiddenRun.json().error.code).toBe('THREAD_NOT_FOUND');
    const hiddenUpdate = await authPatch('/threads/thread-discovered', {
      sandbox: 'workspace-write'
    });
    expect(hiddenUpdate.statusCode).toBe(404);
    expect(hiddenUpdate.json().error.code).toBe('THREAD_NOT_FOUND');
    const hiddenArchive = await authPost('/threads/thread-discovered/archive', {});
    expect(hiddenArchive.statusCode).toBe(404);
    expect(hiddenArchive.json().error.code).toBe('THREAD_NOT_FOUND');
    expect(
      setup.db.prepare('SELECT COUNT(*) AS count FROM codex_session_sources').get()
    ).toEqual({ count: 0 });
  });

  it('uses provider cursors for history and provider search results without item targets', async () => {
    const setup = createSetup();
    insertProject(setup.db, 'project-recent');
    createThreadRepository(setup.db).insertThread({
      id: 'thread-recent',
      title: '最近会话',
      codexThreadId: 'codex-recent',
      projectId: 'project-recent',
      origin: 'clawee_created',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      profile: 'default',
      sandbox: 'read-only',
      status: 'active',
      purpose: 'conversation',
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T02:00:00.000Z'
    });
    const history: CodexThreadHistoryPage = {
      items: [{
        id: 'user-1',
        type: 'user_message',
        text: '历史消息',
        createdAt: '2026-07-15T00:00:00.000Z',
        turnId: 'turn-1'
      }],
      hasMore: true,
      nextCursor: 'older-cursor',
      oldestItemAt: '2026-07-15T00:00:00.000Z'
    };
    const historyItem = history.items[0];
    if (historyItem?.type !== 'user_message') {
      throw new Error('Expected a user history item');
    }
    const runs = createRunRepository(setup.db);
    runs.insertRun({
      id: 'run-history-image',
      threadId: 'thread-recent',
      codexThreadId: 'codex-recent',
      publicStatus: 'succeeded',
      internalStatus: 'succeeded',
      createdBy: 'api',
      profile: 'default',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      sandbox: 'read-only',
      codexVersion: 'test',
      codexBin: 'codex',
      codexHome: join(tempDir, 'codex-home'),
      normalizerVersion: 1
    });
    const attachmentService = createAttachmentService({
      db: setup.db,
      dataDir: tempDir,
      createId: () => 'attachment-history-image'
    });
    const uploaded = await attachmentService.upload({
      draftId: 'draft-history-image',
      fileName: 'history.png',
      mime: 'image/png',
      content: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn6zkAAAAAASUVORK5CYII=',
        'base64'
      )
    });
    await attachmentService.commit({
      ids: [uploaded.attachment.id],
      draftId: 'draft-history-image',
      threadId: 'thread-recent',
      runId: 'run-history-image'
    });
    const search: CodexConversationSearchPage = {
      results: [{
        codexThreadId: 'codex-unknown',
        title: '未知会话',
        cwd: tempDir,
        itemType: 'title',
        createdAt: '2026-07-15T03:00:00.000Z',
        snippet: [{ text: '历史消息', highlighted: true }]
      }],
      hasMore: true,
      nextCursor: 'second-page'
    };
    const secondSearch: CodexConversationSearchPage = {
      results: [{
        codexThreadId: 'codex-recent',
        title: '最近会话',
        cwd: tempDir,
        itemType: 'title',
        createdAt: '2026-07-15T02:00:00.000Z',
        snippet: [{ text: '历史消息', highlighted: true }]
      }],
      hasMore: false
    };
    const provider = fakeProvider({
      listTurns: vi.fn(async () => history),
      search: vi.fn(async query => query.cursor === 'second-page' ? secondSearch : search)
    });
    server = await buildServer({
      token: 'secret',
      dataDir: tempDir,
      db: setup.db,
      codexSessionProvider: provider
    });

    const latestHistoryResponse = await authGet(
      '/threads/thread-recent/history?limit=20'
    );
    const historyResponse = await authGet(
      '/threads/thread-recent/history?limit=20&before=app-server-cursor'
    );
    const searchResponse = await authGet(
      `/search/conversations?query=${encodeURIComponent('历史消息')}&limit=20`
    );

    expect(historyResponse.statusCode).toBe(200);
    expect(latestHistoryResponse.statusCode).toBe(200);
    expect(provider.listTurns).toHaveBeenCalledWith({
      codexThreadId: 'codex-recent',
      limit: 20,
      cursor: 'app-server-cursor'
    });
    expect(historyResponse.json()).toMatchObject({
      threadId: 'thread-recent',
      codexThreadId: 'codex-recent',
      ...history,
      items: [{
        ...history.items[0],
        runId: 'run-history-image',
        attachments: [{
          id: uploaded.attachment.id,
          threadId: 'thread-recent',
          runId: 'run-history-image',
          status: 'committed'
        }]
      }]
    });
    expect(latestHistoryResponse.json()).toMatchObject({
      items: [{
        ...historyItem,
        runId: 'run-history-image',
        attachments: [{
          id: uploaded.attachment.id,
          threadId: 'thread-recent',
          runId: 'run-history-image',
          status: 'committed'
        }]
      }]
    });
    expect(searchResponse.statusCode).toBe(200);
    expect(provider.search).toHaveBeenCalledWith({
      query: '历史消息',
      limit: 20
    });
    expect(provider.search).toHaveBeenCalledWith({
      query: '历史消息',
      limit: 20,
      cursor: 'second-page'
    });
    expect(searchResponse.json()).toEqual({
      ...secondSearch,
      results: [{
        ...secondSearch.results[0],
        threadId: 'thread-recent',
        projectId: 'project-recent'
      }]
    });
    expect(searchResponse.json().results[0]).not.toHaveProperty('itemId');
  });

  it('enriches only the latest history page with persisted tool events', async () => {
    const setup = createSetup();
    insertProject(setup.db, 'project-tools');
    createThreadRepository(setup.db).insertThread({
      id: 'thread-tools',
      title: '工具会话',
      codexThreadId: 'codex-tools',
      projectId: 'project-tools',
      origin: 'clawee_created',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      profile: 'default',
      sandbox: 'read-only',
      status: 'active',
      purpose: 'conversation',
      createdAt: '2026-08-21T11:57:36.000Z',
      updatedAt: '2026-08-21T11:57:37.000Z'
    });
    const runs = createRunRepository(setup.db);
    runs.insertRun({
      id: 'run-tools',
      threadId: 'thread-tools',
      codexThreadId: 'codex-tools',
      publicStatus: 'succeeded',
      internalStatus: 'succeeded',
      createdBy: 'api',
      profile: 'default',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      sandbox: 'read-only',
      codexVersion: 'test',
      codexBin: 'codex',
      codexHome: join(tempDir, 'codex-home'),
      normalizerVersion: 1
    });
    runs.insertRunEvent(runEvent('tool_use', 1, {
      type: 'tool_use',
      toolCallId: 'command-1',
      name: 'command_execution',
      input: { command: 'printf complete' }
    }, 'command-1'));
    runs.insertRunEvent(runEvent('tool_result', 2, {
      type: 'tool_result',
      toolCallId: 'command-1',
      output: 'complete\n',
      exitCode: 0,
      isError: false
    }, 'command-1'));
    setup.db.prepare(`
      UPDATE run_events
      SET created_at = CASE id
        WHEN 'event-1' THEN '2026-08-21 11:57:36.100'
        ELSE '2026-08-21 11:57:36.200'
      END
      WHERE run_id = 'run-tools'
    `).run();

    const provider = fakeProvider({
      listTurns: vi.fn(async (
        input
      ): Promise<CodexThreadHistoryPage> => (
        input.cursor === undefined
          ? {
            items: [
              {
                id: 'user-tools',
                type: 'user_message',
                text: '执行命令',
                createdAt: '2026-08-21T11:57:36.000Z',
                turnId: 'turn-tools'
              },
              {
                id: 'assistant-tools',
                type: 'assistant_message',
                text: '执行完成',
                createdAt: '2026-08-21T11:57:37.000Z',
                turnId: 'turn-tools'
              },
              {
                id: 'done-tools',
                type: 'done',
                status: 'succeeded',
                createdAt: '2026-08-21T11:57:37.000Z',
                turnId: 'turn-tools'
              }
            ],
            hasMore: true,
            nextCursor: 'older-page'
          }
          : {
            items: [{
              id: 'user-older',
              type: 'user_message',
              text: '更早消息',
              createdAt: '2026-08-20T11:57:36.000Z',
              turnId: 'turn-older'
            }],
            hasMore: false
          }
      ))
    });
    server = await buildServer({
      token: 'secret',
      dataDir: tempDir,
      db: setup.db,
      codexSessionProvider: provider
    });

    const latest = await authGet('/threads/thread-tools/history?limit=20');
    const older = await authGet(
      '/threads/thread-tools/history?limit=20&before=older-page'
    );

    expect(latest.statusCode).toBe(200);
    expect(latest.json().items).toEqual([
      expect.objectContaining({ type: 'user_message' }),
      expect.objectContaining({
        id: 'command-1:use',
        type: 'tool_use',
        name: 'command_execution'
      }),
      expect.objectContaining({
        id: 'command-1:result',
        type: 'tool_result',
        output: 'complete\n',
        isError: false
      }),
      expect.objectContaining({ type: 'assistant_message' }),
      expect.objectContaining({ type: 'done' })
    ]);
    expect(older.statusCode).toBe(200);
    expect(older.json().items).toEqual([{
      id: 'user-older',
      type: 'user_message',
      text: '更早消息',
      createdAt: '2026-08-20T11:57:36.000Z',
      turnId: 'turn-older'
    }]);
  });

  it('falls back to persisted run messages when the isolated Home has no rollout', async () => {
    const setup = createSetup();
    insertProject(setup.db, 'project-recovery');
    createThreadRepository(setup.db).insertThread({
      id: 'thread-recovery',
      title: '查找武汉市好玩的地方',
      codexThreadId: 'codex-missing-rollout',
      projectId: 'project-recovery',
      origin: 'clawee_created',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      profile: 'default',
      sandbox: 'read-only',
      status: 'active',
      purpose: 'conversation',
      createdAt: '2026-08-21T11:57:36.000Z',
      updatedAt: '2026-08-21T11:57:37.000Z'
    });
    const runs = createRunRepository(setup.db);
    runs.insertRun({
      id: 'run-recovery',
      threadId: 'thread-recovery',
      codexThreadId: 'codex-missing-rollout',
      publicPrompt: '查找武汉市好玩的地方',
      publicStatus: 'succeeded',
      internalStatus: 'succeeded',
      createdBy: 'api',
      profile: 'default',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      sandbox: 'read-only',
      codexVersion: 'test',
      codexBin: 'codex',
      codexHome: join(tempDir, 'codex-home'),
      normalizerVersion: 1
    });
    runs.insertRunEvent({
      ...runEvent('assistant_message', 1, {
        type: 'assistant_message',
        text: '东湖和湖北省博物馆都值得去。',
        format: 'plain_text',
        delivery: 'message'
      }, 'assistant-recovery'),
      runId: 'run-recovery'
    });
    const provider = fakeProvider({
      listTurns: vi.fn(async () => {
        throw new CodexAppServerResponseError(
          'no rollout found for thread id codex-missing-rollout',
          -32600
        );
      })
    });
    server = await buildServer({
      token: 'secret',
      dataDir: tempDir,
      db: setup.db,
      codexSessionProvider: provider
    });

    const response = await authGet('/threads/thread-recovery/history?limit=50');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      threadId: 'thread-recovery',
      codexThreadId: 'codex-missing-rollout',
      hasMore: false,
      items: [
        {
          id: 'run-prompt:run-recovery',
          type: 'user_message',
          text: '查找武汉市好玩的地方'
        },
        {
          id: 'assistant-recovery',
          type: 'assistant_message',
          text: '东湖和湖北省博物馆都值得去。'
        }
      ]
    });
  });

  it('validates search queries and rejects unsupported target history windows', async () => {
    const setup = createSetup();
    createThreadRepository(setup.db).insertThread({
      id: 'thread-recent',
      title: '最近会话',
      codexThreadId: 'codex-recent',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      profile: 'default',
      sandbox: 'read-only',
      status: 'active',
      purpose: 'conversation',
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T02:00:00.000Z'
    });
    const provider = fakeProvider({
      search: vi.fn(async query => {
        if (query.cursor !== undefined) throw new SearchCursorError('invalid cursor');
        return { results: [], hasMore: false };
      })
    });
    server = await buildServer({
      token: 'secret',
      dataDir: tempDir,
      db: setup.db,
      codexSessionProvider: provider
    });

    for (const url of [
      '/search/conversations',
      '/search/conversations?query=test&limit=0',
      '/search/conversations?query=test&types=unknown',
      '/search/conversations?query=test&cursor=not-a-cursor'
    ]) {
      const response = await authGet(url);
      expect(response.statusCode).toBe(400);
    }

    const target = await authGet(
      '/threads/thread-recent/history?limit=20&targetItemId=message-id'
    );
    expect(target.statusCode).toBe(400);
    expect(target.json().error.code).toBe('VALIDATION_FAILED');
    expect(provider.listTurns).not.toHaveBeenCalled();
  });

  it('maps app-server cursor errors to stable API errors', async () => {
    const setup = createSetup();
    createThreadRepository(setup.db).insertThread({
      id: 'thread-recent',
      title: '最近会话',
      codexThreadId: 'codex-recent',
      cwd: tempDir,
      canonicalCwd: tempDir,
      workspaceMode: 'external',
      profile: 'default',
      sandbox: 'read-only',
      status: 'active',
      purpose: 'conversation',
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T02:00:00.000Z'
    });
    const provider = fakeProvider({
      listTurns: vi.fn(async input => {
        if (input.cursor !== undefined) {
          throw new CodexAppServerResponseError('invalid history cursor', -32602);
        }
        return { items: [], hasMore: false };
      }),
      search: vi.fn(async query => {
        if (query.cursor !== undefined) {
          throw new CodexAppServerResponseError('invalid search cursor', -32602);
        }
        return { results: [], hasMore: false };
      })
    });
    server = await buildServer({
      token: 'secret',
      dataDir: tempDir,
      db: setup.db,
      codexSessionProvider: provider
    });

    const history = await authGet(
      '/threads/thread-recent/history?limit=20&before=invalid-cursor'
    );
    const search = await authGet(
      '/search/conversations?query=test&limit=20&cursor=invalid-cursor'
    );

    expect(history.statusCode).toBe(400);
    expect(history.json().error.code).toBe('THREAD_HISTORY_CURSOR_INVALID');
    expect(search.statusCode).toBe(400);
    expect(search.json().error.code).toBe('SEARCH_CURSOR_INVALID');
  });
});

function createSetup() {
  tempDir = mkdtempSync(join(tmpdir(), 'clawee-app-server-sessions-api-'));
  db = openRuntimeDatabase(join(tempDir, 'app.sqlite'));
  return { db };
}

function insertProject(database: Database.Database, id: string): void {
  createProjectRepository(database).insertProject({
    id,
    name: id,
    cwd: tempDir,
    canonicalCwd: tempDir,
    profile: 'default',
    sandbox: 'follow-global'
  });
}

function fakeProvider(
  overrides: Partial<CodexSessionProvider> = {}
): CodexSessionProvider {
  return {
    listTurns: vi.fn(async () => ({ items: [], hasMore: false })),
    search: vi.fn(async (_query: ConversationSearchQuery) => ({
      results: [],
      hasMore: false
    })),
    close: vi.fn(async () => undefined),
    ...overrides
  };
}

async function authGet(url: string) {
  return server!.inject({
    method: 'GET',
    url,
    headers: { authorization: 'Bearer secret' }
  });
}

async function authPost(url: string, payload: unknown) {
  return server!.inject({
    method: 'POST',
    url,
    headers: { authorization: 'Bearer secret' },
    payload: payload as TestInjectPayload
  });
}

async function authPatch(url: string, payload: unknown) {
  return server!.inject({
    method: 'PATCH',
    url,
    headers: { authorization: 'Bearer secret' },
    payload: payload as TestInjectPayload
  });
}

function runEvent<Type extends AgentEventEnvelope['type']>(
  type: Type,
  seq: number,
  payload: Extract<
    AgentEventEnvelope,
    { type: Type }
  >['payload'],
  rawEventId: string
): Extract<AgentEventEnvelope, { type: Type }> {
  return {
    id: `event-${seq}`,
    runId: 'run-tools',
    seq,
    ts: `2026-08-21T11:57:36.${seq}00Z`,
    type,
    payload,
    normalizerVersion: 1,
    rawEventId
  } as Extract<AgentEventEnvelope, { type: Type }>;
}
