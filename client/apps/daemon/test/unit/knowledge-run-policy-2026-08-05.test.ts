import { describe, expect, it } from 'vitest';
import { createAgentCapabilityTokenStore } from '../../src/agent-tools/capability-token.js';
import {
  AGENT_SCHEDULE_MCP_SERVER_NAME,
  createAgentScheduleRunInjector
} from '../../src/agent-tools/run-injection.js';
import { shouldAutomaticallyRotateRun } from '../../src/runs/manager.js';
import type { RuntimeThread } from '../../src/threads/types.js';

describe('legacy knowledge thread compatibility', () => {
  it('does not rotate an API run only because the thread has enterprise knowledge metadata', () => {
    expect(shouldAutomaticallyRotateRun({
      threadId: 'thread-a',
      prompt: 'policy',
      createdBy: 'api'
    }, knowledgeThread())).toBe(false);
    expect(shouldAutomaticallyRotateRun({
      threadId: 'thread-a',
      prompt: 'policy',
      createdBy: 'schedule'
    }, knowledgeThread())).toBe(true);
  });

  it('uses the same schedule tool injection as an ordinary conversation', () => {
    const capabilities = createAgentCapabilityTokenStore();
    const injector = createAgentScheduleRunInjector({
      capabilities,
      getBaseUrl: () => 'http://127.0.0.1:43123'
    });

    const injection = injector.prepare({
      runId: 'run-a',
      thread: knowledgeThread(),
      createdBy: 'api'
    });

    expect(injection).toMatchObject({
      mcpServers: [{ name: AGENT_SCHEDULE_MCP_SERVER_NAME }]
    });
    expect(injection).not.toHaveProperty('builtInTools');
    expect(JSON.stringify(injection)).not.toContain('clawee_knowledge');
    expect(capabilities.inspect(
      injection!.env.CLAWEE_AGENT_CAPABILITY_TOKEN
    ).scopes).toEqual([
      'schedule:create',
      'schedule:update',
      'schedule:pause',
      'schedule:resume',
      'schedule:run_now',
      'schedule:get'
    ]);
    capabilities.close();
  });

  it('does not create an internal knowledge MCP when schedule tools are disabled', () => {
    const capabilities = createAgentCapabilityTokenStore();
    const injector = createAgentScheduleRunInjector({
      capabilities,
      getBaseUrl: () => 'http://127.0.0.1:43123',
      scheduleToolsEnabled: false
    });

    expect(injector.prepare({
      runId: 'run-a',
      thread: knowledgeThread(),
      createdBy: 'api'
    })).toBeUndefined();
    capabilities.close();
  });
});

function knowledgeThread(): RuntimeThread {
  return {
    id: 'thread-a',
    title: '历史知识库对话',
    projectId: 'project-a',
    enterpriseSubjectId: 'acct-a',
    origin: 'clawee_created',
    cwd: '/workspace/project-a',
    canonicalCwd: '/workspace/project-a',
    workspaceMode: 'external',
    profile: 'default',
    model: null,
    reasoning: null,
    sandbox: 'workspace-write',
    status: 'active',
    purpose: 'conversation',
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z'
  };
}
