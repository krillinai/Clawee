import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { APIError } from "@/lib/api";
import {
  getDouyinAdsDashboard,
  getBilibiliDashboard,
  getXiaohongshuDashboard,
  authorizeBilibili,
  deleteBilibiliSource,
  listBilibiliSources,
  redirectToBilibiliAuthorization,
  setBilibiliSourceSyncEnabled,
  syncBilibili,
  syncBilibiliSource,
  type DouyinAdsDashboard,
  type BilibiliDashboard,
  type BilibiliSource,
  type XiaohongshuDashboard,
} from "@/lib/business-data-api";
import { listMyDataViews } from "@/lib/data-views-api";

import { AppBusinessDataPage } from "./app-business-data";

vi.mock("@/lib/data-views-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-views-api")>("@/lib/data-views-api");
  return { ...actual, listMyDataViews: vi.fn() };
});

vi.mock("@/lib/business-data-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/business-data-api")>("@/lib/business-data-api");
  return {
    ...actual,
    getDouyinAdsDashboard: vi.fn(),
    getBilibiliDashboard: vi.fn(),
    getXiaohongshuDashboard: vi.fn(),
    authorizeBilibili: vi.fn(),
    deleteBilibiliSource: vi.fn(),
    listBilibiliSources: vi.fn(),
    redirectToBilibiliAuthorization: vi.fn(),
    setBilibiliSourceSyncEnabled: vi.fn(),
    syncBilibili: vi.fn(),
    syncBilibiliSource: vi.fn(),
  };
});

const xiaohongshuUnconfigured: XiaohongshuDashboard = {
  view_id: "xiaohongshu_operation",
  data_status: "unconfigured",
  range: "7d",
  timezone: "Asia/Shanghai",
  start_date: "2026-08-11",
  end_date: "2026-08-17",
  generated_at: "2026-08-17T03:00:00Z",
  last_synced_at: null,
  summary: null,
  trend: [],
  top_items: [],
};

const xiaohongshuAvailable: XiaohongshuDashboard = {
  ...xiaohongshuUnconfigured,
  data_status: "available",
  last_synced_at: "2026-08-17T02:10:00Z",
  summary: {
    published_count: 8,
    published_count_change_rate: 0.25,
    exposure_count: 125600,
    exposure_count_change_rate: 0.1,
    interaction_count: 9320,
    interaction_count_change_rate: -0.05,
    new_follower_count: 680,
    new_follower_count_change_rate: null,
    conversion_count: null,
    conversion_rate: null,
  },
  trend: [{ date: "2026-08-17", exposure_count: 125600, interaction_count: 9320 }],
  top_items: [{
    external_content_id: "note_001",
    title: "夏日新品笔记",
    content_type: "image_text",
    exposure_count: 88000,
    interaction_count: 7200,
    interaction_rate: 0.0818,
  }],
};

const douyinAvailable: DouyinAdsDashboard = {
  view_id: "douyin_ads",
  data_status: "available",
  range: "7d",
  timezone: "Asia/Shanghai",
  start_date: "2026-08-11",
  end_date: "2026-08-17",
  generated_at: "2026-08-17T03:00:00Z",
  last_synced_at: "2026-08-17T02:10:00Z",
  summary: {
    spend_minor: 123450,
    spend_change_rate: 0.2,
    video_play_count: 18200,
    video_play_count_change_rate: -0.1,
    conversion_count: null,
    attributed_revenue_minor: null,
    roi: null,
    currency: "CNY",
  },
  trend: [{ date: "2026-08-17", spend_minor: 123450, video_play_count: 18200 }],
  top_items: [{
    external_campaign_id: "campaign_001",
    name: "新品推广计划",
    campaign_type: "video",
    spend_minor: 123450,
    impression_count: 86000,
    video_play_count: 18200,
    click_count: 940,
    currency: "CNY",
  }],
};

const bilibiliAvailable: BilibiliDashboard = {
  status: "available",
  account: {
    source_id: "bdsrc_1",
    name: "B 站账号",
    status: "active",
    status_reason: "",
    last_success_at: "2026-08-28T02:10:00Z",
  },
  range: "7d",
  timezone: "Asia/Shanghai",
  start_date: "2026-08-22",
  end_date: "2026-08-28",
  generated_at: "2026-08-28T02:10:00Z",
  data: {
    captured_at: "2026-08-28T02:10:00Z",
    follower_count: 1200,
    collected_content_count: 3,
    view_count: 68000,
    interaction_count: 5200,
    trend: [
      {
        date: "2026-08-27",
        follower_count: 1250,
        view_count: 69000,
        interaction_count: 5300,
        follower_count_delta: 50,
        view_count_delta: 7000,
        interaction_count_delta: 400,
      },
      {
        date: "2026-08-28",
        follower_count: 1200,
        view_count: 68000,
        interaction_count: 5200,
        follower_count_delta: -50,
        view_count_delta: -1000,
        interaction_count_delta: -100,
      },
    ],
    top_contents: [{
      source_id: "bdsrc_1",
      account_name: "B 站账号",
      external_content_id: "BV_TEST",
      title: "B 站测试稿件",
      captured_at: "2026-08-28T02:10:00Z",
      view_count: 50000,
      interaction_count: 4100,
    }],
  },
};

const bilibiliUnavailable: BilibiliDashboard = {
  status: "unavailable",
  account: {
    source_id: "bdsrc_1",
    name: "B 站账号",
    status: "active",
    status_reason: "",
    last_success_at: null,
  },
  range: "7d",
  timezone: "Asia/Shanghai",
  start_date: "2026-08-22",
  end_date: "2026-08-28",
  generated_at: "2026-08-28T02:10:00Z",
};

const bilibiliUnconfigured: BilibiliDashboard = {
  status: "unconfigured",
  account: {
    source_id: "",
    name: "",
    status: "active",
    status_reason: "",
    last_success_at: null,
  },
  range: "7d",
  timezone: "Asia/Shanghai",
  start_date: "2026-08-22",
  end_date: "2026-08-28",
  generated_at: "2026-08-28T02:10:00Z",
};

const activeBilibiliSource: BilibiliSource = {
  source_id: "bdsrc_1",
  name: "B 站账号",
  status: "active",
  status_reason: "",
  last_attempt_at: "2026-08-28T02:00:00Z",
  last_success_at: "2026-08-28T02:10:00Z",
  next_sync_at: "2026-08-28T18:10:00Z",
  active_run_status: "",
};

describe("AppBusinessDataPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listBilibiliSources).mockResolvedValue([]);
  });

  it("does not request dashboards without a business data view grant", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "agent_activity", actions: ["read"] }]);

    renderPage("/app/business-data");

    expect(await screen.findByText("当前账户未开通数据看板")).toBeInTheDocument();
    expect(getXiaohongshuDashboard).not.toHaveBeenCalled();
    expect(getDouyinAdsDashboard).not.toHaveBeenCalled();
  });

  it("shows only the authorized view and renders an honest unconfigured skeleton", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "xiaohongshu_operation", actions: ["read"] }]);
    vi.mocked(getXiaohongshuDashboard).mockResolvedValue(xiaohongshuUnconfigured);

    renderPage("/app/business-data/douyin-ads");

    expect(await screen.findByText("数据源尚未接入")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "小红书运营" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "抖音投放" })).not.toBeInTheDocument();
    expect(getXiaohongshuDashboard).toHaveBeenCalledWith("7d");
    expect(getDouyinAdsDashboard).not.toHaveBeenCalled();
    const metrics = screen.getByRole("region", { name: "核心指标" });
    expect(within(metrics).getAllByText("--")).toHaveLength(6);
    expect(metrics).not.toHaveTextContent("0");
  });

  it("distinguishes an unavailable source from an unconfigured source", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "xiaohongshu_operation", actions: ["read"] }]);
    vi.mocked(getXiaohongshuDashboard).mockResolvedValue({
      ...xiaohongshuUnconfigured,
      data_status: "unavailable",
    });

    renderPage("/app/business-data/xiaohongshu-operation");

    expect(await screen.findByText("数据暂不可用")).toBeInTheDocument();
    expect(screen.getByText("数据源已启用，但还没有成功同步的数据。")).toBeInTheDocument();
    expect(screen.queryByText("数据源尚未接入")).not.toBeInTheDocument();
  });

  it("renders the complete Xiaohongshu dashboard when data is available", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "xiaohongshu_operation", actions: ["read"] }]);
    vi.mocked(getXiaohongshuDashboard).mockResolvedValue(xiaohongshuAvailable);

    renderPage("/app/business-data/xiaohongshu-operation");

    expect(await screen.findByText("夏日新品笔记")).toBeInTheDocument();
    const metrics = screen.getByRole("region", { name: "核心指标" });
    expect(metrics).toHaveTextContent("125,600");
    expect(metrics).toHaveTextContent("+10%");
    expect(screen.getByRole("img", { name: "小红书运营趋势图" })).toBeInTheDocument();
  });

  it("renders Douyin data and reloads the selected range", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([
      { view_id: "xiaohongshu_operation", actions: ["read"] },
      { view_id: "douyin_ads", actions: ["read"] },
    ]);
    vi.mocked(getDouyinAdsDashboard).mockImplementation(async (range) => ({ ...douyinAvailable, range }));

    renderPage("/app/business-data/douyin-ads");

    expect(await screen.findByText("新品推广计划")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "小红书运营" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "抖音投放" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "核心指标" })).toHaveTextContent("1,234.50");

    fireEvent.click(screen.getByRole("radio", { name: "近 30 天" }));
    await waitFor(() => expect(getDouyinAdsDashboard).toHaveBeenLastCalledWith("30d"));
  });

  it("renders Bilibili latest cumulative data with a range control and daily trend", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliAvailable);
    vi.mocked(listBilibiliSources).mockResolvedValue([activeBilibiliSource]);

    renderPage("/app/business-data/bilibili-operation");

    expect(await screen.findByText("B 站测试稿件")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "查看账号" })).toHaveTextContent("B 站账号");
    expect(screen.getByRole("region", { name: "核心指标" })).toHaveTextContent("68,000");
    expect(getBilibiliDashboard).toHaveBeenCalledWith("7d", "bdsrc_1");
    expect(screen.getByRole("radio", { name: "近 7 天" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "日增长趋势" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "B 站播放量日增长图" })).toBeInTheDocument();
    expect(screen.getByText("+7,000")).toBeInTheDocument();
    expect(screen.getByText("-1,000")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "粉丝数" }));
    expect(screen.getByRole("img", { name: "B 站粉丝数日增长图" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "互动数" }));
    expect(screen.getByRole("img", { name: "B 站互动数日增长图" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "近 30 天" }));
    await waitFor(() => expect(getBilibiliDashboard).toHaveBeenLastCalledWith("30d", "bdsrc_1"));
  });

  it("lets an account with connect permission sync available Bilibili data", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read", "connect"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliAvailable);
    vi.mocked(listBilibiliSources).mockResolvedValue([activeBilibiliSource]);
    vi.mocked(syncBilibili).mockResolvedValue("already_queued");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderPage("/app/business-data/bilibili-operation", queryClient);

    fireEvent.click(await screen.findByRole("button", { name: "同步全部" }));
    await waitFor(() => expect(syncBilibili).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("同步任务已提交")).toBeInTheDocument();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["bilibili-sources"] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["app-business-dashboard", "bilibili_operation"],
    });
  });

  it("renders the Bilibili unavailable state", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read", "connect"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliUnavailable);
    vi.mocked(listBilibiliSources).mockResolvedValue([activeBilibiliSource]);
    vi.mocked(syncBilibili).mockResolvedValue("queued");

    renderPage("/app/business-data/bilibili-operation");

    expect(await screen.findByText("数据暂不可用")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "查看账号" })).toHaveTextContent("B 站账号");
    expect(screen.getByText("所选账号还没有成功同步的数据。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "同步全部" }));
    await waitFor(() => expect(syncBilibili).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("同步任务已提交")).toBeInTheDocument();
  });

  it("keeps the Bilibili account list available when the dashboard fails", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read"] }]);
    vi.mocked(getBilibiliDashboard).mockRejectedValue(new APIError("看板不可用", 503, "service_unavailable"));
    vi.mocked(listBilibiliSources).mockResolvedValue([activeBilibiliSource]);

    renderPage("/app/business-data/bilibili-operation");

    expect(await screen.findByRole("combobox", { name: "查看账号" })).toHaveTextContent("B 站账号");
    expect(await screen.findByText("业务数据加载失败，请稍后重试。")).toBeInTheDocument();
  });

  it("lets a non-admin account with connect permission start Bilibili authorization", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read", "connect"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliUnconfigured);
    vi.mocked(authorizeBilibili).mockResolvedValue("https://account.bilibili.test/oauth");

    renderPage("/app/business-data/bilibili-operation");

    fireEvent.click(await screen.findByRole("button", { name: "添加账号" }));
    await waitFor(() => expect(authorizeBilibili).toHaveBeenCalledTimes(1));
    expect(redirectToBilibiliAuthorization).toHaveBeenCalledWith("https://account.bilibili.test/oauth");
  });

  it("shows the specific Bilibili authorization error returned by the API", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read", "connect"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliUnconfigured);
    vi.mocked(authorizeBilibili).mockRejectedValue(new APIError(
      "哔哩哔哩接入未配置，请在服务端配置开放平台凭据",
      503,
      "bilibili_not_configured",
    ));

    renderPage("/app/business-data/bilibili-operation");

    fireEvent.click(await screen.findByRole("button", { name: "添加账号" }));
    expect(await screen.findByText("哔哩哔哩接入未配置，请在服务端配置开放平台凭据")).toBeInTheDocument();
    expect(screen.queryByText("操作未完成，请稍后重试。")).not.toBeInTheDocument();
  });

  it("shows the Bilibili OAuth callback result", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read", "connect"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliUnconfigured);

    renderPage("/app/business-data/bilibili-operation?authorization=failed");

    expect(await screen.findByText("账号连接失败")).toBeInTheDocument();
    expect(screen.getByText("请确认账号权限后重新发起连接。")).toBeInTheDocument();
  });

  it("does not show Bilibili connection controls without connect permission", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliUnconfigured);

    renderPage("/app/business-data/bilibili-operation");

    expect(await screen.findByText("当前尚未接入哔哩哔哩账号。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加账号" })).not.toBeInTheDocument();
  });

  it("renders same-name accounts independently and syncs by source id", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read", "connect"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliAvailable);
    vi.mocked(listBilibiliSources).mockResolvedValue([
      { ...activeBilibiliSource, source_id: "bdsrc_a", name: "同名账号" },
      { ...activeBilibiliSource, source_id: "bdsrc_b", name: "同名账号" },
    ]);
    vi.mocked(syncBilibiliSource).mockResolvedValue("queued");

    renderPage("/app/business-data/bilibili-operation");

    const accountTable = await screen.findByRole("table");
    expect(await within(accountTable).findAllByText("同名账号")).toHaveLength(2);
    expect(getBilibiliDashboard).toHaveBeenCalledWith("7d", "bdsrc_a");
    const syncButtons = screen.getAllByRole("button", { name: "立即同步 同名账号" });
    expect(screen.queryByRole("button", { name: /删除账号/ })).not.toBeInTheDocument();
    fireEvent.click(syncButtons[1]);
    await waitFor(() => expect(syncBilibiliSource).toHaveBeenCalledWith("bdsrc_b", expect.anything()));
  });

  it("switches the Bilibili dashboard by source id", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read"] }]);
    vi.mocked(listBilibiliSources).mockResolvedValue([
      { ...activeBilibiliSource, source_id: "bdsrc_a", name: "账号甲" },
      { ...activeBilibiliSource, source_id: "bdsrc_b", name: "账号乙" },
    ]);
    vi.mocked(getBilibiliDashboard).mockImplementation(async (range, sourceID) => {
      const isAccountB = sourceID === "bdsrc_b";
      const name = isAccountB ? "账号乙" : "账号甲";
      return {
        ...bilibiliAvailable,
        range,
        account: { ...bilibiliAvailable.account, source_id: sourceID, name },
        data: {
          ...bilibiliAvailable.data!,
          follower_count: isAccountB ? 2200 : 1100,
          top_contents: [{
            ...bilibiliAvailable.data!.top_contents[0],
            source_id: sourceID,
            account_name: name,
            title: `${name}稿件`,
          }],
        },
      };
    });

    renderPage("/app/business-data/bilibili-operation?source_id=bdsrc_a");

    expect(await screen.findByText("账号甲稿件")).toBeInTheDocument();
    const accountSelect = screen.getByRole("combobox", { name: "查看账号" });
    fireEvent.keyDown(accountSelect, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "账号乙" }));

    expect(await screen.findByText("账号乙稿件")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "核心指标" })).toHaveTextContent("2,200");
    expect(getBilibiliDashboard).toHaveBeenLastCalledWith("7d", "bdsrc_b");
  });

  it("separates connect and manage controls", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read", "manage"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliUnavailable);
    vi.mocked(listBilibiliSources).mockResolvedValue([
      activeBilibiliSource,
      { ...activeBilibiliSource, source_id: "bdsrc_2", name: "已停止账号", status: "disabled", status_reason: "bilibili_sync_disabled", next_sync_at: null, active_run_status: "running" },
    ]);

    renderPage("/app/business-data/bilibili-operation");

    expect(await screen.findByRole("button", { name: "停止同步" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复同步" })).toBeInTheDocument();
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加账号" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "同步全部" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /立即同步/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /删除账号/ })).toHaveLength(2);
  });

  it("requires confirmation before deleting an account and refreshes all views", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read", "manage"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliAvailable);
    vi.mocked(listBilibiliSources).mockResolvedValue([activeBilibiliSource]);
    vi.mocked(deleteBilibiliSource).mockResolvedValue();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderPage("/app/business-data/bilibili-operation", queryClient);

    fireEvent.click(await screen.findByRole("button", { name: "删除账号 B 站账号" }));
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("删除后将清理该账号的授权凭据、稿件、快照和同步历史，且无法恢复。")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(deleteBilibiliSource).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除账号 B 站账号" }));
    dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除账号" }));
    await waitFor(() => expect(deleteBilibiliSource).toHaveBeenCalledWith("bdsrc_1"));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["bilibili-sources"] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["app-business-dashboard", "bilibili_operation"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["app-business-dashboard-overview"],
    });
  });

  it("requires confirmation before stopping an account", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read", "manage"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliAvailable);
    vi.mocked(listBilibiliSources).mockResolvedValue([activeBilibiliSource]);
    vi.mocked(setBilibiliSourceSyncEnabled).mockResolvedValue({
      source: { ...activeBilibiliSource, status: "disabled", status_reason: "bilibili_sync_disabled", next_sync_at: null },
      sync_request_status: null,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderPage("/app/business-data/bilibili-operation", queryClient);

    fireEvent.click(await screen.findByRole("button", { name: "停止同步" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("停止后将不再采集该账号的新数据，已采集数据会保留。")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(setBilibiliSourceSyncEnabled).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "停止同步" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "停止同步" }));
    await waitFor(() => expect(setBilibiliSourceSyncEnabled).toHaveBeenCalledWith("bdsrc_1", false));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["bilibili-sources"] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["app-business-dashboard", "bilibili_operation"],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["app-business-dashboard-overview"],
    });
  });

  it("invalidates account and dashboard queries after syncing", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read", "connect"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliAvailable);
    vi.mocked(listBilibiliSources).mockResolvedValue([activeBilibiliSource]);
    vi.mocked(syncBilibiliSource).mockResolvedValue("queued");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderPage("/app/business-data/bilibili-operation", queryClient);
    fireEvent.click(await screen.findByRole("button", { name: "立即同步 B 站账号" }));

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["bilibili-sources"] });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["app-business-dashboard", "bilibili_operation"],
      });
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["app-business-dashboard-overview"],
    });
  });

  it("also invalidates the overview after restoring an account", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read", "manage"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliAvailable);
    const disabledSource = {
      ...activeBilibiliSource,
      status: "disabled" as const,
      status_reason: "bilibili_sync_disabled",
      next_sync_at: null,
    };
    vi.mocked(listBilibiliSources).mockResolvedValue([disabledSource]);
    vi.mocked(setBilibiliSourceSyncEnabled).mockResolvedValue({
      source: activeBilibiliSource,
      sync_request_status: "queued",
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderPage("/app/business-data/bilibili-operation", queryClient);
    fireEvent.click(await screen.findByRole("button", { name: "恢复同步" }));

    await waitFor(() => {
      expect(setBilibiliSourceSyncEnabled).toHaveBeenCalledWith("bdsrc_1", true);
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["bilibili-sources"] });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["app-business-dashboard", "bilibili_operation"],
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["app-business-dashboard-overview"],
      });
    });
  });

  it("disables active-run sync and requires OAuth for authorization failures", async () => {
    vi.mocked(listMyDataViews).mockResolvedValue([{ view_id: "bilibili_operation", actions: ["read", "connect", "manage"] }]);
    vi.mocked(getBilibiliDashboard).mockResolvedValue(bilibiliUnavailable);
    vi.mocked(listBilibiliSources).mockResolvedValue([
      { ...activeBilibiliSource, active_run_status: "queued" },
      { ...activeBilibiliSource, source_id: "bdsrc_reauth", name: "待授权账号", status: "disabled", status_reason: "bilibili_reauth_required", next_sync_at: null },
      { ...activeBilibiliSource, source_id: "bdsrc_deauthorized", name: "已解绑账号", status: "disabled", status_reason: "bilibili_deauthorized", next_sync_at: null },
    ]);
    vi.mocked(authorizeBilibili).mockResolvedValue("https://account.bilibili.test/oauth");

    renderPage("/app/business-data/bilibili-operation");

    expect(await screen.findByRole("button", { name: "立即同步 B 站账号" })).toBeDisabled();
    expect(screen.getByText("已解除授权")).toBeInTheDocument();
    expect(screen.getByText("授权已失效")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "恢复同步" })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "重新授权" })[0]);
    await waitFor(() => expect(authorizeBilibili).toHaveBeenCalledTimes(1));
  });

  it("refreshes permissions after the backend rejects a stale grant", async () => {
    vi.mocked(listMyDataViews)
      .mockResolvedValueOnce([{ view_id: "xiaohongshu_operation", actions: ["read"] }])
      .mockResolvedValue([]);
    vi.mocked(getXiaohongshuDashboard).mockRejectedValue(
      new APIError("无权查看业务数据", 403, "business_data_view_forbidden"),
    );

    renderPage("/app/business-data/xiaohongshu-operation");

    expect(await screen.findByText("当前账户未开通数据看板")).toBeInTheDocument();
    expect(listMyDataViews).toHaveBeenCalledTimes(2);
  });
});

function renderPage(
  initialPath: string,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/app/business-data" element={<AppBusinessDataPage />} />
          <Route
            path="/app/business-data/xiaohongshu-operation"
            element={<AppBusinessDataPage requestedView="xiaohongshu_operation" />}
          />
          <Route
            path="/app/business-data/douyin-ads"
            element={<AppBusinessDataPage requestedView="douyin_ads" />}
          />
          <Route
            path="/app/business-data/bilibili-operation"
            element={<AppBusinessDataPage requestedView="bilibili_operation" />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
