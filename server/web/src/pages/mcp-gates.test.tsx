import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import { permissions } from "@/lib/rbac-api";
import type { MCPGate } from "@/lib/mcp-admin-api";
import {
  acceptMCPGate,
  getMCPGate,
  listMCPGates,
  rejectMCPGate
} from "@/lib/mcp-admin-api";

import { MCPGatesPage } from "./mcp-gates";

vi.mock("@/lib/mcp-admin-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp-admin-api")>("@/lib/mcp-admin-api");
  return {
    ...actual,
    acceptMCPGate: vi.fn(),
    getMCPGate: vi.fn(),
    listMCPGates: vi.fn(),
    rejectMCPGate: vi.fn()
  };
});

function clickTab(tab: HTMLElement) {
  fireEvent.pointerDown(tab);
  fireEvent.mouseDown(tab);
  fireEvent.mouseUp(tab);
  fireEvent.click(tab);
}

async function selectFilterOption(name: string | RegExp, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name }));
  fireEvent.click(await within(screen.getByRole("listbox")).findByRole("option", { name: option }));
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
}

const userPendingGate: MCPGate = {
  id: "mcp_confirm_1",
  type: "user_confirmation",
  provider: "internal",
  traceId: "trace_confirm_1",
  tenantId: "tenant_cn_sales",
  agentId: "sales_zhang_agent",
  actorId: "sales_zhang",
  capabilityId: "cap_crm_customer_update",
  upstreamServerId: "crm-main",
  exposedName: "crm.customer.update",
  upstreamName: "customer.update",
  requestBody: { customer_id: "C1024", phone: "13800131234" },
  argumentsHash: "sha256:abc",
  schemaHash: "sha256:schema-user",
  gateSummary: {
    system: "crm",
    action: "更新客户资料",
    object: "customer/C1024",
    tool: "crm.customer.update",
    riskLevel: "high",
    destructive: true,
    readOnly: false,
    parameters: [
      { path: "customer_id", label: "客户 ID", value: "C1024", sensitive: false },
      { path: "phone", label: "手机号", value: "138****1234", sensitive: true }
    ],
    risks: ["会修改或删除企业系统数据。", "该工具风险等级为 high。"]
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
};

const approvalPendingGate: MCPGate = {
  ...userPendingGate,
  id: "mcp_approval_1",
  type: "admin_approval",
  provider: "internal",
  traceId: "trace_approval_1",
  agentId: "finance_agent",
  actorId: "finance_wang",
  capabilityId: "cap_erp_payment_submit",
  upstreamServerId: "erp-core",
  exposedName: "erp.payment.submit",
  upstreamName: "payment.submit",
  requestBody: { payment_no: "PAY-20260529-018", amount: 280000 },
  argumentsHash: "sha256:approval",
  schemaHash: "sha256:schema-approval",
  gateSummary: {
    ...userPendingGate.gateSummary,
    system: "erp",
    action: "提交财务付款",
    object: "payment/PAY-20260529-018",
    tool: "erp.payment.submit",
    riskLevel: "high",
    parameters: [
      { path: "payment_no", label: "付款单", value: "PAY-20260529-018", sensitive: false },
      { path: "amount", label: "金额", value: "280000.00", sensitive: false }
    ],
    risks: ["管理员通过后才允许继续执行。"]
  },
  confirmUrl: "/admin/mcp/gates/mcp_approval_1",
  expiresAt: "2026-05-29T11:00:00Z"
};

const completedGate: MCPGate = {
  ...userPendingGate,
  id: "mcp_confirm_done",
  status: "completed",
  executionAuditId: "audit_proxy_done",
  decidedBy: "sales_zhang",
  responseBody: { structuredContent: { ok: true }, content: [] }
};

const rejectedGate: MCPGate = {
  ...userPendingGate,
  id: "mcp_confirm_rejected",
  status: "rejected",
  decidedBy: "sales_zhang",
  decisionReason: "参数不正确"
};

const expiredGate: MCPGate = {
  ...userPendingGate,
  id: "mcp_confirm_expired",
  status: "pending",
  expiresAt: "2026-05-29T09:00:00Z"
};

const cancelledGate: MCPGate = {
  ...userPendingGate,
  id: "mcp_confirm_cancelled",
  status: "cancelled",
  decidedBy: "system",
  decisionReason: "外部审批已取消"
};

const gates = [userPendingGate, approvalPendingGate, completedGate, rejectedGate, expiredGate, cancelledGate];

describe("MCPGatesPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-29T10:10:00Z"));
    vi.mocked(listMCPGates).mockResolvedValue(gates);
    vi.mocked(getMCPGate).mockImplementation(async (id) => gates.find((gate) => gate.id === id) ?? userPendingGate);
    vi.mocked(acceptMCPGate).mockImplementation(async (id) => ({
      ...userPendingGate,
      id,
      status: "executing"
    }));
    vi.mocked(rejectMCPGate).mockImplementation(async (id, reason) => ({
      ...userPendingGate,
      id,
      status: "rejected",
      decisionReason: reason
    }));
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders the Open Design gate table, metrics, and filters", async () => {
    renderGatesPage();

    expect(await screen.findByText("门禁队列")).toBeInTheDocument();
    expect(await screen.findByText("mcp_confirm_1")).toBeInTheDocument();
    expect(screen.getByText("用户确认待处理")).toBeInTheDocument();
    expect(screen.getByText("管理员审批待处理")).toBeInTheDocument();
    expect(screen.getByText("已恢复执行")).toBeInTheDocument();
    expect(screen.getByText("终态异常")).toBeInTheDocument();
    expect(within(screen.getByText("终态异常").closest("section")!).getByText("2")).toBeInTheDocument();

    for (const column of ["ID", "类型", "状态", "工具", "动作", "操作者", "智能体", "风险", "裁决结果", "过期时间", "参数哈希", "操作"]) {
      expect(screen.getByRole("columnheader", { name: column })).toBeInTheDocument();
    }

    expect(screen.getByPlaceholderText("搜索 gate_id / 工具 / 操作者 / 智能体 / 追踪")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "筛选门禁类型" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "筛选门禁状态" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "筛选门禁状态" }));
    expect(await within(screen.getByRole("listbox")).findByRole("option", { name: "已取消" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("combobox", { name: "筛选风险等级" })).toBeInTheDocument();

    expect(screen.getByText("mcp_approval_1")).toBeInTheDocument();
    expect(screen.getAllByText("用户确认").length).toBeGreaterThan(1);
    expect(screen.getAllByText("管理员审批").length).toBeGreaterThan(0);
    expect(screen.getAllByText("crm.customer.update").length).toBeGreaterThan(0);
    expect(screen.getByText("erp.payment.submit")).toBeInTheDocument();
    expect(screen.getAllByText("sha256:abc").length).toBeGreaterThan(0);
  });

  it("filters gates by search, gate type, status, and risk", async () => {
    renderGatesPage();

    await screen.findByText("mcp_confirm_1");
    fireEvent.change(screen.getByPlaceholderText("搜索 gate_id / 工具 / 操作者 / 智能体 / 追踪"), {
      target: { value: "payment" }
    });
    expect(screen.queryByText("crm.customer.update")).not.toBeInTheDocument();
    expect(screen.getByText("erp.payment.submit")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索 gate_id / 工具 / 操作者 / 智能体 / 追踪"), {
      target: { value: "" }
    });
    await selectFilterOption("筛选门禁类型", "管理员审批");
    expect(screen.queryByText("mcp_confirm_1")).not.toBeInTheDocument();
    expect(screen.getByText("mcp_approval_1")).toBeInTheDocument();

    await selectFilterOption("筛选门禁类型", "全部门禁类型");
    await selectFilterOption("筛选门禁状态", "已完成");
    expect(screen.getByText("mcp_confirm_done")).toBeInTheDocument();

    await selectFilterOption("筛选风险等级", "高风险");
    expect(screen.getByText("mcp_confirm_done")).toBeInTheDocument();
  });

  it("opens the shared accept modal from list quick actions and submits accept", async () => {
    renderGatesPage();

    await screen.findByText("mcp_confirm_1");
    const confirmRow = screen.getByText("mcp_confirm_1").closest("tr")!;
    fireEvent.click(within(confirmRow).getByRole("button", { name: "通过" }));

    const acceptDialog = screen.getByRole("dialog", { name: "通过 MCP 调用" });
    expect(acceptDialog).toBeInTheDocument();
    expect(within(acceptDialog).getByText("用户确认")).toBeInTheDocument();
    expect(screen.getAllByText("mcp_confirm_1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("crm.customer.update").length).toBeGreaterThan(0);
    expect(screen.getAllByText("sha256:abc").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/actor_id/i)).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("dialog", { name: "通过 MCP 调用" })).getByRole("button", { name: "通过" }));
    await waitFor(() => {
      expect(acceptMCPGate).toHaveBeenCalledWith("mcp_confirm_1");
    });
  });

  it("opens the shared reject modal from list quick actions and submits reason", async () => {
    renderGatesPage();

    await screen.findByText("mcp_approval_1");
    const approvalRow = screen.getByText("mcp_approval_1").closest("tr")!;
    fireEvent.click(within(approvalRow).getByRole("button", { name: "拒绝" }));

    const rejectDialog = screen.getByRole("dialog", { name: "拒绝 MCP 调用" });
    expect(rejectDialog).toBeInTheDocument();
    expect(within(rejectDialog).getByText("管理员审批")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("例如：参数不正确，需让 Agent 重新发起。"), {
      target: { value: "缺少审批依据" }
    });
    fireEvent.click(within(screen.getByRole("dialog", { name: "拒绝 MCP 调用" })).getByRole("button", { name: "拒绝" }));

    await waitFor(() => {
      expect(rejectMCPGate).toHaveBeenCalledWith("mcp_approval_1", "缺少审批依据");
    });
  });

  it("submits an empty reject reason", async () => {
    renderGatesPage();

    await screen.findByText("mcp_confirm_1");
    const confirmRow = screen.getByText("mcp_confirm_1").closest("tr")!;
    fireEvent.click(within(confirmRow).getByRole("button", { name: "拒绝" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "拒绝 MCP 调用" })).getByRole("button", { name: "拒绝" }));

    await waitFor(() => {
      expect(rejectMCPGate).toHaveBeenCalledWith("mcp_confirm_1", "");
    });
  });

  it("does not show decision buttons for completed, rejected, expired, or failed gates", async () => {
    renderGatesPage();

    await screen.findByText("mcp_confirm_done");
    for (const id of ["mcp_confirm_done", "mcp_confirm_rejected", "mcp_confirm_expired", "mcp_confirm_cancelled"]) {
      const row = screen.getByText(id).closest("tr")!;
      expect(within(row).queryByRole("button", { name: "通过" })).not.toBeInTheDocument();
      expect(within(row).queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
      expect(within(row).getByText("不可操作")).toBeInTheDocument();
    }
  });

  it("opens the detail drawer only from the detail button and shows summary, snapshot, provider, json tabs, and audit link", async () => {
    renderGatesPage();

    await screen.findByText("mcp_confirm_1");
    const row = screen.getByText("mcp_confirm_1").closest("tr")!;
    fireEvent.click(within(row).getByText("mcp_confirm_1"));
    expect(screen.queryByRole("heading", { name: "mcp_confirm_1" })).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "查看 mcp_confirm_1 详情" }));

    expect(await screen.findByRole("heading", { name: "mcp_confirm_1" })).toBeInTheDocument();
    expect(screen.getByText("业务摘要")).toBeInTheDocument();
    expect(screen.getByText("参数快照")).toBeInTheDocument();
    expect(screen.getByText("追踪与外部提供方")).toBeInTheDocument();
    expect(screen.getByText("执行区")).toBeInTheDocument();
    expect(screen.getByText("操作区")).toBeInTheDocument();
    expect(screen.getByText("138****1234")).toBeInTheDocument();
    expect(screen.getByText("会修改或删除企业系统数据。")).toBeInTheDocument();
    expect(screen.getByText("sha256:schema-user")).toBeInTheDocument();
    expect(screen.getAllByText("internal").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "跳转审计" })).toBeInTheDocument();

    clickTab(screen.getByRole("tab", { name: "原始参数" }));
    expect(screen.getByText(/13800131234/)).toBeInTheDocument();
    clickTab(screen.getByRole("tab", { name: "错误信息" }));
    expect(screen.getByText(/decision_reason/)).toBeInTheDocument();
  });

  it("shows sensitive parameter values as boolean badges", async () => {
    renderGatesPage();

    await screen.findByText("mcp_confirm_1");
    fireEvent.click(within(screen.getByText("mcp_confirm_1").closest("tr")!).getByRole("button", { name: "查看 mcp_confirm_1 详情" }));

    const sensitiveHeader = await screen.findByRole("columnheader", { name: "sensitive" });
    const snapshotTable = sensitiveHeader.closest("table")!;

    expect(within(snapshotTable).getByText("true")).toBeInTheDocument();
    expect(within(snapshotTable).getByText("false")).toBeInTheDocument();
    expect(within(snapshotTable).queryByRole("cell", { name: "sensitive" })).not.toBeInTheDocument();
  });

  it("opens the same accept modal from drawer actions", async () => {
    renderGatesPage();

    await screen.findByText("mcp_confirm_1");
    fireEvent.click(within(screen.getByText("mcp_confirm_1").closest("tr")!).getByRole("button", { name: "查看 mcp_confirm_1 详情" }));
    await screen.findByText("操作区");
    fireEvent.click(screen.getAllByRole("button", { name: "通过" }).at(-1)!);

    const dialog = screen.getByRole("dialog", { name: "通过 MCP 调用" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("用户确认")).toBeInTheDocument();
  });

  it("opens a gate detail directly from the route param", async () => {
    renderGatesPage("/admin/mcp/gates/detail?gate_id=mcp_confirm_1");

    expect(await screen.findByRole("heading", { name: "mcp_confirm_1" })).toBeInTheDocument();
    expect(screen.getAllByText("sha256:abc").length).toBeGreaterThan(0);
  });

  it("loads a route gate detail by getMCPGate when it is not in the first list page", async () => {
    const routeOnlyGate = {
      ...userPendingGate,
      id: "mcp_confirm_route_only",
      argumentsHash: "sha256:route-only"
    };
    vi.mocked(listMCPGates).mockResolvedValue([approvalPendingGate]);
    vi.mocked(getMCPGate).mockResolvedValue(routeOnlyGate);

    renderGatesPage("/admin/mcp/gates/detail?gate_id=mcp_confirm_route_only");

    expect(await screen.findByRole("heading", { name: "mcp_confirm_route_only" })).toBeInTheDocument();
    expect(screen.getByText("sha256:route-only")).toBeInTheDocument();
    expect(getMCPGate).toHaveBeenCalledWith("mcp_confirm_route_only");
  });

  it("updates a route-only gate detail after accepting it", async () => {
    const routeOnlyGate = {
      ...userPendingGate,
      id: "mcp_confirm_route_only",
      argumentsHash: "sha256:route-only"
    };
    vi.mocked(listMCPGates).mockResolvedValue([approvalPendingGate]);
    vi.mocked(getMCPGate).mockResolvedValue(routeOnlyGate);
    vi.mocked(acceptMCPGate).mockResolvedValue({
      ...routeOnlyGate,
      status: "executing"
    });

    renderGatesPage("/admin/mcp/gates/detail?gate_id=mcp_confirm_route_only");

    expect(await screen.findByRole("heading", { name: "mcp_confirm_route_only" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "通过" }).at(-1)!);
    fireEvent.click(within(screen.getByRole("dialog", { name: "通过 MCP 调用" })).getByRole("button", { name: "通过" }));

    await waitFor(() => {
      expect(acceptMCPGate).toHaveBeenCalledWith("mcp_confirm_route_only");
    });
    expect(await screen.findByText("Gateway 正在使用冻结参数快照恢复执行。")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "通过 MCP 调用" })).not.toBeInTheDocument();
  });

  it("shows an error when a route gate detail fallback fails", async () => {
    vi.mocked(listMCPGates).mockResolvedValue([approvalPendingGate]);
    vi.mocked(getMCPGate).mockRejectedValue(new Error("not found"));

    renderGatesPage("/admin/mcp/gates/detail?gate_id=mcp_missing");

    expect(await screen.findByText("门禁详情加载失败：无法加载 mcp_missing。")).toBeInTheDocument();
  });

  it("guards against duplicate accept submissions while a mutation is pending", async () => {
    const deferred = createDeferred<MCPGate>();
    vi.mocked(acceptMCPGate).mockReturnValue(deferred.promise);
    renderGatesPage();

    await screen.findByText("mcp_confirm_1");
    const confirmRow = screen.getByText("mcp_confirm_1").closest("tr")!;
    fireEvent.click(within(confirmRow).getByRole("button", { name: "通过" }));
    const dialog = screen.getByRole("dialog", { name: "通过 MCP 调用" });
    const submit = within(dialog).getByRole("button", { name: "通过" });

    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(acceptMCPGate).toHaveBeenCalledTimes(1);
    });
    deferred.resolve({ ...userPendingGate, status: "executing" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "通过 MCP 调用" })).not.toBeInTheDocument();
    });
  });

  it("copies a shareable gate url from the list and drawer", async () => {
    renderGatesPage();

    await screen.findByText("mcp_confirm_1");
    const row = screen.getByText("mcp_confirm_1").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "复制URL" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("/admin/mcp/gates/mcp_confirm_1"));
    expect(await within(row).findByRole("button", { name: "已复制" })).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "查看 mcp_confirm_1 详情" }));
    fireEvent.click(await screen.findByRole("button", { name: "复制链接" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("/admin/mcp/gates/mcp_confirm_1"));
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("只有 read 权限时不显示门禁裁决操作", async () => {
    renderGatesPage("/admin/mcp/gates", [permissions.mcpGateRead]);

    await screen.findByText("mcp_confirm_1");
    expect(screen.queryByRole("button", { name: "通过" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByText("mcp_confirm_1").closest("tr")!).getByRole("button", { name: "查看 mcp_confirm_1 详情" }));
    expect(await screen.findByText("业务摘要")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "通过" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
  });
});

function renderGatesPage(initialPath = "/admin/mcp/gates", adminPermissions?: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          {["/admin/mcp/gates", "/admin/mcp/gates/detail"].map((path) => <Route key={path} path={path} element={adminPermissions ? <AdminPermissionsProvider account={{
            userId: "usr_reader",
            email: "reader@example.com",
            name: "Reader",
            status: "active",
            adminPermissions
          }}><MCPGatesPage /></AdminPermissionsProvider> : <MCPGatesPage />} />)}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
