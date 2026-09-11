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

    expect(await screen.findByRole("link", { name: "动态" })).toHaveAttribute("href", "/app/activity");
  });

  it("hides Agent activity without the data view grant", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([]);
    renderNavigation();

    expect(await screen.findByRole("link", { name: "技能" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "MCP" }).querySelector("img")).toHaveAttribute(
      "src",
      "/assets/app-icons/mcp-f654f2a2.png"
    );
    expect(screen.queryByRole("link", { name: "Collector" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "动态" })).not.toBeInTheDocument();
  });

  it("shows the business dashboard for either business data view grant", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "douyin_ads", actions: ["read"] }]);
    renderNavigation();

    expect(await screen.findByRole("link", { name: "数据看板" })).toHaveAttribute("href", "/app/business-data");
    expect(screen.queryByRole("link", { name: "动态" })).not.toBeInTheDocument();
  });

  it("hides the business dashboard for unrelated grants", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    renderNavigation();

    expect(await screen.findByRole("link", { name: "动态" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "数据看板" })).not.toBeInTheDocument();
  });
});

function renderNavigation() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><AppNavigation /></MemoryRouter>
    </QueryClientProvider>,
  );
}
