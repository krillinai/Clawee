import { render as testingLibraryRender, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { MCPUpstreamServer } from "@/lib/mcp-admin-api";
import type { DashboardSummary } from "@/lib/mcp-admin-ui";

import { MCPGatewayTopology } from "./mcp-gateway-topology";
import type { TopologyAgent } from "./mcp-gateway-topology";

function render(ui: ReactElement) {
  return testingLibraryRender(<MemoryRouter>{ui}</MemoryRouter>);
}

function agent(index: number, overrides: Partial<TopologyAgent> = {}): TopologyAgent {
  return {
    id: `collector_${index}/agent_${index}`,
    title: `Agent ${index}`,
    meta: `agent_${index}`,
    status: index % 2 === 0 ? "disabled" : "active",
    href: `/admin/activity/detail?collector_id=collector_${index}&agent_id=agent_${index}`,
    ...overrides
  };
}

function upstream(index: number, overrides: Partial<MCPUpstreamServer> = {}): MCPUpstreamServer {
  return {
    id: `server_${index}`,
    name: `Upstream ${index}`,
    domain: "crm",
    transport: "http",
    endpoint: `http://127.0.0.1:${9000 + index}/mcp`,
    authType: "none",
    credentialRef: "",
    ownerTeam: "sales",
    namespace: "default",
    status: index % 2 === 0 ? "sync_failed" : "active",
    capabilitiesCount: index + 2,
    createdAt: "2026-06-11T00:00:00Z",
    updatedAt: "2026-06-11T00:00:00Z",
    ...overrides
  };
}

function summary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    servers: {
      total: 6,
      active: 4,
      disabled: 1,
      syncFailed: 1
    },
    capabilities: {
      total: 12,
      active: 9,
      pending: 2,
      disabled: 0,
      missing: 1,
      granted: 5,
      missingButGranted: 0,
      pendingCount: 2,
      missingWithGrants: 0
    },
    agents: {
      total: 6,
      active: 4,
      disabled: 2,
      disabledWithRecentAudits: 1
    },
    grants: {
      total: 8
    },
    audits: {
      total: 20,
      allowed: 13,
      rejected: 3,
      upstreamError: 2,
      recent24h: 18
    },
    lastToolSyncAt: "2026-06-11T00:00:00Z",
    ...overrides
  };
}

describe("MCPGatewayTopology", () => {
  it("shows agent and upstream totals from props", () => {
    render(
      <MCPGatewayTopology
        agents={[agent(1), agent(2), agent(3)]}
        servers={[upstream(1), upstream(2)]}
        summary={summary({
          agents: {
            total: 99,
            active: 2,
            disabled: 1,
            disabledWithRecentAudits: 0
          },
          servers: {
            total: 88,
            active: 1,
            disabled: 0,
            syncFailed: 1
          }
        })}
      />
    );

    expect(screen.getByRole("region", { name: "Agent 接入治理链路" })).toBeInTheDocument();
    expect(screen.getByText("3 个运行实例")).toBeInTheDocument();
    expect(screen.getByText("2 个上游服务")).toBeInTheDocument();
    expect(screen.getByText("Agent 1")).toBeInTheDocument();
    expect(screen.getByText("Upstream 2")).toBeInTheDocument();
    expect(screen.getByText(/^4 个能力 ·/)).toBeInTheDocument();
  });

  it("links topology panels to lists and rows to their details", () => {
    render(<MCPGatewayTopology agents={[agent(1)]} servers={[upstream(1)]} summary={summary()} />);

    expect(screen.getByRole("link", { name: "查看 Agent 运行实例列表" })).toHaveAttribute("href", "/admin/activity");
    expect(screen.getByRole("link", { name: "查看 Agent 1 详情" })).toHaveAttribute(
      "href",
      "/admin/activity/detail?collector_id=collector_1&agent_id=agent_1"
    );
    expect(screen.getByRole("link", { name: "查看 上游 MCP 服务列表" })).toHaveAttribute(
      "href",
      "/admin/mcp/upstream-servers"
    );
    expect(screen.getByRole("link", { name: "查看 Upstream 1 详情" })).toHaveAttribute(
      "href",
      "/admin/mcp/upstream-servers/detail?server_id=server_1"
    );
  });

  it("attaches topology animation hooks", () => {
    render(<MCPGatewayTopology agents={[agent(1), agent(2)]} servers={[upstream(1)]} summary={summary()} />);

    expect(screen.getByText("Clawee MCP Gateway").closest("section")?.querySelector(".mcp-topology-gateway-pulse")).toBeInTheDocument();
    expect(screen.getAllByTestId("agent-gateway-line")[0]).toHaveClass("mcp-topology-flow");
    expect(screen.getAllByTestId("gateway-upstream-line")[0]).toHaveClass("mcp-topology-flow");
  });

  it("keeps connector control points inside narrow measured gaps", () => {
    const makeRect = (x: number, width: number, height = 300, y = 0): DOMRect => ({
      x,
      y,
      top: y,
      left: x,
      right: x + width,
      bottom: y + height,
      width,
      height,
      toJSON: () => ({})
    });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "mcp-gateway-topology-grid") return makeRect(0, 1000);
      if (this.dataset.topologyPanel === "agent") return makeRect(42, 288);
      if (this.dataset.topologyPanel === "gateway") return makeRect(400, 200);
      if (this.dataset.topologyPanel === "upstream") return makeRect(670, 288);
      if (this.classList.contains("mcp-topology-row")) {
        const side = this.closest<HTMLElement>("[data-topology-panel]")?.dataset.topologyPanel;
        return side === "agent" ? makeRect(50, 280, 40, 130) : makeRect(670, 280, 40, 130);
      }
      return makeRect(0, 0, 0);
    });

    try {
      render(<MCPGatewayTopology agents={[agent(1)]} servers={[upstream(1)]} summary={summary()} />);

      expect(screen.getByTestId("agent-gateway-line")).toHaveAttribute("d", "M 33 50 C 36.2 50, 36.9 50, 40 50");
      expect(screen.getByTestId("gateway-upstream-line")).toHaveAttribute("d", "M 60 50 C 63.2 50, 63.9 50, 67 50");
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("anchors every connector to its corresponding row edge and center", () => {
    const makeRect = (x: number, width: number, height: number, y: number): DOMRect => ({
      x,
      y,
      top: y,
      left: x,
      right: x + width,
      bottom: y + height,
      width,
      height,
      toJSON: () => ({})
    });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "mcp-gateway-topology-grid") return makeRect(0, 1000, 400, 0);
      if (this.dataset.topologyPanel === "agent") return makeRect(42, 288, 160, 80);
      if (this.dataset.topologyPanel === "gateway") return makeRect(400, 200, 300, 50);
      if (this.dataset.topologyPanel === "upstream") return makeRect(670, 288, 160, 160);
      if (this.classList.contains("mcp-topology-row")) {
        const side = this.closest<HTMLElement>("[data-topology-panel]")?.dataset.topologyPanel;
        const siblings = Array.from(this.parentElement?.querySelectorAll(".mcp-topology-row") ?? []);
        const index = siblings.indexOf(this);
        return side === "agent" ? makeRect(50, 280, 40, 100 + index * 60) : makeRect(670, 280, 40, 200 + index * 60);
      }
      return makeRect(0, 0, 0, 0);
    });

    try {
      render(<MCPGatewayTopology agents={[agent(1), agent(2)]} servers={[upstream(1), upstream(2)]} summary={summary()} />);

      const agentLines = screen.getAllByTestId("agent-gateway-line");
      const upstreamLines = screen.getAllByTestId("gateway-upstream-line");
      expect(agentLines[0]).toHaveAttribute("d", "M 33 30 C 36.2 35.6, 36.9 50, 40 50");
      expect(agentLines[1]).toHaveAttribute("d", "M 33 45 C 36.2 46.4, 36.9 50, 40 50");
      expect(upstreamLines[0]).toHaveAttribute("d", "M 60 50 C 63.2 50, 63.9 53.6, 67 55");
      expect(upstreamLines[1]).toHaveAttribute("d", "M 60 50 C 63.2 50, 63.9 64.4, 67 70");
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("shows gateway governance stats from summary", () => {
    render(<MCPGatewayTopology agents={[agent(1)]} servers={[upstream(1)]} summary={summary()} />);

    expect(screen.getByTestId("gateway-stat-grants")).toHaveTextContent("8");
    expect(screen.getByTestId("gateway-stat-tools")).toHaveTextContent("9 / 12");
    expect(screen.getByTestId("gateway-stat-audits")).toHaveTextContent("18");
    expect(screen.getByTestId("gateway-stat-intercepts")).toHaveTextContent("5");
    expect(screen.getByText("认证")).toBeInTheDocument();
    expect(screen.getByText("授权")).toBeInTheDocument();
    expect(screen.getByText("审计")).toBeInTheDocument();
    expect(screen.getByText("门禁")).toBeInTheDocument();
  });

  it("caps lists at four rows and shows more counts", () => {
    render(
      <MCPGatewayTopology
        agents={Array.from({ length: 7 }, (_, index) => agent(index + 1, { status: "active" }))}
        servers={Array.from({ length: 6 }, (_, index) => upstream(index + 1, { status: "active" }))}
        summary={summary()}
      />
    );

    expect(screen.getByText("Agent 4")).toBeInTheDocument();
    expect(screen.queryByText("Agent 5")).not.toBeInTheDocument();
    expect(screen.getByText("另有 3 个")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看其余 3 个 Agent 运行实例" })).toHaveAttribute("href", "/admin/activity");
    expect(screen.getByText("Upstream 4")).toBeInTheDocument();
    expect(screen.queryByText("Upstream 5")).not.toBeInTheDocument();
    expect(screen.getByText("另有 2 个")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看其余 2 个 上游 MCP 服务" })).toHaveAttribute(
      "href",
      "/admin/mcp/upstream-servers"
    );
  });

  it("prioritizes active agents and upstream services in visible rows", () => {
    render(
      <MCPGatewayTopology
        agents={[
          agent(1, { title: "Disabled Agent 1", status: "disabled" }),
          agent(2, { title: "Disabled Agent 2", status: "disabled" }),
          agent(3, { title: "Disabled Agent 3", status: "disabled" }),
          agent(4, { title: "Disabled Agent 4", status: "disabled" }),
          agent(5, { title: "Disabled Agent 5", status: "disabled" }),
          agent(6, { title: "Active Agent", status: "active" })
        ]}
        servers={[
          upstream(1, { name: "Disabled Upstream 1", status: "disabled" }),
          upstream(2, { name: "Disabled Upstream 2", status: "disabled" }),
          upstream(3, { name: "Disabled Upstream 3", status: "disabled" }),
          upstream(4, { name: "Disabled Upstream 4", status: "disabled" }),
          upstream(5, { name: "Disabled Upstream 5", status: "disabled" }),
          upstream(6, { name: "Active Upstream", status: "active" })
        ]}
        summary={summary()}
      />
    );

    expect(screen.getByText("Active Agent")).toBeInTheDocument();
    expect(screen.queryByText("Disabled Agent 4")).not.toBeInTheDocument();
    expect(screen.getByText("Active Upstream")).toBeInTheDocument();
    expect(screen.queryByText("Disabled Upstream 4")).not.toBeInTheDocument();
  });

  it("renders only visible row connection lines", () => {
    render(
      <MCPGatewayTopology
        agents={[agent(1), agent(2), agent(3), agent(4), agent(5), agent(6)]}
        servers={[upstream(1), upstream(2), upstream(3), upstream(4), upstream(5), upstream(6), upstream(7)]}
        summary={summary()}
      />
    );

    expect(screen.getAllByTestId("agent-gateway-line")).toHaveLength(4);
    expect(screen.getAllByTestId("gateway-upstream-line")).toHaveLength(4);
  });

  it("does not render extra endpoint anchor branches", () => {
    render(<MCPGatewayTopology agents={[agent(1), agent(2)]} servers={[upstream(1)]} summary={summary()} />);

    expect(screen.queryByTestId("agent-panel-anchor-line")).not.toBeInTheDocument();
    expect(screen.queryByTestId("upstream-panel-anchor-line")).not.toBeInTheDocument();
  });

  it("uses compact container-aware tracks for the topology panels", () => {
    render(<MCPGatewayTopology agents={[agent(1)]} servers={[upstream(1)]} summary={summary()} />);

    const region = screen.getByRole("region", { name: "Agent 接入治理链路" });
    const topology = screen.getByTestId("mcp-gateway-topology-grid");
    const agentPanel = region.querySelector('[data-topology-panel="agent"]');
    const gatewayPanel = region.querySelector('[data-topology-panel="gateway"]');
    const upstreamPanel = region.querySelector('[data-topology-panel="upstream"]');
    const agentRow = agentPanel?.querySelector(".mcp-topology-row");
    const upstreamRow = upstreamPanel?.querySelector(".mcp-topology-row");
    const agentMeta = agentPanel?.querySelector(".mcp-topology-row-meta");
    const statusBadge = agentPanel?.querySelector(".mcp-topology-status");

    expect(topology).toBeInTheDocument();
    expect(topology.parentElement).toHaveClass("mcp-topology-container");
    expect(topology).toHaveClass("mcp-topology-grid");
    expect(region).toHaveClass("border", "shadow-sm");
    expect(agentPanel).toHaveClass("mcp-topology-side-panel", "w-full", "content-start", "bg-muted/35");
    expect(agentPanel).not.toHaveClass("border", "shadow-sm");
    expect(upstreamPanel).toHaveClass("bg-muted/35");
    expect(upstreamPanel).not.toHaveClass("border", "shadow-sm");
    expect(agentPanel?.querySelector(".mcp-topology-list")).toHaveClass("border-t", "border-border/35");
    expect(agentRow).toHaveClass("mcp-topology-row", "bg-card/75");
    expect(agentRow).not.toHaveClass("border", "shadow-sm");
    expect(upstreamRow).toHaveClass("bg-card/75");
    expect(upstreamRow).not.toHaveClass("border", "shadow-sm");
    expect(agentMeta).toHaveClass("mcp-topology-row-meta");
    expect(statusBadge).toHaveClass("mcp-topology-status");
    expect(gatewayPanel).toHaveClass("mcp-topology-gateway-node", "bg-muted/35");
    expect(gatewayPanel).not.toHaveClass("border", "shadow-sm");
    expect(gatewayPanel?.querySelector(".mcp-topology-capability")).toHaveClass("bg-card/75");
    expect(gatewayPanel?.querySelector(".mcp-topology-capability")).not.toHaveClass("border");
    expect(gatewayPanel?.querySelector(".mcp-topology-stat")).toHaveClass("bg-card/75");
    expect(gatewayPanel?.querySelector(".mcp-topology-stat")).not.toHaveClass("border");
    expect(gatewayPanel?.parentElement).toHaveClass("mcp-topology-gateway-panel", "w-full");
    expect(gatewayPanel?.querySelector(".mcp-topology-gateway-subtitle")).toBeInTheDocument();
    expect(gatewayPanel?.querySelector(".mcp-topology-capabilities")).toBeInTheDocument();
    expect(gatewayPanel?.querySelector(".mcp-topology-stats")).toBeInTheDocument();
  });

  it("keeps gateway visible when both sides are empty", () => {
    render(
      <MCPGatewayTopology
        agents={[]}
        servers={[]}
        summary={summary({
          agents: {
            total: 0,
            active: 0,
            disabled: 0,
            disabledWithRecentAudits: 0
          },
          servers: {
            total: 0,
            active: 0,
            disabled: 0,
            syncFailed: 0
          }
        })}
      />
    );

    expect(screen.getByText("暂无运行实例")).toBeInTheDocument();
    expect(screen.getByText("暂无上游服务")).toBeInTheDocument();
    expect(screen.getByText("Clawee MCP Gateway")).toBeInTheDocument();
  });

  it("renders stable loading placeholders", () => {
    render(<MCPGatewayTopology agents={[]} servers={[]} loading />);

    const region = screen.getByRole("region", { name: "Agent 接入治理链路" });
    expect(within(region).getByTestId("mcp-gateway-topology-loading")).toBeInTheDocument();
    expect(screen.getByText("... 个运行实例")).toBeInTheDocument();
    expect(screen.getByText("... 个上游服务")).toBeInTheDocument();
    expect(screen.getByTestId("gateway-stat-grants")).toHaveTextContent("...");
  });
});
