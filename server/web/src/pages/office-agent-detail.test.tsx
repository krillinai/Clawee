import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getAgentDetail } from "@/lib/office-api";
import { truncateText } from "@/lib/text";
import { fixtureAgentDetail } from "@/test/office-fixtures";

import { OfficeAgentDetailPage } from "./office-agent-detail";

vi.mock("@/lib/office-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/office-api")>("@/lib/office-api");
  return {
    ...actual,
    getAgentDetail: vi.fn(),
  };
});

const getAgentDetailMock = vi.mocked(getAgentDetail);

describe("OfficeAgentDetailPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the activity detail page from route params", async () => {
    getAgentDetailMock.mockResolvedValue(fixtureAgentDetail);

    renderWithQueryClient(
      <MemoryRouter initialEntries={["/admin/activity/detail?collector_id=collector_1&agent_id=hermes-c03"]}>
        <Routes>
          <Route
            path="/admin/activity/detail"
            element={<OfficeAgentDetailPage />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Hermes C03" })).toBeInTheDocument();
    expect(screen.queryByText("智能体活动详情")).not.toBeInTheDocument();
    expect(screen.getByText(/采集器 ID:/)).toBeInTheDocument();
    expect(screen.getByText(/智能体 ID:/)).toBeInTheDocument();
    expect(screen.getByText("活跃会话")).toBeInTheDocument();
    expect(screen.getByText("Turn 列表")).toBeInTheDocument();
    expect(screen.getByText("Session S-8421")).toBeInTheDocument();
    expect(screen.getByText("Summarize inventory risk")).toBeInTheDocument();
    expect(screen.getByText("Stop hook captured: inventory risk summary is ready.")).toBeInTheDocument();
    expect(screen.queryByText("turn_inventory_stop_8421")).not.toBeInTheDocument();
    expect(screen.getByText("Session S-8421").closest("section")).toHaveClass("rounded-md");
    expect(screen.getByText("Inventory stop summary").closest("article")).toHaveClass("bg-muted/15");
    expect(screen.queryByText("mcp__erp__query")).not.toBeInTheDocument();
  });

  it("shows an error state when detail loading fails", async () => {
    getAgentDetailMock.mockRejectedValue(new Error("detail failed"));

    renderWithQueryClient(
      <MemoryRouter initialEntries={["/admin/activity/detail?collector_id=collector_1&agent_id=hermes-c03"]}>
        <Routes>
          <Route
            path="/admin/activity/detail"
            element={<OfficeAgentDetailPage />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("智能体活动详情加载失败")).toBeInTheDocument();
    expect(screen.getByText("未找到该智能体")).toBeInTheDocument();
  });

  it("truncates Unicode session IDs without splitting characters", async () => {
    const sessionId = "会话🔐abcdef结束12345";
    getAgentDetailMock.mockResolvedValue({
      ...fixtureAgentDetail,
      sessions: [],
      turns: [{ ...fixtureAgentDetail.turns[0], session_id: sessionId }],
    });

    renderWithQueryClient(
      <MemoryRouter initialEntries={["/admin/activity/detail?collector_id=collector_1&agent_id=hermes-c03"]}>
        <Routes>
          <Route path="/admin/activity/detail" element={<OfficeAgentDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(`Session ${truncateText(sessionId, 8)}`)).toBeInTheDocument();
  });

  it("keeps session IDs with at most twelve characters unchanged", async () => {
    const sessionId = "session-10";
    getAgentDetailMock.mockResolvedValue({
      ...fixtureAgentDetail,
      sessions: [],
      turns: [{ ...fixtureAgentDetail.turns[0], session_id: sessionId }],
    });

    renderWithQueryClient(
      <MemoryRouter initialEntries={["/admin/activity/detail?collector_id=collector_1&agent_id=hermes-c03"]}>
        <Routes>
          <Route path="/admin/activity/detail" element={<OfficeAgentDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(`Session ${sessionId}`)).toBeInTheDocument();
  });
});

function renderWithQueryClient(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}
