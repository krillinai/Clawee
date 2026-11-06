import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentPromptPolicyManager
} from '../../src/enterprise/agent-prompt-policy-2026-10-30.js';
import type { EnterpriseHttpClient } from '../../src/enterprise/http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from '../../src/enterprise/session-manager-2026-07-30.js';
import { migrate } from '../../src/storage/migrations.js';

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('Agent 提示词缓存', () => {
  it('拉取失败时沿用最近一次成功缓存，并按当前 Gateway Origin 隔离', async () => {
    db = new Database(':memory:');
    migrate(db);
    let origin = 'https://gateway-a.example';
    const getAgentPromptPolicy = vi.fn()
      .mockResolvedValueOnce({
        version: 3,
        serverAgentPrompt: 'A server',
        claweeAgentPrompt: 'A clawee',
        updatedAt: '2026-10-30T00:00:00Z'
      })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        version: 1,
        serverAgentPrompt: 'B server',
        claweeAgentPrompt: 'B clawee',
        updatedAt: '2026-10-30T01:00:00Z'
      });
    const manager = createAgentPromptPolicyManager({
      db,
      getGatewayOrigin: () => origin,
      sessionManager: {
        requireAccessToken: vi.fn(async () => 'token')
      } as unknown as EnterpriseSessionManager,
      httpClient: { getAgentPromptPolicy } as unknown as EnterpriseHttpClient
    });

    await expect(manager.refresh()).resolves.toMatchObject({
      gatewayOrigin: 'https://gateway-a.example',
      version: 3,
      serverAgentPrompt: 'A server'
    });
    await expect(manager.refresh()).resolves.toMatchObject({
      gatewayOrigin: 'https://gateway-a.example',
      version: 3,
      claweeAgentPrompt: 'A clawee'
    });

    origin = 'https://gateway-b.example';
    await expect(manager.refresh()).resolves.toMatchObject({
      gatewayOrigin: 'https://gateway-b.example',
      version: 1,
      serverAgentPrompt: 'B server'
    });
    expect(manager.getCached().gatewayOrigin).toBe('https://gateway-b.example');
    expect(manager.status()).toEqual({
      version: 1,
      updated: 1,
      prompt: 'B clawee',
      promptType: 'clawee_agent',
      fetchedAt: '2026-10-30T01:00:00Z'
    });
  });

  it('服务端部署只暴露服务端 Agent 提示词片段', async () => {
    db = new Database(':memory:');
    migrate(db);
    const getAgentPromptPolicy = vi.fn().mockResolvedValue({
      version: 2,
      serverAgentPrompt: 'Server prompt',
      claweeAgentPrompt: 'Clawee prompt',
      updatedAt: '2026-10-30T02:00:00Z'
    });
    const manager = createAgentPromptPolicyManager({
      db,
      serverDeployment: true,
      gatewayOrigin: 'https://gateway.example',
      sessionManager: {
        requireAccessToken: vi.fn(async () => 'token')
      } as unknown as EnterpriseSessionManager,
      httpClient: { getAgentPromptPolicy } as unknown as EnterpriseHttpClient
    });

    await manager.refresh();

    expect(manager.status()).toEqual({
      version: 2,
      updated: 2,
      prompt: 'Server prompt',
      promptType: 'server_agent',
      fetchedAt: '2026-10-30T02:00:00Z'
    });
  });
});
