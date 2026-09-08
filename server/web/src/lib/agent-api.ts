import { appApi } from "./api";
import type { CollectorStatus } from "./office-api";

export type AgentAccess = {
  account: { userId: string; email: string; name: string };
  agent: {
    agentId: string;
    clientId: string;
    actorId: string;
    status: string;
    name?: string;
    creationSource?: string;
    collector?: AgentCollectorInfo;
    updatedAt?: string;
  };
};

export type AgentCollectorInfo = {
  collectorId: string;
  officeAgentId: string;
  deviceId: string;
  deviceName: string;
  hostname: string;
  os: string;
  arch: string;
  collectorVersion: string;
  lastSeenAt?: string;
  status?: CollectorStatus;
};

export type AccountTokenInfo = {
  userId: string;
  tokenId: string;
  tokenFingerprint: string;
  tokenStatus: string;
  tokenExpiresAt: string | null;
  tokenLastUsedAt: string | null;
  tokenIssuer: string;
  tokenScopes: string[];
  createdAt: string;
};

export type AccountTokenSecret = {
  token: string;
  authorizationHeader: string;
  tokenInfo: AccountTokenInfo;
};

export type AccountTokenRevocation = {
  userId: string;
  revokedTokenCount: number;
  tokenStatus: string;
};

export type AgentTool = {
  id: string;
  exposedName: string;
  title: string;
  description: string;
  upstreamServerId: string;
  riskLevel: string;
  confirmRequired: boolean;
  expiresAt: string | null;
};

export type AgentMCPTool = {
  id: string;
  upstreamName: string;
  name: string;
  exposedName: string;
  title: string;
  description: string;
  riskLevel: string;
  confirmRequired: boolean;
  status: string;
  authorized: boolean;
  authorizationExpiresAt: string | null;
};

export type AgentMCPUpstream = {
  id: string;
  name: string;
  domain: string;
  iconUrl: string;
  mcpEndpoint: string;
  upstreamTransport: string;
  namespace: string;
  status: string;
  tools: AgentMCPTool[];
};

export type AgentMCPCatalog = {
  upstreams: AgentMCPUpstream[];
};

type AgentAccessResponse = {
  account: {
    user_id?: string;
    userId?: string;
    email: string;
    name?: string;
  };
  agent: {
    agent_id?: string;
    AgentID?: string;
    agentId?: string;
    client_id?: string;
    ClientID?: string;
    clientId?: string;
    actor_id?: string;
    ActorID?: string;
    actorId?: string;
    Name?: string;
    name?: string;
    Status?: string;
    status?: string;
    creation_source?: string;
    CreationSource?: string;
    creationSource?: string;
    collector?: AgentCollectorInfoResponse;
    Collector?: AgentCollectorInfoResponse;
    updated_at?: string;
    UpdatedAt?: string;
    updatedAt?: string;
  };
};

type AgentCollectorInfoResponse = {
  collector_id?: string;
  collectorId?: string;
  office_agent_id?: string;
  officeAgentId?: string;
  device_id?: string;
  deviceId?: string;
  device_name?: string;
  deviceName?: string;
  hostname?: string;
  os?: string;
  arch?: string;
  collector_version?: string;
  collectorVersion?: string;
  last_seen_at?: string;
  lastSeenAt?: string;
  status?: CollectorStatus;
};

type AccountTokenInfoResponse = {
  token?: AccountTokenInfoResponse;
  user_id?: string;
  userId?: string;
  token_id?: string;
  TokenID?: string;
  tokenId?: string;
  token_fingerprint?: string;
  TokenFingerprint?: string;
  tokenFingerprint?: string;
  token_status?: string;
  TokenStatus?: string;
  tokenStatus?: string;
  token_expires_at?: string | null;
  TokenExpiresAt?: string | null;
  tokenExpiresAt?: string | null;
  token_last_used_at?: string | null;
  tokenLastUsedAt?: string | null;
  token_issuer?: string;
  tokenIssuer?: string;
  token_scopes?: string[];
  TokenScopes?: string[];
  tokenScopes?: string[];
  created_at?: string;
  createdAt?: string;
};

type AccountTokenSecretResponse = {
  token_id?: string;
  token_type?: string;
  fingerprint?: string;
  status?: string;
  expires_at?: string | null;
  scopes?: string[];
  created_at?: string;
  plaintext?: string;
  token?: string | AccountTokenInfoResponse;
  token_info?: AccountTokenInfoResponse;
  tokenInfo?: AccountTokenInfoResponse;
  authorization_header?: string;
};

type AccountTokenRevocationResponse = {
  user_id: string;
  revoked_token_count: number;
  token_status: string;
};

type AgentToolResponse = {
  ID?: string;
  id?: string;
  Name?: string;
  exposed_name?: string;
  exposedName?: string;
  Title?: string;
  title?: string;
  Description?: string;
  description?: string;
  upstream_server_id?: string;
  UpstreamServerID?: string;
  upstreamServerId?: string;
  risk_level?: string;
  RiskLevel?: string;
  riskLevel?: string;
  confirm_required?: boolean;
  ConfirmRequired?: boolean;
  confirmRequired?: boolean;
  expires_at?: string | null;
  ExpiresAt?: string | null;
  expiresAt?: string | null;
};

type AgentMCPCatalogResponse = {
  upstreams: Array<{
    id: string;
    name: string;
    domain: string;
    icon_url: string;
    mcp_endpoint: string;
    upstream_transport: string;
    namespace: string;
    status: string;
    tools: Array<{
      id: string;
      upstream_name: string;
      name: string;
      exposed_name: string;
      title: string;
      description: string;
      risk_level: string;
      confirm_required: boolean;
      status: string;
      authorized: boolean;
      authorization_expires_at: string | null;
    }>;
  }>;
};

function mapAgentAccess(response: AgentAccessResponse): AgentAccess {
  const collector = response.agent.collector ?? response.agent.Collector;
  return {
    account: {
      userId: response.account.userId ?? response.account.user_id ?? "",
      email: response.account.email,
      name: response.account.name ?? "",
    },
    agent: {
      agentId: response.agent.agent_id ?? response.agent.agentId ?? response.agent.AgentID ?? "",
      clientId: response.agent.client_id ?? response.agent.clientId ?? response.agent.ClientID ?? "",
      actorId: response.agent.actor_id ?? response.agent.actorId ?? response.agent.ActorID ?? "",
      name: response.agent.name ?? response.agent.Name ?? "",
      status: response.agent.status ?? response.agent.Status ?? "",
      creationSource: response.agent.creation_source ?? response.agent.creationSource ?? response.agent.CreationSource ?? "",
      collector: collector ? mapAgentCollectorInfo(collector) : undefined,
      updatedAt: response.agent.updated_at ?? response.agent.updatedAt ?? response.agent.UpdatedAt
    }
  };
}

function mapAgentCollectorInfo(response: AgentCollectorInfoResponse): AgentCollectorInfo {
  return {
    collectorId: response.collector_id ?? response.collectorId ?? "",
    officeAgentId: response.office_agent_id ?? response.officeAgentId ?? "",
    deviceId: response.device_id ?? response.deviceId ?? "",
    deviceName: response.device_name ?? response.deviceName ?? "",
    hostname: response.hostname ?? "",
    os: response.os ?? "",
    arch: response.arch ?? "",
    collectorVersion: response.collector_version ?? response.collectorVersion ?? "",
    lastSeenAt: response.last_seen_at ?? response.lastSeenAt,
    status: response.status
  };
}

function mapTokenInfo(response: AccountTokenInfoResponse): AccountTokenInfo {
  const token = response.token ?? response;
  return {
    userId: token.user_id ?? token.userId ?? "",
    tokenId: token.token_id ?? token.tokenId ?? token.TokenID ?? "",
    tokenFingerprint: token.token_fingerprint ?? token.tokenFingerprint ?? token.TokenFingerprint ?? "",
    tokenStatus: token.token_status ?? token.tokenStatus ?? token.TokenStatus ?? "",
    tokenExpiresAt: token.token_expires_at ?? token.tokenExpiresAt ?? token.TokenExpiresAt ?? null,
    tokenLastUsedAt: token.token_last_used_at ?? token.tokenLastUsedAt ?? null,
    tokenIssuer: token.token_issuer ?? token.tokenIssuer ?? "",
    tokenScopes: token.token_scopes ?? token.tokenScopes ?? token.TokenScopes ?? [],
    createdAt: token.created_at ?? token.createdAt ?? ""
  };
}

function mapTokenCopy(response: AccountTokenSecretResponse): AccountTokenSecret {
  const tokenInfo = response.token_info ?? response.tokenInfo ?? (typeof response.token === "object" ? response.token : {
    token_id: response.token_id,
    token_fingerprint: response.fingerprint,
    token_status: response.status,
    token_expires_at: response.expires_at,
    token_scopes: response.scopes
  });
  const token = typeof response.token === "string" ? response.token : response.plaintext ?? "";
  return {
    token,
    authorizationHeader: response.authorization_header ?? "",
    tokenInfo: mapTokenInfo(tokenInfo ?? {})
  };
}

function mapTool(tool: AgentToolResponse): AgentTool {
  return {
    id: tool.id ?? tool.ID ?? "",
    exposedName: tool.exposed_name ?? tool.exposedName ?? tool.Name ?? "",
    title: tool.title ?? tool.Title ?? "",
    description: tool.description ?? tool.Description ?? "",
    upstreamServerId: tool.upstream_server_id ?? tool.upstreamServerId ?? tool.UpstreamServerID ?? "",
    riskLevel: tool.risk_level ?? tool.riskLevel ?? tool.RiskLevel ?? "",
    confirmRequired: tool.confirm_required ?? tool.confirmRequired ?? tool.ConfirmRequired ?? false,
    expiresAt: tool.expires_at ?? tool.expiresAt ?? tool.ExpiresAt ?? null
  };
}

export async function getAgentAccess(agentId?: string) {
	if (agentId) {
		return mapAgentAccess(await appApi.get<AgentAccessResponse>(`/agents/detail?agent_id=${encodeURIComponent(agentId)}`));
	}
	const items = await listMyAgents();
	return items[0];
}

export async function listMyAgents(): Promise<AgentAccess[]> {
	const response = await appApi.get<{ items: AgentAccessResponse[] }>("/agents");
	return response.items.map(mapAgentAccess);
}

export async function updateMyAgentName(agentId: string, name: string): Promise<AgentAccess> {
	return mapAgentAccess(await appApi.patch<AgentAccessResponse>("/agents/name", { agent_id: agentId, name }));
}

export function deleteMyAgent(agentId: string) {
	return appApi.post<void>("/agents/remove", { agent_id: agentId });
}

export async function getMyAccountToken() {
		return mapTokenInfo(await appApi.get<AccountTokenInfoResponse>("/mcp/token"));
}

export async function revealMyAccountToken() {
		return mapTokenCopy(await appApi.post<AccountTokenSecretResponse>("/mcp/token/reveal"));
}

export async function rotateMyAccountToken() {
		return mapTokenCopy(await appApi.post<AccountTokenSecretResponse>("/mcp/token/rotate", { scopes: ["mcp:call"] }));
}

export async function revokeMyAccountToken(): Promise<AccountTokenRevocation> {
		const response = await appApi.post<AccountTokenRevocationResponse>("/mcp/token/revoke");
    return {
      userId: response.user_id,
      revokedTokenCount: response.revoked_token_count,
      tokenStatus: response.token_status
    };
}

export async function listMyAgentTools(agentId?: string) {
	const query = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
	const response = await appApi.get<{ items: AgentToolResponse[] }>(`/agents/tools${query}`);
  return { items: response.items.map(mapTool) };
}

export async function listMyMCPCatalog(): Promise<AgentMCPCatalog> {
  const response = await appApi.get<AgentMCPCatalogResponse>("/mcp/catalog");
  return {
    upstreams: response.upstreams.map((upstream) => ({
      id: upstream.id,
      name: upstream.name,
      domain: upstream.domain,
      iconUrl: upstream.icon_url,
      mcpEndpoint: upstream.mcp_endpoint,
      upstreamTransport: upstream.upstream_transport,
      namespace: upstream.namespace,
      status: upstream.status,
      tools: upstream.tools.map((tool) => ({
        id: tool.id,
        upstreamName: tool.upstream_name,
        name: tool.name,
        exposedName: tool.exposed_name,
        title: tool.title,
        description: tool.description,
        riskLevel: tool.risk_level,
        confirmRequired: tool.confirm_required,
        status: tool.status,
        authorized: tool.authorized,
        authorizationExpiresAt: tool.authorization_expires_at
      }))
    }))
  };
}
