import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canReadAgentActivity,
  canReadBusinessData,
  canReadDataView,
  canConnectDataView,
  canManageDataView,
  dataViewIds,
  listMyDataViews,
} from "./data-views-api";

afterEach(() => vi.unstubAllGlobals());

describe("data views api", () => {
  it("loads current-account data views", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ view_id: dataViewIds.xiaohongshuOperation, actions: ["read"] }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const views = await listMyDataViews();

    expect(views).toEqual([{ view_id: dataViewIds.xiaohongshuOperation, actions: ["read"] }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/app/data-views",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("requires the registered view and read action", () => {
    const views = [
      { view_id: dataViewIds.agentActivity, actions: ["read"] },
      { view_id: dataViewIds.xiaohongshuOperation, actions: [] },
    ];

    expect(canReadAgentActivity(views)).toBe(true);
    expect(canReadBusinessData(views)).toBe(false);
    expect(canReadDataView(views, dataViewIds.xiaohongshuOperation)).toBe(false);
    expect(canReadDataView([{ view_id: dataViewIds.douyinAds, actions: ["read"] }], dataViewIds.douyinAds)).toBe(true);
    expect(canConnectDataView([{ view_id: dataViewIds.bilibiliOperation, actions: ["read", "connect"] }], dataViewIds.bilibiliOperation)).toBe(true);
    expect(canConnectDataView([{ view_id: dataViewIds.bilibiliOperation, actions: ["read"] }], dataViewIds.bilibiliOperation)).toBe(false);
    expect(canManageDataView([{ view_id: dataViewIds.bilibiliOperation, actions: ["read", "manage"] }], dataViewIds.bilibiliOperation)).toBe(true);
    expect(canManageDataView([{ view_id: dataViewIds.bilibiliOperation, actions: ["read"] }], dataViewIds.bilibiliOperation)).toBe(false);
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
