import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMCPAgent,
  createMCPGrant,
  createUpstreamServer,
  deleteMCPAgent,
  deleteMCPCapability,
  deleteMCPUpstreamServer,
  deleteMCPGrant,
  acceptMCPGate,
  listMCPGates,
  listMCPAgents,
  listMCPAudits,
  listMCPCapabilities,
  listMCPGrants,
  listMCPUpstreamServers,
  renameMCPCapability,
  rejectMCPGate,
  revokeMCPAccountToken,
  rotateMCPAccountToken,
  syncMCPUpstreamTools,
  transferMCPAgent,
  updateMCPCapabilityGates,
  updateMCPCapabilityStatus,
  updateMCPUpstreamServer,
  updateMCPUpstreamServerStatus
} from "./mcp-admin-api";

const mockFetch = vi.fn();

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init
  });
}

describe("mcp-admin-api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it("lists upstream servers with filters and adapts PascalCase fields", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            ID: "crm-main",
            Name: "CRM Main",
            Domain: "crm",
            Transport: "streamable_http",
            Endpoint: "http://crm.example/mcp",
            AuthType: "",
            CredentialRef: "",
            HasToken: true,
            OwnerTeam: "sales-platform",
            Namespace: "crm",
            RoutingDescription: "负责客户查询和销售流程",
            Status: "active",
            CapabilitiesCount: 3,
            LastSyncedAt: "2026-05-27T00:00:00Z",
            LastSyncResult: "ok",
            MCPEndpoint: "https://gateway.example.com/mcp/servers/crm-main",
            MCPCanonicalEndpoint: "https://gateway.example.com/mcp/servers/crm-main",
            ResourceMetadataURL: "https://gateway.example.com/.well-known/oauth-protected-resource/mcp/servers/crm-main",
            CanonicalResourceMetadataURL: "https://gateway.example.com/.well-known/oauth-protected-resource/mcp/servers/crm-main",
            CreatedAt: "2026-05-26T00:00:00Z",
            UpdatedAt: "2026-05-27T00:00:00Z"
          }
        ]
      })
    );

    const result = await listMCPUpstreamServers({
      status: "active",
      domain: "crm"
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/mcp/upstream-servers?status=active&domain=crm",
      expect.objectContaining({ method: "GET" })
    );
    expect(result).toEqual([
      {
        id: "crm-main",
        name: "CRM Main",
        domain: "crm",
        transport: "streamable_http",
        endpoint: "http://crm.example/mcp",
        authType: "",
        credentialRef: "",
        hasToken: true,
        ownerTeam: "sales-platform",
        namespace: "crm",
        routingDescription: "负责客户查询和销售流程",
        collectorId: "",
        stdio: undefined,
        status: "active",
        capabilitiesCount: 3,
        lastSyncedAt: "2026-05-27T00:00:00Z",
        lastSyncResult: "ok",
        mcpEndpoint: "https://gateway.example.com/mcp/servers/crm-main",
        mcpCanonicalEndpoint: "https://gateway.example.com/mcp/servers/crm-main",
        resourceMetadataUrl: "https://gateway.example.com/.well-known/oauth-protected-resource/mcp/servers/crm-main",
        canonicalResourceMetadataUrl: "https://gateway.example.com/.well-known/oauth-protected-resource/mcp/servers/crm-main",
        createdAt: "2026-05-26T00:00:00Z",
        updatedAt: "2026-05-27T00:00:00Z"
      }
    ]);
  });

  it("creates upstream servers with snake_case request bodies", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        ID: "crm-main",
        Name: "CRM Main",
        Domain: "crm",
        Transport: "stdio",
        Endpoint: "",
        Stdio: {
          command: "go",
          args: ["run", "./internal/teststdio"],
          cwd: "/repo",
          env: { UPSTREAM_TOKEN: "from-config" }
        },
        AuthType: "",
        CredentialRef: "",
        OwnerTeam: "sales-platform",
        Namespace: "crm",
        RoutingDescription: "负责客户查询和销售流程",
        Status: "active",
        CreatedAt: "2026-05-27T00:00:00Z",
        UpdatedAt: "2026-05-27T00:00:00Z"
      })
    );

    const result = await createUpstreamServer({
      serverId: "crm-main",
      name: "CRM Main",
      domain: "crm",
      transport: "stdio",
      endpoint: "",
      stdio: {
        command: "go",
        args: ["run", "./internal/teststdio"],
        cwd: "/repo",
        env: { UPSTREAM_TOKEN: "from-config" }
      },
      namespace: "crm",
      ownerTeam: "sales-platform",
      routingDescription: "负责客户查询和销售流程"
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/mcp/upstream-servers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          server_id: "crm-main",
          name: "CRM Main",
          domain: "crm",
          transport: "stdio",
          endpoint: "",
          stdio: {
            command: "go",
            args: ["run", "./internal/teststdio"],
            cwd: "/repo",
            env: { UPSTREAM_TOKEN: "from-config" }
          },
          namespace: "crm",
          owner_team: "sales-platform",
          routing_description: "负责客户查询和销售流程"
        })
      })
    );
    expect(result.id).toBe("crm-main");
    expect(result.ownerTeam).toBe("sales-platform");
    expect(result.stdio?.command).toBe("go");
  });

  it("updates and syncs upstream servers using encoded path parameters", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          ID: "server/one",
          Status: "disabled",
          UpdatedAt: "2026-05-27T00:00:00Z"
        })
      )
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    const status = await updateMCPUpstreamServerStatus("server/one", "disabled");
    const sync = await syncMCPUpstreamTools("server/one", {
      headers: { Authorization: "Bearer delegated" }
    });

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/admin/mcp/upstream-servers",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ server_id: "server/one", status: "disabled" })
      })
    );
    expect(status).toEqual({
      id: "server/one",
      status: "disabled",
      updatedAt: "2026-05-27T00:00:00Z"
    });
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/admin/mcp/upstream-servers/sync-tools",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ server_id: "server/one" }),
        headers: expect.objectContaining({ Authorization: "Bearer delegated" })
      })
    );
    expect(sync).toEqual({ status: "ok" });
  });

  it("updates and deletes upstream servers using encoded path parameters", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          ID: "server/one",
          Name: "Server Updated",
          Domain: "crm",
          Transport: "streamable_http",
          Endpoint: "https://crm.example/mcp",
          AuthType: "",
          CredentialRef: "",
          OwnerTeam: "platform",
          Namespace: "crm",
          Status: "disabled",
          CreatedAt: "2026-05-27T00:00:00Z",
          UpdatedAt: "2026-05-27T01:00:00Z"
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const updated = await updateMCPUpstreamServer("server/one", {
      serverId: "ignored-client-side",
      name: "Server Updated",
      domain: "crm",
      transport: "streamable_http",
      endpoint: "https://crm.example/mcp",
      namespace: "crm",
      ownerTeam: "platform",
      routingDescription: "负责研发任务",
      token: "configured-token"
    });
    await expect(deleteMCPUpstreamServer("server/one")).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/admin/mcp/upstream-servers",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          server_id: "server/one",
          name: "Server Updated",
          domain: "crm",
          transport: "streamable_http",
          endpoint: "https://crm.example/mcp",
          stdio: undefined,
          namespace: "crm",
          owner_team: "platform",
          routing_description: "负责研发任务",
          token: "configured-token"
        })
      })
    );
    expect(updated.id).toBe("server/one");
    expect(updated.status).toBe("disabled");
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/admin/mcp/upstream-servers/remove",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ server_id: "server/one" }) })
    );
  });

  it("surfaces sync tool error messages from response bodies", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "spawn stdio: permission denied" }, { status: 502 }));

    await expect(syncMCPUpstreamTools("local-crm")).rejects.toThrow("spawn stdio: permission denied");
  });

  it("creates agents without creating an account token", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        agent: {
          AgentID: "sales-agent",
          ClientID: "client",
          Name: "Sales Agent",
          TenantID: "demo",
          ActorID: "sales_zhang",
          Status: "active",
          CreatedAt: "2026-05-26T00:00:00Z",
          UpdatedAt: "2026-05-27T00:00:00Z"
        }
      })
    );

    const result = await createMCPAgent({
      userId: "usr_1",
      agentId: "sales-agent",
      clientId: "client",
      name: "Sales Agent",
      tenantId: "demo",
      actorId: "sales_zhang",
      status: "active"
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/mcp/agents",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          user_id: "usr_1",
          agent_id: "sales-agent",
          client_id: "client",
          name: "Sales Agent",
          tenant_id: "demo",
          actor_id: "sales_zhang",
          status: "active"
        })
      })
    );
    expect(result.agentId).toBe("sales-agent");
  });

  it("lists agents and rotates or revokes tokens by account", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              AgentID: "sales-agent",
              ClientID: "client",
              Name: "Sales Agent",
              TenantID: "demo",
              ActorID: "sales_zhang",
              Status: "active",
              CreatedAt: "2026-05-26T00:00:00Z",
              UpdatedAt: "2026-05-27T00:00:00Z"
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          token: "rotated",
          authorization_header: "Authorization: Bearer rotated",
          token_info: {
            user_id: "usr/one",
            token_id: "token_2",
            token_fingerprint: "def456",
            token_status: "active",
            token_expires_at: "2031-01-01T00:00:00Z",
            token_issuer: "claw-mcp-admin",
            token_scopes: ["mcp:call"],
            created_at: "2026-05-27T00:00:00Z"
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          user_id: "usr/one",
          revoked_token_count: 1,
          token_status: "revoked"
        })
      );

    const agents = await listMCPAgents({ status: "active" });
    const rotated = await rotateMCPAccountToken("usr/one", {
      expiresAt: "2031-01-01T00:00:00Z",
      scopes: ["mcp:call"]
    });
    const revoked = await revokeMCPAccountToken("usr/one");

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/admin/mcp/agents?status=active",
      expect.objectContaining({ method: "GET" })
    );
    expect(agents[0].agentId).toBe("sales-agent");
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/admin/mcp/accounts/token/rotate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          user_id: "usr/one",
          expires_at: "2031-01-01T00:00:00Z",
          scopes: ["mcp:call"]
        })
      })
    );
    expect(rotated.tokenInfo.tokenId).toBe("token_2");
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      "/api/v1/admin/mcp/accounts/token/revoke",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ user_id: "usr/one" }) })
    );
    expect(revoked).toEqual({
      userId: "usr/one",
      revokedTokenCount: 1,
      tokenStatus: "revoked"
    });
  });

  it("deletes agents using the admin removal endpoint", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(deleteMCPAgent("agent/one")).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/mcp/agents/remove",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ agent_id: "agent/one" })
      })
    );
  });

  it("transfers an Agent without requesting token rotation or grant revocation", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({
      action: "agent_transfer",
      agent_ids: ["agent/one"],
      source_user_id: "usr-old",
      target_user_id: "usr-new",
      tokens_preserved: true,
      grants_preserved: true,
      token_count: 1,
      grant_count: 2,
      completed_at: "2026-08-18T03:00:00Z"
    }));

    await transferMCPAgent({ agentId: "agent/one", sourceUserId: "usr-old", targetUserId: "usr-new", reason: "重复账号" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/mcp/agents/transfer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ agent_id: "agent/one", source_user_id: "usr-old", target_user_id: "usr-new", reason: "重复账号" })
      })
    );
  });

  it("lists capabilities preserving schema payloads and updates governance fields", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              ID: "cap_search",
              UpstreamServerID: "crm-main",
              Type: "tool",
              UpstreamName: "customer.search",
              ExposedName: "crm.customer.search",
              Title: "Search customers",
              Description: "Search customers by keyword",
              InputSchema: { type: "object" },
              OutputSchema: { type: "array" },
              Annotations: { destructiveHint: false },
              RiskLevel: "low",
              ReadOnly: true,
              Destructive: false,
              Idempotent: true,
              ApprovalRequired: false,
              ConfirmRequired: true,
              ConfirmTemplate: "请确认搜索客户 {{keyword}}",
              Status: "pending",
              SchemaHash: "hash",
              Version: "v1",
              LastSyncedAt: "2026-05-27T00:00:00Z",
              CreatedAt: "2026-05-26T00:00:00Z",
              UpdatedAt: "2026-05-27T00:00:00Z"
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ID: "cap_search",
          ExposedName: "crm.customer/search",
          Status: "active",
          UpdatedAt: "2026-05-27T01:00:00Z"
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ID: "cap_search",
          ExposedName: "crm.customer.lookup",
          Status: "pending",
          UpdatedAt: "2026-05-27T02:00:00Z"
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ID: "cap_search",
          UpstreamServerID: "crm-main",
          Type: "tool",
          UpstreamName: "customer.search",
          ExposedName: "crm.customer.lookup",
          Title: "Search customers",
          Description: "Search customers by keyword",
          InputSchema: { type: "object" },
          OutputSchema: { type: "array" },
          Annotations: { destructiveHint: false },
          RiskLevel: "low",
          ReadOnly: true,
          Destructive: false,
          Idempotent: true,
          ApprovalRequired: true,
          ConfirmRequired: false,
          ConfirmTemplate: "请确认搜索客户 {{keyword}}",
          Status: "pending",
          SchemaHash: "hash",
          Version: "v1",
          LastSyncedAt: "2026-05-27T00:00:00Z",
          CreatedAt: "2026-05-26T00:00:00Z",
          UpdatedAt: "2026-05-27T03:00:00Z"
        })
      );

    const capabilities = await listMCPCapabilities({
      serverId: "crm-main",
      type: "tool",
      status: "pending",
      domain: "crm",
      riskLevel: "low"
    });
    const status = await updateMCPCapabilityStatus("crm.customer/search", "active");
    const renamed = await renameMCPCapability("crm.customer/search", "crm.customer.lookup");
    const gates = await updateMCPCapabilityGates("cap_search", {
      approvalRequired: true,
      confirmRequired: false
    });

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/admin/mcp/capabilities?server_id=crm-main&type=tool&status=pending&domain=crm&risk_level=low",
      expect.objectContaining({ method: "GET" })
    );
    expect(capabilities[0].inputSchema).toEqual({ type: "object" });
    expect(capabilities[0].annotations).toEqual({ destructiveHint: false });
    expect(capabilities[0].confirmRequired).toBe(true);
    expect(capabilities[0].confirmTemplate).toBe("请确认搜索客户 {{keyword}}");
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/admin/mcp/capabilities",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ capability_id: "crm.customer/search", status: "active" })
      })
    );
    expect(status.status).toBe("active");
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      "/api/v1/admin/mcp/capabilities",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ capability_id: "crm.customer/search", exposed_name: "crm.customer.lookup" })
      })
    );
    expect(renamed.exposedName).toBe("crm.customer.lookup");
    expect(mockFetch).toHaveBeenNthCalledWith(
      4,
      "/api/v1/admin/mcp/capabilities/gate-policy",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ capability_id: "cap_search", approval_required: true, confirm_required: false })
      })
    );
    expect(gates.approvalRequired).toBe(true);
    expect(gates.confirmRequired).toBe(false);
  });

  it("creates and lists grants using backend grant IDs", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          ID: "grant_backend_id",
          UserID: "usr_1",
          CapabilityID: "cap",
          GrantType: "tool",
          DataScope: { regions: ["north"] },
          ExpiresAt: "2030-01-01T00:00:00Z",
          CreatedBy: "admin",
          CreatedAt: "2026-05-26T00:00:00Z",
          UpdatedAt: "2026-05-27T00:00:00Z"
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              ID: "grant_from_list",
              UserID: "usr_1",
              CapabilityID: "cap",
              GrantType: "tool",
              DataScope: null,
              ExpiresAt: null,
              CreatedBy: "admin",
              CreatedAt: "2026-05-26T00:00:00Z",
              UpdatedAt: "2026-05-27T00:00:00Z"
            }
          ]
        })
      );

    const created = await createMCPGrant({
      userId: "usr_1",
      capabilityId: "cap",
      grantType: "tool",
      ...({ createdBy: "伪造用户" } as Record<string, string>),
      dataScope: { regions: ["north"] },
      expiresAt: "2030-01-01T00:00:00Z"
    });
    const grants = await listMCPGrants({
      userId: "usr_1",
      capabilityId: "cap",
      grantType: "tool"
    });

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/admin/mcp/grants",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          user_id: "usr_1",
          capability_id: "cap",
          grant_type: "tool",
          data_scope: { regions: ["north"] },
          expires_at: "2030-01-01T00:00:00Z"
        })
      })
    );
    expect(created.id).toBe("grant_backend_id");
    expect(created.dataScope).toEqual({ regions: ["north"] });
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/admin/mcp/grants?user_id=usr_1&capability_id=cap&grant_type=tool",
      expect.objectContaining({ method: "GET" })
    );
    expect(grants[0].id).toBe("grant_from_list");
  });

  it("deletes a capability and accepts 204 No Content", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(deleteMCPCapability("cap_missing")).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/mcp/capabilities/remove",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ capability_id: "cap_missing" }) })
    );
  });

  it("deletes grants and accepts 204 No Content", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(deleteMCPGrant("grant/one")).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/mcp/grants/remove",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ grant_id: "grant/one" }) })
    );
  });

  it("lists audits preserving request and response payloads", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            ID: "audit_001",
            TraceID: "trace_001",
            RequestID: "req_001",
            InboundSessionID: "sess_in",
            UpstreamSessionID: "sess_up",
            AgentID: "agent",
            ActorID: "actor",
            TenantID: "demo",
            TokenID: "token",
            TokenHash: "sha256:masked",
            EndpointType: "upstream",
            EndpointUpstreamServerID: "crm-main",
            UpstreamServerID: "crm-main",
            CapabilityID: "cap",
            CapabilityType: "tool",
            ExposedName: "crm.customer.search",
            UpstreamName: "customer.search",
            RequestHeaders: { Authorization: "Bearer ***" },
            RequestBody: { keyword: "Acme" },
            ResponseHeaders: { "Content-Type": "application/json" },
            ResponseBody: { results: [] },
            Decision: "allowed",
            DecisionReason: "allowed",
            Error: "",
            DurationMS: 120,
            CreatedAt: "2026-05-27T00:00:00Z",
            CompletedAt: "2026-05-27T00:00:01Z"
          }
        ]
      })
    );

    const result = await listMCPAudits({
      limit: 25,
      decision: "allowed",
      agentId: "agent",
      upstreamServerId: "crm-main",
      tool: "crm.customer.search",
      createdFrom: "2026-05-27T00:00:00Z",
      createdTo: "2026-05-27T01:00:00Z",
      errorOnly: true
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/mcp/audits?limit=25&decision=allowed&agent_id=agent&upstream_server_id=crm-main&tool=crm.customer.search&created_from=2026-05-27T00%3A00%3A00Z&created_to=2026-05-27T01%3A00%3A00Z&error_only=true",
      expect.objectContaining({ method: "GET" })
    );
    expect(result[0].requestBody).toEqual({ keyword: "Acme" });
    expect(result[0].responseBody).toEqual({ results: [] });
    expect(result[0].durationMs).toBe(120);
    expect(result[0].endpointType).toBe("upstream");
    expect(result[0].endpointUpstreamServerId).toBe("crm-main");
  });

  it("lists gates with filters and adapts PascalCase fields", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            ID: "mcp_confirm_1",
            Type: "user_confirmation",
            Provider: "internal",
            TraceID: "trace_1",
            TenantID: "tenant_1",
            AgentID: "agent_1",
            ActorID: "actor_1",
            CapabilityID: "cap_1",
            UpstreamServerID: "crm-main",
            ExposedName: "crm.customer.update",
            UpstreamName: "customer.update",
            RequestBody: { customer_id: "cust_1" },
            ArgumentsHash: "sha256:args",
            SchemaHash: "sha256:schema",
            GateSummary: {
              system: "crm",
              action: "Update customer",
              object: "cust_1",
              tool: "crm.customer.update",
              risk_level: "high",
              destructive: true,
              read_only: false,
              parameters: [
                {
                  path: "customer_id",
                  label: "Customer ID",
                  value: "cust_1",
                  sensitive: false
                }
              ],
              risks: ["May update customer data"]
            },
            Status: "pending",
            ConfirmURL: "/admin/mcp/gates/mcp_confirm_1",
            DecidedBy: "",
            DecisionReason: "",
            DecidedAt: null,
            ExpiresAt: "2026-05-29T10:30:00Z",
            ExecutionAuditID: "",
            ResponseBody: null,
            Error: "",
            CreatedAt: "2026-05-29T10:00:00Z",
            UpdatedAt: "2026-05-29T10:00:00Z"
          }
        ]
      })
    );

    const result = await listMCPGates({
      limit: 50,
      status: "pending",
      agentId: "agent_1",
      actorId: "actor_1",
      tenantId: "tenant_1",
      capabilityId: "cap_1",
      gateType: "user_confirmation",
      createdFrom: "2026-05-29T00:00:00Z",
      createdTo: "2026-05-29T23:59:59Z"
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/mcp/gates?limit=50&status=pending&agent_id=agent_1&actor_id=actor_1&tenant_id=tenant_1&capability_id=cap_1&gate_type=user_confirmation&created_from=2026-05-29T00%3A00%3A00Z&created_to=2026-05-29T23%3A59%3A59Z",
      expect.objectContaining({ method: "GET" })
    );
    expect(result).toEqual([
      {
        id: "mcp_confirm_1",
        type: "user_confirmation",
        provider: "internal",
        traceId: "trace_1",
        tenantId: "tenant_1",
        agentId: "agent_1",
        actorId: "actor_1",
        capabilityId: "cap_1",
        upstreamServerId: "crm-main",
        exposedName: "crm.customer.update",
        upstreamName: "customer.update",
        requestBody: { customer_id: "cust_1" },
        argumentsHash: "sha256:args",
        schemaHash: "sha256:schema",
        gateSummary: {
          system: "crm",
          action: "Update customer",
          object: "cust_1",
          tool: "crm.customer.update",
          riskLevel: "high",
          destructive: true,
          readOnly: false,
          parameters: [
            {
              path: "customer_id",
              label: "Customer ID",
              value: "cust_1",
              sensitive: false
            }
          ],
          risks: ["May update customer data"]
        },
        status: "pending",
        confirmUrl: "/admin/mcp/gates/mcp_confirm_1",
        decidedBy: "",
        decisionReason: "",
        decidedAt: null,
        expiresAt: "2026-05-29T10:30:00Z",
        executionAuditId: "",
        responseBody: null,
        error: "",
        createdAt: "2026-05-29T10:00:00Z",
        updatedAt: "2026-05-29T10:00:00Z",
        externalInstanceId: "",
        externalUrl: ""
      }
    ]);
  });

  it("decides gates with snake_case request bodies", async () => {
    vi.stubGlobal("fetch", mockFetch);
    const response = {
      ID: "mcp_confirm_1",
      Type: "user_confirmation",
      Provider: "internal",
      TraceID: "trace_1",
      TenantID: "tenant_1",
      AgentID: "agent_1",
      ActorID: "actor_1",
      CapabilityID: "cap_1",
      UpstreamServerID: "crm-main",
      ExposedName: "crm.customer.update",
      UpstreamName: "customer.update",
      RequestBody: {},
      ArgumentsHash: "sha256:args",
      SchemaHash: "sha256:schema",
      GateSummary: {
        system: "crm",
        action: "Update customer",
        object: "cust_1",
        tool: "crm.customer.update",
        risk_level: "high",
        destructive: true,
        read_only: false,
        parameters: [],
        risks: []
      },
      Status: "accepted",
      ConfirmURL: "/admin/mcp/gates/mcp_confirm_1",
      DecidedBy: "actor_1",
      DecisionReason: "",
      DecidedAt: "2026-05-29T10:05:00Z",
      ExpiresAt: "2026-05-29T10:30:00Z",
      ExecutionAuditID: "",
      ResponseBody: {},
      Error: "",
      CreatedAt: "2026-05-29T10:00:00Z",
      UpdatedAt: "2026-05-29T10:05:00Z",
      ExternalInstanceID: "approval_1",
      ExternalURL: "https://approval.example/tasks/approval_1"
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(response)).mockResolvedValueOnce(jsonResponse(response));

    await acceptMCPGate("mcp/confirm/1");
    await rejectMCPGate("mcp/confirm/1", "wrong params");

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/admin/mcp/gates/decide",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ gate_id: "mcp/confirm/1", decision: "approved" })
      })
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/admin/mcp/gates/decide",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ gate_id: "mcp/confirm/1", decision: "rejected", reason: "wrong params" })
      })
    );
  });
});
