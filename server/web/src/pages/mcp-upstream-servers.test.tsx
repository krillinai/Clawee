import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MCPAudit, MCPCapability, MCPGrant, MCPUpstreamServer } from "@/lib/mcp-admin-api";
import {
  createUpstreamServer,
  deleteMCPUpstreamServer,
  listMCPAudits,
  listMCPCapabilities,
  listMCPGrants,
  listMCPUpstreamServers,
  syncMCPUpstreamTools,
  updateMCPUpstreamServer,
  updateMCPUpstreamServerStatus
} from "@/lib/mcp-admin-api";

import { MCPUpstreamServersPage } from "./mcp-upstream-servers";

vi.mock("@/lib/mcp-admin-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp-admin-api")>("@/lib/mcp-admin-api");
  return {
    ...actual,
    createUpstreamServer: vi.fn(),
    deleteMCPUpstreamServer: vi.fn(),
    listMCPAudits: vi.fn(),
    listMCPCapabilities: vi.fn(),
    listMCPGrants: vi.fn(),
    listMCPUpstreamServers: vi.fn(),
    syncMCPUpstreamTools: vi.fn(),
    updateMCPUpstreamServer: vi.fn(),
    updateMCPUpstreamServerStatus: vi.fn()
  };
});

const createUpstreamServerMock = vi.mocked(createUpstreamServer);
const deleteMCPUpstreamServerMock = vi.mocked(deleteMCPUpstreamServer);
const listMCPAuditsMock = vi.mocked(listMCPAudits);
const listMCPCapabilitiesMock = vi.mocked(listMCPCapabilities);
const listMCPGrantsMock = vi.mocked(listMCPGrants);
const listMCPUpstreamServersMock = vi.mocked(listMCPUpstreamServers);
const syncMCPUpstreamToolsMock = vi.mocked(syncMCPUpstreamTools);
const updateMCPUpstreamServerMock = vi.mocked(updateMCPUpstreamServer);
const updateMCPUpstreamServerStatusMock = vi.mocked(updateMCPUpstreamServerStatus);

const activeServer = upstreamServer({ id: "crm-main", status: "active" });
const disabledServer = upstreamServer({
  id: "erp-main",
  name: "ERP Main",
  status: "disabled",
  domain: "erp",
  namespace: "erp",
  transport: "sse"
});
const capabilities: MCPCapability[] = [];
const grants: MCPGrant[] = [];
const audits: MCPAudit[] = [];

async function selectFilterOption(name: string | RegExp, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name }));
  fireEvent.click(await within(screen.getByRole("listbox")).findByRole("option", { name: option }));
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
}

describe("MCPUpstreamServersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMCPUpstreamServersMock.mockResolvedValue([activeServer, disabledServer]);
    listMCPCapabilitiesMock.mockResolvedValue(capabilities);
    listMCPGrantsMock.mockResolvedValue(grants);
    listMCPAuditsMock.mockResolvedValue(audits);
    createUpstreamServerMock.mockResolvedValue(upstreamServer({
      id: "new-main",
      name: "New Main"
    }));
    syncMCPUpstreamToolsMock.mockResolvedValue({ status: "ok" });
    updateMCPUpstreamServerMock.mockResolvedValue({ ...activeServer, name: "CRM Updated", ownerTeam: "platform" });
    updateMCPUpstreamServerStatusMock.mockResolvedValue({
      id: "crm-main",
      status: "disabled",
      updatedAt: "2026-06-10T00:00:00Z"
    });
    deleteMCPUpstreamServerMock.mockResolvedValue(undefined);
  });

  it("opens server details only from the detail button", async () => {
    renderPage();

    const row = await findRowByText("crm-main");
    fireEvent.click(within(row).getByText("crm-main"));
    expect(screen.queryByRole("heading", { name: "CRM Main" })).not.toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "查看 crm-main 详情" }));
    expect(await screen.findByRole("heading", { name: "CRM Main" })).toBeInTheDocument();
    expect(screen.getByText("https://gateway.example.com/mcp/servers/crm-main")).toBeInTheDocument();
  });

  it("opens edit modal with current server values and saves mutable fields without changing server_id", async () => {
    renderPage();

    const row = await findRowByText("crm-main");
    fireEvent.click(within(row).getByRole("button", { name: "编辑 crm-main" }));

    expect(await screen.findByRole("heading", { name: "编辑上游服务" })).toBeInTheDocument();
    const serverID = screen.getByLabelText("server_id");
    expect(serverID).toHaveValue("crm-main");
    expect(serverID).toBeDisabled();

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "CRM Updated" } });
    fireEvent.change(screen.getByLabelText("owner_team"), { target: { value: "platform" } });
    fireEvent.change(screen.getByLabelText("负责内容"), { target: { value: "负责研发任务" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(updateMCPUpstreamServerMock).toHaveBeenCalledWith(
        "crm-main",
        expect.objectContaining({
          serverId: "crm-main",
          name: "CRM Updated",
          ownerTeam: "platform",
          routingDescription: "负责研发任务"
        })
      );
    });
  });

  it("allows setting a token for a streamable_http upstream server", async () => {
    listMCPUpstreamServersMock.mockResolvedValue([upstreamServer({
      id: "secure-http",
      name: "Secure HTTP",
      hasToken: false
    })]);
    renderPage();

    const row = await findRowByText("secure-http");
    fireEvent.click(within(row).getByRole("button", { name: "编辑 secure-http" }));
    fireEvent.change(await screen.findByLabelText("token"), { target: { value: "configured-token" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(updateMCPUpstreamServerMock).toHaveBeenCalledWith(
        "secure-http",
        expect.objectContaining({ token: "configured-token" })
      );
    });
  });

  it("registers collector_pull with a collector id and without endpoint or token", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "新增上游服务" }));
    fireEvent.change(screen.getByLabelText("server_id"), { target: { value: "codexb-dev" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "研发 Codex B" } });
    fireEvent.change(screen.getByRole("combobox", { name: "transport" }), { target: { value: "collector_pull" } });
    fireEvent.change(screen.getByLabelText("collector_id"), { target: { value: "collector-dev" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(createUpstreamServerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: "codexb-dev",
          transport: "collector_pull",
          collectorId: "collector-dev",
          endpoint: "",
          token: ""
        }),
        expect.anything()
      );
    });
    expect(screen.queryByLabelText("token")).not.toBeInTheDocument();
  });

  it("keeps builtin upstream servers visible but hides mutable server actions", async () => {
    listMCPUpstreamServersMock.mockResolvedValue([upstreamServer({
      id: "knowledge-adapter",
      name: "企业知识库",
      transport: "builtin",
      endpoint: ""
    })]);
    renderPage();

    const row = await findRowByText("knowledge-adapter");
    expect(within(row).queryByRole("button", { name: "编辑 knowledge-adapter" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "删除 knowledge-adapter" })).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "查看 knowledge-adapter 详情" }));
    expect(await screen.findByRole("button", { name: "同步工具" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "禁用" })).not.toBeInTheDocument();
  });

  it("requires disabling an active server before delete and then allows deleting disabled servers", async () => {
    renderPage();

    const activeRow = await findRowByText("crm-main");
    fireEvent.click(within(activeRow).getByRole("button", { name: "删除 crm-main" }));

    expect(await screen.findByText("删除前需要先禁用该上游服务。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "先禁用" }));

    await waitFor(() => {
      expect(updateMCPUpstreamServerStatusMock).toHaveBeenCalledWith("crm-main", "disabled");
    });

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const disabledRow = await findRowByText("erp-main");
    fireEvent.click(within(disabledRow).getByRole("button", { name: "删除 erp-main" }));

    expect(await screen.findByText("删除后该上游服务默认不再出现在列表中，历史能力、授权和审计记录仍保留。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(deleteMCPUpstreamServerMock).toHaveBeenCalledWith("erp-main");
    });
  });

  it("filters upstream servers by transport", async () => {
    renderPage();

    expect(await screen.findByText("crm-main")).toBeInTheDocument();
    expect(screen.getByText("erp-main")).toBeInTheDocument();

    await selectFilterOption("筛选上游服务传输方式", "sse");

    await waitFor(() => {
      expect(screen.queryByText("crm-main")).not.toBeInTheDocument();
    });
    expect(screen.getByText("erp-main")).toBeInTheDocument();
  });

  it("creates an upstream server without an environment field", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "新增上游服务" }));

    expect(await screen.findByRole("heading", { name: "新增上游服务" })).toBeInTheDocument();
    expect(screen.queryByLabelText("environment")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("server_id"), { target: { value: "new-main" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "New Main" } });
    fireEvent.change(screen.getByLabelText("负责内容"), { target: { value: "负责财务分析" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(createUpstreamServerMock).toHaveBeenCalled();
    });
    const input = createUpstreamServerMock.mock.calls[0]?.[0];
    expect(input).toEqual(expect.objectContaining({
      serverId: "new-main",
      name: "New Main",
      routingDescription: "负责财务分析"
    }));
    expect(input).not.toHaveProperty("environment");
  });

  it("restores the selected server from the detail route query", async () => {
    renderPage("/admin/mcp/upstream-servers/detail?server_id=crm-main");

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "CRM Main" })).toBeInTheDocument();
    expect(within(drawer).getByText("crm-main")).toBeInTheDocument();
    expect(within(drawer).getByText("负责代码分析和故障定位")).toBeInTheDocument();
  });
});

function renderPage(initialEntry = "/admin/mcp/upstream-servers") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <MCPUpstreamServersPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function findRowByText(text: string) {
  const cell = await screen.findByText(text);
  const row = cell.closest("tr");
  if (!row) throw new Error(`row not found for ${text}`);
  return row;
}

function upstreamServer(overrides: Partial<MCPUpstreamServer>): MCPUpstreamServer {
  return {
    id: "crm-main",
    name: "CRM Main",
    domain: "crm",
    transport: "streamable_http",
    endpoint: "https://crm.example/mcp",
    authType: "",
    credentialRef: "",
    hasToken: false,
    ownerTeam: "sales-platform",
    namespace: "crm",
    routingDescription: "负责代码分析和故障定位",
    collectorId: "",
    status: "active",
    capabilitiesCount: 0,
    lastSyncedAt: "2026-06-10T00:00:00Z",
    lastSyncResult: "ok",
    mcpEndpoint: "https://gateway.example.com/mcp/servers/crm-main",
    mcpCanonicalEndpoint: "https://gateway.example.com/mcp/servers/crm-main",
    createdAt: "2026-06-09T00:00:00Z",
    updatedAt: "2026-06-10T00:00:00Z",
    ...overrides
  };
}
