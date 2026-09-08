import { adminApi } from "./api";
import type { CollectorStatus } from "./office-api";

type ListResponse<T> = {
  items: T[];
};

type MCPUpstreamServerResponse = {
  ID: string;
  Name: string;
  Domain: string;
  Transport: string;
  Endpoint: string;
  Stdio?: MCPStdioConfigResponse;
  AuthType: string;
  CredentialRef: string;
  HasToken?: boolean;
  OwnerTeam: string;
  Namespace: string;
  RoutingDescription?: string;
  CollectorID?: string;
  Status: string;
  CapabilitiesCount?: number;
  LastSyncedAt?: string | null;
  LastSyncResult?: string;
  MCPEndpoint?: string;
  mcp_endpoint?: string;
  MCPCanonicalEndpoint?: string;
  mcp_canonical_endpoint?: string;
  ResourceMetadataURL?: string;
  resource_metadata_url?: string;
  CanonicalResourceMetadataURL?: string;
  canonical_resource_metadata_url?: string;
  CreatedAt: string;
  UpdatedAt: string;
};

export type MCPStdioConfig = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

type MCPStdioConfigResponse = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

type MCPStatusResponse = {
  ID: string;
  Status: string;
  UpdatedAt: string;
};

type MCPCapabilityStatusResponse = MCPStatusResponse & {
  ExposedName: string;
};

type MCPAgentResponse = {
  AgentID: string;
  BoundUserID?: string;
  BoundUserName?: string;
  BoundUserEmail?: string;
  ClientID: string;
  Name: string;
  TenantID: string;
  ActorID: string;
  Status: string;
  CreationSource?: string;
  creation_source?: string;
  creationSource?: string;
  Collector?: MCPAgentCollectorResponse;
  collector?: MCPAgentCollectorResponse;
  CreatedAt: string;
  UpdatedAt: string;
};

type MCPAgentCollectorResponse = {
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

type MCPAccountTokenInfoResponse = {
  user_id: string;
  token_id: string;
  token_fingerprint: string;
  token_status: string;
  token_expires_at: string | null;
  token_last_used_at?: string | null;
  token_issuer: string;
  token_scopes: string[];
  created_at: string;
};

type MCPAccountTokenResponseBody = {
  token: string;
  authorization_header: string;
  token_info: MCPAccountTokenInfoResponse;
};

type MCPRevokedTokenResponse = {
  user_id: string;
  revoked_token_count: number;
  token_status: string;
};

type MCPCapabilityResponse = {
  ID: string;
  UpstreamServerID: string;
  Type: string;
  UpstreamName: string;
  ExposedName: string;
  Title: string;
  Description: string;
  InputSchema: unknown;
  OutputSchema: unknown;
  Annotations: unknown;
  RiskLevel: string;
  ReadOnly: boolean;
  Destructive: boolean;
  Idempotent: boolean;
  ApprovalRequired: boolean;
  ConfirmRequired: boolean;
  ConfirmTemplate: string;
  Status: string;
  SchemaHash: string;
  Version: string;
  LastSyncedAt: string | null;
  CreatedAt: string;
  UpdatedAt: string;
};

type MCPGrantResponse = {
  ID: string;
  UserID: string;
  CapabilityID: string;
  GrantType: string;
  DataScope: unknown;
  ExpiresAt: string | null;
  CreatedBy: string;
  CreatedAt: string;
  UpdatedAt: string;
};

type MCPAuditResponse = {
  ID: string;
  TraceID: string;
  RequestID: string;
  InboundSessionID: string;
  UpstreamSessionID: string;
  AgentID: string;
  ActorID: string;
  TenantID: string;
  TokenID: string;
  TokenHash: string;
  EndpointType?: string;
  EndpointUpstreamServerID?: string;
  UpstreamServerID: string;
  CapabilityID: string;
  CapabilityType: string;
  ExposedName: string;
  UpstreamName: string;
  RequestHeaders: Record<string, string>;
  RequestBody: unknown;
  ResponseHeaders: Record<string, string>;
  ResponseBody: unknown;
  Decision: string;
  DecisionReason: string;
  Error: string;
  DurationMS: number;
  CreatedAt: string;
  CompletedAt: string;
};

type MCPGateParameterResponse = {
  path: string;
  label: string;
  value: string;
  sensitive: boolean;
};

type MCPGateSummaryResponse = {
  system: string;
  action: string;
  object: string;
  tool: string;
  risk_level: string;
  destructive: boolean;
  read_only: boolean;
  parameters?: MCPGateParameterResponse[];
  risks?: string[];
};

type MCPGateResponse = {
  ID: string;
  Type: string;
  Provider: string;
  TraceID: string;
  TenantID: string;
  AgentID: string;
  ActorID: string;
  CapabilityID: string;
  UpstreamServerID: string;
  ExposedName: string;
  UpstreamName: string;
  RequestBody: unknown;
  ArgumentsHash: string;
  SchemaHash: string;
  GateSummary: MCPGateSummaryResponse;
  Status: string;
  ConfirmURL: string;
  DecidedBy: string;
  DecisionReason: string;
  DecidedAt: string | null;
  ExpiresAt: string;
  ExecutionAuditID: string;
  ResponseBody: unknown;
  Error: string;
  CreatedAt: string;
  UpdatedAt: string;
  ExternalInstanceID?: string;
  ExternalURL?: string;
};

export type CreateUpstreamServerInput = {
  serverId: string;
  name: string;
  domain: string;
  transport: string;
  endpoint: string;
  stdio?: MCPStdioConfig;
  namespace: string;
  ownerTeam: string;
  routingDescription?: string;
  collectorId?: string;
  token?: string;
};

export type CreateMCPAgentInput = {
  userId: string;
  agentId: string;
  clientId?: string;
  name?: string;
  tenantId?: string;
  actorId?: string;
  status?: string;
};

export type RotateMCPAccountTokenInput = {
  expiresAt?: string;
  scopes?: string[];
};

export type CreateMCPGrantInput = {
  userId: string;
  capabilityId: string;
  grantType: string;
  dataScope?: unknown;
  expiresAt?: string;
};

export type UpdateMCPCapabilityGatesInput = {
  approvalRequired: boolean;
  confirmRequired: boolean;
};

export type MCPUpstreamServerFilters = {
  status?: string;
  domain?: string;
};

export type MCPCapabilityFilters = {
  serverId?: string;
  type?: string;
  status?: string;
  domain?: string;
  riskLevel?: string;
};

export type MCPAgentFilters = {
  status?: string;
};

export type MCPGrantFilters = {
  userId?: string;
  capabilityId?: string;
  grantType?: string;
};

export type MCPAuditFilters = {
  limit?: number;
  decision?: string;
  agentId?: string;
  upstreamServerId?: string;
  tool?: string;
  createdFrom?: string;
  createdTo?: string;
  errorOnly?: boolean;
};

export type MCPGateFilters = {
  limit?: number;
  status?: string;
  gateType?: string;
  agentId?: string;
  actorId?: string;
  tenantId?: string;
  capabilityId?: string;
  createdFrom?: string;
  createdTo?: string;
};

export type MCPUpstreamServer = {
  id: string;
  name: string;
  domain: string;
  transport: string;
  endpoint: string;
  stdio?: MCPStdioConfig;
  authType: string;
  credentialRef: string;
  hasToken?: boolean;
  ownerTeam: string;
  namespace: string;
  routingDescription?: string;
  collectorId?: string;
  status: string;
  capabilitiesCount?: number;
  lastSyncedAt?: string | null;
  lastSyncResult?: string;
  mcpEndpoint?: string;
  mcpCanonicalEndpoint?: string;
  resourceMetadataUrl?: string;
  canonicalResourceMetadataUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type MCPCapability = {
  id: string;
  upstreamServerId: string;
  type: string;
  upstreamName: string;
  exposedName: string;
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: unknown;
  riskLevel: string;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  approvalRequired: boolean;
  confirmRequired: boolean;
  confirmTemplate: string;
  status: string;
  schemaHash: string;
  version: string;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MCPAgent = {
  agentId: string;
  boundUserId?: string;
  boundUserName?: string;
  boundUserEmail?: string;
  clientId: string;
  name: string;
  tenantId: string;
  actorId: string;
  status: string;
  creationSource?: string;
  collector?: MCPAgentCollector;
  createdAt: string;
  updatedAt: string;
};

export type MCPAgentCollector = {
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

export type MCPGrant = {
  id: string;
  userId: string;
  capabilityId: string;
  grantType: string;
  dataScope: unknown;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type MCPAudit = {
  id: string;
  traceId: string;
  requestId: string;
  inboundSessionId: string;
  upstreamSessionId: string;
  agentId: string;
  actorId: string;
  tenantId: string;
  tokenId: string;
  tokenHash: string;
  endpointType?: string;
  endpointUpstreamServerId?: string;
  upstreamServerId: string;
  capabilityId: string;
  capabilityType: string;
  exposedName: string;
  upstreamName: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  decision: string;
  decisionReason: string;
  error: string;
  durationMs: number;
  createdAt: string;
  completedAt: string;
};

export type MCPGateParameter = {
  path: string;
  label: string;
  value: string;
  sensitive: boolean;
};

export type MCPGateSummary = {
  system: string;
  action: string;
  object: string;
  tool: string;
  riskLevel: string;
  destructive: boolean;
  readOnly: boolean;
  parameters: MCPGateParameter[];
  risks: string[];
};

export type MCPGate = {
  id: string;
  type: string;
  provider: string;
  traceId: string;
  tenantId: string;
  agentId: string;
  actorId: string;
  capabilityId: string;
  upstreamServerId: string;
  exposedName: string;
  upstreamName: string;
  requestBody: unknown;
  argumentsHash: string;
  schemaHash: string;
  gateSummary: MCPGateSummary;
  status: string;
  confirmUrl: string;
  decidedBy: string;
  decisionReason: string;
  decidedAt: string | null;
  expiresAt: string;
  executionAuditId: string;
  responseBody: unknown;
  error: string;
  createdAt: string;
  updatedAt: string;
  externalInstanceId: string;
  externalUrl: string;
};

export type MCPAccountTokenResponse = {
  token: string;
  authorizationHeader: string;
  tokenInfo: {
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
};

export type MCPAccountTokenInfo = MCPAccountTokenResponse["tokenInfo"];

export type MCPRevokedToken = {
  userId: string;
  revokedTokenCount: number;
  tokenStatus: string;
};

export type MCPStatusUpdate = {
  id: string;
  status: string;
  updatedAt: string;
};

export type MCPCapabilityStatusUpdate = MCPStatusUpdate & {
  exposedName: string;
};

function queryString(params: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  });
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function responseField<T>(record: object, legacyName: string, snakeName: string): T {
  const fields = record as Record<string, unknown>;
  return (fields[snakeName] ?? fields[legacyName]) as T;
}

function mapUpstreamServer(server: MCPUpstreamServerResponse): MCPUpstreamServer {
  const mcpEndpoint = responseField<string | undefined>(server, "MCPEndpoint", "mcp_endpoint");
  const mcpCanonicalEndpoint = responseField<string | undefined>(server, "MCPCanonicalEndpoint", "mcp_canonical_endpoint");
  const resourceMetadataUrl = responseField<string | undefined>(server, "ResourceMetadataURL", "resource_metadata_url");
  const canonicalResourceMetadataUrl = responseField<string | undefined>(server, "CanonicalResourceMetadataURL", "canonical_resource_metadata_url");
  return {
    id: responseField(server, "ID", "id"),
    name: responseField(server, "Name", "name"),
    domain: responseField(server, "Domain", "domain"),
    transport: responseField(server, "Transport", "transport"),
    endpoint: responseField(server, "Endpoint", "endpoint"),
    stdio: mapStdioConfig(responseField(server, "Stdio", "stdio")),
    authType: responseField(server, "AuthType", "auth_type"),
    credentialRef: responseField(server, "CredentialRef", "credential_ref"),
    hasToken: Boolean(responseField(server, "HasToken", "has_token")),
    ownerTeam: responseField(server, "OwnerTeam", "owner_team"),
    namespace: responseField(server, "Namespace", "namespace"),
    routingDescription: responseField(server, "RoutingDescription", "routing_description") ?? "",
    collectorId: responseField(server, "CollectorID", "collector_id") ?? "",
    status: responseField(server, "Status", "status"),
    capabilitiesCount: responseField(server, "CapabilitiesCount", "capabilities_count"),
    lastSyncedAt: responseField(server, "LastSyncedAt", "last_synced_at"),
    lastSyncResult: responseField(server, "LastSyncResult", "last_sync_result"),
    ...(mcpEndpoint ? { mcpEndpoint } : {}),
    ...(mcpCanonicalEndpoint ? { mcpCanonicalEndpoint } : {}),
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(canonicalResourceMetadataUrl ? { canonicalResourceMetadataUrl } : {}),
    createdAt: responseField(server, "CreatedAt", "created_at"),
    updatedAt: responseField(server, "UpdatedAt", "updated_at")
  };
}

function mapStatusUpdate(update: MCPStatusResponse): MCPStatusUpdate {
  return {
    id: responseField(update, "ID", "id"),
    status: responseField(update, "Status", "status"),
    updatedAt: responseField(update, "UpdatedAt", "updated_at")
  };
}

function mapCapabilityStatusUpdate(update: MCPCapabilityStatusResponse): MCPCapabilityStatusUpdate {
  return {
    ...mapStatusUpdate(update),
    exposedName: responseField(update, "ExposedName", "exposed_name")
  };
}

function mapAgent(agent: MCPAgentResponse): MCPAgent {
  const collector = agent.Collector ?? agent.collector;
  return {
    agentId: responseField(agent, "AgentID", "agent_id"),
    boundUserId: responseField(agent, "BoundUserID", "bound_user_id"),
    boundUserName: responseField(agent, "BoundUserName", "bound_user_name"),
    boundUserEmail: responseField(agent, "BoundUserEmail", "bound_user_email"),
    clientId: responseField(agent, "ClientID", "client_id"),
    name: responseField(agent, "Name", "name"),
    tenantId: responseField(agent, "TenantID", "tenant_id"),
    actorId: responseField(agent, "ActorID", "actor_id"),
    status: responseField(agent, "Status", "status"),
    creationSource: responseField(agent, "CreationSource", "creation_source") ?? agent.creationSource,
    collector: collector ? {
      collectorId: collector.collector_id ?? collector.collectorId ?? "",
      officeAgentId: collector.office_agent_id ?? collector.officeAgentId ?? "",
      deviceId: collector.device_id ?? collector.deviceId ?? "",
      deviceName: collector.device_name ?? collector.deviceName ?? "",
      hostname: collector.hostname ?? "",
      os: collector.os ?? "",
      arch: collector.arch ?? "",
      collectorVersion: collector.collector_version ?? collector.collectorVersion ?? "",
      lastSeenAt: collector.last_seen_at ?? collector.lastSeenAt,
      status: collector.status
    } : undefined,
    createdAt: responseField(agent, "CreatedAt", "created_at"),
    updatedAt: responseField(agent, "UpdatedAt", "updated_at")
  };
}

function mapAccountTokenResponse(response: MCPAccountTokenResponseBody): MCPAccountTokenResponse {
  const tokenInfo = mapAccountTokenInfo(response.token_info);
  return {
    token: response.token,
    authorizationHeader: response.authorization_header,
    tokenInfo
  };
}

function mapAccountTokenInfo(response: MCPAccountTokenInfoResponse): MCPAccountTokenInfo {
  return {
    userId: response.user_id,
    tokenId: response.token_id,
    tokenFingerprint: response.token_fingerprint,
    tokenStatus: response.token_status,
    tokenExpiresAt: response.token_expires_at,
    tokenLastUsedAt: response.token_last_used_at ?? null,
    tokenIssuer: response.token_issuer,
    tokenScopes: response.token_scopes,
    createdAt: response.created_at
  };
}

function mapRevokedToken(token: MCPRevokedTokenResponse): MCPRevokedToken {
  return {
    userId: token.user_id,
    revokedTokenCount: token.revoked_token_count,
    tokenStatus: token.token_status
  };
}

function mapCapability(capability: MCPCapabilityResponse): MCPCapability {
  return {
    id: responseField(capability, "ID", "id"),
    upstreamServerId: responseField(capability, "UpstreamServerID", "upstream_server_id"),
    type: responseField(capability, "Type", "type"),
    upstreamName: responseField(capability, "UpstreamName", "upstream_name"),
    exposedName: responseField(capability, "ExposedName", "exposed_name"),
    title: responseField(capability, "Title", "title"),
    description: responseField(capability, "Description", "description"),
    inputSchema: responseField(capability, "InputSchema", "input_schema"),
    outputSchema: responseField(capability, "OutputSchema", "output_schema"),
    annotations: responseField(capability, "Annotations", "annotations"),
    riskLevel: responseField(capability, "RiskLevel", "risk_level"),
    readOnly: responseField(capability, "ReadOnly", "read_only"),
    destructive: responseField(capability, "Destructive", "destructive"),
    idempotent: responseField(capability, "Idempotent", "idempotent"),
    approvalRequired: responseField(capability, "ApprovalRequired", "approval_required"),
    confirmRequired: responseField(capability, "ConfirmRequired", "confirm_required"),
    confirmTemplate: responseField(capability, "ConfirmTemplate", "confirm_template"),
    status: responseField(capability, "Status", "status"),
    schemaHash: responseField(capability, "SchemaHash", "schema_hash"),
    version: responseField(capability, "Version", "version"),
    lastSyncedAt: responseField(capability, "LastSyncedAt", "last_synced_at"),
    createdAt: responseField(capability, "CreatedAt", "created_at"),
    updatedAt: responseField(capability, "UpdatedAt", "updated_at")
  };
}

function mapGateSummary(summary: MCPGateSummaryResponse): MCPGateSummary {
  return {
    system: summary.system,
    action: summary.action,
    object: summary.object,
    tool: summary.tool,
    riskLevel: summary.risk_level,
    destructive: summary.destructive,
    readOnly: summary.read_only,
    parameters: summary.parameters ?? [],
    risks: summary.risks ?? []
  };
}

function mapGate(gate: MCPGateResponse): MCPGate {
  const summary = responseField<MCPGateSummaryResponse>(gate, "GateSummary", "gate_summary");
  return {
    id: responseField(gate, "ID", "id"),
    type: responseField(gate, "Type", "type"),
    provider: responseField(gate, "Provider", "provider"),
    traceId: responseField(gate, "TraceID", "trace_id"),
    tenantId: responseField(gate, "TenantID", "tenant_id"),
    agentId: responseField(gate, "AgentID", "agent_id"),
    actorId: responseField(gate, "ActorID", "actor_id"),
    capabilityId: responseField(gate, "CapabilityID", "capability_id"),
    upstreamServerId: responseField(gate, "UpstreamServerID", "upstream_server_id"),
    exposedName: responseField(gate, "ExposedName", "exposed_name"),
    upstreamName: responseField(gate, "UpstreamName", "upstream_name"),
    requestBody: responseField(gate, "RequestBody", "request_body"),
    argumentsHash: responseField(gate, "ArgumentsHash", "arguments_hash"),
    schemaHash: responseField(gate, "SchemaHash", "schema_hash"),
    gateSummary: mapGateSummary(summary),
    status: responseField(gate, "Status", "status"),
    confirmUrl: responseField(gate, "ConfirmURL", "confirm_url"),
    decidedBy: responseField(gate, "DecidedBy", "decided_by"),
    decisionReason: responseField(gate, "DecisionReason", "decision_reason"),
    decidedAt: responseField(gate, "DecidedAt", "decided_at"),
    expiresAt: responseField(gate, "ExpiresAt", "expires_at"),
    executionAuditId: responseField(gate, "ExecutionAuditID", "execution_audit_id"),
    responseBody: responseField(gate, "ResponseBody", "response_body"),
    error: responseField(gate, "Error", "error"),
    createdAt: responseField(gate, "CreatedAt", "created_at"),
    updatedAt: responseField(gate, "UpdatedAt", "updated_at"),
    externalInstanceId: responseField(gate, "ExternalInstanceID", "external_instance_id") ?? "",
    externalUrl: responseField(gate, "ExternalURL", "external_url") ?? ""
  };
}

function mapGrant(grant: MCPGrantResponse): MCPGrant {
  return {
    id: responseField(grant, "ID", "id"),
    userId: responseField(grant, "UserID", "user_id"),
    capabilityId: responseField(grant, "CapabilityID", "capability_id"),
    grantType: responseField(grant, "GrantType", "grant_type"),
    dataScope: responseField(grant, "DataScope", "data_scope"),
    expiresAt: responseField(grant, "ExpiresAt", "expires_at"),
    createdBy: responseField(grant, "CreatedBy", "created_by"),
    createdAt: responseField(grant, "CreatedAt", "created_at"),
    updatedAt: responseField(grant, "UpdatedAt", "updated_at")
  };
}

function mapAudit(audit: MCPAuditResponse): MCPAudit {
  return {
    id: responseField(audit, "ID", "id"),
    traceId: responseField(audit, "TraceID", "trace_id"),
    requestId: responseField(audit, "RequestID", "request_id"),
    inboundSessionId: responseField(audit, "InboundSessionID", "inbound_session_id"),
    upstreamSessionId: responseField(audit, "UpstreamSessionID", "upstream_session_id"),
    agentId: responseField(audit, "AgentID", "agent_id"),
    actorId: responseField(audit, "ActorID", "actor_id"),
    tenantId: responseField(audit, "TenantID", "tenant_id"),
    tokenId: responseField(audit, "TokenID", "token_id"),
    tokenHash: responseField(audit, "TokenHash", "token_hash"),
    endpointType: responseField(audit, "EndpointType", "endpoint_type") ?? "aggregate",
    endpointUpstreamServerId: responseField(audit, "EndpointUpstreamServerID", "endpoint_upstream_server_id") ?? "",
    upstreamServerId: responseField(audit, "UpstreamServerID", "upstream_server_id"),
    capabilityId: responseField(audit, "CapabilityID", "capability_id"),
    capabilityType: responseField(audit, "CapabilityType", "capability_type"),
    exposedName: responseField(audit, "ExposedName", "exposed_name"),
    upstreamName: responseField(audit, "UpstreamName", "upstream_name"),
    requestHeaders: responseField(audit, "RequestHeaders", "request_headers"),
    requestBody: responseField(audit, "RequestBody", "request_body"),
    responseHeaders: responseField(audit, "ResponseHeaders", "response_headers"),
    responseBody: responseField(audit, "ResponseBody", "response_body"),
    decision: responseField(audit, "Decision", "decision"),
    decisionReason: responseField(audit, "DecisionReason", "decision_reason"),
    error: responseField(audit, "Error", "error"),
    durationMs: responseField(audit, "DurationMS", "duration_ms"),
    createdAt: responseField(audit, "CreatedAt", "created_at"),
    completedAt: responseField(audit, "CompletedAt", "completed_at")
  };
}

export async function listMCPUpstreamServers(filters: MCPUpstreamServerFilters = {}) {
  const response = await adminApi.get<ListResponse<MCPUpstreamServerResponse>>(
    `/mcp/upstream-servers${queryString({
      status: filters.status,
      domain: filters.domain
    })}`
  );
  return response.items.map(mapUpstreamServer);
}

export async function getMCPUpstreamServer(serverId: string) {
  const response = await adminApi.get<MCPUpstreamServerResponse>(`/mcp/upstream-servers/detail?server_id=${encodeURIComponent(serverId)}`);
  return mapUpstreamServer(response);
}

export async function createUpstreamServer(input: CreateUpstreamServerInput) {
  const response = await adminApi.post<MCPUpstreamServerResponse>("/mcp/upstream-servers", {
    server_id: input.serverId,
    name: input.name,
    domain: input.domain,
    transport: input.transport,
    endpoint: input.endpoint,
    stdio: input.stdio,
    namespace: input.namespace,
    owner_team: input.ownerTeam,
    routing_description: input.routingDescription,
    collector_id: input.collectorId,
    token: input.token
  });
  return mapUpstreamServer(response);
}

export async function updateMCPUpstreamServer(serverId: string, input: CreateUpstreamServerInput) {
  const response = await adminApi.patch<MCPUpstreamServerResponse>("/mcp/upstream-servers", {
    server_id: serverId,
    name: input.name,
    domain: input.domain,
    transport: input.transport,
    endpoint: input.endpoint,
    stdio: input.stdio,
    namespace: input.namespace,
    owner_team: input.ownerTeam,
    routing_description: input.routingDescription,
    collector_id: input.collectorId,
    token: input.token
  });
  return mapUpstreamServer(response);
}

export function deleteMCPUpstreamServer(serverId: string) {
  return adminApi.post<void>("/mcp/upstream-servers/remove", { server_id: serverId });
}

function mapStdioConfig(config?: MCPStdioConfigResponse): MCPStdioConfig | undefined {
  if (!config) return undefined;
  return {
    command: config.command,
    args: config.args ? [...config.args] : undefined,
    cwd: config.cwd,
    env: config.env ? { ...config.env } : undefined
  };
}

export async function updateMCPUpstreamServerStatus(serverId: string, status: string) {
  const response = await adminApi.patch<MCPStatusResponse>("/mcp/upstream-servers", {
    server_id: serverId,
    status,
  });
  return mapStatusUpdate(response);
}

export function syncMCPUpstreamTools(serverId: string, init?: RequestInit) {
  return adminApi.post<{ status: string }>("/mcp/upstream-servers/sync-tools", { server_id: serverId }, init);
}

export async function listMCPAgents(filters: MCPAgentFilters = {}) {
  const response = await adminApi.get<ListResponse<MCPAgentResponse>>(
    `/mcp/agents${queryString({
      status: filters.status
    })}`
  );
  return response.items.map(mapAgent);
}

export async function getMCPAccountToken(userId: string): Promise<MCPAccountTokenInfo> {
  const response = await adminApi.get<{ token: MCPAccountTokenInfoResponse }>(
    `/mcp/accounts/token${queryString({ user_id: userId })}`
  );
  return mapAccountTokenInfo(response.token);
}

export async function createMCPAgent(input: CreateMCPAgentInput) {
  const response = await adminApi.post<{ agent: MCPAgentResponse }>("/mcp/agents", {
    user_id: input.userId,
    agent_id: input.agentId,
    client_id: input.clientId,
    name: input.name,
    tenant_id: input.tenantId,
    actor_id: input.actorId,
    status: input.status
  });
  return mapAgent(response.agent);
}

export async function transferMCPAgent(input: { agentId: string; sourceUserId: string; targetUserId: string; reason: string }) {
  return adminApi.post<{
    action: "agent_transfer";
    agent_ids: string[];
    source_user_id: string;
    target_user_id: string;
    tokens_preserved: boolean;
    grants_preserved: boolean;
    token_count: number;
    grant_count: number;
    completed_at: string;
  }>("/mcp/agents/transfer", {
    agent_id: input.agentId,
    source_user_id: input.sourceUserId,
    target_user_id: input.targetUserId,
    reason: input.reason
  });
}

export function deleteMCPAgent(agentId: string) {
  return adminApi.post<void>("/mcp/agents/remove", { agent_id: agentId });
}

export async function rotateMCPAccountToken(userId: string, input: RotateMCPAccountTokenInput = {}) {
  const response = await adminApi.post<MCPAccountTokenResponseBody>("/mcp/accounts/token/rotate", {
    user_id: userId,
    expires_at: input.expiresAt,
    scopes: input.scopes
  });
  return mapAccountTokenResponse(response);
}

export async function revealMCPAccountToken(userId: string) {
  const response = await adminApi.post<MCPAccountTokenResponseBody>("/mcp/accounts/token/reveal", { user_id: userId });
  return mapAccountTokenResponse(response);
}

export async function revokeMCPAccountToken(userId: string) {
  const response = await adminApi.post<MCPRevokedTokenResponse>("/mcp/accounts/token/revoke", { user_id: userId });
  return mapRevokedToken(response);
}

export async function listMCPCapabilities(filters: MCPCapabilityFilters = {}) {
  const response = await adminApi.get<ListResponse<MCPCapabilityResponse>>(
    `/mcp/capabilities${queryString({
      server_id: filters.serverId,
      type: filters.type,
      status: filters.status,
      domain: filters.domain,
      risk_level: filters.riskLevel
    })}`
  );
  return response.items.map(mapCapability);
}

export function deleteMCPCapability(capabilityId: string) {
  return adminApi.post<void>("/mcp/capabilities/remove", { capability_id: capabilityId });
}

export async function updateMCPCapabilityStatus(exposedName: string, status: string) {
  const response = await adminApi.patch<MCPCapabilityStatusResponse>("/mcp/capabilities", {
    capability_id: exposedName,
    status
  });
  return mapCapabilityStatusUpdate(response);
}

export async function renameMCPCapability(exposedName: string, newExposedName: string) {
  const response = await adminApi.patch<MCPCapabilityStatusResponse>("/mcp/capabilities", {
    capability_id: exposedName,
    exposed_name: newExposedName
  });
  return mapCapabilityStatusUpdate(response);
}

export async function updateMCPCapabilityGates(capabilityId: string, input: UpdateMCPCapabilityGatesInput) {
  const response = await adminApi.put<MCPCapabilityResponse>("/mcp/capabilities/gate-policy", {
    capability_id: capabilityId,
    approval_required: input.approvalRequired,
    confirm_required: input.confirmRequired
  });
  return mapCapability(response);
}

export async function listMCPGrants(filters: MCPGrantFilters = {}) {
  const response = await adminApi.get<ListResponse<MCPGrantResponse>>(
    `/mcp/grants${queryString({
      user_id: filters.userId,
      capability_id: filters.capabilityId,
      grant_type: filters.grantType
    })}`
  );
  return response.items.map(mapGrant);
}

export async function createMCPGrant(input: CreateMCPGrantInput) {
  const response = await adminApi.post<MCPGrantResponse>("/mcp/grants", {
    user_id: input.userId,
    capability_id: input.capabilityId,
    grant_type: input.grantType,
    data_scope: input.dataScope,
    expires_at: input.expiresAt
  });
  return mapGrant(response);
}

export function deleteMCPGrant(grantId: string) {
  return adminApi.post<void>("/mcp/grants/remove", { grant_id: grantId });
}

export async function listMCPAudits(filters: MCPAuditFilters = {}) {
  const response = await adminApi.get<ListResponse<MCPAuditResponse>>(
    `/mcp/audits${queryString({
      limit: filters.limit,
      decision: filters.decision,
      agent_id: filters.agentId,
      upstream_server_id: filters.upstreamServerId,
      tool: filters.tool,
      created_from: filters.createdFrom,
      created_to: filters.createdTo,
      error_only: filters.errorOnly
    })}`
  );
  return response.items.map(mapAudit);
}

export async function listMCPGates(filters: MCPGateFilters = {}) {
  const response = await adminApi.get<ListResponse<MCPGateResponse>>(
    `/mcp/gates${queryString({
      limit: filters.limit,
      status: filters.status,
      agent_id: filters.agentId,
      actor_id: filters.actorId,
      tenant_id: filters.tenantId,
      capability_id: filters.capabilityId,
      gate_type: filters.gateType,
      created_from: filters.createdFrom,
      created_to: filters.createdTo
    })}`
  );
  return response.items.map(mapGate);
}

export async function getMCPGate(gateId: string) {
  return mapGate(await adminApi.get<MCPGateResponse>(`/mcp/gates/detail?gate_id=${encodeURIComponent(gateId)}`));
}

export async function acceptMCPGate(gateId: string) {
  return mapGate(await adminApi.post<MCPGateResponse>("/mcp/gates/decide", { gate_id: gateId, decision: "approved" }));
}

export async function rejectMCPGate(gateId: string, reason: string) {
  return mapGate(await adminApi.post<MCPGateResponse>("/mcp/gates/decide", { gate_id: gateId, decision: "rejected", reason }));
}
