import type Database from 'better-sqlite3';
import type { AgentPromptPolicySnapshot } from '../threads/types.js';
import type { EnterpriseHttpClient } from './http-client-2026-07-30.js';
import type { EnterpriseSessionManager } from './session-manager-2026-07-30.js';

export type AgentPromptPolicyCache = AgentPromptPolicySnapshot & {
  gatewayOrigin: string;
  version: number;
  fetchedAt: string;
};

export type AgentPromptPolicyStatus = {
  version: number;
  updated?: number;
  prompt: string;
  promptType: 'server_agent' | 'clawee_agent';
  fetchedAt: string;
};

export type AgentPromptPolicyManager = {
  refresh(): Promise<AgentPromptPolicyCache | undefined>;
  getCached(): AgentPromptPolicyCache;
  status(): AgentPromptPolicyStatus;
};

const EMPTY_SNAPSHOT: AgentPromptPolicySnapshot = {
  serverAgentPrompt: '',
  claweeAgentPrompt: ''
};

export function createAgentPromptPolicyManager(input: {
  db: Database.Database;
  gatewayOrigin?: string;
  getGatewayOrigin?: () => string;
  serverDeployment?: boolean;
  sessionManager: EnterpriseSessionManager;
  httpClient: EnterpriseHttpClient;
}): AgentPromptPolicyManager {
  const read = input.db.prepare<string>(`
    SELECT gateway_origin AS gatewayOrigin, version, server_agent_prompt AS serverAgentPrompt,
      clawee_agent_prompt AS claweeAgentPrompt, fetched_at AS fetchedAt
    FROM agent_prompt_policy_cache WHERE gateway_origin = ?
  `);
  const write = input.db.prepare(`
    INSERT INTO agent_prompt_policy_cache
      (gateway_origin, version, server_agent_prompt, clawee_agent_prompt, fetched_at)
    VALUES (@gatewayOrigin, @version, @serverAgentPrompt, @claweeAgentPrompt, @fetchedAt)
    ON CONFLICT(gateway_origin) DO UPDATE SET
      version = excluded.version,
      server_agent_prompt = excluded.server_agent_prompt,
      clawee_agent_prompt = excluded.clawee_agent_prompt,
      fetched_at = excluded.fetched_at
  `);
  const updatedVersions = new Map<string, number>();

  function gatewayOrigin(): string {
    return input.getGatewayOrigin?.() ?? input.gatewayOrigin ?? '';
  }

  function getCached(): AgentPromptPolicyCache {
    const origin = gatewayOrigin();
    const row = read.get(origin) as AgentPromptPolicyCache | undefined;
    return row === undefined
      ? { gatewayOrigin: origin, version: 0, ...EMPTY_SNAPSHOT, fetchedAt: '' }
      : row;
  }

  return {
    async refresh() {
      if (input.httpClient.getAgentPromptPolicy === undefined) return getCached();
      try {
        const accessToken = await input.sessionManager.requireAccessToken();
        const remote = await input.httpClient.getAgentPromptPolicy(accessToken);
        const previous = getCached();
        if (remote.version < previous.version) return previous;
        const cache: AgentPromptPolicyCache = {
          gatewayOrigin: gatewayOrigin(),
          version: remote.version,
          serverAgentPrompt: remote.serverAgentPrompt,
          claweeAgentPrompt: remote.claweeAgentPrompt,
          fetchedAt: remote.updatedAt
        };
        write.run(cache);
        if (remote.version > previous.version) updatedVersions.set(cache.gatewayOrigin, remote.version);
        return cache;
      } catch {
        return getCached();
      }
    },
    getCached,
    status() {
      const cache = getCached();
      const updated = updatedVersions.get(cache.gatewayOrigin);
      const promptType = input.serverDeployment === true ? 'server_agent' : 'clawee_agent';
      return {
        version: cache.version,
        ...(updated === undefined ? {} : { updated }),
        prompt: promptType === 'server_agent' ? cache.serverAgentPrompt : cache.claweeAgentPrompt,
        promptType,
        fetchedAt: cache.fetchedAt
      };
    }
  };
}
