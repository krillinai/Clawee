import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';
import { createProjectManager } from '../../src/projects/manager.js';
import type { RunManager } from '../../src/runs/manager.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { createThreadManager } from '../../src/threads/manager.js';
import { registerEnterpriseWorkflowRoutes } from '../../src/api/routes.enterprise-workflow.js';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async callTool() { return { structuredContent: { instruction: '整理内容', input: { text: '测试主题' } } }; }
    async close() {}
  }
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }));

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('enterprise workflow execution', () => {
  it('creates a visible project conversation and binds the run to it without duplicating pending runs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'clawee-workflow-thread-'));
    directories.push(directory);
    const db = openRuntimeDatabase(join(directory, 'app.sqlite'));
    const projects = createProjectManager({ db, homeDir: directory });
    const project = projects.createProject({ cwd: directory, profile: 'default', sandbox: 'workspace-write' });
    const threads = createThreadManager({ db, dataDir: directory, projectManager: projects });
    const server = Fastify();
    const associations = new Map<string, { task_id: string; user_id: string; run_id: string; complete_key: string; state: string }>();
    const associationDb = {
      prepare(sql: string) {
        if (sql.includes("WHERE state='pending'")) return { all: () => [...associations.values()].filter(row => row.state === 'pending') };
        if (sql.startsWith('SELECT task_id')) return { get: (id: string) => associations.get(id) };
        if (sql.startsWith('INSERT INTO')) return { run: (task_id: string, user_id: string, run_id: string, complete_key: string, state: string) => {
          associations.set(task_id, { task_id, user_id, run_id, complete_key, state });
        } };
        return { run: () => undefined };
      }
    } as unknown as Database.Database;
    const startRun = vi.fn((input: { threadId: string }) => ({ id: 'run-1', status: 'running', threadId: input.threadId }));
    const runs = { startRun, getRun: vi.fn(() => ({ threadId: startRun.mock.results[0]?.value.threadId })) } as unknown as RunManager;
    try {
      await registerEnterpriseWorkflowRoutes(server, {
        db: associationDb, threads, runs,
        session: {
          getSnapshot: () => ({ status: 'signed_in', account: { subjectId: 'user-1' }, agentId: 'agent-1' }),
          requireAccessToken: async () => 'access-token'
        } as unknown as EnterpriseSessionManager,
        http: { revealAccountMcpToken: async () => ({ token: 'mcp-token' }) } as unknown as EnterpriseHttpClient,
        origin: () => 'http://127.0.0.1:1904',
        canExecute: () => true
      });
      const request = { method: 'POST' as const, url: '/enterprise/workflow-tasks/task-1/execute', payload: { projectId: project.id } };
      const first = await server.inject(request);
      expect(first.statusCode, first.body).toBe(202);
      const { threadId } = first.json();
      expect(threads.listPublicThreads({ assignment: 'assigned' })).toEqual([
        expect.objectContaining({ id: threadId, projectId: project.id, title: '工作流 · 整理内容', purpose: 'conversation', sandbox: 'danger-full-access' })
      ]);
      expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
        threadId, cwd: directory, sandbox: 'danger-full-access', prompt: '整理内容\n\n输入：\n测试主题'
      }));
      const second = await server.inject(request);
      expect(second.json()).toMatchObject({ runId: 'run-1', threadId, status: 'pending' });
      expect(startRun).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
      db.close();
    }
  });
});
