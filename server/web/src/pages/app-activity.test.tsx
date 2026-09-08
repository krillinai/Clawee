import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getMyActivityStatistics, type ActivityStatistics } from "@/lib/activity-api";
import { APIError } from "@/lib/api";
import { createRechargeSession, getBillingOverview, openRechargePage, type BillingOverview } from "@/lib/billing-api";
import { listMyDataViews } from "@/lib/data-views-api";
import { getMyAgentDetail } from "@/lib/office-api";
import { fixtureAgentDetail } from "@/test/office-fixtures";

import { AppActivityPage } from "./app-activity";

vi.mock("@/lib/activity-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/activity-api")>("@/lib/activity-api");
  return { ...actual, getMyActivityStatistics: vi.fn() };
});

vi.mock("@/lib/data-views-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-views-api")>("@/lib/data-views-api");
  return { ...actual, listMyDataViews: vi.fn() };
});

vi.mock("@/lib/billing-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/billing-api")>("@/lib/billing-api");
  return { ...actual, createRechargeSession: vi.fn(), getBillingOverview: vi.fn(), openRechargePage: vi.fn() };
});

vi.mock("@/lib/office-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/office-api")>("@/lib/office-api");
  return { ...actual, getMyAgentDetail: vi.fn() };
});

const fixtureStatistics: ActivityStatistics = {
  range: "7d",
  timezone: "Asia/Shanghai",
  start_date: "2026-08-07",
  end_date: "2026-08-13",
  generated_at: "2026-08-13T03:12:37Z",
  organization: {
    usage: { input_tokens: 18279996, cached_input_tokens: 16894080, output_tokens: 116251, total_tokens: 18396247 },
    active_employees: 3,
    active_agents: 5,
    completed_turns: 42,
    mcp_distribution: [{ id: "filesystem", label: "filesystem", invocation_count: 18, share: 1 }],
  },
  trend: {
    granularity: "day",
    points: [
      { bucket_start: "2026-08-07T00:00:00+08:00", input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200, total_tokens: 1200 },
      { bucket_start: "2026-08-08T00:00:00+08:00", input_tokens: 2000, cached_input_tokens: 800, output_tokens: 300, total_tokens: 2300 },
    ],
  },
  model_distribution: [{ model: "gpt-5.6-sol", requests: 20, input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200, total_tokens: 1200, share: 1 }],
  token_usage_ranking: [
    { rank: 1, name: "张三", requests: 12, total_tokens: 860000 },
    { rank: 2, name: "李四", requests: 8, total_tokens: 2400 },
  ],
  agents: [{ collector_id: "collector 1", agent_id: "hermes/c03", name: "Hermes C03", status: "online", session_count: 4, turn_count: 12, last_activity_at: "2026-08-13T03:00:00Z" }],
  data_status: { model_usage: "available", activity: "available" },
};

const fixtureBilling: BillingOverview = {
  currency: "CNY",
  exchange_rate: 7.5,
  balance_cny: 100,
  start_date: "2026-08-07",
  end_date: "2026-08-13",
  granularity: "day",
  generated_at: "2026-08-13T03:12:37Z",
  stats: { requests: 20, input_tokens: 18279996, cached_input_tokens: 16894080, output_tokens: 116251, total_tokens: 18396247 },
};

describe("AppActivityPage", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders authorized organization activity and switches ranges", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    vi.mocked(getMyActivityStatistics).mockImplementation(async (range) => ({ ...fixtureStatistics, range }));
    vi.mocked(getBillingOverview).mockResolvedValue(fixtureBilling);

    renderPage(<AppActivityPage />, "/app/activity");

    expect(await screen.findByRole("heading", { name: "Agent 动态" })).toBeInTheDocument();
    expect(await screen.findByTitle("18,396,247")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "核心指标" })).toHaveTextContent("活跃员工3");
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.getByText("filesystem")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Token 使用排行" })).toHaveTextContent("张三12860,000");
    expect(screen.getByRole("region", { name: "账户额度" })).toHaveTextContent("账户余额");
    expect(screen.getByRole("region", { name: "账户额度" })).toHaveTextContent("¥100.00");
    expect(screen.getByRole("region", { name: "账户额度" })).not.toHaveTextContent("当前区间实际费用");
    const rechargeButton = screen.getByRole("button", { name: "充值" });
    const rechargeRecordsLink = screen.getByRole("link", { name: "充值记录" });
    expect(rechargeRecordsLink).toHaveAttribute("href", "/app/activity/recharge-records");
    expect(rechargeRecordsLink).not.toHaveTextContent("充值记录");
    expect(rechargeButton.compareDocumentPosition(rechargeRecordsLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/sub2api/i)).not.toBeInTheDocument();
    expect(screen.getByText("Hermes C03")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看 Hermes C03 详情" })).toHaveAttribute(
      "href",
      "/app/activity/detail?collector_id=collector%201&agent_id=hermes%2Fc03",
    );

    fireEvent.click(screen.getByRole("radio", { name: "近 30 天" }));
    await waitFor(() => expect(getMyActivityStatistics).toHaveBeenLastCalledWith("30d"));
    await waitFor(() => expect(getBillingOverview).toHaveBeenLastCalledWith("30d"));
  });

  it("renders billing unavailable without displaying a zero balance", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    vi.mocked(getMyActivityStatistics).mockResolvedValue(fixtureStatistics);
    vi.mocked(getBillingOverview).mockRejectedValue(new Error("unavailable"));

    renderPage(<AppActivityPage />, "/app/activity");

    expect(await screen.findByText("账户额度暂不可用，请稍后重试。")).toBeInTheDocument();
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
  });

  it("hides central balance and recharge for enterprise-managed billing", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    vi.mocked(getMyActivityStatistics).mockResolvedValue(fixtureStatistics);
    vi.mocked(getBillingOverview).mockRejectedValue(new APIError(
      "当前部署使用企业自有模型服务",
      409,
      "billing_not_managed",
    ));

    renderPage(<AppActivityPage />, "/app/activity");

    expect(await screen.findByText("Hermes C03")).toBeInTheDocument();
    expect(screen.queryByText("账户额度暂不可用，请稍后重试。")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "账户额度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "充值" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "充值记录" })).not.toBeInTheDocument();
  });

  it("renders an unconfigured token source without hiding local activity", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    vi.mocked(getMyActivityStatistics).mockResolvedValue({
      ...fixtureStatistics,
      organization: { ...fixtureStatistics.organization, usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
      trend: { ...fixtureStatistics.trend, points: [] },
      model_distribution: [],
      token_usage_ranking: [],
      data_status: { model_usage: "not_configured", activity: "available" },
    });
    vi.mocked(getBillingOverview).mockRejectedValue(new APIError("not managed", 409, "billing_not_managed"));

    renderPage(<AppActivityPage />, "/app/activity");

    expect(await screen.findByText("暂未配置模型用量数据源")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "核心指标" })).toHaveTextContent("总 Token--");
    expect(screen.queryByText("Token 趋势")).not.toBeInTheDocument();
    expect(screen.queryByText("Token 构成")).not.toBeInTheDocument();
    expect(screen.queryByText("模型分布")).not.toBeInTheDocument();
    expect(screen.getByText("filesystem")).toBeInTheDocument();
    expect(screen.getByText("Hermes C03")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/sub2api|test-admin-api-key/i);
  });

  it("renders unavailable token data and retries statistics only", async () => {
    const unavailable: ActivityStatistics = {
      ...fixtureStatistics,
      organization: { ...fixtureStatistics.organization, usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
      trend: { ...fixtureStatistics.trend, points: [] },
      model_distribution: [],
      token_usage_ranking: [],
      data_status: { model_usage: "unavailable", activity: "available" },
    };
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    vi.mocked(getMyActivityStatistics).mockResolvedValueOnce(unavailable).mockResolvedValueOnce(fixtureStatistics);
    vi.mocked(getBillingOverview).mockRejectedValue(new APIError("not managed", 409, "billing_not_managed"));

    renderPage(<AppActivityPage />, "/app/activity");

    expect(await screen.findByText("Token 数据暂不可用", { selector: "[data-slot='empty-title']" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "核心指标" })).toHaveTextContent("总 Token--");
    expect(screen.getByText("filesystem")).toBeInTheDocument();
    expect(screen.getByText("Hermes C03")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(getMyActivityStatistics).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument());
    expect(getBillingOverview).toHaveBeenCalledTimes(1);
  });

  it("renders real zero token usage as available", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    vi.mocked(getMyActivityStatistics).mockResolvedValue({
      ...fixtureStatistics,
      organization: { ...fixtureStatistics.organization, usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
      trend: { ...fixtureStatistics.trend, points: [] },
      model_distribution: [],
      token_usage_ranking: [],
    });
    vi.mocked(getBillingOverview).mockResolvedValue(fixtureBilling);

    renderPage(<AppActivityPage />, "/app/activity");

    expect(await screen.findByText("Token 趋势")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "核心指标" })).toHaveTextContent("总 Token0");
    expect(screen.getByText("Token 构成")).toBeInTheDocument();
    expect(screen.getByText("模型分布")).toBeInTheDocument();
    expect(screen.getByText("当前范围内暂无 Token 使用记录")).toBeInTheDocument();
    expect(screen.queryByText("暂未配置模型用量数据源")).not.toBeInTheDocument();
    expect(screen.queryByText("Token 数据暂不可用")).not.toBeInTheDocument();
  });

  it("opens the recharge page returned by the billing service", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    vi.mocked(getMyActivityStatistics).mockResolvedValue(fixtureStatistics);
    vi.mocked(getBillingOverview).mockResolvedValue(fixtureBilling);
    vi.mocked(createRechargeSession).mockResolvedValue({ recharge_url: "https://billing.example/recharge/session-token", expires_at: "2026-08-13T03:22:37Z" });

    renderPage(<AppActivityPage />, "/app/activity");

    fireEvent.click(await screen.findByRole("button", { name: "充值" }));
    await waitFor(() => expect(createRechargeSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(openRechargePage).toHaveBeenCalledWith("https://billing.example/recharge/session-token"));
  });

  it("shows an error and does not redirect when recharge session creation fails", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);
    vi.mocked(getMyActivityStatistics).mockResolvedValue(fixtureStatistics);
    vi.mocked(getBillingOverview).mockResolvedValue(fixtureBilling);
    vi.mocked(createRechargeSession).mockRejectedValue(new Error("unavailable"));

    renderPage(<AppActivityPage />, "/app/activity");

    fireEvent.click(await screen.findByRole("button", { name: "充值" }));
    expect(await screen.findByText("充值入口暂不可用")).toBeInTheDocument();
    expect(openRechargePage).not.toHaveBeenCalled();
  });

  it("does not request statistics without the data view grant", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([]);

    renderPage(<AppActivityPage />, "/app/activity");

    expect(await screen.findByText("当前账户未开通 Agent 动态")).toBeInTheDocument();
    expect(getMyActivityStatistics).not.toHaveBeenCalled();
    expect(getBillingOverview).not.toHaveBeenCalled();
  });

  it("renders account activity detail with an app back link", async () => {
    vi.mocked(getMyAgentDetail).mockResolvedValue(fixtureAgentDetail);

    renderPage(<AppActivityPage detail />, "/app/activity/detail?collector_id=collector_1&agent_id=hermes-c03");

    expect(await screen.findByRole("heading", { name: "Hermes C03" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回活动列表" })).toHaveAttribute("href", "/app/activity");
  });
});

function renderPage(node: React.ReactNode, path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}
