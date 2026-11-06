import type { FastifyInstance } from 'fastify';
import type { AgentPromptPolicyManager } from '../enterprise/agent-prompt-policy-2026-10-30.js';

export async function registerAgentPromptPolicyRoutes(
  server: FastifyInstance,
  manager: AgentPromptPolicyManager
): Promise<void> {
  server.get('/agent-prompt-policy/status', async () => manager.status());
}
