import { afterEach, describe, expect, it, vi } from "vitest";

import { getMyActivityStatistics } from "./activity-api";

afterEach(() => vi.unstubAllGlobals());

describe("activity api", () => {
  it("loads scoped activity statistics", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { range: "30d", organization: { usage: {} } } }));
    vi.stubGlobal("fetch", fetchMock);

    const statistics = await getMyActivityStatistics("30d");

    expect(statistics.range).toBe("30d");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/app/activity/statistics?range=30d",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
