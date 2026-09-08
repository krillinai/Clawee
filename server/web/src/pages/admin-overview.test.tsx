import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import { permissions } from "@/lib/rbac-api";
import {
  listMCPAgents,
  listMCPAudits,
  listMCPCapabilities,
  listMCPGates,
  listMCPGrants,
  listMCPUpstreamServers
} from "@/lib/mcp-admin-api";
import { listKnowledgeBases } from "@/lib/knowledge-api";
import { getAgentActivityList } from "@/lib/office-api";
import type { AgentActivityList, AgentListItem } from "@/lib/office-api";
import { listSharedSpaces } from "@/lib/shared-files-api";
import { listSkills } from "@/lib/skillhub-api";

import { AdminOverviewPage } from "./admin-overview";

vi.mock("@/lib/mcp-admin-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp-admin-api")>("@/lib/mcp-admin-api");
  return {
    ...actual,
    listMCPAgents: vi.fn(),
    listMCPAudits: vi.fn(),
    listMCPCapabilities: vi.fn(),
    listMCPGates: vi.fn(),
    listMCPGrants: vi.fn(),
    listMCPUpstreamServers: vi.fn()
  };
});

vi.mock("@/lib/knowledge-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/knowledge-api")>("@/lib/knowledge-api");
  return { ...actual, listKnowledgeBases: vi.fn() };
});

vi.mock("@/lib/office-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/office-api")>("@/lib/office-api");
  return {
    ...actual,
    getAgentActivityList: vi.fn()
  };
});

vi.mock("@/lib/shared-files-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shared-files-api")>("@/lib/shared-files-api");
  return { ...actual, listSharedSpaces: vi.fn() };
});

vi.mock("@/lib/skillhub-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/skillhub-api")>("@/lib/skillhub-api");
  return { ...actual, listSkills: vi.fn() };
});

const listMCPAgentsMock = vi.mocked(listMCPAgents);
const listMCPAuditsMock = vi.mocked(listMCPAudits);
const listMCPCapabilitiesMock = vi.mocked(listMCPCapabilities);
const listMCPGatesMock = vi.mocked(listMCPGates);
const listMCPGrantsMock = vi.mocked(listMCPGrants);
const listMCPUpstreamServersMock = vi.mocked(listMCPUpstreamServers);
const listKnowledgeBasesMock = vi.mocked(listKnowledgeBases);
const getAgentActivityListMock = vi.mocked(getAgentActivityList);
const listSharedSpacesMock = vi.mocked(listSharedSpaces);
const listSkillsMock = vi.mocked(listSkills);

function renderAdminOverviewPage(adminPermissions?: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      }
    }
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        {adminPermissions ? <AdminPermissionsProvider account={{
          userId: "usr_reader",
          email: "reader@example.com",
          name: "Reader",
          status: "active",
          adminPermissions
        }}><AdminOverviewPage /></AdminPermissionsProvider> : <AdminOverviewPage />}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function mockAgent(index: number) {
  return {
    agentId: `agent_${index}`,
    clientId: `client_${index}`,
    name: `Agent ${index}`,
    tenantId: "tenant_default",
    actorId: `user_${index}`,
    status: "active",
    createdAt: "2026-06-11T00:00:00Z",
    updatedAt: "2026-06-11T00:00:00Z"
  };
}

function mockActivityAgent(index: number, overrides: Partial<AgentListItem> = {}): AgentListItem {
  return {
    collector_id: `collector_${index}`,
    agent_id: `office_agent_${index}_very_long_identifier`,
    display_name: `Office Agent ${index}`,
    avatar_label: `A${index}`,
    agent_type: "external",
    role_label: "Agent",
    device_id: `device_${index}`,
    workspace_name: "default",
    status: "idle",
    sub_agents: {
      active_count: 0,
      total_count: 0,
      preview: []
    },
    sessions: [],
    recent_tool_calls: 0,
    last_seen_at: "2026-06-11T00:00:00Z",
    updated_at: "2026-06-11T00:00:00Z",
    ...overrides
  };
}

function mockOfficeActivity(agents: AgentListItem[] = []): AgentActivityList {
  return {
    schema_version: "office.v1",
    server_time: "2026-06-11T00:00:00Z",
    sse_url: "/api/v1/admin/office/events",
    filters: {
      workspaces: [],
      status_counts: {},
      business_systems: []
    },
    summary: {
      total_agents: agents.length,
      online_agents: agents.length,
      active_sub_agents: 0,
      blocked_agents: 0,
      error_agents: 0,
      working_agents: 0,
      active_sessions: 0,
      active_turns: 0,
      recent_tool_call_count: 0
    },
    agents,
    recent_feed: []
  };
}

function mockServer(index: number) {
  return {
    id: `server_${index}`,
    name: `CRM Upstream ${index}`,
    domain: "crm",
    transport: "http",
    endpoint: `http://127.0.0.1:${9100 + index}/mcp`,
    authType: "none",
    credentialRef: "",
    ownerTeam: "sales",
    namespace: "crm",
    status: "active",
    capabilitiesCount: index + 1,
    createdAt: "2026-06-11T00:00:00Z",
    updatedAt: "2026-06-11T00:00:00Z"
  } as const;
}

function mockCapability(index: number) {
  return {
    id: `cap_${index}`,
    upstreamServerId: `server_${index <= 2 ? 1 : 2}`,
    type: "tool",
    upstreamName: `tool_${index}`,
    exposedName: `crm.customer.tool_${index}`,
    title: `Tool ${index}`,
    description: "",
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
    schemaHash: `hash_${index}`,
    version: "1",
    lastSyncedAt: "2026-06-11T00:00:00Z",
    createdAt: "2026-06-11T00:00:00Z",
    updatedAt: "2026-06-11T00:00:00Z"
  } as const;
}

function mockGrant(index: number) {
  return {
    id: `grant_${index}`,
    userId: `user_${index}`,
    capabilityId: `cap_${index}`,
    grantType: "tool",
    dataScope: {},
    expiresAt: null,
    createdBy: "admin",
    createdAt: "2026-06-11T00:00:00Z",
    updatedAt: "2026-06-11T00:00:00Z"
  } as const;
}

function mockAudit(index: number, decision = "allowed") {
  return {
    id: `audit_${index}`,
    traceId: `trace_${index}`,
    requestId: `request_${index}`,
    inboundSessionId: `inbound_${index}`,
    upstreamSessionId: `upstream_session_${index}`,
    agentId: `agent_${index}`,
    actorId: `user_${index}`,
    tenantId: "tenant_default",
    tokenId: `token_${index}`,
    tokenHash: `hash_${index}`,
    upstreamServerId: "server_1",
    capabilityId: `cap_${index}`,
    capabilityType: "tool",
    exposedName: `crm.customer.tool_${index}`,
    upstreamName: `tool_${index}`,
    requestHeaders: {},
    requestBody: {},
    responseHeaders: {},
    responseBody: {},
    decision,
    decisionReason: "",
    error: "",
    durationMs: 12,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  } as const;
}

function mockGate(index: number) {
  return {
    id: `gate_${index}`,
    type: "admin_approval",
    provider: "internal",
    traceId: `trace_gate_${index}`,
    tenantId: "tenant_default",
    agentId: `agent_${index}`,
    actorId: `user_${index}`,
    capabilityId: `cap_${index}`,
    upstreamServerId: "server_1",
    exposedName: `crm.customer.tool_${index}`,
    upstreamName: `tool_${index}`,
    requestBody: {},
    argumentsHash: `arguments_${index}`,
    schemaHash: `schema_${index}`,
    gateSummary: {
      system: "CRM",
      action: "更新",
      object: "客户",
      tool: `tool_${index}`,
      riskLevel: "high",
      destructive: false,
      readOnly: false,
      parameters: [],
      risks: []
    },
    status: "pending",
    confirmUrl: "",
    decidedBy: "",
    decisionReason: "",
    decidedAt: null,
    expiresAt: "2099-06-11T00:00:00Z",
    executionAuditId: "",
    responseBody: {},
    error: "",
    createdAt: "2026-06-11T00:00:00Z",
    updatedAt: "2026-06-11T00:00:00Z",
    externalInstanceId: "",
    externalUrl: ""
  };
}

describe("AdminOverviewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMCPAgentsMock.mockResolvedValue([]);
    listMCPAuditsMock.mockResolvedValue([]);
    listMCPCapabilitiesMock.mockResolvedValue([]);
    listMCPGatesMock.mockResolvedValue([]);
    listMCPGrantsMock.mockResolvedValue([]);
    listMCPUpstreamServersMock.mockResolvedValue([]);
    listKnowledgeBasesMock.mockResolvedValue([]);
    getAgentActivityListMock.mockResolvedValue(mockOfficeActivity());
    listSharedSpacesMock.mockResolvedValue({ items: [], meta: { next_cursor: "", has_next: false } });
    listSkillsMock.mockResolvedValue([]);
  });

  it("does not show the hidden gateway summary on the overview", async () => {
    renderAdminOverviewPage();

    expect(await screen.findByRole("heading", { name: "企业治理总览" })).toBeInTheDocument();
    expect(screen.queryByText("治理态势")).not.toBeInTheDocument();
    expect(screen.queryByText(`${["Action", "Gateway"].join(" ")} 摘要`)).not.toBeInTheDocument();
    expect(screen.queryByText(`查看 ${["Action", "Runs"].join(" ")}`)).not.toBeInTheDocument();
    expect(screen.queryByText(`暂无 ${["Action", "Runs"].join(" ")}。`)).not.toBeInTheDocument();
  });

  it("renders the gateway topology with Office activity agents and MCP upstream data", async () => {
    listMCPAgentsMock.mockResolvedValue(Array.from({ length: 6 }, (_, index) => mockAgent(index + 1)));
    getAgentActivityListMock.mockResolvedValue(
      mockOfficeActivity(Array.from({ length: 6 }, (_, index) => mockActivityAgent(index + 1)))
    );
    listMCPUpstreamServersMock.mockResolvedValue(Array.from({ length: 6 }, (_, index) => mockServer(index + 1)));
    listMCPCapabilitiesMock.mockResolvedValue(
      Array.from({ length: 3 }, (_, index) => mockCapability(index + 1))
    );
    listMCPGrantsMock.mockResolvedValue(Array.from({ length: 2 }, (_, index) => mockGrant(index + 1)));
    listMCPAuditsMock.mockResolvedValue([
      mockAudit(1, "allowed"),
      mockAudit(2, "rejected"),
      mockAudit(3, "upstream_error")
    ]);

    renderAdminOverviewPage();

    const topology = await screen.findByRole("region", { name: "Agent 接入治理链路" });

    expect(await within(topology).findByText("6 个运行实例")).toBeInTheDocument();
    expect(within(topology).getByText("6 个上游服务")).toBeInTheDocument();
    expect(within(topology).getByText("Office Agent 4")).toBeInTheDocument();
    expect(within(topology).queryByText("Office Agent 5")).not.toBeInTheDocument();
    expect(within(topology).queryByText("Agent 1")).not.toBeInTheDocument();
    expect(within(topology).getAllByText("另有 2 个")).toHaveLength(2);
    expect(within(topology).getByTestId("gateway-stat-grants")).toHaveTextContent("2");
    expect(within(topology).getByTestId("gateway-stat-tools")).toHaveTextContent("3 / 3");
    expect(within(topology).getByTestId("gateway-stat-audits")).toHaveTextContent("3");
    expect(within(topology).getByTestId("gateway-stat-intercepts")).toHaveTextContent("2");
    expect(listMCPAgentsMock).toHaveBeenCalledTimes(1);
    expect(listMCPUpstreamServersMock).toHaveBeenCalledTimes(1);
    expect(listMCPCapabilitiesMock).toHaveBeenCalledTimes(1);
    expect(listMCPGrantsMock).toHaveBeenCalledTimes(1);
    expect(listMCPAuditsMock).toHaveBeenCalledTimes(1);
    expect(listMCPAuditsMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 200, createdFrom: expect.any(String) }));
    expect(getAgentActivityListMock).toHaveBeenCalledTimes(1);
  });

  it("使用真实审计数据展示趋势、结果、能力排行和活跃排行", async () => {
    listMCPAgentsMock.mockResolvedValue([
      { ...mockAgent(1), boundUserId: "user_1", boundUserName: "林晓" },
      { ...mockAgent(2), boundUserId: "user_2", boundUserName: "陈明" }
    ]);
    listMCPAuditsMock.mockResolvedValue([
      mockAudit(1, "allowed"),
      { ...mockAudit(2, "allowed"), agentId: "agent_1", actorId: "user_1", exposedName: "crm.customer.tool_1" },
      { ...mockAudit(3, "rejected"), agentId: "agent_1", actorId: "user_1", exposedName: "crm.customer.tool_1" },
      { ...mockAudit(4, "upstream_error"), agentId: "agent_2", actorId: "user_2" }
    ]);

    renderAdminOverviewPage();

    expect(await screen.findByRole("region", { name: "代理调用趋势" })).toBeInTheDocument();
    const results = screen.getByRole("region", { name: "调用结果分布" });
    expect(await within(results).findByText("2")).toBeInTheDocument();
    expect(within(results).getAllByText("1")).toHaveLength(2);

    const capabilities = screen.getByRole("region", { name: "高频能力调用" });
    expect(within(capabilities).getByText("crm.customer.tool_1")).toBeInTheDocument();
    expect(within(capabilities).getByText("3")).toBeInTheDocument();

    const activity = screen.getByRole("region", { name: "Agent 活跃使用" });
    expect(within(activity).getByText("林晓")).toBeInTheDocument();
    expect(within(activity).getByText("3")).toBeInTheDocument();
  });

  it("将卡片说明收进标题后的帮助提示", async () => {
    renderAdminOverviewPage();

    const description = "按审计记录聚合请求量，辅助识别流量波动与异常时段。";
    expect(screen.queryByText(description)).not.toBeInTheDocument();

    const helpButton = await screen.findByRole("button", { name: "查看代理调用趋势说明" });
    fireEvent.focus(helpButton);

    expect(await screen.findByRole("tooltip")).toHaveTextContent(description);
    expect(screen.getByRole("button", { name: "查看 Agent 接入治理链路说明" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看 Agent 活跃使用说明" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看企业资源状态说明" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看调用结果分布说明" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看高频能力调用说明" })).toBeInTheDocument();
  });

  it("按治理链路、企业资源、调用趋势和活跃使用排列总览面板", async () => {
    renderAdminOverviewPage();

    const governance = await screen.findByRole("region", { name: "治理概况" });
    const accessAndResources = screen.getByRole("region", { name: "接入与资源" });
    const analysisAndActions = screen.getByRole("region", { name: "分析与处置" });
    const topology = await screen.findByRole("region", { name: "Agent 接入治理链路" });
    const activity = await screen.findByRole("region", { name: "Agent 活跃使用" });
    const enterprise = await screen.findByRole("region", { name: "企业资源状态" });
    const trend = await screen.findByRole("region", { name: "代理调用趋势" });

    expect(within(governance).getByLabelText("核心治理指标")).toBeInTheDocument();
    expect(within(accessAndResources).getByRole("region", { name: "Agent 接入治理链路" })).toBe(topology);
    expect(within(accessAndResources).getByRole("region", { name: "企业资源状态" })).toBe(enterprise);
    expect(within(analysisAndActions).getByRole("region", { name: "代理调用趋势" })).toBe(trend);
    expect(within(analysisAndActions).getByRole("region", { name: "Agent 活跃使用" })).toBe(activity);
    expect(screen.getByRole("heading", { level: 2, name: "接入与资源" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "分析与处置" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Agent 接入治理链路" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "企业资源状态" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Agent 活跃使用" })).toBeInTheDocument();
    expect(governance.compareDocumentPosition(accessAndResources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(accessAndResources.compareDocumentPosition(analysisAndActions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(topology.compareDocumentPosition(enterprise) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(enterprise.compareDocumentPosition(trend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(trend.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("通过吸顶分区导航快速定位总览区域", async () => {
    renderAdminOverviewPage();

    const navigation = await screen.findByRole("navigation", { name: "总览分区导航" });
    const governanceLink = within(navigation).getByRole("link", { name: "治理概况" });
    const accessLink = within(navigation).getByRole("link", { name: "接入与资源" });
    const analysisLink = within(navigation).getByRole("link", { name: "分析与处置" });
    const analysisSection = screen.getByRole("region", { name: "分析与处置" });
    const scrollSpy = vi.spyOn(analysisSection, "scrollIntoView");

    expect(navigation).toHaveClass("sticky", "top-0");
    expect(navigation.firstElementChild).toHaveClass("rounded-lg", "bg-muted", "p-1");
    expect(governanceLink).toHaveAttribute("aria-current", "location");
    expect(governanceLink).toHaveClass("border", "bg-card", "text-foreground", "shadow-sm");
    expect(accessLink).toHaveClass("text-muted-foreground");
    expect(accessLink).not.toHaveClass("border", "bg-card", "shadow-sm");
    expect(accessLink).toHaveAttribute("href", "#access-resources");
    expect(analysisLink).toHaveAttribute("href", "#analysis-actions");

    fireEvent.click(analysisLink);

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(analysisLink).toHaveAttribute("aria-current", "location");
    expect(analysisLink).toHaveClass("border", "bg-card", "text-foreground", "shadow-sm");
    expect(governanceLink).toHaveClass("text-muted-foreground");
    expect(governanceLink).not.toHaveAttribute("aria-current");
    scrollSpy.mockRestore();
  });

  it("滚动页面时同步高亮当前总览区域", async () => {
    const positions: Record<string, { bottom: number; top: number }> = {
      "governance-overview": { bottom: 700, top: 160 },
      "access-resources": { bottom: 1500, top: 760 },
      "analysis-actions": { bottom: 2300, top: 1560 }
    };
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const position = positions[this.id];
      if (position) {
        return {
          bottom: position.bottom,
          height: position.bottom - position.top,
          left: 0,
          right: 1200,
          top: position.top,
          width: 1200,
          x: 0,
          y: position.top,
          toJSON: () => ({})
        };
      }
      if (this.getAttribute("aria-label") === "总览分区导航") {
        return {
          bottom: 48,
          height: 48,
          left: 0,
          right: 1200,
          top: 0,
          width: 1200,
          x: 0,
          y: 0,
          toJSON: () => ({})
        };
      }
      return {
        bottom: 0,
        height: 0,
        left: 0,
        right: 0,
        top: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({})
      };
    });

    try {
      renderAdminOverviewPage();
      const navigation = await screen.findByRole("navigation", { name: "总览分区导航" });
      const governanceLink = within(navigation).getByRole("link", { name: "治理概况" });
      const accessLink = within(navigation).getByRole("link", { name: "接入与资源" });
      expect(governanceLink).toHaveAttribute("aria-current", "location");

      positions["governance-overview"] = { bottom: -40, top: -580 };
      positions["access-resources"] = { bottom: 700, top: 40 };
      positions["analysis-actions"] = { bottom: 1500, top: 760 };
      fireEvent.scroll(window);

      await waitFor(() => expect(accessLink).toHaveAttribute("aria-current", "location"));
      expect(governanceLink).not.toHaveAttribute("aria-current");
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("切换统计范围后按所选时间重新请求审计数据", async () => {
    renderAdminOverviewPage();

    const rangeSelect = await screen.findByRole("combobox", { name: "统计时间范围" });
    fireEvent.click(rangeSelect);
    fireEvent.click(await within(screen.getByRole("listbox")).findByRole("option", { name: "最近 7 天" }));

    await waitFor(() => expect(listMCPAuditsMock).toHaveBeenCalledTimes(2));
    const latestFilters = listMCPAuditsMock.mock.calls.at(-1)?.[0];
    const requestedSince = Date.parse(latestFilters?.createdFrom ?? "");
    const elapsed = Date.now() - requestedSince;
    expect(elapsed).toBeGreaterThanOrEqual(6.9 * 24 * 60 * 60 * 1000);
    expect(elapsed).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);
    expect(await screen.findByText("7 天代理调用")).toBeInTheDocument();
  });

  it("按已绑定运行实例计算 Agent 接入覆盖", async () => {
    listMCPAgentsMock.mockResolvedValue([mockAgent(1), mockAgent(2)]);
    listMCPGrantsMock.mockResolvedValue([mockGrant(1)]);
    getAgentActivityListMock.mockResolvedValue(mockOfficeActivity([
      mockActivityAgent(1, { mcp_agent_id: "agent_1" }),
      mockActivityAgent(3)
    ]));

    renderAdminOverviewPage();

    const label = await screen.findByText("Agent 接入覆盖");
    const card = label.parentElement?.parentElement;
    expect(card).not.toBeNull();
    expect(await within(card!).findByText("1/2")).toBeInTheDocument();
    expect(within(card!).getByText("1 未接入 · 0 离线")).toBeInTheDocument();

    const governanceLabel = await screen.findByText("治理待办");
    const governanceCard = governanceLabel.parentElement?.parentElement;
    expect(governanceCard).not.toBeNull();
    expect(await within(governanceCard!).findByText("2")).toBeInTheDocument();
    expect(within(governanceCard!).getByText("Agent 1 · 门禁 0 · 能力授权 1 · 上游 0")).toBeInTheDocument();
  });

  it("治理待办总数与未接入 Agent 摘要和明细保持一致", async () => {
    getAgentActivityListMock.mockResolvedValue(mockOfficeActivity(
      Array.from({ length: 7 }, (_, index) => mockActivityAgent(index + 1))
    ));

    renderAdminOverviewPage();

    const governanceLabel = await screen.findByText("治理待办");
    const governanceCard = governanceLabel.parentElement?.parentElement;
    expect(governanceCard).not.toBeNull();
    expect(await within(governanceCard!).findByText("7")).toBeInTheDocument();
    expect(within(governanceCard!).getByText("Agent 7 · 门禁 0 · 能力授权 0 · 上游 0")).toBeInTheDocument();

    expect(screen.getByText("Agent 尚未接入 MCP")).toBeInTheDocument();
    expect(screen.getByText("7 个运行实例尚未建立 MCP 治理身份。")).toBeInTheDocument();
  });

  it("治理待办为空时隐藏治理工作台", async () => {
    renderAdminOverviewPage();

    expect(await screen.findByText("最近 24 小时暂无能力调用")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "治理工作台" })).not.toBeInTheDocument();
    expect(screen.queryByText("当前没有需要处理的治理风险")).not.toBeInTheDocument();
    expect(screen.getByLabelText("能力使用与治理待办")).not.toHaveClass("lg:grid-cols-2");
  });

  it("展示治理待办和已落地的企业资源状态", async () => {
    listMCPGatesMock.mockResolvedValue([mockGate(1)]);
    listKnowledgeBasesMock.mockResolvedValue([{
      knowledgeBaseId: "kb_1",
      name: "企业知识库",
      description: "",
      providerType: "builtin",
      status: "active",
      errorMessage: "",
      documentCount: 12,
      createdBy: "admin",
      createdAt: "2026-06-11T00:00:00Z",
      updatedAt: "2026-06-11T00:00:00Z"
    }]);
    listSkillsMock.mockResolvedValue([{
      skillId: "skill_1",
      name: "日报生成",
      description: "",
      currentVersionId: "version_1",
      createdBy: "admin",
      createdAt: "2026-06-11T00:00:00Z",
      updatedAt: "2026-06-11T00:00:00Z"
    }]);
    listSharedSpacesMock.mockResolvedValue({
      items: [{
        spaceId: "space_1",
        name: "运营空间",
        description: "",
        memberCount: 3,
        fileCount: 7,
        sizeBytes: 1024,
        createdBy: "admin",
        createdAt: "2026-06-11T00:00:00Z",
        updatedBy: "admin",
        updatedAt: "2026-06-11T00:00:00Z"
      }],
      meta: { next_cursor: "", has_next: false }
    });

    renderAdminOverviewPage();

    expect(await screen.findByRole("heading", { name: "治理工作台" })).toBeInTheDocument();
    const pendingApproval = await screen.findByText("管理员审批待处理");
    expect(pendingApproval).toBeInTheDocument();
    expect(pendingApproval.closest('[data-slot="card"]')).toHaveClass(
      "rounded-none",
      "border-x-0",
      "border-b-0",
      "bg-transparent",
      "first:border-t-0"
    );
    expect(screen.getByText("1 项待办")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "处理 1 项待办" })).not.toBeInTheDocument();
    const pageHeader = screen.getByRole("heading", { name: "企业治理总览" }).closest("header");
    expect(pageHeader).not.toBeNull();
    expect(within(pageHeader!).getByRole("status")).toHaveTextContent("实时治理数据 · 最近更新");
    expect(within(pageHeader!).getByRole("link", { name: "查看代理审计" })).toHaveAttribute("href", "/admin/mcp/audits");
    const resources = screen.getByRole("region", { name: "企业资源状态" });
    expect(resources).toBeInTheDocument();
    expect(await within(resources).findByRole("img", { name: "纳管资源分布，共 3 项" })).toBeInTheDocument();
    expect(within(resources).getByText("12 份文档")).toBeInTheDocument();
    expect(within(resources).getByText("1 个已发布")).toBeInTheDocument();
    expect(within(resources).getByText("7 份文件")).toBeInTheDocument();
    expect(within(resources).getAllByRole("link", { name: "查看" })).toHaveLength(3);
  });

  it("只请求当前账号有权读取的总览数据源", async () => {
    renderAdminOverviewPage([permissions.mcpCapabilityRead]);

    expect(await screen.findByRole("heading", { name: "企业治理总览" })).toBeInTheDocument();
    await waitFor(() => expect(listMCPCapabilitiesMock).toHaveBeenCalledTimes(1));
    expect(listMCPAgentsMock).not.toHaveBeenCalled();
    expect(listMCPAuditsMock).not.toHaveBeenCalled();
    expect(listMCPGrantsMock).not.toHaveBeenCalled();
    expect(listMCPUpstreamServersMock).not.toHaveBeenCalled();
    expect(getAgentActivityListMock).not.toHaveBeenCalled();
    expect(listMCPGatesMock).not.toHaveBeenCalled();
    expect(listKnowledgeBasesMock).not.toHaveBeenCalled();
    expect(listSkillsMock).not.toHaveBeenCalled();
    expect(listSharedSpacesMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /处理 \d+ 项待办/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查看失败调用" })).not.toBeInTheDocument();
  });

  it("仅有审计权限时显示分析区且不渲染空的接入资源区", async () => {
    renderAdminOverviewPage([permissions.mcpAuditRead]);

    expect(await screen.findByRole("heading", { level: 2, name: "分析与处置" })).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "总览分区导航" });
    expect(within(navigation).getByRole("link", { name: "治理概况" })).toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: "分析与处置" })).toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "接入与资源" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "代理调用趋势" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent 活跃使用" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "接入与资源" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Agent 接入治理链路" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "企业资源状态" })).not.toBeInTheDocument();
  });
});
