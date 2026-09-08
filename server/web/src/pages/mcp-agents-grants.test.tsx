import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import { APIError } from "@/lib/api";
import type { Account } from "@/lib/auth-api";
import type { MCPAccountTokenResponse, MCPAgent, MCPCapability, MCPGrant, MCPUpstreamServer } from "@/lib/mcp-admin-api";
import type { AgentListItem } from "@/lib/office-api";
import { listAccounts } from "@/lib/accounts-api";
import {
  createMCPAgent,
  createMCPGrant,
  getMCPAccountToken,
  deleteMCPAgent,
  deleteMCPGrant,
  listMCPAgents,
  listMCPCapabilities,
  listMCPGrants,
  listMCPUpstreamServers,
  revealMCPAccountToken,
  revokeMCPAccountToken,
  rotateMCPAccountToken,
  transferMCPAgent
} from "@/lib/mcp-admin-api";
import { bindOfficeAgentToMCP, deleteOfficeAgent, getAgentActivityList, unbindOfficeAgentFromMCP } from "@/lib/office-api";
import { permissions } from "@/lib/rbac-api";

import { MCPAgentsGrantsPage } from "./mcp-agents-grants";

vi.mock("@/lib/mcp-admin-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp-admin-api")>("@/lib/mcp-admin-api");
  return {
    ...actual,
    createMCPAgent: vi.fn(),
    createMCPGrant: vi.fn(),
    getMCPAccountToken: vi.fn(),
    deleteMCPAgent: vi.fn(),
    deleteMCPGrant: vi.fn(),
    listMCPAgents: vi.fn(),
    listMCPCapabilities: vi.fn(),
    listMCPGrants: vi.fn(),
    listMCPUpstreamServers: vi.fn(),
    revealMCPAccountToken: vi.fn(),
    revokeMCPAccountToken: vi.fn(),
    rotateMCPAccountToken: vi.fn(),
    transferMCPAgent: vi.fn()
  };
});

vi.mock("@/lib/accounts-api", () => ({ listAccounts: vi.fn() }));
vi.mock("@/lib/office-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/office-api")>("@/lib/office-api");
  return {
    ...actual,
    bindOfficeAgentToMCP: vi.fn(),
    deleteOfficeAgent: vi.fn(),
    getAgentActivityList: vi.fn(),
    unbindOfficeAgentFromMCP: vi.fn()
  };
});

const createMCPAgentMock = vi.mocked(createMCPAgent);
const createMCPGrantMock = vi.mocked(createMCPGrant);
const getMCPAccountTokenMock = vi.mocked(getMCPAccountToken);
const deleteMCPAgentMock = vi.mocked(deleteMCPAgent);
const deleteMCPGrantMock = vi.mocked(deleteMCPGrant);
const listMCPAgentsMock = vi.mocked(listMCPAgents);
const listMCPCapabilitiesMock = vi.mocked(listMCPCapabilities);
const listMCPGrantsMock = vi.mocked(listMCPGrants);
const listMCPUpstreamServersMock = vi.mocked(listMCPUpstreamServers);
const revealMCPAccountTokenMock = vi.mocked(revealMCPAccountToken);
const revokeMCPAccountTokenMock = vi.mocked(revokeMCPAccountToken);
const rotateMCPAccountTokenMock = vi.mocked(rotateMCPAccountToken);
const transferMCPAgentMock = vi.mocked(transferMCPAgent);
const listAccountsMock = vi.mocked(listAccounts);
const bindOfficeAgentToMCPMock = vi.mocked(bindOfficeAgentToMCP);
const deleteOfficeAgentMock = vi.mocked(deleteOfficeAgent);
const getAgentActivityListMock = vi.mocked(getAgentActivityList);
const unbindOfficeAgentFromMCPMock = vi.mocked(unbindOfficeAgentFromMCP);

const plaintextListToken = "claw_plaintext_from_list_must_not_render";
const copiedToken = "claw_copied_token_once";

async function selectFilterOption(name: string | RegExp, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name }));
  fireEvent.click(await within(screen.getByRole("listbox")).findByRole("option", { name: option }));
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
}

const agents: MCPAgent[] = [
  {
    agentId: "agent_sales",
    boundUserId: "usr_1",
    boundUserName: "销售张三",
    boundUserEmail: "user@example.com",
    clientId: "client_sales",
    name: "Sales Assistant",
    tenantId: "tenant_a",
    actorId: "sales_zhang",
    status: "active",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T00:00:00Z"
  }
];

const revokedAgents: MCPAgent[] = [
  {
    ...agents[0],
    agentId: "agent_revoked",
    status: "revoked"
  }
];

const servers: MCPUpstreamServer[] = [
  {
    id: "crm-main",
    name: "CRM Main",
    domain: "crm",
    transport: "streamable_http",
    endpoint: "https://crm.example/mcp",
    authType: "bearer",
    credentialRef: "secret/crm-main",
    ownerTeam: "sales-platform",
    namespace: "crm",
    status: "active",
    capabilitiesCount: 2,
    lastSyncedAt: "2026-05-27T08:00:00Z",
    lastSyncResult: "ok",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T08:00:00Z"
  },
  {
    id: "finance-main",
    name: "Finance Main",
    domain: "finance",
    transport: "streamable_http",
    endpoint: "https://finance.example/mcp",
    authType: "bearer",
    credentialRef: "secret/finance-main",
    ownerTeam: "finance-platform",
    namespace: "finance",
    status: "active",
    capabilitiesCount: 1,
    lastSyncedAt: "2026-05-27T08:00:00Z",
    lastSyncResult: "ok",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T08:00:00Z"
  }
];

const capabilities: MCPCapability[] = [
  capability({ id: "cap_active", exposedName: "crm.customer.search", status: "active", confirmRequired: true }),
  capability({ id: "cap_report", exposedName: "finance.report.export", status: "active", upstreamServerId: "finance-main", approvalRequired: true }),
  capability({ id: "cap_crm_note", exposedName: "crm.note.create", upstreamName: "note.create", status: "active" }),
  capability({ id: "cap_disabled", exposedName: "crm.customer.delete", status: "disabled" })
];

const grants: MCPGrant[] = [
  {
    id: "grant_from_api_001",
    userId: "usr_1",
    capabilityId: "cap_active",
    grantType: "tool",
    dataScope: { region: "cn" },
    expiresAt: null,
    createdBy: "admin",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T09:00:00Z"
  },
  {
    id: "grant_from_api_002",
    userId: "usr_1",
    capabilityId: "cap_report",
    grantType: "tool",
    dataScope: {},
    expiresAt: null,
    createdBy: "admin",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T09:00:00Z"
  }
];

describe("MCPAgentsGrantsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn()
      }
    });
    listMCPAgentsMock.mockResolvedValue(agents);
    listMCPCapabilitiesMock.mockResolvedValue(capabilities);
    listMCPUpstreamServersMock.mockResolvedValue(servers);
    listMCPGrantsMock.mockImplementation((filters = {}) =>
      Promise.resolve(filters.userId ? grants.filter((grant) => grant.userId === filters.userId) : grants)
    );
    listAccountsMock.mockResolvedValue([
      { userId: "usr_1", email: "owner@example.com", name: "责任人", status: "active", agent: null },
      { userId: "usr_2", email: "target@example.com", name: "目标责任人", status: "active", agent: null }
    ]);
    getAgentActivityListMock.mockResolvedValue(officeActivity([]));
    bindOfficeAgentToMCPMock.mockResolvedValue({ status: "bound" });
    deleteOfficeAgentMock.mockResolvedValue(undefined);
    unbindOfficeAgentFromMCPMock.mockResolvedValue(undefined);
    createMCPAgentMock.mockResolvedValue({ ...agents[0], agentId: "agent_created" });
    getMCPAccountTokenMock.mockResolvedValue(tokenResponse(copiedToken).tokenInfo);
    revealMCPAccountTokenMock.mockResolvedValue(tokenResponse(copiedToken));
    rotateMCPAccountTokenMock.mockResolvedValue(tokenResponse("claw_rotated_token_once"));
    revokeMCPAccountTokenMock.mockResolvedValue({
      userId: "usr_1",
      revokedTokenCount: 1,
      tokenStatus: "revoked"
    });
    createMCPGrantMock.mockResolvedValue(grants[0]);
    deleteMCPAgentMock.mockResolvedValue(undefined);
    deleteMCPGrantMock.mockResolvedValue(undefined);
    transferMCPAgentMock.mockResolvedValue({
      action: "agent_transfer", agent_ids: ["agent_sales"], source_user_id: "usr_1", target_user_id: "usr_2",
      tokens_preserved: true, grants_preserved: true, token_count: 1, grant_count: 2, completed_at: "2026-08-18T03:00:00Z"
    });
  });

  it("restores the selected agent from the detail route query", async () => {
    renderPage(undefined, "/admin/mcp/agents/detail?agent_id=agent_sales");

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "账户级 Token 与 MCP 配置" })).toBeInTheDocument();
    expect(within(drawer).getAllByText("agent_sales")).not.toHaveLength(0);
  });

  it("never renders plaintext or masked tokens from list responses", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "智能体管理" })).toBeInTheDocument();
    expect(screen.queryByText("agent_sales_gKvG********EQoqo")).not.toBeInTheDocument();
    expect(screen.queryByText(plaintextListToken)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(plaintextListToken);
  });

  it("迁移 Agent 时不迁移账户 Token 和账户授权", async () => {
    renderPage();

    const row = await findRowByText("agent_sales");
    fireEvent.click(within(row).getByRole("button", { name: "迁移" }));
    const dialog = await screen.findByRole("dialog", { name: "迁移 Agent" });
    expect(within(dialog).getByText(/账户 Token 和账户授权不迁移/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("迁移原因"), { target: { value: "重复账号" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认迁移" }));

    await waitFor(() => expect(transferMCPAgentMock).toHaveBeenCalledWith({
      agentId: "agent_sales",
      sourceUserId: "usr_1",
      targetUserId: "usr_2",
      reason: "重复账号"
    }));
    expect(rotateMCPAccountTokenMock).not.toHaveBeenCalled();
    expect(revokeMCPAccountTokenMock).not.toHaveBeenCalled();
  });

  it("supports a grant-only account without requesting unrelated modules", async () => {
    const account: Account = {
      userId: "usr_grant_reader",
      email: "grant-reader@example.com",
      name: "授权审计员",
      status: "active",
      applications: { frontend: true, admin: true },
      adminRoles: ["grant_reader"],
      adminPermissions: [permissions.mcpGrantRead]
    };
    renderPage(account);

    const row = await findRowByText("agent_sales");
    expect(within(row).getByRole("button", { name: "查看授权" })).toBeInTheDocument();
    expect(listMCPAgentsMock).toHaveBeenCalled();
    expect(listMCPGrantsMock).toHaveBeenCalled();
    expect(listMCPCapabilitiesMock).not.toHaveBeenCalled();
    expect(listMCPUpstreamServersMock).not.toHaveBeenCalled();
    expect(getAgentActivityListMock).not.toHaveBeenCalled();
  });

  it("shows Office-only, MCP-only and explicitly linked Agents in one list", async () => {
    listMCPAgentsMock.mockResolvedValue([
      {
        ...agents[0],
        agentId: "mcp_linked",
        name: "已关联治理身份",
        creationSource: "collector",
        collector: {
          collectorId: "collector_1",
          officeAgentId: "office_linked",
          deviceId: "device_1",
          deviceName: "MacBook",
          hostname: "mac.local",
          os: "darwin",
          arch: "arm64",
          collectorVersion: "0.1.1",
          lastSeenAt: "2026-08-05T09:01:00Z",
          status: "online" as const
        }
      },
      { ...agents[0], agentId: "mcp_only", name: "仅 MCP 智能体" }
    ]);
    getAgentActivityListMock.mockResolvedValue(officeActivity([
      officeAgent("office_linked", "mcp_linked", "已关联运行实例"),
      officeAgent("office_only", undefined, "仅采集智能体")
    ]));

    renderPage();

    expect(await screen.findByText("仅采集智能体")).toBeInTheDocument();
    expect(screen.getByText("仅 MCP 智能体")).toBeInTheDocument();
		expect(screen.getByText("已关联治理身份")).toBeInTheDocument();
    expect(screen.getAllByText("mcp_linked")).toHaveLength(1);
    expect(screen.getByText("未绑定 MCP 身份")).toBeInTheDocument();
    expect(screen.getByText("未接入采集")).toBeInTheDocument();
		const linkedRow = await findRowByText("已关联治理身份");
    expect(within(linkedRow).getByText("在线空闲")).toHaveClass("w-fit");
    expect(within(linkedRow).getByText("正常")).toHaveClass("w-fit");
    expect(within(linkedRow).getByText("运行实例 ID")).toBeInTheDocument();
    expect(within(linkedRow).getByText("MCP Agent ID")).toBeInTheDocument();
    expect(within(linkedRow).getByText("采集器创建")).toBeInTheDocument();
    expect(within(linkedRow).getByText("collector_1")).toBeInTheDocument();
    expect(within(linkedRow).getByText("在线")).toBeInTheDocument();
    expect(within(linkedRow).getByText("最后上报 2026/08/05 17:01:00")).toBeInTheDocument();
    const agentTable = screen.getByRole("columnheader", { name: "名称" }).closest("table");
    expect(agentTable).toHaveClass("table-fixed");
    expect(Array.from(agentTable?.querySelectorAll("col") ?? [], (column) => column.style.width)).toEqual([
      "16%", "11%", "11%", "11%", "16%", "5%", "14%", "16%"
    ]);
  });

  it("binds an Office-only Agent to an existing unbound MCP identity", async () => {
    listMCPAgentsMock.mockResolvedValue([{ ...agents[0], agentId: "mcp_available", name: "可用治理身份" }]);
    getAgentActivityListMock.mockResolvedValue(officeActivity([
      officeAgent("office_only", undefined, "待接入智能体")
    ]));

    renderPage();

    const row = await findRowByText("待接入智能体");
    fireEvent.click(within(row).getByRole("button", { name: "接入 MCP" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "选择 MCP 治理身份" }), {
      target: { value: "mcp_available" }
    });
    fireEvent.click(screen.getByRole("button", { name: "确认绑定" }));

    await waitFor(() => {
      expect(bindOfficeAgentToMCPMock).toHaveBeenCalledWith("collector_1", "office_only", "mcp_available");
    });
  });

  it("explains an Agent owner mismatch in Chinese with both binding targets", async () => {
    listMCPAgentsMock.mockResolvedValue([{ ...agents[0], agentId: "mcp_available", name: "销售治理身份" }]);
    getAgentActivityListMock.mockResolvedValue(officeActivity([
      officeAgent("office_only", undefined, "待接入智能体")
    ]));
    bindOfficeAgentToMCPMock.mockRejectedValueOnce(new APIError(
      "office agent and mcp agent owners do not match",
      409,
      "agent_owner_mismatch"
    ));

    renderPage();

    const row = await findRowByText("待接入智能体");
    fireEvent.click(within(row).getByRole("button", { name: "接入 MCP" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认绑定" }));

    const reason = await screen.findByText(/不属于同一责任账号/);
    expect(reason).toHaveTextContent("待接入智能体");
    expect(reason).toHaveTextContent("Agent ID：office_only");
    expect(reason).toHaveTextContent("Collector ID：collector_1");
    expect(reason).toHaveTextContent("销售治理身份");
    expect(reason).toHaveTextContent("责任账号：销售张三 / user@example.com");
    expect(reason).toHaveTextContent("请检查该采集器的注册账号");
    expect(screen.queryByText("office agent and mcp agent owners do not match")).not.toBeInTheDocument();
  });

  it("deletes an Office-only Agent after destructive confirmation", async () => {
    listMCPAgentsMock.mockResolvedValue([]);
    getAgentActivityListMock.mockResolvedValue(officeActivity([
      officeAgent("office_only", undefined, "待清理智能体")
    ]));

    renderPage();

    const row = await findRowByText("待清理智能体");
    fireEvent.click(within(row).getByRole("button", { name: "清理运行实例 待清理智能体" }));
    expect(deleteOfficeAgentMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/若采集器后续再次上报，该实例会重新出现/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "清理运行实例" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认清理运行实例" }));

    await waitFor(() => {
      expect(deleteOfficeAgentMock).toHaveBeenCalledWith("collector_1", "office_only");
    });
    expect(await screen.findByText("运行实例“待清理智能体”的当前采集数据已清理；采集器再次上报后可能重新出现。")).toBeInTheDocument();
  });

  it("shows an error when unlinking an Agent fails", async () => {
    listMCPAgentsMock.mockResolvedValue([{ ...agents[0], agentId: "mcp_linked", name: "已关联治理身份" }]);
    getAgentActivityListMock.mockResolvedValue(officeActivity([
      officeAgent("office_linked", "mcp_linked", "已关联运行实例")
    ]));
    unbindOfficeAgentFromMCPMock.mockRejectedValue(new Error("请求失败"));

    renderPage();

		const row = await findRowByText("已关联治理身份");
    fireEvent.click(within(row).getByRole("button", { name: "解除关联" }));

    await waitFor(() => {
      expect(unbindOfficeAgentFromMCPMock).toHaveBeenCalledWith("collector_1", "office_linked");
    });
    expect(await screen.findByText("解除关联失败：请求失败")).toBeInTheDocument();
  });

  it("organizes the admin Agent list without token metadata columns", async () => {
    renderPage();

    const row = await findRowByText("agent_sales");
    expect(within(row).getByText("销售张三")).toBeInTheDocument();
    expect(within(row).getByText("user@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "掩码令牌" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "令牌状态" })).not.toBeInTheDocument();
    expect(within(row).queryByText("agent_sales_gKvG********EQoqo")).not.toBeInTheDocument();
    expect(within(row).queryByText(/指纹/)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "筛选令牌状态" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Token" })).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "查看授权" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "添加授权" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Selected Agent Grants" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新增用户" })).not.toBeInTheDocument();
  });

  it("opens token operations only from the detail button and reveals the token explicitly", async () => {
    revealMCPAccountTokenMock.mockResolvedValue(tokenResponse("agent_sales_plaintext_copy"));
    renderPage();

    const row = await findRowByText("agent_sales");
    fireEvent.click(within(row).getByText("agent_sales"));
    expect(screen.queryByRole("heading", { name: "账户级 Token 与 MCP 配置" })).not.toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "查看 Sales Assistant 令牌详情" }));
    expect(await screen.findByRole("heading", { name: "账户级 Token 与 MCP 配置" })).toBeInTheDocument();
    expect(screen.queryByText("masked_token")).not.toBeInTheDocument();
    expect(screen.getByText("token_status")).toBeInTheDocument();
    expect(revealMCPAccountTokenMock).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "显示令牌" }));

    await waitFor(() => {
      expect(revealMCPAccountTokenMock).toHaveBeenCalledWith("usr_1");
    });
    expect(await screen.findByText("agent_sales_plaintext_copy")).toBeInTheDocument();
    expect(await screen.findByText("Authorization: Bearer agent_sales_plaintext_copy")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Token" })).getByRole("button", { name: "复制" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "授权请求头" })).getByRole("button", { name: "复制" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "MCP 配置" })).getByRole("button", { name: "复制" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制原始 Token" })).not.toBeInTheDocument();
  });

  it("opens grants in a drawer and keeps grant mutation controls inside that drawer", async () => {
    renderPage();

    const row = await findRowByText("agent_sales");
    fireEvent.click(within(row).getByRole("button", { name: "查看授权" }));

    expect(await screen.findByRole("heading", { name: "授权信息" })).toBeInTheDocument();
    expect(await screen.findByText("crm.customer.search")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("grant_from_api_001");
    expect(document.body).not.toHaveTextContent("expires -");
    expect(screen.getByRole("button", { name: "添加授权" })).toHaveClass("h-7", "px-2", "text-xs");
    expect(screen.getAllByRole("button", { name: "删除授权" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "删除授权" })[0]).toHaveClass("h-7", "px-2", "text-xs");
  });

  it("filters grants by keyword, server, and domain while showing compact governance tags", async () => {
    renderPage();

    await selectAgent("agent_sales");
    expect(await screen.findByText("crm.customer.search")).toBeInTheDocument();
    expect(await screen.findByText("finance.report.export")).toBeInTheDocument();
    expect(screen.getByTestId("grant-card-cap_active").firstElementChild?.textContent).toMatch(/^crm\.customer\.search/);
    expect(screen.getByText("需确认")).toBeInTheDocument();
    expect(screen.getByText("需审批")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("{}");
    expect(document.body).not.toHaveTextContent("tooltool");

    const keywordSearch = screen.getByLabelText("搜索授权");
    const filterRow = keywordSearch.closest("div");
    expect(filterRow?.querySelector("label")).toBe(keywordSearch.closest("label"));

    fireEvent.change(keywordSearch, { target: { value: "finance" } });
    expect(screen.queryByText("crm.customer.search")).not.toBeInTheDocument();
    expect(screen.getByText("finance.report.export")).toBeInTheDocument();

    fireEvent.change(keywordSearch, { target: { value: "" } });
    await selectFilterOption("筛选授权上游服务", "CRM Main");
    expect(screen.getByText("crm.customer.search")).toBeInTheDocument();
    expect(screen.queryByText("finance.report.export")).not.toBeInTheDocument();

    await selectFilterOption("筛选授权上游服务", "全部上游服务");
    await selectFilterOption("筛选授权领域", "finance");
    expect(screen.queryByText("crm.customer.search")).not.toBeInTheDocument();
    expect(screen.getByText("finance.report.export")).toBeInTheDocument();
  });

  it("creating an Agent does not create or reveal an account token", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "创建智能体" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "责任账号" }), { target: { value: "usr_1" } });
    fireEvent.change(screen.getByLabelText("agent_id"), { target: { value: "agent_created" } });
    fireEvent.change(screen.getByLabelText("client_id"), { target: { value: "client_created" } });
    fireEvent.click(screen.getByRole("button", { name: "提交创建" }));

    await waitFor(() => expect(createMCPAgentMock).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "账户级 Token 与 MCP 配置" })).not.toBeInTheDocument();
    expect(rotateMCPAccountTokenMock).not.toHaveBeenCalled();
    expect(revealMCPAccountTokenMock).not.toHaveBeenCalled();
  });

  it("copies an active Agent token through the copy token API", async () => {
    renderPage();

    await openTokenDrawer("agent_sales");
    fireEvent.click(screen.getByRole("button", { name: "显示令牌" }));
    const tokenPane = await screen.findByRole("region", { name: "Token" });
    fireEvent.click(within(tokenPane).getByRole("button", { name: "复制" }));

    expect(await screen.findByText(`Authorization: Bearer ${copiedToken}`)).toBeInTheDocument();
    expect(revealMCPAccountTokenMock).toHaveBeenCalledWith("usr_1");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(copiedToken);
    expect(await within(tokenPane).findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("guides admins to rotate when the current token cannot be copied", async () => {
    revealMCPAccountTokenMock.mockRejectedValueOnce(new Error("account token not found"));
    renderPage();

    await openTokenDrawer("agent_sales");
    fireEvent.click(screen.getByRole("button", { name: "显示令牌" }));

    expect(await screen.findByText("当前账户尚未生成访问令牌。请点击“生成访问令牌”。")).toBeInTheDocument();
    expect(screen.queryByText("account token not found")).not.toBeInTheDocument();
  });

  it("copies Authorization header and MCP config through their drawer actions", async () => {
    renderPage();

    await openTokenDrawer("agent_sales");
    fireEvent.click(screen.getByRole("button", { name: "显示令牌" }));
    const headerPane = await screen.findByRole("region", { name: "授权请求头" });
    fireEvent.click(within(headerPane).getByRole("button", { name: "复制" }));
    expect(await screen.findByText(`Authorization: Bearer ${copiedToken}`)).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`Authorization: Bearer ${copiedToken}`);
    expect(await within(headerPane).findByRole("button", { name: "已复制" })).toBeInTheDocument();

    const configPane = await screen.findByRole("region", { name: "MCP 配置" });
    fireEvent.click(within(configPane).getByRole("button", { name: "复制" }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        JSON.stringify({ mcpServers: { "claw-mcp": { url: "http://localhost:3000/mcp", headers: { Authorization: `Bearer ${copiedToken}`, "X-Claw-Agent-ID": "agent_sales" } } } }, null, 2)
      );
    });
    expect(await within(configPane).findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("disables token copy when the token is not active", async () => {
    listMCPAgentsMock.mockResolvedValue(revokedAgents);
    getMCPAccountTokenMock.mockResolvedValueOnce({ ...tokenResponse(copiedToken).tokenInfo, tokenStatus: "revoked" });
    renderPage();

    await openTokenDrawer("agent_revoked");
    expect(revealMCPAccountTokenMock).not.toHaveBeenCalled();
    expect(within(screen.getByRole("region", { name: "Token" })).getByRole("button", { name: "复制" })).toBeDisabled();
  });

  it("does not show a stale create agent error after closing and reopening the create modal", async () => {
    createMCPAgentMock.mockRejectedValueOnce(new Error("create failed once"));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "创建智能体" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "责任账号" }), { target: { value: "usr_1" } });
    fireEvent.change(screen.getByLabelText("agent_id"), { target: { value: "agent_created" } });
    fireEvent.click(screen.getByRole("button", { name: "提交创建" }));

    expect(await screen.findByText("create failed once")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "创建智能体" }));

    expect(screen.queryByText("create failed once")).not.toBeInTheDocument();
  });

  it("does not show stale confirmation errors when opening a different confirm action", async () => {
    rotateMCPAccountTokenMock.mockRejectedValueOnce(new Error("rotate failed once"));
    renderPage();

    await openTokenDrawer("agent_sales");
    fireEvent.click(screen.getByRole("button", { name: "轮换访问令牌" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认轮换访问令牌" }));

    expect(await within(screen.getByRole("dialog", { name: "确认" })).findByText(/rotate failed once/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "吊销访问令牌" }));

    expect(screen.queryByText("rotate failed once")).not.toBeInTheDocument();
  });

  it("only lists ungranted active capabilities in the Add Grant modal by default", async () => {
    renderPage();

    await selectAgent("agent_sales");
    fireEvent.click(screen.getByRole("button", { name: "添加授权" }));

    fireEvent.click(screen.getByRole("combobox", { name: /已选择 1 个能力/ }));
    expect(await screen.findByRole("option", { name: /crm\.note\.create/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /crm\.note\.create/ })).toHaveTextContent("CRM Main");
    expect(screen.getByRole("option", { name: /crm\.note\.create/ })).toHaveTextContent("crm");
    expect(screen.queryByRole("option", { name: /crm\.customer\.search/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /finance\.report\.export/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /crm\.customer\.delete/ })).not.toBeInTheDocument();
  });

  it("scrolls the capability picker list with the mouse wheel inside the Add Grant modal", async () => {
    renderPage();

    await selectAgent("agent_sales");
    fireEvent.click(screen.getByRole("button", { name: "添加授权" }));
    fireEvent.click(await screen.findByRole("combobox", { name: /已选择 1 个能力/ }));

    expect(await screen.findByRole("option", { name: /crm\.note\.create/ })).toBeInTheDocument();
    const list = screen.getByRole("listbox");
    Object.defineProperty(list, "scrollTop", { configurable: true, value: 0, writable: true });
    fireEvent.wheel(list, { deltaY: 120 });

    expect(list.scrollTop).toBe(120);
  });

  it("opens Add Grant from the grants drawer instead of the list action column", async () => {
    renderPage();

    const row = await findRowByText("agent_sales");
    expect(within(row).queryByRole("button", { name: "添加授权" })).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "查看授权" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加授权" }));

    expect(await screen.findByRole("dialog", { name: "添加授权" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /已选择 1 个能力/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("data_scope")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提交授权" }));

    await waitFor(() => {
      expect(createMCPGrantMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "usr_1", capabilityId: "cap_crm_note" }));
    });
  });

  it("leaves Add Grant expires_at unset by default and omits it from the create payload", async () => {
    renderPage();

    await selectAgent("agent_sales");
    fireEvent.click(screen.getByRole("button", { name: "添加授权" }));

    expect(await screen.findByRole("button", { name: "expires_at，未设置过期时间" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提交授权" }));

    await waitFor(() => {
      expect(createMCPGrantMock).toHaveBeenCalled();
    });
    expect(createMCPGrantMock.mock.calls[0][0]).not.toHaveProperty("expiresAt");
    expect(createMCPGrantMock.mock.calls[0][0]).not.toHaveProperty("createdBy");
  });

  it("creates one grant per selected ungranted capability_id from the Add Grant modal", async () => {
    renderPage();

    await selectAgent("agent_sales");
    fireEvent.click(screen.getByRole("button", { name: "添加授权" }));

    fireEvent.click(screen.getByRole("combobox", { name: /已选择 1 个能力/ }));
    expect(await screen.findByRole("option", { name: /crm\.note\.create/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("option", { name: /finance\.report\.export/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提交授权" }));

    await waitFor(() => {
      expect(createMCPGrantMock).toHaveBeenCalledTimes(1);
    });
    expect(createMCPGrantMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userId: "usr_1", capabilityId: "cap_crm_note" })
    );
  });

  it("deletes grants using the returned grant.id", async () => {
    renderPage();

    await selectAgent("agent_sales");
    expect(await screen.findByText("crm.customer.search")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("grant_from_api_001");
    fireEvent.click(screen.getAllByRole("button", { name: "删除授权" })[0]);
    expect(await screen.findByText("删除后同账户所有 Agent 都将失去该工具权限。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除授权" }));

    await waitFor(() => {
      expect(deleteMCPGrantMock).toHaveBeenCalledWith("grant_from_api_001");
    });
  });

  it("deletes an agent only after destructive confirmation", async () => {
    renderPage();

    const row = await findRowByText("agent_sales");
    fireEvent.click(within(row).getByRole("button", { name: "删除 MCP 身份 Sales Assistant" }));
    expect(deleteMCPAgentMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/采集器上报的运行实例不会删除/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "删除 MCP 身份" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认删除 MCP 身份" }));
    await waitFor(() => {
      expect(deleteMCPAgentMock).toHaveBeenCalledWith("agent_sales");
    });
    expect(await screen.findByText("MCP 身份“Sales Assistant”已删除；采集器上报的运行实例不会因此删除。")).toBeInTheDocument();
  });

  it("warns that tools/list and tools/call will be rejected before revoking a token", async () => {
    renderPage();

    await openTokenDrawer("agent_sales");
    fireEvent.click(screen.getByRole("button", { name: "吊销访问令牌" }));

    expect(await screen.findByText("吊销后该账户下所有 Agent 都将无法访问 MCP Gateway。")).toBeInTheDocument();
  });

  it("omits missing upstream domain labels instead of rendering dashes", async () => {
    listMCPUpstreamServersMock.mockResolvedValue([
      {
        ...servers[0],
        domain: ""
      }
    ]);
    listMCPCapabilitiesMock.mockResolvedValue([
      capability({ id: "cap_domainless", exposedName: "crm.domainless.run", status: "active" })
    ]);
    listMCPGrantsMock.mockResolvedValue([]);
    renderPage();

    await selectAgent("agent_sales");
    fireEvent.click(screen.getByRole("button", { name: "添加授权" }));
    fireEvent.click(await screen.findByRole("combobox", { name: /已选择 1 个能力/ }));

    const option = await screen.findByRole("option", { name: /crm\.domainless\.run/ });
    expect(option).toHaveTextContent("CRM Main");
    expect(option).not.toHaveTextContent("-");
  });

  it("disables Add Grant submit when every active capability is already granted", async () => {
    listMCPCapabilitiesMock.mockResolvedValue([
      capability({ id: "cap_active", exposedName: "crm.customer.search", status: "active", confirmRequired: true }),
      capability({ id: "cap_report", exposedName: "finance.report.export", status: "active", upstreamServerId: "finance-main", approvalRequired: true })
    ]);
    renderPage();

    await selectAgent("agent_sales");
    fireEvent.click(screen.getByRole("button", { name: "添加授权" }));

    expect(await screen.findByRole("combobox", { name: /未选择能力/ })).toBeInTheDocument();
    expect(screen.getByText("当前过滤条件下没有可授权能力")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交授权" })).toBeDisabled();
  });

  it("creates knowledge.search as a regular tool grant without data scope", async () => {
    const knowledgeCapability = capability({
      id: "cap_knowledge_search",
      upstreamServerId: "knowledge-adapter",
      upstreamName: "search",
      exposedName: "enterprise.policy.search",
      status: "active"
    });
    listMCPCapabilitiesMock.mockResolvedValue([knowledgeCapability]);
    listMCPGrantsMock.mockResolvedValue([]);
    renderPage();

    await selectAgent("agent_sales");
    fireEvent.click(screen.getByRole("button", { name: "添加授权" }));
    fireEvent.click(await screen.findByRole("combobox", { name: /已选择 1 个能力/ }));
    expect(await screen.findByRole("option", { name: /enterprise\.policy\.search/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "提交授权" }));

    await waitFor(() => expect(createMCPGrantMock).toHaveBeenCalledWith({
      userId: "usr_1",
      capabilityId: "cap_knowledge_search",
      grantType: "tool"
    }));
  });
});

function renderPage(account?: Account, initialEntry = "/admin/mcp/agents") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        {account ? (
          <AdminPermissionsProvider account={account}>
            <MCPAgentsGrantsPage />
          </AdminPermissionsProvider>
        ) : (
          <MCPAgentsGrantsPage />
        )}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function selectAgent(agentId: string) {
  await openGrantsDrawer(agentId);
}

async function openGrantsDrawer(agentId: string) {
  const row = await findRowByText(agentId);
  fireEvent.click(within(row).getByRole("button", { name: "查看授权" }));
  await screen.findByRole("heading", { name: "授权信息" });
}

async function openTokenDrawer(agentId: string) {
  const row = await findRowByText(agentId);
  fireEvent.click(within(row).getByRole("button", { name: "查看 Sales Assistant 令牌详情" }));
  await screen.findByRole("heading", { name: "账户级 Token 与 MCP 配置" });
  await waitFor(() => expect(getMCPAccountTokenMock).toHaveBeenCalledWith("usr_1"));
}

async function findRowByText(text: string) {
  const cells = await screen.findAllByText(text);
  const cell = cells.find((item) => item.closest("tr"));
  if (!cell) throw new Error(`No table cell found for ${text}`);
  const row = cell.closest("tr");
  if (!row) throw new Error(`No table row found for ${text}`);
  return row;
}

function capability(overrides: Partial<MCPCapability>): MCPCapability {
  return {
    id: "cap_default",
    upstreamServerId: "crm-main",
    type: "tool",
    upstreamName: "customer.default",
    exposedName: "crm.customer.default",
    title: "Default Customer",
    description: "Default customer capability",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    annotations: {},
    riskLevel: "low",
    readOnly: true,
    destructive: false,
    idempotent: true,
    approvalRequired: false,
    confirmRequired: false,
    confirmTemplate: "",
    status: "active",
    schemaHash: "hash_default",
    version: "v1",
    lastSyncedAt: "2026-05-27T10:00:00Z",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T10:00:00Z",
    ...overrides
  };
}

function tokenResponse(token: string): MCPAccountTokenResponse {
  return {
    token,
    authorizationHeader: `Authorization: Bearer ${token}`,
    tokenInfo: {
      userId: "usr_1",
      tokenId: "token_created",
      tokenFingerprint: "fp_created",
      tokenStatus: "active",
      tokenExpiresAt: "2026-06-27T00:00:00Z",
      tokenLastUsedAt: null,
      tokenIssuer: "mcp-gateway",
      tokenScopes: ["mcp:call"],
      createdAt: "2026-05-27T10:00:00Z"
    }
  };
}

function officeAgent(agentId: string, mcpAgentId?: string, displayName = agentId): AgentListItem {
  return {
    collector_id: "collector_1",
    agent_id: agentId,
    mcp_agent_id: mcpAgentId,
    display_name: displayName,
    avatar_label: "A",
    agent_type: "codex",
    role_label: "Agent",
    device_id: "device_1",
    workspace_name: "workspace",
    status: "idle",
    sub_agents: { active_count: 0, total_count: 0, preview: [] },
    sessions: [],
    recent_tool_calls: 0,
    last_seen_at: "2026-07-29T10:00:00Z",
    updated_at: "2026-07-29T10:00:00Z"
  };
}

function officeActivity(officeAgents: AgentListItem[]) {
  return {
    schema_version: "office.v1" as const,
    server_time: "2026-07-29T10:00:00Z",
    sse_url: "/api/v1/admin/office/realtime/events",
    filters: { workspaces: [], status_counts: {}, business_systems: [] },
    summary: {
      total_agents: officeAgents.length,
      online_agents: 0,
      active_sub_agents: 0,
      blocked_agents: 0,
      error_agents: 0,
      working_agents: 0,
      active_sessions: 0,
      active_turns: 0,
      recent_tool_call_count: 0
    },
    agents: officeAgents,
    recent_feed: []
  };
}
