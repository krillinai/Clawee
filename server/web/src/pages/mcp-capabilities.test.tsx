import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MCPCapability, MCPGrant, MCPUpstreamServer } from "@/lib/mcp-admin-api";
import {
  deleteMCPCapability,
  listMCPCapabilities,
  listMCPGrants,
  listMCPUpstreamServers,
  renameMCPCapability,
  updateMCPCapabilityGates,
  updateMCPCapabilityStatus
} from "@/lib/mcp-admin-api";

import { MCPCapabilitiesPage } from "./mcp-capabilities";

vi.mock("@/lib/mcp-admin-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp-admin-api")>("@/lib/mcp-admin-api");
  return {
    ...actual,
    deleteMCPCapability: vi.fn(),
    listMCPCapabilities: vi.fn(),
    listMCPGrants: vi.fn(),
    listMCPUpstreamServers: vi.fn(),
    renameMCPCapability: vi.fn(),
    updateMCPCapabilityGates: vi.fn(),
    updateMCPCapabilityStatus: vi.fn()
  };
});

const deleteMCPCapabilityMock = vi.mocked(deleteMCPCapability);
const listMCPCapabilitiesMock = vi.mocked(listMCPCapabilities);
const listMCPGrantsMock = vi.mocked(listMCPGrants);
const listMCPUpstreamServersMock = vi.mocked(listMCPUpstreamServers);
const renameMCPCapabilityMock = vi.mocked(renameMCPCapability);
const updateMCPCapabilityGatesMock = vi.mocked(updateMCPCapabilityGates);
const updateMCPCapabilityStatusMock = vi.mocked(updateMCPCapabilityStatus);

function clickTab(tab: HTMLElement) {
  fireEvent.pointerDown(tab);
  fireEvent.mouseDown(tab);
  fireEvent.mouseUp(tab);
  fireEvent.click(tab);
}

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
    routingDescription: "负责客户查询、代码分析和故障定位。",
    status: "active",
    capabilitiesCount: 3,
    lastSyncedAt: "2026-05-27T08:00:00Z",
    lastSyncResult: "ok",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T08:00:00Z"
  }
];

const capabilities: MCPCapability[] = [
  capability({
    id: "cap_pending",
    exposedName: "crm.customer.delete",
    upstreamName: "customer.delete",
    title: "Delete Customer",
    status: "pending",
    riskLevel: "high",
    readOnly: false,
    destructive: true,
    idempotent: false,
    approvalRequired: true,
    confirmRequired: true,
    confirmTemplate: "请确认本次 CRM 写入动作的参数快照。"
  }),
  capability({
    id: "cap_active",
    exposedName: "crm.customer.search",
    upstreamName: "customer.search",
    title: "Search Customer",
    status: "active",
    inputSchema: { type: "object", properties: { keyword: { type: "string" } } },
    outputSchema: { type: "object", properties: { items: { type: "array" } } },
    annotations: { readOnlyHint: true }
  }),
  capability({
    id: "cap_active_without_grants",
    exposedName: "crm.customer.export",
    upstreamName: "customer.export",
    title: "Export Customer",
    status: "active"
  }),
  capability({
    id: "cap_codex_ask",
    exposedName: "crm.codex.ask",
    upstreamName: "codex.ask",
    title: "Ask Codex",
    description: "向本机 Codex 提问并返回最终回答",
    status: "active"
  }),
  capability({
    id: "cap_missing",
    exposedName: "crm.customer.legacy",
    upstreamName: "customer.legacy",
    title: "Legacy Customer",
    status: "missing"
  })
];

const grants: MCPGrant[] = [
  {
    id: "grant_codex:device_8ec0373cff60f1d97a19fb63134796c4:main_tool_cap_active",
    userId: "usr_sales",
    capabilityId: "cap_active",
    grantType: "tool",
    dataScope: { region: "cn" },
    expiresAt: null,
    createdBy: "徐刚",
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: "2026-05-27T09:00:00Z"
  }
];

describe("MCPCapabilitiesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMCPCapabilitiesMock.mockResolvedValue(capabilities);
    listMCPUpstreamServersMock.mockResolvedValue(servers);
    listMCPGrantsMock.mockImplementation((filters = {}) =>
      Promise.resolve(filters.capabilityId ? grants.filter((grant) => grant.capabilityId === filters.capabilityId) : grants)
    );
    deleteMCPCapabilityMock.mockResolvedValue(undefined);
    renameMCPCapabilityMock.mockResolvedValue({
      id: "cap_pending",
      exposedName: "crm.customer.remove",
      status: "pending",
      updatedAt: "2026-05-27T10:00:00Z"
    });
    updateMCPCapabilityStatusMock.mockResolvedValue({
      id: "cap_pending",
      exposedName: "crm.customer.delete",
      status: "active",
      updatedAt: "2026-05-27T10:00:00Z"
    });
    updateMCPCapabilityGatesMock.mockResolvedValue({
      ...capabilities[1],
      approvalRequired: true,
      confirmRequired: true
    });
  });

  it("does not render a manual capability create button", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "能力目录" })).toBeInTheDocument();
    expect(await screen.findByText("crm.customer.search")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新增|新建|创建|create capability/i })).not.toBeInTheDocument();
  });

  it("uses compact widths for toolbar filters on desktop", async () => {
    renderPage();

    await screen.findByText("crm.customer.search");

    expect(screen.getByLabelText("筛选能力状态")).toHaveClass("sm:w-36");
    expect(screen.getByLabelText("筛选能力上游服务")).toHaveClass("sm:w-56");
    expect(screen.getByLabelText("筛选能力领域")).toHaveClass("sm:w-36");
    expect(screen.getByLabelText("筛选能力授权")).toHaveClass("sm:w-40");
  });

  it("shows capability boolean fields as badges in the list", async () => {
    renderPage();

    const pendingRow = await findRowByText("crm.customer.delete");

    expect(screen.getByRole("columnheader", { name: "需要确认" })).toBeInTheDocument();
    expect(within(pendingRow).getAllByText("true")).toHaveLength(3);
    expect(within(pendingRow).getAllByText("false")).toHaveLength(1);

    const activeRow = await findRowByText("crm.customer.search");
    expect(within(activeRow).getAllByText("false")).toHaveLength(3);
  });

  it("shows an Activate action for pending capabilities", async () => {
    renderPage();

    const row = await findRowByText("crm.customer.delete");
    expect(within(row).queryByRole("button", { name: "详情" })).not.toBeInTheDocument();
    expect(within(row).getAllByRole("button")).toHaveLength(3);
    expect(within(row).getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "启用" }).querySelector("svg")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "启用" }));

    await waitFor(() => {
      expect(updateMCPCapabilityStatusMock).toHaveBeenCalledWith("crm.customer.delete", "active");
    });
  });

  it("does not open rename editing for missing capabilities", async () => {
    renderPage();

    const row = await findRowByText("crm.customer.legacy");
    expect(within(row).queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  });

  it("deletes missing capabilities after confirmation", async () => {
    renderPage();

    const missingRow = await findRowByText("crm.customer.legacy");
    expect(within(missingRow).getByRole("button", { name: "删除" })).toBeInTheDocument();
    expect(within(await findRowByText("crm.customer.search")).queryByRole("button", { name: "删除" })).not.toBeInTheDocument();

    fireEvent.click(within(missingRow).getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "删除已缺失能力" })).toBeInTheDocument();
    expect(within(dialog).getByText(/crm\.customer\.legacy/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(deleteMCPCapabilityMock).toHaveBeenCalledWith("cap_missing");
    });
  });

  it("blocks rename submit for active capabilities with grants", async () => {
    renderPage();

    const row = await findRowByText("crm.customer.search");
    expect(within(row).getAllByRole("button")).toHaveLength(3);
    expect(within(row).getByRole("button", { name: "禁用" }).querySelector("svg")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("新的 exposed_name"), { target: { value: "crm.customer.lookup" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 rename" }));

    expect(await screen.findByText("已有授权，请先删除授权，或后续通过别名能力处理。")).toBeInTheDocument();
    expect(renameMCPCapabilityMock).not.toHaveBeenCalled();
  });

  it("requires confirmation before renaming active capabilities without grants", async () => {
    renderPage();

    const row = await findRowByText("crm.customer.export");
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("新的 exposed_name"), { target: { value: "crm.customer.bulk_export" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 rename" }));

    expect(await screen.findByText("请输入当前 exposed_name 以确认 rename。")).toBeInTheDocument();
    expect(renameMCPCapabilityMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("确认当前 exposed_name"), { target: { value: "crm.customer.export" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 rename" }));

    await waitFor(() => {
      expect(renameMCPCapabilityMock).toHaveBeenCalledWith("crm.customer.export", "crm.customer.bulk_export");
    });
  });

  it("switches schema tabs between input_schema, output_schema, and annotations", async () => {
    renderPage();

    const row = await findRowByText("crm.customer.search");
    fireEvent.click(within(row).getByText("crm.customer.search"));
    expect(screen.queryByText(/"keyword"/)).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "查看 crm.customer.search 详情" }));

    expect(await screen.findByText(/"keyword"/)).toBeInTheDocument();
    clickTab(screen.getByRole("tab", { name: "output_schema" }));
    expect(await screen.findByText(/"items"/)).toBeInTheDocument();
    clickTab(screen.getByRole("tab", { name: "annotations" }));
    expect(await screen.findByText(/"readOnlyHint"/)).toBeInTheDocument();
  });

  it("shows related grants with a concise title and copyable technical ID", async () => {
    renderPage();

    const row = await findRowByText("crm.customer.search");
    fireEvent.click(within(row).getByRole("button", { name: "查看 crm.customer.search 详情" }));

    expect(await screen.findByText("工具授权")).toBeInTheDocument();
    expect(screen.getByText("账户 usr_sales · 创建人 徐刚")).toBeInTheDocument();
    expect(screen.getByText("有效期：永不过期")).toBeInTheDocument();
    const grantID = "grant_codex:device_8ec0373cff60f1d97a19fb63134796c4:main_tool_cap_active";
    expect(screen.getByText(grantID)).toHaveClass("truncate");
    expect(screen.getByRole("button", { name: `复制授权 ID ${grantID}` })).toBeInTheDocument();
  });

  it("shows confirmation governance fields in the capability detail drawer", async () => {
    renderPage();

    const row = await findRowByText("crm.customer.delete");
    fireEvent.click(within(row).getByRole("button", { name: "查看 crm.customer.delete 详情" }));

    expect((await screen.findAllByText("confirm_required")).length).toBeGreaterThan(0);
    expect(screen.getByText("请确认本次 CRM 写入动作的参数快照。")).toBeInTheDocument();
    expect(screen.queryByText(/\/admin\/api/)).not.toBeInTheDocument();
  });

  it("previews routed codex.ask metadata while preserving Collector metadata", async () => {
    renderPage();

    const row = await findRowByText("crm.codex.ask");
    fireEvent.click(within(row).getByRole("button", { name: "查看 crm.codex.ask 详情" }));

    expect(await screen.findByText("原始元数据与治理")).toBeInTheDocument();
    expect(screen.getByText("向本机 Codex 提问并返回最终回答")).toBeInTheDocument();
    expect(screen.getByText("对 Agent 展示预览")).toBeInTheDocument();
    expect(screen.getByText("委派给CRM Main")).toBeInTheDocument();
    expect(screen.getByText("将任务委派给CRM Main。负责客户查询、代码分析和故障定位。")).toBeInTheDocument();
  });

  it("updates capability gate settings from the detail drawer after confirmation", async () => {
    renderPage();

    const row = await findRowByText("crm.customer.search");
    fireEvent.click(within(row).getByRole("button", { name: "查看 crm.customer.search 详情" }));
    fireEvent.click(await screen.findByLabelText("approval_required"));
    fireEvent.click(screen.getByLabelText("confirm_required"));
    fireEvent.click(screen.getByRole("button", { name: "保存门禁策略" }));

    expect(await screen.findByText("approval_required: false -> true")).toBeInTheDocument();
    expect(screen.getByText("confirm_required: false -> true")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));

    await waitFor(() => {
      expect(updateMCPCapabilityGatesMock).toHaveBeenCalledWith("cap_active", {
        approvalRequired: true,
        confirmRequired: true
      });
    });
  });

  it("allows updating gate settings for non-active capabilities", async () => {
    renderPage();

    const row = await findRowByText("crm.customer.delete");
    fireEvent.click(within(row).getByRole("button", { name: "查看 crm.customer.delete 详情" }));
    fireEvent.click(await screen.findByLabelText("approval_required"));
    fireEvent.click(screen.getByLabelText("confirm_required"));
    fireEvent.click(screen.getByRole("button", { name: "保存门禁策略" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认保存" }));

    await waitFor(() => {
      expect(updateMCPCapabilityGatesMock).toHaveBeenCalledWith("cap_pending", {
        approvalRequired: false,
        confirmRequired: false
      });
    });
  });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MCPCapabilitiesPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function findRowByText(text: string) {
  const cell = await screen.findByText(text);
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
