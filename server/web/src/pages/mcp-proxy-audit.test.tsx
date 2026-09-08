import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MCPAgent, MCPAudit, MCPCapability, MCPUpstreamServer } from "@/lib/mcp-admin-api";
import { AdminPermissionsProvider } from "@/components/admin-permissions";
import type { Account } from "@/lib/auth-api";
import { permissions } from "@/lib/rbac-api";
import {
  listMCPAgents,
  listMCPAudits,
  listMCPCapabilities,
  listMCPUpstreamServers
} from "@/lib/mcp-admin-api";

import { MCPProxyAuditPage } from "./mcp-proxy-audit";

vi.mock("@/lib/mcp-admin-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp-admin-api")>("@/lib/mcp-admin-api");
  return {
    ...actual,
    listMCPAgents: vi.fn(),
    listMCPAudits: vi.fn(),
    listMCPCapabilities: vi.fn(),
    listMCPUpstreamServers: vi.fn()
  };
});

const listMCPAgentsMock = vi.mocked(listMCPAgents);
const listMCPAuditsMock = vi.mocked(listMCPAudits);
const listMCPCapabilitiesMock = vi.mocked(listMCPCapabilities);
const listMCPUpstreamServersMock = vi.mocked(listMCPUpstreamServers);

function clickTab(tab: HTMLElement) {
  fireEvent.pointerDown(tab);
  fireEvent.mouseDown(tab);
  fireEvent.mouseUp(tab);
  fireEvent.click(tab);
}

async function selectFilterOption(name: string | RegExp, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name }));
  fireEvent.click(await within(screen.getByRole("listbox")).findByRole("option", { name: option }));
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
}

const audits: MCPAudit[] = [
  {
    id: "audit_1",
    traceId: "trace-proxy-001",
    requestId: "req-proxy-001",
    inboundSessionId: "inbound-session-001",
    upstreamSessionId: "upstream-session-001",
    agentId: "agent_sales",
    actorId: "actor_zhang",
    tenantId: "tenant_cn",
    tokenId: "token_001",
    tokenHash: "token_hash_001",
    upstreamServerId: "crm-main",
    capabilityId: "cap_search",
    capabilityType: "tool",
    exposedName: "crm.customer.search",
    upstreamName: "customer.search",
    requestHeaders: {
      Authorization: "Bearer raw-token",
      Cookie: "session=raw-cookie",
      "Set-Cookie": "unexpected=set-cookie",
      "X-Request-ID": "req-proxy-001"
    },
    requestBody: { keyword: "Acme" },
    responseHeaders: {
      "Content-Type": "application/json",
      "Set-Cookie": "backend-session=raw-cookie"
    },
    responseBody: { items: [{ id: "customer_1" }] },
    decision: "allowed",
    decisionReason: "grant matched",
    error: "",
    durationMs: 42,
    createdAt: "2026-05-27T08:00:00Z",
    completedAt: "2026-05-27T08:00:01Z"
  },
  {
    id: "audit_2",
    traceId: "trace-proxy-002",
    requestId: "req-proxy-002",
    inboundSessionId: "inbound-session-002",
    upstreamSessionId: "upstream-session-002",
    agentId: "agent_support",
    actorId: "actor_li",
    tenantId: "tenant_cn",
    tokenId: "token_002",
    tokenHash: "token_hash_002",
    upstreamServerId: "erp-main",
    capabilityId: "cap_order",
    capabilityType: "tool",
    exposedName: "erp.order.update",
    upstreamName: "order.update",
    requestHeaders: {},
    requestBody: { order_id: "order_1" },
    responseHeaders: {
      "Set-Cookie": "backend-session=raw-cookie"
    },
    responseBody: { message: "upstream timeout" },
    decision: "upstream_error",
    decisionReason: "upstream failed",
    error: "timeout",
    durationMs: 1200,
    createdAt: "2026-05-27T09:00:00Z",
    completedAt: "2026-05-27T09:00:02Z"
  }
];

const agents: MCPAgent[] = [
  {
    agentId: "agent_sales",
    clientId: "sales-client",
    name: "Sales Agent",
    tenantId: "tenant_cn",
    actorId: "actor_zhang",
    status: "active",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T08:00:00Z"
  }
];

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
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T08:00:00Z"
  }
];

const capabilities: MCPCapability[] = [
  {
    id: "cap_search",
    upstreamServerId: "crm-main",
    type: "tool",
    upstreamName: "customer.search",
    exposedName: "crm.customer.search",
    title: "Search Customer",
    description: "Search customer records",
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
    lastSyncedAt: "2026-05-27T08:00:00Z",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T08:00:00Z"
  }
];

describe("MCPProxyAuditPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMCPAuditsMock.mockResolvedValue(audits);
    listMCPAgentsMock.mockResolvedValue(agents);
    listMCPUpstreamServersMock.mockResolvedValue(servers);
    listMCPCapabilitiesMock.mockResolvedValue(capabilities);
  });

  it("passes URL filters as backend query params", async () => {
    const { listMCPAudits: realListMCPAudits } =
      await vi.importActual<typeof import("@/lib/mcp-admin-api")>("@/lib/mcp-admin-api");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] })
    } as Response);

    await realListMCPAudits({
      decision: "allowed",
      agentId: "agent_sales",
      upstreamServerId: "crm-main",
      tool: "crm.customer.search",
      createdFrom: "2026-05-27T00:00:00Z",
      createdTo: "2026-05-28T00:00:00Z",
      errorOnly: true,
      limit: 200
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/mcp/audits?limit=200&decision=allowed&agent_id=agent_sales&upstream_server_id=crm-main&tool=crm.customer.search&created_from=2026-05-27T00%3A00%3A00Z&created_to=2026-05-28T00%3A00%3A00Z&error_only=true",
      expect.objectContaining({ method: "GET" })
    );

    fetchMock.mockRestore();
  });

  it("passes URL filters to the audit adapter", async () => {
    renderPage(
      "/admin/mcp/proxy-audit?decision=allowed&agent_id=agent_sales&upstream_server_id=crm-main&tool=crm.customer.search&created_from=2026-05-27T00:00:00Z&created_to=2026-05-28T00:00:00Z&error_only=true"
    );

    expect(await screen.findByRole("heading", { name: "代理审计" })).toBeInTheDocument();
    await waitFor(() => {
      expect(listMCPAuditsMock).toHaveBeenCalledWith({
        decision: "allowed",
        agentId: "agent_sales",
        upstreamServerId: "crm-main",
        tool: "crm.customer.search",
        createdFrom: "2026-05-27T00:00:00Z",
        createdTo: "2026-05-28T00:00:00Z",
        errorOnly: true,
        limit: 200
      });
    });
  });

  it("does not request unauthorized helper modules for an audit-only account", async () => {
    const account: Account = {
      userId: "usr_auditor",
      email: "auditor@example.com",
      name: "审计员",
      status: "active",
      applications: { frontend: true, admin: true },
      adminRoles: ["security_auditor"],
      adminPermissions: [permissions.mcpAuditRead]
    };
    renderPage("/admin/mcp/proxy-audit", account);

    expect(await screen.findByText("trace-proxy-001")).toBeInTheDocument();
    expect(listMCPAgentsMock).not.toHaveBeenCalled();
    expect(listMCPUpstreamServersMock).not.toHaveBeenCalled();
    expect(listMCPCapabilitiesMock).not.toHaveBeenCalled();
  });

  it("filters visible audits by audit_id from the URL", async () => {
    renderPage("/admin/mcp/proxy-audit?audit_id=audit_2");

    expect(await screen.findByText("trace-proxy-002")).toBeInTheDocument();
    expect(screen.getByText("erp.order.update")).toBeInTheDocument();
    expect(screen.queryByText("trace-proxy-001")).not.toBeInTheDocument();
    expect(screen.queryByText("crm.customer.search")).not.toBeInTheDocument();
  });

  it("filters visible audits by trace_id from the URL", async () => {
    renderPage("/admin/mcp/proxy-audit?trace_id=trace-proxy-001");

    expect(await screen.findByText("trace-proxy-001")).toBeInTheDocument();
    expect(screen.getByText("crm.customer.search")).toBeInTheDocument();
    expect(screen.queryByText("trace-proxy-002")).not.toBeInTheDocument();
    expect(screen.queryByText("erp.order.update")).not.toBeInTheDocument();
  });

  it("clears deep-link filters when the user applies an explicit filter", async () => {
    renderPage("/admin/mcp/proxy-audit?audit_id=audit_2");

    expect(await screen.findByText("trace-proxy-002")).toBeInTheDocument();
    expect(screen.queryByText("trace-proxy-001")).not.toBeInTheDocument();

    await selectFilterOption("筛选审计裁决结果", "已允许");

    expect(await screen.findByText("trace-proxy-001")).toBeInTheDocument();
    expect(screen.queryByText("trace-proxy-002")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(listMCPAuditsMock).toHaveBeenLastCalledWith({
        decision: "allowed",
        limit: 200
      });
    });
  });

  it("shows RFC3339 date query params as local input values and sends local input changes as RFC3339", async () => {
    renderPage("/admin/mcp/proxy-audit?created_from=2026-05-27T04:00:00.000Z&created_to=2026-05-27T05:00:00Z");

    const createdFromInput = screen.getByLabelText("筛选审计开始时间");
    const createdToInput = screen.getByLabelText("筛选审计结束时间");

    expect(createdFromInput).toHaveValue(toDateTimeLocalValue("2026-05-27T04:00:00.000Z"));
    expect(createdToInput).toHaveValue(toDateTimeLocalValue("2026-05-27T05:00:00Z"));

    await waitFor(() => {
      expect(listMCPAuditsMock).toHaveBeenCalledWith({
        createdFrom: "2026-05-27T04:00:00.000Z",
        createdTo: "2026-05-27T05:00:00Z",
        limit: 200
      });
    });

    fireEvent.change(createdFromInput, { target: { value: "2026-05-27T12:30" } });

    await waitFor(() => {
      expect(listMCPAuditsMock).toHaveBeenLastCalledWith({
        createdFrom: new Date("2026-05-27T12:30").toISOString(),
        createdTo: "2026-05-27T05:00:00Z",
        limit: 200
      });
    });

    fireEvent.change(createdToInput, { target: { value: "" } });

    await waitFor(() => {
      expect(listMCPAuditsMock).toHaveBeenLastCalledWith({
        createdFrom: new Date("2026-05-27T12:30").toISOString(),
        limit: 200
      });
    });
  });

  it("toggles error-only filter into error_only=true", async () => {
    renderPage();

    await screen.findByText("crm.customer.search");
    expect(screen.getByRole("checkbox", { name: "仅看错误" })).toHaveClass("size-4", "shrink-0");
    fireEvent.click(screen.getByText("仅看错误"));

    await waitFor(() => {
      expect(listMCPAuditsMock).toHaveBeenLastCalledWith({
        errorOnly: true,
        limit: 200
      });
    });
  });

  it("opens a trace drawer with audit identity fields and JSON evidence", async () => {
    renderPage();

    const row = await findRowByText("trace-proxy-001");
    fireEvent.click(within(row).getByRole("button", { name: "详情" }));

    expect(await screen.findByText("trace_id")).toBeInTheDocument();
    expect(screen.getAllByText("trace-proxy-001").length).toBeGreaterThan(1);
    expect(screen.getByText("inbound-session-001")).toBeInTheDocument();
    expect(screen.getByText("upstream-session-001")).toBeInTheDocument();
    expect(screen.getByText("token_001")).toBeInTheDocument();
    expect(screen.getByText("token_hash_001")).toBeInTheDocument();
    expect(screen.getByText("grant matched")).toBeInTheDocument();

    clickTab(screen.getByRole("tab", { name: "request_body" }));
    expect(screen.getByText(/"keyword": "Acme"/)).toBeInTheDocument();
    clickTab(screen.getByRole("tab", { name: "response_body" }));
    expect(screen.getByText(/"customer_1"/)).toBeInTheDocument();
  });

  it("redacts sensitive request and response headers in the trace drawer", async () => {
    renderPage();

    const row = await findRowByText("trace-proxy-001");
    fireEvent.click(within(row).getByRole("button", { name: "详情" }));

    clickTab(await screen.findByRole("tab", { name: "request_headers" }));
    expect(screen.getByText(/"Authorization": "\*\*\*\*\*\*"/)).toBeInTheDocument();
    expect(screen.getByText(/"Cookie": "\*\*\*\*\*\*"/)).toBeInTheDocument();
    expect(screen.getByText(/"Set-Cookie": "\*\*\*\*\*\*"/)).toBeInTheDocument();
    expect(screen.queryByText(/raw-token/)).not.toBeInTheDocument();
    expect(screen.queryByText(/raw-cookie/)).not.toBeInTheDocument();

    clickTab(screen.getByRole("tab", { name: "response_headers" }));
    expect(screen.getByText(/"Set-Cookie": "\*\*\*\*\*\*"/)).toBeInTheDocument();
    expect(screen.queryByText(/backend-session=raw-cookie/)).not.toBeInTheDocument();
  });
});

function toDateTimeLocalValue(value: string) {
  const date = new Date(value);
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function renderPage(initialEntry = "/admin/mcp/proxy-audit", account?: Account) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        {account ? (
          <AdminPermissionsProvider account={account}>
            <MCPProxyAuditPage />
          </AdminPermissionsProvider>
        ) : (
          <MCPProxyAuditPage />
        )}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function findRowByText(text: string) {
  const cell = await screen.findByText(text);
  const row = cell.closest("tr");
  if (!row) throw new Error(`No table row found for ${text}`);
  return row;
}
