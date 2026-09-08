import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindOfficeAgentToMCP,
  createMyCollectorRegistrationCode,
  createRegistrationCode,
  deleteCollector,
  deleteMyCollector,
  deleteOfficeAgent,
  fetchCollectorOverview,
  getAgentActivityDetail,
  getAgentActivityList,
  getMyAgentDetail,
  getMyOfficeSnapshot,
  getMyRecentActivities,
  getMySubAgents,
  getOfficeSnapshot,
  getRecentActivities,
  getSubAgents,
  revokeCollectorToken,
  unbindOfficeAgentFromMCP,
} from "./office-api";

const mockFetch = vi.fn();

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("office-api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it("gets collectors overview from the office admin endpoint", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        schema_version: "office.v1",
        server_time: "2026-06-03T12:00:00Z",
        online_threshold_seconds: 60,
        registration_code: {
          exists: true,
          code: "reg_visible",
          install_url: "http://admin.local/office/collectors/install?code=reg_visible",
          install_script_url: "http://admin.local/office/collectors/install.sh?code=reg_visible",
          install_command: "curl -fsSL 'http://admin.local/office/collectors/install.sh?code=reg_visible' | sh",
          used_count: 0,
          revoked: false,
        },
        summary: {
          total_collectors: 1,
          online_collectors: 1,
          offline_collectors: 0,
          never_seen_collectors: 0,
        },
        collectors: [],
      }),
    );

    const overview = await fetchCollectorOverview();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/collectors/overview",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
    expect(overview.registration_code.code).toBe("reg_visible");
    expect(overview.registration_code.install_url).toBe("http://admin.local/office/collectors/install?code=reg_visible");
  });

  it("creates an account-bound registration code", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        registration_code: "reg_new",
        install_url: "http://admin.local/office/collectors/install?code=reg_new",
        install_script_url: "http://admin.local/office/collectors/install.sh?code=reg_new",
        install_command: "curl -fsSL 'http://admin.local/office/collectors/install.sh?code=reg_new' | sh",
        created_at: "2026-06-03T12:00:00Z",
      }),
    );

    const created = await createRegistrationCode("usr_1");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/collector-registration-codes",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ user_id: "usr_1" }),
      }),
    );
    expect(created.registration_code).toBe("reg_new");
    expect(created.install_url).toBe("http://admin.local/office/collectors/install?code=reg_new");
  });

  it("creates a registration code for the current account", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        registration_code: "reg_mine",
        install_url: "http://app.local/office/collectors/install?code=reg_mine",
        install_command: "curl -fsSL 'http://app.local/office/collectors/install.sh?code=reg_mine' | sh",
        install_powershell_command: "irm 'http://app.local/office/collectors/install.ps1?code=reg_mine' | iex",
        created_at: "2026-06-03T12:00:00Z",
      }),
    );

    const created = await createMyCollectorRegistrationCode();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/app/collector-registration-codes",
      expect.objectContaining({ method: "POST", body: JSON.stringify({}) }),
    );
    expect(created.registration_code).toBe("reg_mine");
  });

  it("revokes a collector token by id with path encoding", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await revokeCollectorToken("collector/1");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/collectors/token/revoke",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ collector_id: "collector/1" }) }),
    );
  });

  it("deletes admin and current-account collectors", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));

    await deleteCollector("collector/1");
    await deleteMyCollector("collector/2");

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/admin/collectors/remove",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ collector_id: "collector/1" }) }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/app/collectors/remove",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ collector_id: "collector/2" }) }),
    );
  });

  it("gets agent activity list from the normalized office endpoint", async () => {
    vi.stubGlobal("fetch", mockFetch);
    const payload = {
      schema_version: "office.v1",
      server_time: "2026-06-03T10:21:36Z",
      sse_url: "/api/v1/admin/office/realtime/events",
      filters: { workspaces: [], status_counts: {}, business_systems: [] },
      summary: {
        total_agents: 0,
        online_agents: 0,
        active_sub_agents: 0,
        blocked_agents: 0,
        error_agents: 0,
        working_agents: 0,
        active_sessions: 0,
        active_turns: 0,
        recent_tool_call_count: 0,
      },
      agents: [],
      recent_feed: [],
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload)).mockResolvedValueOnce(jsonResponse(payload));

    await getAgentActivityList();
    await getOfficeSnapshot();

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/admin/activity/agents",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/admin/activity/overview",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("gets detail, sub agents and recent activities from office endpoints", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ schema_version: "office.v1", server_time: "", agent: {}, sessions: [], turns: [], sub_agents: [], tool_calls: [], status_timeline: [], recent_activities: [], stats: {} }))
      .mockResolvedValueOnce(jsonResponse({ schema_version: "office.v1", server_time: "", collector_id: "collector 1", agent_id: "agent/same", sub_agents: [] }))
      .mockResolvedValueOnce(jsonResponse({ schema_version: "office.v1", server_time: "", recent_feed: [] }));

    await getAgentActivityDetail("collector 1", "agent/same");
    await getSubAgents("collector 1", "agent/same");
    await getRecentActivities(35);

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/admin/activity/detail?collector_id=collector%201&agent_id=agent%2Fsame&include_history=false",
      expect.objectContaining({ method: "GET" }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/admin/activity/sub-agents?collector_id=collector%201&agent_id=agent%2Fsame",
      expect.objectContaining({ method: "GET" }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      "/api/v1/admin/activity/recent?limit=35",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("gets account-scoped activity from app endpoints", async () => {
    vi.stubGlobal("fetch", mockFetch);
    const snapshot = { schema_version: "office.v1", server_time: "", filters: { workspaces: [], status_counts: {}, business_systems: [] }, summary: {}, agents: [], recent_feed: [] };
    mockFetch
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(jsonResponse({ schema_version: "office.v1", server_time: "", agent: {} }))
      .mockResolvedValueOnce(jsonResponse({ schema_version: "office.v1", server_time: "", sub_agents: [] }))
      .mockResolvedValueOnce(jsonResponse({ schema_version: "office.v1", server_time: "", recent_feed: [] }));

    const result = await getMyOfficeSnapshot();
    await getMyAgentDetail("collector 1", "agent/same");
    await getMySubAgents("collector 1", "agent/same");
    await getMyRecentActivities(35);

    expect(result.sse_url).toBe("/api/v1/app/activity/events");
    expect(mockFetch).toHaveBeenNthCalledWith(1, "/api/v1/app/activity/overview", expect.objectContaining({ method: "GET" }));
    expect(mockFetch).toHaveBeenNthCalledWith(2, "/api/v1/app/activity/detail?collector_id=collector%201&agent_id=agent%2Fsame&include_history=false", expect.objectContaining({ method: "GET" }));
    expect(mockFetch).toHaveBeenNthCalledWith(3, "/api/v1/app/activity/sub-agents?collector_id=collector%201&agent_id=agent%2Fsame", expect.objectContaining({ method: "GET" }));
    expect(mockFetch).toHaveBeenNthCalledWith(4, "/api/v1/app/activity/recent?limit=35", expect.objectContaining({ method: "GET" }));
  });

  it("binds, unbinds, and deletes an Office Agent using request bodies", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ status: "bound" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await bindOfficeAgentToMCP("collector/1", "office agent", "mcp/1");
    await unbindOfficeAgentFromMCP("collector/1", "office agent");
    await deleteOfficeAgent("collector/1", "office agent");

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/admin/activity/mcp-agent-binding",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ collector_id: "collector/1", agent_id: "office agent", mcp_agent_id: "mcp/1" }) }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/admin/activity/mcp-agent-binding/remove",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ collector_id: "collector/1", agent_id: "office agent" }) }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      "/api/v1/admin/activity/agents/remove",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ collector_id: "collector/1", agent_id: "office agent" }) }),
    );
  });
});
