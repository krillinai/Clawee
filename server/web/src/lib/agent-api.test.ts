import { afterEach, describe, expect, it, vi } from "vitest";

import {
  revealMyAccountToken,
  getAgentAccess,
  getMyAccountToken,
  listMyAgents,
  listMyAgentTools,
  listMyMCPCatalog,
  rotateMyAccountToken,
  updateMyAgentName
} from "./agent-api";

describe("agent-api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the frontend namespace and parses unified snake_case responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: {
        account: { user_id: "usr_route", email: "route@example.com", name: "Route User" },
        agent: {
          agent_id: "agent_route",
          client_id: "client_route",
          actor_id: "usr_route",
          status: "active",
          creation_source: "collector",
          collector: {
            collector_id: "collector_1",
            office_agent_id: "codex:device_1:main",
            device_id: "device_1",
            device_name: "MacBook",
            hostname: "mac.local",
            os: "darwin",
            arch: "arm64",
            collector_version: "0.1.1",
            last_seen_at: "2026-08-05T09:01:00Z",
            status: "online"
          }
        }
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: { token: tokenInfo() } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        token: "agt_secret", authorization_header: "Authorization: Bearer agt_secret", token_info: tokenInfo()
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        token: "agt_rotated", token_info: tokenInfo(),
        authorization_header: "Authorization: Bearer agt_rotated"
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{
        id: "cap_1", exposed_name: "crm.search", title: "Search", description: "Search CRM",
        upstream_server_id: "crm", risk_level: "low", confirm_required: false, expires_at: null
      }], meta: { next_cursor: "", has_next: false } }));
    vi.stubGlobal("fetch", fetchMock);

    const access = await getAgentAccess("agent_route");
    const token = await getMyAccountToken();
    const copied = await revealMyAccountToken();
    const rotated = await rotateMyAccountToken();
    const tools = await listMyAgentTools("agent_route");

    expect(access.agent.agentId).toBe("agent_route");
    expect(access.agent.creationSource).toBe("collector");
    expect(access.agent.collector).toEqual({
      collectorId: "collector_1",
      officeAgentId: "codex:device_1:main",
      deviceId: "device_1",
      deviceName: "MacBook",
      hostname: "mac.local",
      os: "darwin",
      arch: "arm64",
      collectorVersion: "0.1.1",
      lastSeenAt: "2026-08-05T09:01:00Z",
      status: "online"
    });
    expect(token.tokenId).toBe("token_1");
    expect(copied.token).toBe("agt_secret");
    expect(copied.authorizationHeader).toBe("Authorization: Bearer agt_secret");
    expect(copied.tokenInfo).toMatchObject({ tokenId: "token_1", tokenStatus: "active", tokenScopes: ["mcp:call"] });
    expect(rotated.authorizationHeader).toBe("Authorization: Bearer agt_rotated");
    expect(tools.items[0]).toMatchObject({ id: "cap_1", exposedName: "crm.search", upstreamServerId: "crm" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/app/agents/detail?agent_id=agent_route", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/app/mcp/token", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/app/mcp/token/reveal", expect.objectContaining({ body: undefined }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/v1/app/mcp/token/rotate", expect.objectContaining({ body: JSON.stringify({ scopes: ["mcp:call"] }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/v1/app/agents/tools?agent_id=agent_route", expect.any(Object));
  });

  it("maps every Agent returned by the account-scoped list", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: [
      { account: { user_id: "usr_1", email: "user@example.com" }, agent: { agent_id: "agent_1", status: "active" } },
      { account: { user_id: "usr_1", email: "user@example.com" }, agent: { agent_id: "agent_2", status: "active" } }
    ] }));
    vi.stubGlobal("fetch", fetchMock);

    const agents = await listMyAgents();

    expect(agents.map((item) => item.agent.agentId)).toEqual(["agent_1", "agent_2"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/app/agents", expect.objectContaining({ method: "GET" }));
  });

  it("updates only the selected Agent name", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: {
      account: { user_id: "usr_1", email: "user@example.com", name: "User" },
      agent: { agent_id: "agent_1", name: "销售助手", status: "active" }
    } }));
    vi.stubGlobal("fetch", fetchMock);

    const updated = await updateMyAgentName("agent_1", "销售助手");

    expect(updated.agent).toMatchObject({ agentId: "agent_1", name: "销售助手" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/app/agents/name",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ agent_id: "agent_1", name: "销售助手" })
      })
    );
  });

  it("does not use a camelCase authorization header compatibility field", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: {
      token: tokenInfo(),
      plaintext: "agt_secret",
      authorizationHeader: "Authorization: Bearer legacy"
    } }));
    vi.stubGlobal("fetch", fetchMock);

    const copied = await revealMyAccountToken();

    expect(copied.authorizationHeader).toBe("");
  });

  it("maps the account MCP catalog without an Agent parameter", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: {
      upstreams: [{
        id: "crm-main",
        name: "CRM",
        domain: "sales",
        icon_url: "https://gateway.example/assets/app-icons/mcp-f654f2a2.png",
        mcp_endpoint: "https://gateway.example/mcp/servers/crm-main",
        upstream_transport: "streamable_http",
        namespace: "crm",
        status: "active",
        tools: [{
          id: "cap_search",
          upstream_name: "customer.search",
          name: "customer.search",
          exposed_name: "crm.customer.search",
          title: "查询客户",
          description: "按条件查询客户",
          risk_level: "low",
          confirm_required: false,
          status: "active",
          authorized: true,
          authorization_expires_at: "2026-08-01T10:00:00Z"
        }]
      }]
    } }));
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await listMyMCPCatalog();

    expect(catalog).toEqual({
      upstreams: [{
        id: "crm-main",
        name: "CRM",
        domain: "sales",
        iconUrl: "https://gateway.example/assets/app-icons/mcp-f654f2a2.png",
        mcpEndpoint: "https://gateway.example/mcp/servers/crm-main",
        upstreamTransport: "streamable_http",
        namespace: "crm",
        status: "active",
        tools: [{
          id: "cap_search",
          upstreamName: "customer.search",
          name: "customer.search",
          exposedName: "crm.customer.search",
          title: "查询客户",
          description: "按条件查询客户",
          riskLevel: "low",
          confirmRequired: false,
          status: "active",
          authorized: true,
          authorizationExpiresAt: "2026-08-01T10:00:00Z"
        }]
      }]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/app/mcp/catalog",
      expect.objectContaining({ method: "GET" })
    );
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function tokenInfo() {
  return {
    token_id: "token_1",
    user_id: "usr_route",
    token_fingerprint: "fp_1",
    token_status: "active",
    token_expires_at: null,
    token_last_used_at: null,
    token_issuer: "claw-mcp-user",
    token_scopes: ["mcp:call"]
  };
}
