import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAgentDetail, getOfficeSnapshot } from "@/lib/office-api";
import { truncateText } from "@/lib/text";
import { fixtureAgentDetail, fixtureOffice } from "@/test/office-fixtures";

import { OfficeAgentActivityPage } from "./office-agent-activity";

vi.mock("@/lib/office-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/office-api")>("@/lib/office-api");
  return {
    ...actual,
    getAgentDetail: vi.fn(),
    getOfficeSnapshot: vi.fn(),
  };
});

const getAgentDetailMock = vi.mocked(getAgentDetail);
const getOfficeSnapshotMock = vi.mocked(getOfficeSnapshot);

describe("OfficeAgentActivityPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "EventSource",
      class {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        addEventListener() {}
        removeEventListener() {}
        close() {}
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the activity list with summary and detail entry", async () => {
    getOfficeSnapshotMock.mockResolvedValue({
      ...fixtureOffice,
      agents: fixtureOffice.agents.map((agent) => ({
        ...agent,
        owner_user_id: "usr_xugang",
        owner_name: "徐刚",
        owner_email: "xugang@test.com",
      })),
    });
    getAgentDetailMock.mockResolvedValue(fixtureAgentDetail);

    renderWithQueryClient(<OfficeAgentActivityPage />);

    expect(await screen.findByRole("heading", { name: "智能体活动" })).toBeInTheDocument();
    expect(screen.getByText("活动列表")).toBeInTheDocument();
    expect(await screen.findByRole("columnheader", { name: "责任账号" })).toBeInTheDocument();
    expect(screen.getByText("徐刚")).toBeInTheDocument();
    expect(screen.getByText("xugang@test.com")).toBeInTheDocument();
    expect((await screen.findAllByText("Hermes C03")).length).toBeGreaterThan(0);
    expect(screen.getByText("S-8422")).toBeInTheDocument();
    expect(screen.getAllByText("ERP: purchase order query").length).toBeGreaterThan(0);
    await screen.findByText("Summarize inventory risk");
    expect(screen.queryByText("最近 10 条 Turn")).not.toBeInTheDocument();
    expect(screen.getAllByText("用户输入").length).toBeGreaterThan(0);
    expect(screen.getByText("Summarize inventory risk")).toBeInTheDocument();
    expect(screen.getByText("Stop hook captured: inventory risk summary is ready.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看 Hermes C03 详情" })).toHaveAttribute(
      "href",
      "/admin/activity/detail?collector_id=collector_1&agent_id=hermes-c03",
    );
  });

  it("shows the empty state and realtime connection state", async () => {
    getOfficeSnapshotMock.mockResolvedValue({
      ...fixtureOffice,
      agents: [],
      recent_feed: [],
    });

    renderWithQueryClient(<OfficeAgentActivityPage />);

    expect(await screen.findByText("还没有智能体状态")).toBeInTheDocument();
    expect(screen.getByText("实时状态")).toBeInTheDocument();
    expect(screen.getByText("连接中")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /查看 .* 详情/ })).not.toBeInTheDocument();
  });

  it("shows a dense realtime status panel with the latest 5 records", async () => {
    getOfficeSnapshotMock.mockResolvedValue({
      ...fixtureOffice,
      recent_feed: Array.from({ length: 11 }, (_, index) => ({
        collector_id: "collector_1",
        agent_id: "hermes-c03",
        activity_id: `act_${index + 1}`,
        activity_type: index === 0 ? "thinking" : "running_commands",
        status: index === 0 ? "thinking" : "running_commands",
        title: index === 0 ? "Thinking" : "Running command",
        summary: index === 0 ? "Thinking" : `git diff --stat ${index + 1}`,
        occurred_at: `2026-06-03T10:2${index}:30Z`,
        text: `Hermes C03 ${index === 0 ? "thinking: Thinking" : `running_commands: status record ${index + 1}`}`,
      })),
    });
    getAgentDetailMock.mockResolvedValue(fixtureAgentDetail);

    renderWithQueryClient(<OfficeAgentActivityPage />);

    await screen.findByText("思考中");
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(screen.getAllByText("跑命令")).toHaveLength(4);
    expect(screen.queryByText("running_commands")).not.toBeInTheDocument();
    expect(screen.getByText("18:20:30")).toBeInTheDocument();
    expect(screen.getByText("git diff --stat 5")).toBeInTheDocument();
    expect(screen.queryByText("git diff --stat 6")).not.toBeInTheDocument();
    expect(screen.queryByText("act_1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("还有更多实时状态")).toHaveTextContent("...");
  });

  it("safely truncates long current turn text in the activity table", async () => {
    const longTurnTitle =
      "按照 http://192.168.3.167:1904/office/collectors/install?code=reg_07008336ffec32d1 指南重新安装；要求先删除旧的采集器。";

    getOfficeSnapshotMock.mockResolvedValue({
      ...fixtureOffice,
      agents: [
        {
          ...fixtureOffice.agents[0],
          current_turn: {
            ...fixtureOffice.agents[0].current_turn!,
            title: longTurnTitle,
          },
        },
      ],
    });
    getAgentDetailMock.mockResolvedValue(fixtureAgentDetail);

    renderWithQueryClient(<OfficeAgentActivityPage />);

    const truncatedTitle = await screen.findByText(truncateText(longTurnTitle, 72));
    expect(truncatedTitle).toHaveAttribute("title", longTurnTitle);
    expect(truncatedTitle).toHaveClass("block");
    expect(truncatedTitle).toHaveClass("truncate");
    expect(truncatedTitle.closest("td")).toHaveClass("max-w-[320px]");
    expect(truncatedTitle.closest("div")).toHaveClass("min-w-0");
    expect(screen.queryByText(longTurnTitle)).not.toBeInTheDocument();
  });

  it("shows the current turn status in the activity table even when the session status is stale", async () => {
    getOfficeSnapshotMock.mockResolvedValue({
      ...fixtureOffice,
      agents: [
        {
          ...fixtureOffice.agents[0],
          status: "idle",
          current_session: {
            ...fixtureOffice.agents[0].current_session!,
            status: "idle",
          },
          sessions: [
            {
              ...fixtureOffice.agents[0].sessions[0],
              status: "idle",
            },
          ],
          current_turn: {
            ...fixtureOffice.agents[0].current_turn!,
            status: "coding",
          },
        },
      ],
    });
    getAgentDetailMock.mockResolvedValue(fixtureAgentDetail);

    renderWithQueryClient(<OfficeAgentActivityPage />);

    expect(await screen.findByRole("cell", { name: "编码中" })).toBeInTheDocument();
  });

  it("constrains long selected-agent turn text in the side panel", async () => {
    const longTitle = "Investigate unusually long inventory procurement exception title ".repeat(6).trim();
    const longUserPrompt = "Please analyze every purchase order exception and explain the operational risk in detail. ".repeat(8).trim();
    const longStopMessage = "Stop hook captured a detailed final assistant message with many operational findings. ".repeat(8).trim();

    getOfficeSnapshotMock.mockResolvedValue(fixtureOffice);
    getAgentDetailMock.mockResolvedValue({
      ...fixtureAgentDetail,
      turns: [
        {
          ...fixtureAgentDetail.turns[0],
          title: longTitle,
          user_prompt: longUserPrompt,
          last_assistant_message: longStopMessage,
        },
      ],
    });

    renderWithQueryClient(<OfficeAgentActivityPage />);

    const titleNode = await screen.findByText(longTitle);
    expect(titleNode).toHaveClass("truncate");
    expect(titleNode).toHaveAttribute("title", longTitle);
    expect(titleNode.closest("article")).toHaveClass("rounded-md");
    expect(titleNode.closest("article")).toHaveClass("bg-muted/15");
    expect(titleNode.closest("article")).not.toHaveTextContent(fixtureAgentDetail.turns[0].turn_id);
    expect(screen.getByText(`Session ${fixtureAgentDetail.turns[0].session_id}`)).toBeInTheDocument();
    expect(screen.getByText(longUserPrompt)).toHaveClass("line-clamp-3");
    expect(screen.getByText(longUserPrompt)).toHaveAttribute("title", longUserPrompt);
    expect(screen.getByText(longStopMessage)).toHaveClass("line-clamp-3");
    expect(screen.getByText(longStopMessage)).toHaveAttribute("title", longStopMessage);
  });

  it("limits selected-agent sessions and links to the detail page for more", async () => {
    const turns = Array.from({ length: 4 }, (_, index) => ({
      ...fixtureAgentDetail.turns[0],
      turn_id: `turn_side_${index + 1}`,
      session_id: `session_side_${index + 1}`,
      title: `Side panel turn ${index + 1}`,
      user_prompt: `Prompt ${index + 1}`,
      last_assistant_message: `Reply ${index + 1}`,
      updated_at: `2026-06-03T10:2${index}:30Z`,
    }));
    const sessions = turns.map((turn, index) => ({
      ...fixtureAgentDetail.sessions[0],
      session_id: turn.session_id,
      status: "idle" as const,
      started_at: `2026-06-03T10:1${index}:00Z`,
    }));

    getOfficeSnapshotMock.mockResolvedValue(fixtureOffice);
    getAgentDetailMock.mockResolvedValue({
      ...fixtureAgentDetail,
      sessions,
      turns,
    });

    renderWithQueryClient(<OfficeAgentActivityPage />);

    expect(await screen.findAllByText("Session session_...")).toHaveLength(3);
    expect(screen.getByText("Side panel turn 4")).toBeInTheDocument();
    expect(screen.getByText("Side panel turn 3")).toBeInTheDocument();
    expect(screen.getByText("Side panel turn 2")).toBeInTheDocument();
    expect(screen.queryByText("Side panel turn 1")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看更多 session 和 turn" })).toHaveAttribute(
      "href",
      "/admin/activity/detail?collector_id=collector_1&agent_id=hermes-c03",
    );
  });

  it("limits turns inside each selected-agent session", async () => {
    const turns = Array.from({ length: 4 }, (_, index) => ({
      ...fixtureAgentDetail.turns[0],
      turn_id: `turn_same_session_${index + 1}`,
      session_id: "session_side_same",
      title: `Same session turn ${index + 1}`,
      user_prompt: `Prompt ${index + 1}`,
      last_assistant_message: `Reply ${index + 1}`,
      updated_at: `2026-06-03T10:2${index}:30Z`,
    }));

    getOfficeSnapshotMock.mockResolvedValue(fixtureOffice);
    getAgentDetailMock.mockResolvedValue({
      ...fixtureAgentDetail,
      sessions: [{ ...fixtureAgentDetail.sessions[0], session_id: "session_side_same", status: "idle" }],
      turns,
    });

    renderWithQueryClient(<OfficeAgentActivityPage />);

    expect(await screen.findByText("Same session turn 4")).toBeInTheDocument();
    expect(screen.getByText("Same session turn 3")).toBeInTheDocument();
    expect(screen.getByText("Same session turn 2")).toBeInTheDocument();
    expect(screen.queryByText("Same session turn 1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("还有更多 turn")).toHaveTextContent("...");
  });

  it("shows the latest turn status on the selected-agent session group", async () => {
    getOfficeSnapshotMock.mockResolvedValue(fixtureOffice);
    getAgentDetailMock.mockResolvedValue({
      ...fixtureAgentDetail,
      sessions: [{ ...fixtureAgentDetail.sessions[0], status: "idle" }],
      turns: [
        {
          ...fixtureAgentDetail.turns[0],
          status: "searching",
          updated_at: "2026-06-03T10:22:30Z",
        },
      ],
    });

    renderWithQueryClient(<OfficeAgentActivityPage />);

    const sessionHeader = (await screen.findByText("Session S-8422")).closest("section");
    expect(sessionHeader).toHaveTextContent("检索中");
    expect(sessionHeader).not.toHaveTextContent("空闲");
  });

  it("does not repeat a turn title when it is effectively the same as the user prompt", async () => {
    const duplicatedPrompt = "[采集器安装策略.md](docs/collector/采集器安装策略.md) 开发落地这个方案，先落地实施计划";
    const fullPrompt = `${duplicatedPrompt}，并补充验收清单`;

    getOfficeSnapshotMock.mockResolvedValue(fixtureOffice);
    getAgentDetailMock.mockResolvedValue({
      ...fixtureAgentDetail,
      turns: [
        {
          ...fixtureAgentDetail.turns[0],
          title: duplicatedPrompt,
          user_prompt: fullPrompt,
        },
      ],
    });

    renderWithQueryClient(<OfficeAgentActivityPage />);

    expect(await screen.findByText("Turn turn_po_...")).toBeInTheDocument();
    expect(screen.queryByText(duplicatedPrompt)).not.toBeInTheDocument();
    expect(screen.getByText(fullPrompt)).toBeInTheDocument();
    expect(screen.getAllByText("用户输入").length).toBeGreaterThan(0);
  });
});

function renderWithQueryClient(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}
