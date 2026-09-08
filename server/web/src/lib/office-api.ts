import { adminApi, appApi } from "./api";

export type CollectorStatus = "online" | "offline" | "never" | "revoked";

export type RegistrationCodeSummary = {
  exists: boolean;
  code?: string;
  install_url?: string;
  install_script_url?: string;
  install_command?: string;
  created_by?: string;
  created_at?: string;
  expires_at?: string;
  used_count: number;
  last_used_at?: string;
  revoked: boolean;
};

export type CollectorSummary = {
  total_collectors: number;
  online_collectors: number;
  offline_collectors: number;
  never_seen_collectors: number;
};

export type CollectorItem = {
  collector_id: string;
  device_id: string;
  device_name: string;
  hostname: string;
  os: string;
  arch: string;
  collector_version: string;
  registered_agent_count: number;
  registered_at?: string;
  token_created_at: string;
  token_last_used_at?: string;
  last_seen_at?: string;
  status: CollectorStatus;
  user_id?: string;
  user_name?: string;
  user_email?: string;
  token_status: "active" | "revoked";
};

export type CollectorsOverview = {
  schema_version: "office.v1";
  server_time: string;
  online_threshold_seconds: number;
  registration_code: RegistrationCodeSummary;
  summary: CollectorSummary;
  collectors: CollectorItem[];
};

export type CreateRegistrationCodeResponse = {
  registration_code: string;
  install_url?: string;
  install_script_url?: string;
  install_command?: string;
  install_powershell_command?: string;
  created_at: string;
  expires_at?: string;
};

export type RegistrationCodeDetail = {
  exists: boolean;
  registration_code?: string;
  install_url?: string;
  install_script_url?: string;
  install_command?: string;
  install_powershell_command?: string;
  created_by?: string;
  created_at?: string;
  expires_at?: string;
  used_count: number;
  last_used_at?: string;
  revoked: boolean;
};

export type AgentKey = {
  collector_id: string;
  agent_id: string;
};

export type WorkspaceCount = {
  workspace_name: string;
  agent_count: number;
};

export type BusinessSystemCount = {
  system_type: string;
  system_name: string;
  active_count: number;
};

export type OfficeFilters = {
  workspaces: WorkspaceCount[];
  status_counts: Record<string, number>;
  business_systems: BusinessSystemCount[];
};

export type OfficeSummary = {
  total_agents: number;
  online_agents: number;
  active_sub_agents: number;
  blocked_agents: number;
  error_agents: number;
  working_agents: number;
  active_sessions: number;
  active_turns: number;
  recent_tool_call_count: number;
};

type UnknownString = string & Record<never, never>;

export type KnownAgentStatus =
  | "offline"
  | "idle"
  | "thinking"
  | "searching"
  | "coding"
  | "reading_files"
  | "running_commands"
  | "organizing_data"
  | "summarizing"
  | "calling_business_system"
  | "waiting_user"
  | "blocked"
  | "error";

export type AgentStatus = KnownAgentStatus | UnknownString;

export type KnownRiskLevel = "low" | "medium" | "high" | "unknown";

export type RiskLevel = KnownRiskLevel | UnknownString;

export type AgentLastAction = {
  tool_name: string;
  tool_type: string;
  status: string;
  started_at: string;
};

export type SessionItem = {
  session_id: string;
  status: AgentStatus;
  summary: string;
  started_at: string;
  ended_at?: string;
  workspace_name: string;
  duration_ms: number;
};

export type TurnItem = {
  turn_id: string;
  session_id: string;
  sub_agent_id?: string;
  parent_agent_id?: string;
  parent_turn_id?: string;
  spawn_tool_call_id?: string;
  title: string;
  user_prompt: string;
  assistant_summary: string;
  last_assistant_message: string;
  status: AgentStatus;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  progress?: number;
};

export type BusinessCall = {
  system_type: string;
  system_name: string;
  operation_label: string;
  risk_level: RiskLevel;
  external_event_id?: string;
  external_source?: string;
};

export type SubAgentItem = {
  collector_id: string;
  parent_agent_id: string;
  sub_agent_id: string;
  session_id: string;
  parent_turn_id: string;
  turn_title: string;
  nickname: string;
  spawn_tool_call_id: string;
  name: string;
  role: string;
  status: AgentStatus;
  current_activity: string;
  active_business_call?: BusinessCall;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  duration_ms: number;
};

export type SubAgentSummary = {
  active_count: number;
  total_count: number;
  preview: SubAgentItem[] | null;
};

export type AgentSessionBrief = {
  session_id: string;
  status: AgentStatus;
  current_turn_title: string;
  active: boolean;
  last_action?: AgentLastAction;
  recent_actions: AgentLastAction[];
};

export type AgentListItem = AgentKey & {
  mcp_agent_id?: string;
  owner_user_id?: string;
  owner_name?: string;
  owner_email?: string;
  display_name: string;
  avatar_label: string;
  agent_type: string;
  role_label: string;
  device_id: string;
  workspace_name: string;
  status: AgentStatus;
  current_session?: SessionItem;
  current_turn?: TurnItem;
  sub_agents: SubAgentSummary;
  active_business_call?: BusinessCall;
  sessions: AgentSessionBrief[];
  last_action?: AgentLastAction;
  recent_tool_calls: number;
  last_seen_at: string;
  updated_at: string;
};

export type ToolCallItem = AgentKey & {
  tool_call_id: string;
  external_tool_call_id: string;
  session_id: string;
  turn_id: string;
  sub_agent_id?: string;
  tool_name: string;
  tool_type: string;
  status: string;
  input: unknown;
  response: unknown;
  response_text: string;
  started_at: string;
  completed_at?: string;
  duration_ms: number;
};

export type ActivityItem = {
  collector_id: string;
  activity_id: string;
  agent_id: string;
  sub_agent_id?: string;
  session_id: string;
  turn_id: string;
  tool_call_id?: string;
  activity_type: string;
  status: AgentStatus;
  title: string;
  summary: string;
  started_at: string;
  completed_at?: string;
  duration_ms: number;
  business_call?: BusinessCall;
};

export type TimelineItem = {
  activity_id?: string;
  event_type: string;
  title: string;
  summary: string;
  status: AgentStatus;
  activity_type: string;
  occurred_at: string;
  completed_at?: string;
};

export type ActivityFeedItem = AgentKey & {
  activity_id?: string;
  activity_type?: string;
  status?: AgentStatus;
  title?: string;
  summary?: string;
  occurred_at: string;
  text: string;
};

export type AgentStats = {
  session_duration_ms: number;
  active_sub_agents: number;
  total_sub_agents: number;
  recent_activity_count: number;
  business_risk_level: RiskLevel;
  active_sessions: number;
  active_work_ms: number;
  tool_type_variety: number;
  tool_call_count: number;
};

export type AgentActivityList = {
  schema_version: "office.v1";
  server_time: string;
  sse_url: string;
  filters: OfficeFilters;
  summary: OfficeSummary;
  agents: AgentListItem[];
  recent_feed: ActivityFeedItem[];
};

export type AgentActivityDetail = {
  schema_version: "office.v1";
  server_time: string;
  agent: AgentListItem;
  current_session?: SessionItem;
  current_turn?: TurnItem;
  sessions: SessionItem[];
  turns: TurnItem[];
  sub_agents: SubAgentItem[];
  tool_calls: ToolCallItem[];
  status_timeline: TimelineItem[];
  recent_activities: ActivityItem[];
  active_business_call?: BusinessCall;
  stats: AgentStats;
};

export type OfficeSnapshot = AgentActivityList;
export type AgentDetail = AgentActivityDetail;

export type RealtimeScope = {
  collector_id?: string;
  agent_id?: string;
  session_id?: string;
  turn_id?: string;
  sub_agent_id?: string;
};

export type KnownRealtimeEventType =
  | "hello"
  | "agent.upserted"
  | "session.upserted"
  | "turn.upserted"
  | "turn.completed"
  | "sub_agent.upserted"
  | "activity.upserted"
  | "activity.completed"
  | "office.stats.updated"
  | "snapshot.required"
  | "heartbeat";

export type RealtimeEventType = KnownRealtimeEventType | UnknownString;

export type RealtimeEnvelope<TData = unknown> = {
  schema_version: "office.v1";
  event_id: string;
  event_type: RealtimeEventType;
  emitted_at: string;
  cursor: string;
  scope: RealtimeScope;
  data: TData;
};

export function fetchCollectorOverview(): Promise<CollectorsOverview> {
  return adminApi.get<CollectorsOverview>("/collectors/overview");
}

export function createRegistrationCode(userId: string): Promise<CreateRegistrationCodeResponse> {
  return adminApi.post<CreateRegistrationCodeResponse>("/collector-registration-codes", { user_id: userId });
}

export function fetchRegistrationCode(userId: string): Promise<RegistrationCodeDetail> {
  return adminApi.get<RegistrationCodeDetail>(`/collector-registration-codes?user_id=${encodeURIComponent(userId)}`);
}

export function createMyCollectorRegistrationCode(): Promise<CreateRegistrationCodeResponse> {
  return appApi.post<CreateRegistrationCodeResponse>("/collector-registration-codes", {});
}

export function fetchMyCollectorRegistrationCode(): Promise<RegistrationCodeDetail> {
  return appApi.get<RegistrationCodeDetail>("/collector-registration-codes");
}

export function revokeCollectorToken(collectorId: string): Promise<void> {
  return adminApi.post("/collectors/token/revoke", { collector_id: collectorId });
}

export function deleteCollector(collectorId: string): Promise<void> {
  return adminApi.post("/collectors/remove", { collector_id: collectorId });
}

export async function listMyCollectors(): Promise<CollectorItem[]> {
  const response = await appApi.get<{ items: CollectorItem[] }>("/collectors");
  return response.items;
}

export function getMyCollector(collectorId: string): Promise<CollectorItem> {
  return appApi.get(`/collectors/detail?collector_id=${encodeURIComponent(collectorId)}`);
}

export function revokeMyCollectorToken(collectorId: string): Promise<void> {
  return appApi.post("/collectors/token/revoke", { collector_id: collectorId });
}

export function deleteMyCollector(collectorId: string): Promise<void> {
  return appApi.post("/collectors/remove", { collector_id: collectorId });
}

export function bindOfficeAgentToMCP(collectorId: string, agentId: string, mcpAgentId: string): Promise<{ status: "bound" }> {
  return adminApi.put("/activity/mcp-agent-binding", {
    collector_id: collectorId,
    agent_id: agentId,
    mcp_agent_id: mcpAgentId,
  });
}

export function unbindOfficeAgentFromMCP(collectorId: string, agentId: string): Promise<void> {
  return adminApi.post("/activity/mcp-agent-binding/remove", { collector_id: collectorId, agent_id: agentId });
}

export function deleteOfficeAgent(collectorId: string, agentId: string): Promise<void> {
  return adminApi.post("/activity/agents/remove", { collector_id: collectorId, agent_id: agentId });
}

export async function getAgentActivityList(): Promise<AgentActivityList> {
  const response = await adminApi.get<AgentActivityList>("/activity/agents");
  return { ...response, sse_url: "/api/v1/admin/activity/events" };
}

export async function getOfficeSnapshot(): Promise<OfficeSnapshot> {
  const response = await adminApi.get<OfficeSnapshot>("/activity/overview");
  return { ...response, sse_url: "/api/v1/admin/activity/events" };
}

export function getAgentActivityDetail(collectorId: string, agentId: string): Promise<AgentActivityDetail> {
  return adminApi.get<AgentActivityDetail>(
    `/activity/detail?collector_id=${encodeURIComponent(collectorId)}&agent_id=${encodeURIComponent(agentId)}&include_history=false`,
  );
}

export function getAgentDetail(collectorId: string, agentId: string): Promise<AgentDetail> {
  return getAgentActivityDetail(collectorId, agentId);
}

export function getSubAgents(
  collectorId: string,
  agentId: string,
): Promise<{ schema_version: "office.v1"; server_time: string; collector_id: string; agent_id: string; sub_agents: SubAgentItem[] }> {
  return adminApi.get(`/activity/sub-agents?collector_id=${encodeURIComponent(collectorId)}&agent_id=${encodeURIComponent(agentId)}`);
}

export function getRecentActivities(
  limit = 20,
): Promise<{ schema_version: "office.v1"; server_time: string; recent_feed: ActivityFeedItem[] }> {
  return adminApi.get(`/activity/recent?limit=${encodeURIComponent(String(limit))}`);
}

export async function getMyOfficeSnapshot(): Promise<OfficeSnapshot> {
  const response = await appApi.get<OfficeSnapshot>("/activity/overview");
  return { ...response, sse_url: "/api/v1/app/activity/events" };
}

export function getMyAgentDetail(collectorId: string, agentId: string): Promise<AgentDetail> {
  return appApi.get(
    `/activity/detail?collector_id=${encodeURIComponent(collectorId)}&agent_id=${encodeURIComponent(agentId)}&include_history=false`,
  );
}

export function getMySubAgents(
  collectorId: string,
  agentId: string,
): Promise<{ schema_version: "office.v1"; server_time: string; collector_id: string; agent_id: string; sub_agents: SubAgentItem[] }> {
  return appApi.get(`/activity/sub-agents?collector_id=${encodeURIComponent(collectorId)}&agent_id=${encodeURIComponent(agentId)}`);
}

export function getMyRecentActivities(
  limit = 20,
): Promise<{ schema_version: "office.v1"; server_time: string; recent_feed: ActivityFeedItem[] }> {
  return appApi.get(`/activity/recent?limit=${encodeURIComponent(String(limit))}`);
}
