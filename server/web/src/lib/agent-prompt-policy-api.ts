import { adminApi } from "./api";

export type AgentPromptPolicy = {
  version: number;
  serverAgentPrompt: string;
  claweeAgentPrompt: string;
  updatedAt: string;
};

type AgentPromptPolicyResponse = {
  version: number;
  server_agent_prompt: string;
  clawee_agent_prompt: string;
  updated_at: string;
};

function mapPolicy(value: AgentPromptPolicyResponse): AgentPromptPolicy {
  return {
    version: value.version,
    serverAgentPrompt: value.server_agent_prompt,
    claweeAgentPrompt: value.clawee_agent_prompt,
    updatedAt: value.updated_at
  };
}

export async function getAgentPromptPolicy(): Promise<AgentPromptPolicy> {
  return mapPolicy(await adminApi.get<AgentPromptPolicyResponse>("/agent-prompt-policy"));
}

export async function updateAgentPromptPolicy(input: {
  serverAgentPrompt: string;
  claweeAgentPrompt: string;
}): Promise<AgentPromptPolicy> {
  return mapPolicy(await adminApi.put<AgentPromptPolicyResponse>("/agent-prompt-policy", {
    server_agent_prompt: input.serverAgentPrompt,
    clawee_agent_prompt: input.claweeAgentPrompt
  }));
}
