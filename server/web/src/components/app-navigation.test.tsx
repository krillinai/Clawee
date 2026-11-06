import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listMyDataViews } from "@/lib/data-views-api";

import { AppNavigation } from "./app-navigation";

vi.mock("@/lib/data-views-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-views-api")>("@/lib/data-views-api");
  return { ...actual, listMyDataViews: vi.fn() };
});

describe("AppNavigation", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows Agent activity only when the current account can read the data view", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    renderNavigation();

    expect(await screen.findByRole("link", { name: "Agent 动态" })).toHaveAttribute("href", "/app/activity");
  });

  it("hides Agent activity without the data view grant", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([]);
    renderNavigation();

    expect(await screen.findByRole("link", { name: "技能" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "审批中心" })).toHaveAttribute("href", "/app/approvals");
    expect(screen.getByRole("link", { name: "MCP 授权" }).querySelector("img")).toHaveAttribute(
      "src",
      "/assets/app-icons/mcp-f654f2a2.png"
    );
    expect(screen.queryByRole("link", { name: "Collector" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Agent 动态" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "我的 Agent",
      "审批中心",
      "技能",
      "MCP 授权",
      "模型记录"
    ]);
  });

  it("hides model usage in enterprise managed mode", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([]);
    renderNavigation(false);

    expect(await screen.findByRole("link", { name: "技能" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "模型记录" })).not.toBeInTheDocument();
  });

  it("shows the business dashboard for either business data view grant", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "douyin_ads", actions: ["read"] }]);
    renderNavigation();

    expect(await screen.findByRole("link", { name: "数据看板" })).toHaveAttribute("href", "/app/business-data");
    expect(screen.queryByRole("link", { name: "Agent 动态" })).not.toBeInTheDocument();
  });

  it("keeps the agreed navigation order with permission items in place", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([
      { view_id: "agent_activity", actions: ["read"] },
      { view_id: "douyin_ads", actions: ["read"] }
    ]);
    renderNavigation();

    await screen.findByRole("link", { name: "Agent 动态" });
    await screen.findByRole("link", { name: "数据看板" });
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "我的 Agent",
      "审批中心",
      "Agent 动态",
      "数据看板",
      "技能",
      "MCP 授权",
      "模型记录"
    ]);
  });

  it("hides the business dashboard for unrelated grants", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    renderNavigation();

    expect(await screen.findByRole("link", { name: "Agent 动态" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "数据看板" })).not.toBeInTheDocument();
  });
});

function renderNavigation(modelGatewayEnabled?: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><AppNavigation modelGatewayEnabled={modelGatewayEnabled} /></MemoryRouter>
    </QueryClientProvider>,
  );
}
