import { afterEach, describe, expect, it, vi } from "vitest";

import { getMyActivityStatistics, getMyAgentUsage } from "./activity-api";

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

  it("loads scoped personal agent usage", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: { range: "7d" } }));
    vi.stubGlobal("fetch", fetchMock);

    const usage = await getMyAgentUsage("collector 1", "agent/1", "7d");

    expect(usage.range).toBe("7d");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/app/activity/agent-usage?collector_id=collector%201&agent_id=agent%2F1&range=7d",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
