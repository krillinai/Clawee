import { describe, expect, it } from "vitest";

import type {
  MCPAgent,
  MCPAudit,
  MCPCapability,
  MCPGrant,
  MCPUpstreamServer
} from "./mcp-admin-api";
import {
  buildGrantIndex,
  canDecideMCPGate,
  decisionLabel,
  decisionVariant,
  deriveCapabilityRows,
  deriveMCPDashboardSummary,
  filterAgents,
  filterAudits,
  filterCapabilities,
  filterUpstreamServers,
  formatDateTime,
  formatDuration,
  isMCPGateExpired,
  isMCPGateTerminal,
  mcpGateStatusLabel,
  mcpGateStatusVariant,
  mcpGateTypeLabel,
  mcpStatusLabel,
  mcpStatusVariant,
  parseMCPServerConfigImport,
  parseStdioEnvJSON,
  redactHeaders,
  riskLevelLabel,
  validateExposedName
} from "./mcp-admin-ui";

const now = "2026-05-27T12:00:00Z";

const servers: MCPUpstreamServer[] = [
  {
    id: "crm-main",
    name: "CRM Main",
    domain: "crm",
    transport: "streamable_http",
    endpoint: "https://crm.example/mcp",
    authType: "bearer",
    credentialRef: "secret/crm-main",
    ownerTeam: "sales-platform",
    namespace: "crm",
    status: "active",
    capabilitiesCount: 2,
    lastSyncedAt: "2026-05-27T08:00:00Z",
    lastSyncResult: "ok",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T08:00:00Z"
  },
  {
    id: "erp-main",
    name: "ERP Main",
    domain: "erp",
    transport: "streamable_http",
    endpoint: "https://erp.example/mcp",
    authType: "",
    credentialRef: "",
    ownerTeam: "finance-platform",
    namespace: "erp",
    status: "disabled",
    capabilitiesCount: 0,
    lastSyncedAt: "",
    lastSyncResult: "",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T07:00:00Z"
  },
  {
    id: "oa-approval",
    name: "OA Approval",
    domain: "oa",
    transport: "streamable_http",
    endpoint: "https://oa.example/mcp",
    authType: "bearer",
    credentialRef: "secret/oa-approval",
    ownerTeam: "workflow-platform",
    namespace: "oa",
    status: "sync_failed",
    capabilitiesCount: 1,
    lastSyncedAt: "2026-05-27T07:30:00Z",
    lastSyncResult: "upstream 502",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T07:30:00Z"
  }
];

const capabilities: MCPCapability[] = [
  {
    id: "cap_search",
    upstreamServerId: "crm-main",
    type: "tool",
    upstreamName: "customer.search",
    exposedName: "crm.customer.search",
    title: "Search Customers",
    description: "Search CRM customers",
    inputSchema: {},
    outputSchema: {},
    annotations: {},
    riskLevel: "low",
    readOnly: true,
    destructive: false,
    idempotent: true,
    approvalRequired: false,
    confirmRequired: false,
    confirmTemplate: "",
    status: "active",
    schemaHash: "hash_search",
    version: "v1",
    lastSyncedAt: "2026-05-27T10:00:00Z",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T10:00:00Z"
  },
  {
    id: "cap_delete",
    upstreamServerId: "crm-main",
    type: "tool",
    upstreamName: "customer.delete",
    exposedName: "crm.customer.delete",
    title: "Delete Customer",
    description: "Delete CRM customers",
    inputSchema: {},
    outputSchema: {},
    annotations: {},
    riskLevel: "high",
    readOnly: false,
    destructive: true,
    idempotent: false,
    approvalRequired: true,
    confirmRequired: true,
    confirmTemplate: "请确认删除客户 {{customer_id}}",
    status: "pending",
    schemaHash: "hash_delete",
    version: "v1",
    lastSyncedAt: null,
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T09:00:00Z"
  },
  {
    id: "cap_archive",
    upstreamServerId: "crm-main",
    type: "tool",
    upstreamName: "customer.archive",
    exposedName: "crm.customer.archive",
    title: "Archive Customer",
    description: "Archive CRM customers",
    inputSchema: {},
    outputSchema: {},
    annotations: {},
    riskLevel: "medium",
    readOnly: false,
    destructive: false,
    idempotent: true,
    approvalRequired: true,
    confirmRequired: true,
    confirmTemplate: "请确认归档客户 {{customer_id}}",
    status: "disabled",
    schemaHash: "hash_archive",
    version: "v1",
    lastSyncedAt: "2026-05-27T09:30:00Z",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T09:30:00Z"
  },
  {
    id: "cap_legacy",
    upstreamServerId: "oa-approval",
    type: "tool",
    upstreamName: "approval.cancel",
    exposedName: "oa.approval.cancel",
    title: "Cancel Approval",
    description: "Legacy approval cancellation",
    inputSchema: {},
    outputSchema: {},
    annotations: {},
    riskLevel: "high",
    readOnly: false,
    destructive: true,
    idempotent: false,
    approvalRequired: true,
    confirmRequired: false,
    confirmTemplate: "",
    status: "missing",
    schemaHash: "hash_legacy",
    version: "v1",
    lastSyncedAt: "2026-05-27T08:30:00Z",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T08:30:00Z"
  }
];

const agents: MCPAgent[] = [
  {
    agentId: "sales_zhang_agent",
    clientId: "sales_zhang_client",
    name: "Sales Zhang Agent",
    tenantId: "demo",
    actorId: "sales_zhang",
    status: "active",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T10:30:00Z"
  },
  {
    agentId: "sales_li_agent",
    clientId: "sales_li_client",
    name: "Sales Li Agent",
    tenantId: "demo",
    actorId: "sales_li",
    status: "disabled",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T07:00:00Z"
  }
];

const grants: MCPGrant[] = [
  {
    id: "grant_sales_zhang_agent_tool_cap_search",
    userId: "user_sales_zhang",
    capabilityId: "cap_search",
    grantType: "tool",
    dataScope: { region: "cn" },
    expiresAt: null,
    createdBy: "admin",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T09:00:00Z"
  },
  {
    id: "grant_sales_zhang_agent_tool_missing",
    userId: "user_sales_zhang",
    capabilityId: "cap_missing",
    grantType: "tool",
    dataScope: {},
    expiresAt: null,
    createdBy: "admin",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T09:00:00Z"
  },
  {
    id: "grant_sales_zhang_agent_tool_cap_legacy",
    userId: "user_sales_zhang",
    capabilityId: "cap_legacy",
    grantType: "tool",
    dataScope: {},
    expiresAt: null,
    createdBy: "admin",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T09:00:00Z"
  }
];

const audits: MCPAudit[] = [
  {
    id: "audit_1",
    traceId: "trace_1",
    requestId: "req_1",
    inboundSessionId: "in_1",
    upstreamSessionId: "up_1",
    agentId: "sales_zhang_agent",
    actorId: "sales_zhang",
    tenantId: "demo",
    tokenId: "token_1",
    tokenHash: "hash_1",
    upstreamServerId: "crm-main",
    capabilityId: "cap_search",
    capabilityType: "tool",
    exposedName: "crm.customer.search",
    upstreamName: "customer.search",
    requestHeaders: { Authorization: "Bearer secret", "X-Trace": "trace_1" },
    requestBody: { q: "acme" },
    responseHeaders: { "Set-Cookie": "sid=secret" },
    responseBody: { items: [] },
    decision: "allowed",
    decisionReason: "grant matched",
    error: "",
    durationMs: 128,
    createdAt: "2026-05-27T11:00:00Z",
    completedAt: "2026-05-27T11:00:01Z"
  },
  {
    id: "audit_2",
    traceId: "trace_2",
    requestId: "req_2",
    inboundSessionId: "in_2",
    upstreamSessionId: "up_2",
    agentId: "sales_li_agent",
    actorId: "sales_li",
    tenantId: "demo",
    tokenId: "token_2",
    tokenHash: "hash_2",
    upstreamServerId: "crm-main",
    capabilityId: "cap_delete",
    capabilityType: "tool",
    exposedName: "crm.customer.delete",
    upstreamName: "customer.delete",
    requestHeaders: {},
    requestBody: {},
    responseHeaders: {},
    responseBody: {},
    decision: "rejected",
    decisionReason: "approval required",
    error: "policy denied",
    durationMs: 12,
    createdAt: "2026-05-27T10:00:00Z",
    completedAt: "2026-05-27T10:00:01Z"
  },
  {
    id: "audit_3",
    traceId: "trace_3",
    requestId: "req_3",
    inboundSessionId: "in_3",
    upstreamSessionId: "up_3",
    agentId: "sales_zhang_agent",
    actorId: "sales_zhang",
    tenantId: "demo",
    tokenId: "token_1",
    tokenHash: "hash_1",
    upstreamServerId: "oa-approval",
    capabilityId: "cap_legacy",
    capabilityType: "tool",
    exposedName: "oa.approval.cancel",
    upstreamName: "approval.cancel",
    requestHeaders: {},
    requestBody: {},
    responseHeaders: {},
    responseBody: {},
    decision: "upstream_error",
    decisionReason: "upstream timeout",
    error: "upstream timeout",
    durationMs: 1204,
    createdAt: "2026-05-27T09:00:00Z",
    completedAt: "2026-05-27T09:00:01Z"
  }
];

describe("mcp-admin-ui", () => {
  it("aggregates dashboard counts and latest sync time from MCP admin lists", () => {
    const summary = deriveMCPDashboardSummary({
      servers,
      capabilities,
      agents,
      grants,
      audits,
      now
    });

    expect(summary).toEqual({
      servers: { total: 3, active: 1, disabled: 1, syncFailed: 1 },
      capabilities: {
        total: 4,
        active: 1,
        pending: 1,
        disabled: 1,
        missing: 1,
        granted: 2,
        missingButGranted: 1,
        pendingCount: 1,
        missingWithGrants: 1
      },
      agents: { total: 2, active: 1, disabled: 1, disabledWithRecentAudits: 1 },
      grants: { total: 3 },
      audits: { total: 3, allowed: 1, rejected: 1, upstreamError: 1, recent24h: 3 },
      lastToolSyncAt: "2026-05-27T10:00:00Z"
    });
  });

  it("ignores invalid sync timestamps when deriving the latest tool sync time", () => {
    const summary = deriveMCPDashboardSummary({
      servers: [{ ...servers[0], lastSyncedAt: "not-a-date" }],
      capabilities: [{ ...capabilities[0], lastSyncedAt: "2026-05-27T10:00:00Z" }],
      agents: [],
      grants: [],
      audits: [],
      now
    });

    expect(summary.lastToolSyncAt).toBe("2026-05-27T10:00:00Z");
  });

  it("counts upstream error audit decisions without an error message in dashboard summaries", () => {
    const summary = deriveMCPDashboardSummary({
      servers: [],
      capabilities: [],
      agents: [],
      grants: [],
      audits: [{ ...audits[0], decision: "upstream_error", error: "" }],
      now
    });

    expect(summary.audits.upstreamError).toBe(1);
  });

  it("counts MCP backend rejection decisions as recent rejected audits", () => {
    const rejectionDecisions = [
      "no_matching_grant",
      "grant_expired",
      "agent_disabled",
      "capability_disabled",
      "server_disabled",
      "invalid_input"
    ];
    const summary = deriveMCPDashboardSummary({
      servers: [],
      capabilities: [],
      agents: [],
      grants: [],
      audits: [
        ...rejectionDecisions.map((decision, index) => ({
          ...audits[0],
          id: `backend_rejection_${index}`,
          decision,
          createdAt: "2026-05-27T11:00:00Z"
        })),
        { ...audits[0], id: "internal_error", decision: "internal_error", createdAt: "2026-05-27T11:00:00Z" }
      ],
      now
    });

    expect(summary.audits).toMatchObject({
      allowed: 0,
      rejected: rejectionDecisions.length,
      upstreamError: 1,
      recent24h: rejectionDecisions.length + 1
    });
  });

  it("excludes old audits from recent dashboard decision counts", () => {
    const summary = deriveMCPDashboardSummary({
      servers: [],
      capabilities: [],
      agents: [],
      grants: [],
      audits: [
        { ...audits[0], id: "recent_allowed", decision: "allowed", createdAt: "2026-05-27T11:00:00Z" },
        { ...audits[0], id: "old_allowed", decision: "allowed", createdAt: "2026-05-26T11:59:59Z" },
        { ...audits[0], id: "old_rejected", decision: "rejected", createdAt: "2026-05-26T11:59:59Z" },
        { ...audits[0], id: "old_upstream_error", decision: "upstream_error", createdAt: "2026-05-26T11:59:59Z" }
      ],
      now
    });

    expect(summary.audits).toMatchObject({
      allowed: 1,
      rejected: 0,
      upstreamError: 0,
      recent24h: 1
    });
  });

  it("indexes grants and marks missing but granted capabilities", () => {
    const index = buildGrantIndex(grants);
    const rows = deriveCapabilityRows(capabilities, grants);

    expect(index.get("cap_search")?.map((grant) => grant.id)).toEqual([
      "grant_sales_zhang_agent_tool_cap_search"
    ]);
    expect(rows.find((row) => row.id === "cap_search")).toMatchObject({
      exposedName: "crm.customer.search",
      grantCount: 1,
      missingButGranted: false
    });
    expect(rows.find((row) => row.id === "cap_missing")).toMatchObject({
      id: "cap_missing",
      exposedName: "cap_missing",
      grantCount: 1,
      missingButGranted: true
    });
  });

  it("validates exposed names with enterprise domain.resource.action guidance", () => {
    expect(validateExposedName("")).toBe("exposed_name 不能为空");
    expect(validateExposedName("crm.customer search")).toBe("exposed_name 不能包含空格");
    expect(validateExposedName("crm.customer")).toBe("建议使用 domain.resource.action 格式");
    expect(validateExposedName("crm.customer.search")).toBeNull();
  });

  it("redacts sensitive headers case-insensitively without mutating unrelated headers", () => {
    const headers = {
      Authorization: "Bearer secret",
      cookie: "sid=secret",
      "Set-Cookie": "sid=secret",
      "X-Trace": "trace_1"
    };

    expect(redactHeaders(headers)).toEqual({
      Authorization: "******",
      cookie: "******",
      "Set-Cookie": "******",
      "X-Trace": "trace_1"
    });
    expect(headers).toEqual({
      Authorization: "Bearer secret",
      cookie: "sid=secret",
      "Set-Cookie": "sid=secret",
      "X-Trace": "trace_1"
    });
  });

  it("maps statuses and decisions to badge variants", () => {
    expect(mcpStatusLabel("active")).toBe("正常");
    expect(mcpStatusLabel("pending")).toBe("待审核");
    expect(mcpStatusLabel("missing")).toBe("已缺失");
    expect(mcpStatusLabel("sync_failed")).toBe("同步失败");
    expect(mcpStatusLabel("custom_state")).toBe("custom_state");
    expect(mcpStatusLabel()).toBe("未知");
    expect(decisionLabel("allowed")).toBe("已允许");
    expect(decisionLabel("upstream_error")).toBe("上游异常");
    expect(mcpGateStatusLabel("pending")).toBe("待处理");
    expect(mcpGateStatusLabel("cancelled")).toBe("已取消");
    expect(riskLevelLabel("high")).toBe("高风险");
    expect(mcpStatusVariant("active")).toBe("success");
    expect(mcpStatusVariant("pending")).toBe("warning");
    expect(mcpStatusVariant("disabled")).toBe("muted");
    expect(mcpStatusVariant("revoked")).toBe("danger");
    expect(mcpStatusVariant("syncing")).toBe("accent");
    expect(decisionVariant("allowed")).toBe("success");
    expect(decisionVariant("allow")).toBe("success");
    expect(decisionVariant("rejected")).toBe("danger");
    expect(decisionVariant("deny")).toBe("danger");
    expect(decisionVariant("denied")).toBe("danger");
    expect(decisionVariant("blocked")).toBe("danger");
    expect(decisionVariant("forbidden")).toBe("danger");
    expect(decisionVariant("unauthorized")).toBe("danger");
    expect(decisionVariant("no_matching_grant")).toBe("danger");
    expect(decisionVariant("grant_expired")).toBe("danger");
    expect(decisionVariant("agent_disabled")).toBe("danger");
    expect(decisionVariant("capability_disabled")).toBe("danger");
    expect(decisionVariant("server_disabled")).toBe("danger");
    expect(decisionVariant("invalid_input")).toBe("danger");
    expect(decisionVariant("upstream_error")).toBe("warning");
    expect(decisionVariant("internal_error")).toBe("warning");
    expect(decisionVariant("error")).toBe("warning");
    expect(decisionVariant("failed")).toBe("warning");
    expect(decisionVariant("timeout")).toBe("warning");
    expect(decisionVariant("not_allowed")).toBe("muted");
    expect(decisionVariant("disallowed")).toBe("muted");
    expect(decisionVariant("allow_denied")).toBe("muted");
    expect(decisionVariant("needs_approval")).toBe("muted");
  });

  it("maps MCP gate statuses to variants and terminal states", () => {
    expect(mcpGateStatusVariant("pending")).toBe("warning");
    expect(mcpGateStatusVariant("completed")).toBe("success");
    expect(mcpGateStatusVariant("rejected")).toBe("danger");
    expect(mcpGateStatusVariant("expired")).toBe("muted");
    expect(isMCPGateTerminal("completed")).toBe(true);
    expect(isMCPGateTerminal("cancelled")).toBe(true);
    expect(isMCPGateTerminal("pending")).toBe(false);
  });

  it("detects expired MCP gates", () => {
    const now = new Date("2026-05-29T10:31:00Z");
    expect(isMCPGateExpired("2026-05-29T10:30:00Z", now)).toBe(true);
    expect(isMCPGateExpired("2026-05-29T10:32:00Z", now)).toBe(false);
    expect(isMCPGateExpired("", now)).toBe(false);
  });

  it("derives MCP gate labels and decision availability", () => {
    const now = new Date("2026-05-29T10:31:00Z");

    expect(mcpGateTypeLabel("user_confirmation")).toBe("用户确认");
    expect(mcpGateTypeLabel("admin_approval")).toBe("管理员审批");
    expect(canDecideMCPGate("PENDING", "2026-05-29T10:32:00Z", now)).toBe(true);
    expect(canDecideMCPGate("accepted", "2026-05-29T10:32:00Z", now)).toBe(false);
    expect(canDecideMCPGate("expired", "2026-05-29T10:32:00Z", now)).toBe(false);
    expect(canDecideMCPGate("cancelled", "2026-05-29T10:32:00Z", now)).toBe(false);
    expect(canDecideMCPGate("completed", "2026-05-29T10:32:00Z", now)).toBe(false);
    expect(canDecideMCPGate("pending", "2026-05-29T10:30:00Z", now)).toBe(false);
  });

  it("formats exported date times and durations", () => {
    expect(formatDateTime(null)).toBe("-");
    expect(formatDateTime("invalid-date")).toBe("invalid-date");
    expect(formatDateTime("2026-05-27T12:00:00Z")).toBe("2026/05/27 20:00:00");
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(10000)).toBe("10s");
  });

  it("filters MCP admin lists by text and structured fields", () => {
    expect(filterCapabilities(capabilities, { query: "crm.customer.search", status: "active" })).toHaveLength(1);
    expect(filterUpstreamServers(servers, { query: "crm", status: "active", domain: "crm" })).toHaveLength(1);
    expect(filterAgents(agents, { query: "zhang", status: "active" })).toHaveLength(1);
    expect(filterAudits(audits, { query: "policy", decision: "rejected", errorOnly: true })).toHaveLength(1);
  });

  it("filters upstream servers by server id, endpoint, and owner team search", () => {
    expect(filterUpstreamServers(servers, { query: "crm-main" }).map((server) => server.id)).toEqual(["crm-main"]);
    expect(filterUpstreamServers(servers, { query: "erp.example" }).map((server) => server.id)).toEqual(["erp-main"]);
    expect(filterUpstreamServers(servers, { query: "workflow-platform" }).map((server) => server.id)).toEqual([
      "oa-approval"
    ]);
  });

  it("filters upstream servers by all supported status values", () => {
    expect(filterUpstreamServers(servers, { status: "active" }).map((server) => server.id)).toEqual(["crm-main"]);
    expect(filterUpstreamServers(servers, { status: "disabled" }).map((server) => server.id)).toEqual(["erp-main"]);
    expect(filterUpstreamServers(servers, { status: "sync_failed" }).map((server) => server.id)).toEqual([
      "oa-approval"
    ]);
  });

  it("parses a pasted stdio mcp server config", () => {
    const result = parseMCPServerConfigImport(JSON.stringify({
      mcpServers: {
        "twenty-crm": {
          command: "node",
          args: ["/opt/example/twenty-crm-mcp-server/index.js"],
          env: {
            TWENTY_API_KEY: "jwt.value.with.dots",
            TWENTY_BASE_URL: "http://localhost:3000"
          }
        }
      }
    }));

    expect(result.serverId).toBe("twenty-crm");
    expect(result.stdio.command).toBe("node");
    expect(result.stdio.args).toEqual(["/opt/example/twenty-crm-mcp-server/index.js"]);
    expect(result.stdio.env?.TWENTY_API_KEY).toBe("jwt.value.with.dots");
    expect(result.stdio.env?.TWENTY_BASE_URL).toBe("http://localhost:3000");
  });

  it("parses stdio env as json instead of whitespace pairs", () => {
    const env = parseStdioEnvJSON(`{
      "TWENTY_API_KEY": "jwt value can contain spaces",
      "TWENTY_BASE_URL": "http://localhost:3000"
    }`);

    expect(env.TWENTY_API_KEY).toBe("jwt value can contain spaces");
    expect(env.TWENTY_BASE_URL).toBe("http://localhost:3000");
  });

  it("combines upstream domain filters with search", () => {
    expect(filterUpstreamServers(servers, { query: "approval", domain: "oa" }).map((server) => server.id)).toEqual([
      "oa-approval"
    ]);
    expect(filterUpstreamServers(servers, { query: "approval", domain: "crm" })).toHaveLength(0);
    expect(filterUpstreamServers(servers, { query: "main", domain: "crm" })).toHaveLength(1);
  });
});
