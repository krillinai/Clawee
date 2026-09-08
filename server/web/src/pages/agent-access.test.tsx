import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteMyAgent,
  getMyAccountToken,
  listMyAgents,
  listMyMCPCatalog,
  revealMyAccountToken,
  revokeMyAccountToken,
  rotateMyAccountToken,
  updateMyAgentName
} from "@/lib/agent-api";

import { AgentAccessPage } from "./agent-access";

vi.mock("@/lib/agent-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-api")>("@/lib/agent-api");
  return {
    ...actual,
    deleteMyAgent: vi.fn(),
    getMyAccountToken: vi.fn(),
    listMyAgents: vi.fn(),
    listMyMCPCatalog: vi.fn(),
    revealMyAccountToken: vi.fn(),
    revokeMyAccountToken: vi.fn(),
    rotateMyAccountToken: vi.fn(),
    updateMyAgentName: vi.fn()
  };
});

const deleteMyAgentMock = vi.mocked(deleteMyAgent);
const getMyAccountTokenMock = vi.mocked(getMyAccountToken);
const listMyAgentsMock = vi.mocked(listMyAgents);
const listMyMCPCatalogMock = vi.mocked(listMyMCPCatalog);
const revealMyAccountTokenMock = vi.mocked(revealMyAccountToken);
const revokeMyAccountTokenMock = vi.mocked(revokeMyAccountToken);
const rotateMyAccountTokenMock = vi.mocked(rotateMyAccountToken);
const updateMyAgentNameMock = vi.mocked(updateMyAgentName);

const accountToken = {
  userId: "usr_user",
  tokenId: "token_1",
  tokenFingerprint: "fp_1234",
  tokenStatus: "active",
  tokenExpiresAt: null,
  tokenLastUsedAt: null,
  tokenIssuer: "claw-mcp-user",
  tokenScopes: ["mcp:call"],
  createdAt: "2026-08-28T08:00:00Z"
};

describe("AgentAccessPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    listMyAgentsMock.mockResolvedValue([
      access("agent_one", "主 Agent"),
      access("agent_two", "辅助 Agent")
    ]);
    getMyAccountTokenMock.mockResolvedValue(accountToken);
    revealMyAccountTokenMock.mockResolvedValue({
      token: "agt_account_secret",
      authorizationHeader: "Authorization: Bearer agt_account_secret",
      tokenInfo: accountToken
    });
    rotateMyAccountTokenMock.mockResolvedValue({
      token: "agt_account_rotated",
      authorizationHeader: "Authorization: Bearer agt_account_rotated",
      tokenInfo: { ...accountToken, tokenId: "token_2", tokenFingerprint: "fp_5678" }
    });
    revokeMyAccountTokenMock.mockResolvedValue({ userId: "usr_user", revokedTokenCount: 1, tokenStatus: "revoked" });
    listMyMCPCatalogMock.mockResolvedValue({
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
          description: "查询客户",
          riskLevel: "low",
          confirmRequired: false,
          status: "active",
          authorized: true,
          authorizationExpiresAt: null
        }]
      }]
    });
    updateMyAgentNameMock.mockResolvedValue(access("agent_one", "销售助手"));
    deleteMyAgentMock.mockResolvedValue(undefined);
  });

  it("只展示一份账户 Token，并只请求一次账户 Catalog", async () => {
    renderPage();

    expect(await screen.findByText("账户 MCP Token")).toBeInTheDocument();
    expect(await screen.findAllByText("fp_1234")).toHaveLength(1);
    expect(await screen.findByText("agent_one")).toBeInTheDocument();
    expect(await screen.findByText("agent_two")).toBeInTheDocument();
    expect(getMyAccountTokenMock).toHaveBeenCalledTimes(1);
    expect(listMyMCPCatalogMock).toHaveBeenCalledTimes(1);
  });

  it("使用账户 Token 和所选 Agent ID 生成双 Header MCP 配置", async () => {
    renderPage();
    const row = await findRowByText("agent_two");

    fireEvent.click(within(row).getByRole("button", { name: "查看 辅助 Agent 令牌详情" }));

    expect(await screen.findByRole("heading", { name: "账户级 Token 与 MCP 配置" })).toBeInTheDocument();
    await waitFor(() => expect(revealMyAccountTokenMock).toHaveBeenCalledTimes(1));
    const config = await screen.findByRole("region", { name: "MCP 配置" });
    expect(config).toHaveTextContent("Authorization");
    expect(config).toHaveTextContent("Bearer agt_account_secret");
    expect(config).toHaveTextContent("X-Claw-Agent-ID");
    expect(config).toHaveTextContent("agent_two");
  });

  it("删除 Agent 时明确保留账户 Token 和账户授权", async () => {
    renderPage();
    const row = await findRowByText("agent_one");
    fireEvent.click(within(row).getByRole("button", { name: "删除 agent_one" }));

    expect(await screen.findByText(/账户 Token、账户授权和历史审计记录不受影响/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除智能体" }));
    await waitFor(() => expect(deleteMyAgentMock).toHaveBeenCalledWith("agent_one"));
  });

  it("编辑 Agent 名称时保持 Agent ID 只读", async () => {
    renderPage();
    const row = await findRowByText("agent_one");
    fireEvent.click(within(row).getByRole("button", { name: "编辑 agent_one 名称" }));

    expect(await screen.findByLabelText("Agent ID")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Agent 名称"), { target: { value: "销售助手" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateMyAgentNameMock).toHaveBeenCalledWith("agent_one", "销售助手"));
  });
});

function access(agentId: string, name: string) {
  return {
    account: { userId: "usr_user", email: "user@example.com", name: "销售张三" },
    agent: { agentId, clientId: `client_${agentId}`, actorId: "usr_user", status: "active", name }
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/app/agents"]}><AgentAccessPage /></MemoryRouter></QueryClientProvider>);
}

async function findRowByText(text: string) {
  const cell = await screen.findByText(text);
  const row = cell.closest("tr");
  if (!row) throw new Error(`missing row for ${text}`);
  return row;
}
