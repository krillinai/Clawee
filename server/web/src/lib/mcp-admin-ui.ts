import type {
  MCPStdioConfig,
  MCPAgent,
  MCPAudit,
  MCPCapability,
  MCPGrant,
  MCPUpstreamServer
} from "./mcp-admin-api";
import { formatBeijingDateTime } from "./datetime";

export type BadgeVariant = "default" | "success" | "muted" | "warning" | "danger" | "accent";

export type CapabilityRowView = Partial<MCPCapability> & {
  id: string;
  exposedName: string;
  grantCount: number;
  grants: MCPGrant[];
  missingButGranted: boolean;
};

export type MCPServerConfigImport = {
  serverId: string;
  stdio: MCPStdioConfig;
};

export type DashboardInput = {
  servers: MCPUpstreamServer[];
  capabilities: MCPCapability[];
  agents: MCPAgent[];
  grants: MCPGrant[];
  audits: MCPAudit[];
  now?: string | Date;
};

export type DashboardSummary = {
  servers: {
    total: number;
    active: number;
    disabled: number;
    syncFailed: number;
  };
  capabilities: {
    total: number;
    active: number;
    pending: number;
    disabled: number;
    missing: number;
    granted: number;
    missingButGranted: number;
    pendingCount: number;
    missingWithGrants: number;
  };
  agents: {
    total: number;
    active: number;
    disabled: number;
    disabledWithRecentAudits: number;
  };
  grants: {
    total: number;
  };
  audits: {
    total: number;
    allowed: number;
    rejected: number;
    upstreamError: number;
    recent24h: number;
  };
  lastToolSyncAt: string | null;
};

export type CapabilityFilters = {
  query?: string;
  status?: string;
  type?: string;
  domain?: string;
  riskLevel?: string;
  upstreamServerId?: string;
};

export type UpstreamServerFilters = {
  query?: string;
  status?: string;
  domain?: string;
};

export type AgentFilters = {
  query?: string;
  status?: string;
};

export type AuditFilters = {
  query?: string;
  decision?: string;
  agentId?: string;
  upstreamServerId?: string;
  tool?: string;
  errorOnly?: boolean;
};

const REDACTED_VALUE = "******";
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie"]);
const MCP_STATUS_LABELS: Record<string, string> = {
  active: "正常",
  blocked: "受阻",
  calling_business_system: "调用业务系统",
  cancelled: "已取消",
  coding: "编码中",
  completed: "已完成",
  degraded: "性能下降",
  disabled: "已停用",
  enabled: "已启用",
  error: "异常",
  failed: "失败",
  healthy: "正常",
  idle: "在线空闲",
  inactive: "未激活",
  missing: "已缺失",
  offline: "离线",
  ok: "正常",
  online: "在线",
  organizing_data: "整理数据",
  pending: "待审核",
  pending_approval: "待审批",
  reading_files: "读取文件",
  rejected: "已拒绝",
  revoked: "已撤销",
  rotating: "轮换中",
  running: "运行中",
  running_commands: "执行命令",
  searching: "搜索中",
  succeeded: "成功",
  success: "成功",
  summarizing: "总结中",
  sync_failed: "同步失败",
  syncing: "同步中",
  thinking: "思考中",
  unknown: "未知",
  waiting_user: "等待用户",
  warning: "警告",
  working: "工作中"
};

export function mcpStatusVariant(value: string): BadgeVariant {
  const normalized = value.toLowerCase();
  if (["active", "enabled", "healthy", "ok", "succeeded", "success"].includes(normalized)) return "success";
  if (["pending", "pending_approval", "degraded", "warning"].includes(normalized)) return "warning";
  if (["disabled", "inactive", "archived", "unknown"].includes(normalized)) return "muted";
  if (["revoked", "failed", "error", "denied", "deleted"].includes(normalized)) return "danger";
  if (["syncing", "rotating", "running"].includes(normalized)) return "accent";
  return "default";
}

export function mcpStatusLabel(value?: string | null): string {
  if (!value) return "未知";
  return MCP_STATUS_LABELS[value.toLowerCase()] ?? value;
}

export function decisionVariant(value: string): BadgeVariant {
  const normalized = value.toLowerCase();
  if (["allowed", "allow"].includes(normalized)) return "success";
  if (
    [
      "rejected",
      "deny",
      "denied",
      "blocked",
      "forbidden",
      "unauthorized",
      "no_matching_grant",
      "grant_expired",
      "agent_disabled",
      "capability_disabled",
      "server_disabled",
      "invalid_input"
    ].includes(normalized)
  ) {
    return "danger";
  }
  if (["upstream_error", "internal_error", "error", "failed", "timeout"].includes(normalized)) return "warning";
  return "muted";
}

export function decisionLabel(value?: string | null): string {
  if (!value) return "未知";
  const labels: Record<string, string> = {
    allowed: "已允许",
    allow: "已允许",
    rejected: "已拒绝",
    deny: "已拒绝",
    denied: "已拒绝",
    blocked: "已阻止",
    forbidden: "已禁止",
    unauthorized: "未授权",
    upstream_error: "上游异常",
    internal_error: "内部异常",
    error: "异常",
    failed: "失败",
    timeout: "超时"
  };
  return labels[value.toLowerCase()] ?? value;
}

export function mcpGateStatusVariant(status: string): BadgeVariant {
  const normalized = status.toLowerCase();
  if (normalized === "completed") return "success";
  if (normalized === "pending") return "warning";
  if (normalized === "accepted" || normalized === "executing") return "accent";
  if (normalized === "rejected" || normalized === "failed") return "danger";
  if (normalized === "expired" || normalized === "cancelled") return "muted";
  return "muted";
}

export function mcpGateStatusLabel(status?: string | null): string {
  if (!status) return "未知";
  const labels: Record<string, string> = {
    pending: "待处理",
    accepted: "已接受",
    executing: "执行中",
    completed: "已完成",
    rejected: "已拒绝",
    expired: "已过期",
    failed: "失败",
    cancelled: "已取消"
  };
  return labels[status.toLowerCase()] ?? status;
}

export function isMCPGateTerminal(status: string) {
  return ["completed", "rejected", "expired", "failed", "cancelled"].includes(status.toLowerCase());
}

export function isMCPGateExpired(expiresAt: string, now = new Date()) {
  if (!expiresAt) return false;
  const expires = new Date(expiresAt);
  return !Number.isNaN(expires.getTime()) && expires.getTime() < now.getTime();
}

export function mcpGateTypeLabel(type: string) {
  return type === "admin_approval" ? "管理员审批" : "用户确认";
}

export function riskLevelLabel(value?: string | null): string {
  if (!value) return "未知";
  const labels: Record<string, string> = {
    high: "高风险",
    medium: "中风险",
    low: "低风险",
    unknown: "未知"
  };
  return labels[value.toLowerCase()] ?? value;
}

export function canDecideMCPGate(status: string, expiresAt: string, now = new Date()) {
  return status.toLowerCase() === "pending" && !isMCPGateExpired(expiresAt, now);
}

export function validateExposedName(value: string): string | null {
  if (!value) return "exposed_name 不能为空";
  if (/\s/.test(value)) return "exposed_name 不能包含空格";
  if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+$/.test(value)) {
    return "建议使用 domain.resource.action 格式";
  }
  return null;
}

export function redactHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return headers;

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED_VALUE : value
    ])
  );
}

export function formatDateTime(value?: string | null): string {
  return formatBeijingDateTime(value);
}

export function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

export function buildGrantIndex(grants: MCPGrant[]): Map<string, MCPGrant[]> {
  const index = new Map<string, MCPGrant[]>();
  for (const grant of grants) {
    const existing = index.get(grant.capabilityId) ?? [];
    existing.push(grant);
    index.set(grant.capabilityId, existing);
  }
  return index;
}

export function deriveCapabilityRows(capabilities: MCPCapability[], grants: MCPGrant[]): CapabilityRowView[] {
  const capabilityIDs = new Set(capabilities.map((capability) => capability.id));
  const grantsByCapability = buildGrantIndex(grants);
  const rows: CapabilityRowView[] = capabilities.map((capability) => {
    const capabilityGrants = grantsByCapability.get(capability.id) ?? [];
    return {
      ...capability,
      grantCount: capabilityGrants.length,
      grants: capabilityGrants,
      missingButGranted: false
    };
  });

  for (const [capabilityID, capabilityGrants] of grantsByCapability.entries()) {
    if (!capabilityIDs.has(capabilityID)) {
      rows.push({
        id: capabilityID,
        exposedName: capabilityID,
        grantCount: capabilityGrants.length,
        grants: capabilityGrants,
        missingButGranted: true
      });
    }
  }

  return rows;
}

export function deriveMCPDashboardSummary(input: DashboardInput): DashboardSummary {
  const capabilityIDs = new Set(input.capabilities.map((capability) => capability.id));
  const grantedCapabilityIDs = new Set(input.grants.map((grant) => grant.capabilityId));
  const grantedMissingCapabilityIDs = new Set(
    input.capabilities
      .filter((capability) => capability.status === "missing" && grantedCapabilityIDs.has(capability.id))
      .map((capability) => capability.id)
  );
  const disabledAgentIDs = new Set(
    input.agents.filter((agent) => agent.status === "disabled").map((agent) => agent.agentId)
  );
  const now = input.now ? new Date(input.now) : new Date();
  const recentSince = now.getTime() - 24 * 60 * 60 * 1000;
  const recentAudits = input.audits.filter((audit) => isAtOrAfter(audit.createdAt, recentSince));

  return {
    servers: {
      total: input.servers.length,
      active: countStatus(input.servers, "active"),
      disabled: countStatus(input.servers, "disabled"),
      syncFailed: countStatus(input.servers, "sync_failed")
    },
    capabilities: {
      total: input.capabilities.length,
      active: countStatus(input.capabilities, "active"),
      pending: countStatus(input.capabilities, "pending"),
      disabled: countStatus(input.capabilities, "disabled"),
      missing: countStatus(input.capabilities, "missing"),
      granted: Array.from(grantedCapabilityIDs).filter((capabilityID) => capabilityIDs.has(capabilityID)).length,
      missingButGranted: Array.from(grantedCapabilityIDs).filter((capabilityID) => !capabilityIDs.has(capabilityID)).length,
      pendingCount: countStatus(input.capabilities, "pending"),
      missingWithGrants: grantedMissingCapabilityIDs.size
    },
    agents: {
      total: input.agents.length,
      active: countStatus(input.agents, "active"),
      disabled: countStatus(input.agents, "disabled"),
      disabledWithRecentAudits: new Set(
        input.audits
          .filter((audit) => disabledAgentIDs.has(audit.agentId) && isAtOrAfter(audit.createdAt, recentSince))
          .map((audit) => audit.agentId)
      ).size
    },
    grants: {
      total: input.grants.length
    },
    audits: {
      total: input.audits.length,
      allowed: recentAudits.filter((audit) => decisionVariant(audit.decision) === "success").length,
      rejected: recentAudits.filter((audit) => decisionVariant(audit.decision) === "danger").length,
      upstreamError: recentAudits.filter((audit) => decisionVariant(audit.decision) === "warning").length,
      recent24h: recentAudits.length
    },
    lastToolSyncAt: latestTimestamp([
      ...input.servers.map((server) => server.lastSyncedAt),
      ...input.capabilities.map((capability) => capability.lastSyncedAt)
    ])
  };
}

export function filterCapabilities(capabilities: MCPCapability[], filters: CapabilityFilters = {}) {
  const query = normalizeQuery(filters.query);
  return capabilities.filter((capability) => {
    return (
      matchesQuery(query, [
        capability.id,
        capability.upstreamServerId,
        capability.type,
        capability.upstreamName,
        capability.exposedName,
        capability.title,
        capability.description,
        capability.riskLevel
      ]) &&
      matchesFilter(capability.status, filters.status) &&
      matchesFilter(capability.type, filters.type) &&
      matchesFilter(capability.upstreamServerId, filters.upstreamServerId) &&
      matchesFilter(capability.riskLevel, filters.riskLevel) &&
      (!filters.domain || capability.exposedName.startsWith(`${filters.domain}.`))
    );
  });
}

export function filterUpstreamServers(servers: MCPUpstreamServer[], filters: UpstreamServerFilters = {}) {
  const query = normalizeQuery(filters.query);
  return servers.filter((server) => {
    return (
      matchesQuery(query, [
        server.id,
        server.name,
        server.domain,
        server.transport,
        server.endpoint,
        server.ownerTeam,
        server.namespace,
        server.status
      ]) &&
      matchesFilter(server.status, filters.status) &&
      matchesFilter(server.domain, filters.domain)
    );
  });
}

export function filterAgents(agents: MCPAgent[], filters: AgentFilters = {}) {
  const query = normalizeQuery(filters.query);
  return agents.filter((agent) => {
    return (
      matchesQuery(query, [
        agent.agentId,
        agent.clientId,
        agent.name,
        agent.tenantId,
        agent.actorId,
        agent.status
      ]) && matchesFilter(agent.status, filters.status)
    );
  });
}

export function filterAudits(audits: MCPAudit[], filters: AuditFilters = {}) {
  const query = normalizeQuery(filters.query);
  return audits.filter((audit) => {
    return (
      matchesQuery(query, [
        audit.id,
        audit.traceId,
        audit.requestId,
        audit.agentId,
        audit.actorId,
        audit.upstreamServerId,
        audit.capabilityId,
        audit.exposedName,
        audit.upstreamName,
        audit.decision,
        audit.decisionReason,
        audit.error
      ]) &&
      matchesFilter(audit.decision, filters.decision) &&
      matchesFilter(audit.agentId, filters.agentId) &&
      matchesFilter(audit.upstreamServerId, filters.upstreamServerId) &&
      matchesFilter(audit.exposedName, filters.tool) &&
      (!filters.errorOnly || Boolean(audit.error))
    );
  });
}

export function parseMCPServerConfigImport(raw: string): MCPServerConfigImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid mcp server config json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error("mcpServers object is required");
  }
  const entries = Object.entries(parsed.mcpServers);
  if (entries.length !== 1) {
    throw new Error("exactly one mcp server entry is required");
  }
  const [serverId, config] = entries[0];
  if (!isRecord(config) || typeof config.command !== "string" || config.command.trim() === "") {
    throw new Error("mcp server command is required");
  }
  return {
    serverId,
    stdio: {
      command: config.command.trim(),
      args: stringArray(config.args),
      env: stringRecord(config.env),
      cwd: typeof config.cwd === "string" ? config.cwd : ""
    }
  };
}

export function parseStdioEnvJSON(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`invalid stdio env json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return stringRecord(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function stringRecord(value: unknown) {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = String(item);
  }
  return out;
}

function countStatus<T extends { status: string }>(items: T[], status: string) {
  return items.filter((item) => item.status === status).length;
}

function latestTimestamp(values: Array<string | null | undefined>) {
  const timestamps = values.filter((value): value is string => {
    if (!value) return false;
    return !Number.isNaN(new Date(value).getTime());
  });
  if (timestamps.length === 0) return null;
  return timestamps.reduce((latest, value) => {
    return new Date(value).getTime() > new Date(latest).getTime() ? value : latest;
  });
}

function isAtOrAfter(value: string, epochMs: number) {
  const parsed = new Date(value).getTime();
  return !Number.isNaN(parsed) && parsed >= epochMs;
}

function normalizeQuery(value?: string) {
  return value?.trim().toLowerCase() ?? "";
}

function matchesQuery(query: string, values: Array<string | undefined | null>) {
  if (!query) return true;
  return values.some((value) => value?.toLowerCase().includes(query));
}

function matchesFilter(value: string, filter?: string) {
  return !filter || value === filter;
}
