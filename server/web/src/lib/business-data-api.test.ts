import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizeBilibili,
  deleteBilibiliSource,
  getBilibiliDashboard,
  getDouyinAdsDashboard,
  getXiaohongshuDashboard,
  listBilibiliSources,
  setBilibiliSourceSyncEnabled,
  syncBilibili,
  syncBilibiliSource,
} from "./business-data-api";

afterEach(() => vi.unstubAllGlobals());

describe("business data api", () => {
  it("loads each fixed dashboard through the app API", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { view_id: "xiaohongshu_operation", data_status: "unconfigured" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { view_id: "douyin_ads", data_status: "unconfigured" } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        status: "unconfigured",
        range: "7d",
        timezone: "Asia/Shanghai",
        start_date: "2026-08-22",
        end_date: "2026-08-28",
        generated_at: "2026-08-28T02:10:00Z",
      } }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          status: "available",
          range: "30d",
          timezone: "Asia/Shanghai",
          start_date: "2026-07-30",
          end_date: "2026-08-28",
          generated_at: "2026-08-28T02:10:00Z",
          data: {
            captured_at: "2026-08-28T02:10:00Z",
            follower_count: 12,
            collected_content_count: 1,
            view_count: 100,
            interaction_count: 8,
            trend: [{ date: "2026-08-28", follower_count: 12, view_count: 100, interaction_count: 8, follower_count_delta: 2, view_count_delta: 10, interaction_count_delta: 1 }],
            top_contents: [],
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ data: { authorization_url: "https://account.bilibili.test/oauth" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: "queued" } }, 202))
      .mockResolvedValueOnce(jsonResponse({ data: { items: [{ source_id: "bdsrc/one", name: "账号一" }] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: "already_queued" } }, 202))
      .mockResolvedValueOnce(jsonResponse({ data: { source: { source_id: "bdsrc/one", status: "disabled" }, sync_request_status: null } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const xiaohongshu = await getXiaohongshuDashboard("7d");
    const douyin = await getDouyinAdsDashboard("30d");
    const bilibili = await getBilibiliDashboard("7d", "bdsrc/one");
    const availableBilibili = await getBilibiliDashboard("30d", "bdsrc/two");
    const authorizationURL = await authorizeBilibili();
    const syncStatus = await syncBilibili();
    const sources = await listBilibiliSources();
    const sourceSyncStatus = await syncBilibiliSource("bdsrc/one");
    const sourceChange = await setBilibiliSourceSyncEnabled("bdsrc/one", false);
    await deleteBilibiliSource("bdsrc/one");

    expect(xiaohongshu.view_id).toBe("xiaohongshu_operation");
    expect(douyin.view_id).toBe("douyin_ads");
    expect(bilibili.status).toBe("unconfigured");
    expect(availableBilibili.status).toBe("available");
    expect(availableBilibili.data?.view_count).toBe(100);
    expect(availableBilibili.data?.trend[0].view_count_delta).toBe(10);
    expect(authorizationURL).toBe("https://account.bilibili.test/oauth");
    expect(syncStatus).toBe("queued");
    expect(sources[0].source_id).toBe("bdsrc/one");
    expect(sourceSyncStatus).toBe("already_queued");
    expect(sourceChange.sync_request_status).toBeNull();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/app/business-dashboards/xiaohongshu-operation?range=7d",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/app/business-dashboards/douyin-ads?range=30d",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/v1/app/business-dashboards/bilibili-operation?range=7d&source_id=bdsrc%2Fone",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/v1/app/business-dashboards/bilibili-operation?range=30d&source_id=bdsrc%2Ftwo",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/v1/app/business-data-sources/bilibili/authorize", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(6, "/api/v1/app/business-data-sources/bilibili/sync", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(7, "/api/v1/app/business-data-sources/bilibili", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(8, "/api/v1/app/business-data-sources/bilibili/bdsrc%2Fone/sync", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(9, "/api/v1/app/business-data-sources/bilibili/bdsrc%2Fone", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ sync_enabled: false }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(10, "/api/v1/app/business-data-sources/bilibili/bdsrc%2Fone", expect.objectContaining({ method: "DELETE", body: undefined }));
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
