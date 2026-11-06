import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeConversationManager } from '../../src/enterprise/knowledge-conversation-2026-08-05.js';
import { EnterpriseSessionError } from '../../src/enterprise/session-manager-2026-07-30.js';
import { contributionConversationTitle, createContributionConversationManager } from '../../src/enterprise/skill-contributions-conversation.js';
import type { SkillContributionsManager } from '../../src/enterprise/skill-contributions-manager.js';
import { createProjectManager } from '../../src/projects/manager.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';
import { createThreadManager } from '../../src/threads/manager.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'clawee-contribution-manager-'));
  const db = openRuntimeDatabase(join(directory, 'runtime.sqlite'));
  cleanups.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const threads = createThreadManager({ db, dataDir: directory });
  let subjectId = 'account-1';
  const session = { requireIdentity: async () => ({ subjectId, agentId: 'agent-1', accessToken: 'test-token' }) };
  const requireRead = vi.fn(async () => {});
  const contributions = createContributionConversationManager({ sessionManager: session, threadManager: threads, contributions: { requireRead } as unknown as SkillContributionsManager });
  const knowledge = createKnowledgeConversationManager({ sessionManager: session, threadManager: threads });
  const project = createProjectManager({ db }).createProject({ cwd: directory });
  return { db, threads, contributions, knowledge, project, requireRead, switchAccount() { subjectId = 'account-2'; } };
}

describe('企业会话 manager 结构化隔离', () => {
  it('超过一页其他类型会话时仍恢复本类型的最新会话', async () => {
    const context = fixture();
    const publicThread = context.threads.createConversationThread({ projectId: context.project.id, title: '普通对话' });
    const contribution = await context.contributions.create('');
    for (let index = 0; index < 101; index += 1) {
      await context.knowledge.create(context.project.id);
    }
    context.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', contribution.id);
    context.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run('2025-01-01T00:00:00Z', publicThread.id);
    expect(context.threads.listPublicThreads({ assignment: 'assigned', limit: 1 }).map(thread => thread.id)).toEqual([publicThread.id]);
    expect((await context.contributions.latest())?.id).toBe(contribution.id);
    context.db.prepare('UPDATE threads SET updated_at = ? WHERE project_id IS NOT NULL').run('2026-01-02T00:00:00Z');
    const knowledge = await context.knowledge.latest();
    for (let index = 0; index < 101; index += 1) {
      await context.contributions.create('');
    }
    expect((await context.knowledge.latest())?.id).toBe(knowledge?.id);
  });

  it('直接调用 manager 时按项目归属识别，改名不改变会话类型', async () => {
    const context = fixture();
    const contribution = await context.contributions.create('');
    const knowledge = await context.knowledge.create(context.project.id);
    context.threads.updateThread(contribution.id, { title: '改名后的贡献会话' });
    context.threads.updateThread(knowledge.id, { title: contributionConversationTitle });
    expect((await context.contributions.latest())?.id).toBe(contribution.id);
    expect((await context.knowledge.latest())?.id).toBe(knowledge.id);
    expect((await context.contributions.requireOwnedThread(contribution.id)).id).toBe(contribution.id);
    expect((await context.knowledge.requireOwnedThread(knowledge.id)).id).toBe(knowledge.id);
    await expect(context.contributions.requireOwnedThread(knowledge.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(context.knowledge.requireOwnedThread(contribution.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('manager 本身检查贡献授权与当前账号，知识库不继承贡献授权', async () => {
    const context = fixture();
    const contribution = await context.contributions.create('');
    const knowledge = await context.knowledge.create(context.project.id);
    context.requireRead.mockRejectedValue(new EnterpriseSessionError('ENTERPRISE_DATA_VIEW_FORBIDDEN', 403));
    await expect(context.contributions.latest()).rejects.toMatchObject({ statusCode: 403 });
    await expect(context.contributions.requireOwnedThread(contribution.id)).rejects.toMatchObject({ statusCode: 403 });
    expect((await context.knowledge.requireOwnedThread(knowledge.id)).id).toBe(knowledge.id);
    context.requireRead.mockResolvedValue(undefined);
    context.switchAccount();
    expect(await context.contributions.latest()).toBeUndefined();
    expect(await context.knowledge.latest()).toBeUndefined();
    await expect(context.contributions.requireOwnedThread(contribution.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(context.knowledge.requireOwnedThread(knowledge.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
