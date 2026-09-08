import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listMyAgents, listMyMCPCatalog } from "@/lib/agent-api";

import { AppMCPCapabilitiesPage } from "./app-mcp-capabilities";

vi.mock("@/lib/agent-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-api")>("@/lib/agent-api");
  return {
    ...actual,
    listMyAgents: vi.fn(),
    listMyMCPCatalog: vi.fn()
  };
});

const listMyAgentsMock = vi.mocked(listMyAgents);
const listMyMCPCatalogMock = vi.mocked(listMyMCPCatalog);

describe("AppMCPCapabilitiesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMyAgentsMock.mockResolvedValue([
      { account: { userId: "usr_1", email: "user@example.com", name: "用户" }, agent: { agentId: "agent-primary", clientId: "web", actorId: "usr_1", status: "active", name: "主 Agent" } },
      { account: { userId: "usr_1", email: "user@example.com", name: "用户" }, agent: { agentId: "agent-secondary", clientId: "desktop", actorId: "usr_1", status: "active", name: "辅助 Agent" } }
    ]);
    listMyMCPCatalogMock.mockResolvedValue({
      upstreams: [{
        id: "crm-main",
        name: "CRM",
        domain: "sales",
        iconUrl: "https://gateway.example/assets/app-icons/mcp-f654f2a2.png",
        mcpEndpoint: "https://gateway.example/mcp/servers/crm-main",
        upstreamTransport: "streamable_http",
        namespace: "crm",
        status: "active",
        tools: [
          {
            id: "cap_search",
            upstreamName: "customer.search",
            name: "customer.search",
            exposedName: "crm.customer.search",
            title: "查询客户",
            description: "查询客户资料",
            riskLevel: "low",
            confirmRequired: false,
            status: "active",
            authorized: true,
            authorizationExpiresAt: null
          }
        ]
      }]
    });
  });

  it("shows the MCP tools authorized for the current account", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "MCP 能力目录" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "选择 Agent" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "CRM" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "CRM 图标" })).toHaveAttribute(
      "src",
      "https://gateway.example/assets/app-icons/mcp-f654f2a2.png"
    );
    expect(screen.queryByRole("columnheader", { name: "授权状态" })).not.toBeInTheDocument();

    const searchRow = findRow("customer.search");
    expect(within(searchRow).getByText("查询客户资料")).toBeInTheDocument();
    expect(listMyMCPCatalogMock).toHaveBeenCalledWith();
  });

  it("shows an empty state when no upstreams are available", async () => {
    listMyMCPCatalogMock.mockResolvedValue({ upstreams: [] });

    renderPage();

    expect(await screen.findByText("当前账户暂无已授权 MCP 能力")).toBeInTheDocument();
  });

  it("shows an error state when the catalog cannot be loaded", async () => {
    listMyMCPCatalogMock.mockRejectedValue(new Error("catalog unavailable"));

    renderPage();

    expect(await screen.findByText("MCP 能力目录加载失败")).toBeInTheDocument();
  });
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app/mcp-capabilities"]}>
        <AppMCPCapabilitiesPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function findRow(text: string) {
  const row = screen.getByText(text).closest("tr");
  if (!row) throw new Error(`missing row for ${text}`);
  return row;
}
