import { adminApi } from "./api";
export type AccountStatus = "active" | "disabled";

export type AccountAgent = {
  agentId: string;
  clientId: string;
  name?: string;
  status: string;
  actorId?: string;
  updatedAt?: string;
};

export type Account = {
  userId: string;
  email: string;
  name: string;
  status: AccountStatus;
  agent: AccountAgent | null;
};

export type CreateAccountInput = {
  email: string;
  name: string;
  password: string;
  status?: AccountStatus;
};

export type AccountGovernanceResult = {
  action: "agent_transfer" | "account_merge";
  agentIds: string[];
  sourceUserId: string;
  targetUserId: string;
  tokensPreserved: boolean;
  grantsPreserved: boolean;
  tokenCount: number;
  grantCount: number;
  completedAt: string;
};

type AccountGovernanceResponse = {
  action: "agent_transfer" | "account_merge";
  agent_ids: string[];
  source_user_id: string;
  target_user_id: string;
  tokens_preserved: boolean;
  grants_preserved: boolean;
  token_count: number;
  grant_count: number;
  completed_at: string;
};

type AccountAgentResponse = {
  agent_id?: string;
  agentId?: string;
  AgentID?: string;
  client_id?: string;
  clientId?: string;
  ClientID?: string;
  name?: string;
  Name?: string;
  status?: string;
  Status?: string;
  actor_id?: string;
  actorId?: string;
  ActorID?: string;
  updated_at?: string;
  updatedAt?: string;
  UpdatedAt?: string;
};

type AccountResponse = {
  user_id?: string;
  userId?: string;
  email: string;
  name?: string;
  status: AccountStatus;
  agent?: AccountAgentResponse | null;
};

function mapAccountAgent(agent?: AccountAgentResponse | null): AccountAgent | null {
  if (!agent) return null;
  return {
    agentId: agent.agent_id ?? agent.agentId ?? agent.AgentID ?? "",
    clientId: agent.client_id ?? agent.clientId ?? agent.ClientID ?? "",
    name: agent.name ?? agent.Name ?? "",
    status: agent.status ?? agent.Status ?? "",
    actorId: agent.actor_id ?? agent.actorId ?? agent.ActorID,
    updatedAt: agent.updated_at ?? agent.updatedAt ?? agent.UpdatedAt
  };
}

function mapAccount(account: AccountResponse): Account {
  return {
    userId: account.userId ?? account.user_id ?? "",
    email: account.email,
    name: account.name ?? "",
    status: account.status,
    agent: mapAccountAgent(account.agent)
  };
}

export async function listAccounts(): Promise<Account[]> {
  const response = await adminApi.get<{ items: AccountResponse[] }>("/accounts");
  return response.items.map(mapAccount);
}

export async function createAccount(input: CreateAccountInput): Promise<Account> {
  return mapAccount(await adminApi.post<AccountResponse>("/accounts", input));
}

export async function updateAccountStatus(userId: string, status: AccountStatus): Promise<Account> {
  return mapAccount(
    await adminApi.patch<AccountResponse>("/accounts", { user_id: userId, status })
  );
}

export async function updateAccountName(userId: string, name: string): Promise<Account> {
  return mapAccount(
    await adminApi.patch<AccountResponse>("/accounts", { user_id: userId, name })
  );
}

export async function resetAccountPassword(userId: string, password: string): Promise<Account> {
  return mapAccount(
		await adminApi.post<AccountResponse>("/accounts/password/reset", { user_id: userId, password })
  );
}

export async function mergeAccounts(input: { sourceUserId: string; targetUserId: string; reason: string }): Promise<AccountGovernanceResult> {
  const response = await adminApi.post<AccountGovernanceResponse>("/accounts/merge", {
    source_user_id: input.sourceUserId,
    target_user_id: input.targetUserId,
    reason: input.reason
  });
  return mapAccountGovernanceResult(response);
}

function mapAccountGovernanceResult(response: AccountGovernanceResponse): AccountGovernanceResult {
  return {
    action: response.action,
    agentIds: response.agent_ids,
    sourceUserId: response.source_user_id,
    targetUserId: response.target_user_id,
    tokensPreserved: response.tokens_preserved,
    grantsPreserved: response.grants_preserved,
    tokenCount: response.token_count,
    grantCount: response.grant_count,
    completedAt: response.completed_at
  };
}
