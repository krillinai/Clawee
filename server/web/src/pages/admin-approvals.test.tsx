import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import { approvalsAdmin, type AdminApprovalDetail, type AdminApprovalItem } from "@/lib/admin-approvals-api";
import { APIError } from "@/lib/api";
import { permissions } from "@/lib/rbac-api";
import { mapSkillDetail, resolveSkillApproval, syncSkillApproval } from "@/lib/skillhub-api";
import { workflowAdmin } from "@/lib/workflow-api";
import { AdminApprovalDetailPage, AdminApprovalsPage } from "./admin-approvals";

vi.mock("@/lib/admin-approvals-api", () => ({ approvalsAdmin: { list: vi.fn(), summary: vi.fn(), detail: vi.fn(), files: vi.fn(), file: vi.fn(), packageURL: vi.fn() } }));
vi.mock("@/lib/workflow-api", async () => ({ ...await vi.importActual<typeof import("@/lib/workflow-api")>("@/lib/workflow-api"), workflowAdmin: { terminate: vi.fn() } }));
vi.mock("@/lib/skillhub-api", async () => ({ ...await vi.importActual<typeof import("@/lib/skillhub-api")>("@/lib/skillhub-api"), syncSkillApproval: vi.fn(), resolveSkillApproval: vi.fn() }));

const item = (id: string, overrides: Partial<AdminApprovalItem> = {}): AdminApprovalItem => ({ kind: "workflow_instance", id, type: "workflow", title: `审批 ${id}`, channel: "workflow", status: "pending", business_status: "running", initiated_by: "writer", initiated_name: "发起人", created_at: "2026-10-10T00:00:00Z", current_approvers: ["reviewer"], current_approver_names: ["评审人"], progress_completed: 0, progress_total: 1, can_process: false, materials_available: true, task_id: `task-${id}`, ...overrides });
const detail = (id: string, overrides: Partial<AdminApprovalDetail> = {}): AdminApprovalDetail => ({ item: item(id), actions: { terminate: true }, workflow: { id, template_id: "template", template_revision: 1, started_by: "writer", started_at: "2026-10-10T00:00:00Z", status: "running", nodes: [{ node_id: "review", order: 0, title: "人工核对", type: "approval", instruction: "核对输入" }], tasks: [] }, ...overrides });

function Navigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/admin/approvals/workflow_instance/b")}>切换到 b</button>;
}

function mount(path = "/admin/approvals", granted = [permissions.skillRead, permissions.workflowInstanceRead, permissions.workflowInstanceTerminate]) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  render(<QueryClientProvider client={cache}><AdminPermissionsProvider account={{ userId: "admin", email: "admin@test.invalid", name: "管理员", status: "active", adminPermissions: granted }}><MemoryRouter initialEntries={[path]}><Navigation /><Routes>
    <Route path="/admin/approvals" element={<AdminApprovalsPage />} />
    <Route path="/admin/approvals/:kind/:id" element={<AdminApprovalDetailPage />} />
  </Routes></MemoryRouter></AdminPermissionsProvider></QueryClientProvider>);
  return cache;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(approvalsAdmin.list).mockResolvedValue({ items: [], meta: { has_next: false, next_cursor: "" } });
  vi.mocked(approvalsAdmin.summary).mockResolvedValue({ total: 100, pending: 70, running: 25, abnormal: 5 });
  vi.mocked(approvalsAdmin.detail).mockImplementation(async (_kind, id) => detail(id));
  vi.mocked(workflowAdmin.terminate).mockResolvedValue(detail("a").workflow!);
  vi.mocked(syncSkillApproval).mockResolvedValue({});
  vi.mocked(resolveSkillApproval).mockResolvedValue({});
});

describe("审批管理列表", () => {
  it("AI 阶段不冒充人工待办，详情说明前置评估尚未通过", async () => {
    const review = item("ai", { kind: "skill", type: "skill", channel: "local", workflow_stage: "ai_failed" });
    vi.mocked(approvalsAdmin.list).mockResolvedValue({ items: [review], meta: { has_next: false, next_cursor: "" } });
    vi.mocked(approvalsAdmin.detail).mockResolvedValue({ item: review, actions: {} });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "查看审批 ai详情" }));
    expect(screen.getAllByText("评估执行异常").length).toBeGreaterThan(0);
    expect(await screen.findByText("AI 评估尚未通过，当前仅可查看。")).toBeInTheDocument();
    expect(screen.queryByText("人工审核")).not.toBeInTheDocument();
    expect(screen.queryByText("评审人")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "处理审批" })).not.toBeInTheDocument();
  });

  it("统计来自独立查询，筛选与视图重置分页", async () => {
    vi.mocked(approvalsAdmin.list).mockResolvedValue({ items: [item("a")], meta: { has_next: true, next_cursor: "server-next" } });
    mount();
    await screen.findByRole("button", { name: "查看审批 a详情" });
    expect(await screen.findByText("100")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(approvalsAdmin.list).toHaveBeenLastCalledWith(expect.anything(), "server-next", expect.anything()));
    fireEvent.change(screen.getByLabelText("关键词"), { target: { value: "特定审批" } });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => expect(approvalsAdmin.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "特定审批" }), "", expect.anything()));
    const tab = screen.getByRole("tab", { name: "异常" });
    fireEvent.mouseDown(tab); fireEvent.click(tab);
    await waitFor(() => expect(approvalsAdmin.list).toHaveBeenLastCalledWith(expect.objectContaining({ view: "error", q: "特定审批" }), "", expect.anything()));
    expect(approvalsAdmin.summary).toHaveBeenLastCalledWith(expect.objectContaining({ view: "error", q: "特定审批" }), expect.anything());
  });

  it("抽屉提供直接详情入口，保留列表筛选", async () => {
    vi.mocked(approvalsAdmin.list).mockResolvedValue({ items: [item("a")], meta: { has_next: false, next_cursor: "" } });
    mount("/admin/approvals?type=workflow&view=active");
    fireEvent.click(await screen.findByRole("button", { name: "查看审批 a详情" }));
    expect(await screen.findByRole("heading", { name: "审批 a" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开详情页" })).toHaveAttribute("href", "/admin/approvals/workflow_instance/a?type=workflow&view=active");
    expect(screen.queryByRole("link", { name: "处理审批" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭详情抽屉" }));
    expect(screen.queryByRole("heading", { name: "审批 a" })).not.toBeInTheDocument();
  });

  it("仅有一个领域权限时不提供另一领域选项", async () => {
    mount("/admin/approvals", [permissions.workflowInstanceRead]);
    expect(within(screen.getByLabelText("审批类型")).queryByRole("option", { name: "技能审核" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("审批渠道")).queryByRole("option", { name: "钉钉审批" })).not.toBeInTheDocument();
    await screen.findByText("暂无审批记录");
  });

  it.each([403, 404, 500])("列表错误 %s 不泄露服务端错误正文", async status => {
    vi.mocked(approvalsAdmin.list).mockRejectedValue(new APIError("内部连接信息", status, "error"));
    mount();
    await screen.findByRole("alert");
    expect(screen.queryByText("内部连接信息")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  });
});

describe("审批管理详情", () => {
  it.each([false, true])("Skill 状态、人工评分和 AI 报告分区展示，校验信息可展开（已通过：%s）", async approved => {
    const stage = approved ? "approved" : "revision_required";
    const status = approved ? "approved" : "pending";
    const createdAt = "2026-10-10T00:00:00Z";
    const skill = mapSkillDetail({
      skill: { skill_id: "skill", space_id: "space", space_name: "技能空间", name: "项目资料整理", description: "整理项目资料", current_version_id: null, created_by: "writer", created_at: createdAt, updated_at: createdAt },
      versions: [{
        version_id: "version", skill_id: "skill", version: "1.0.1", description: "", changelog: "", package_sha256: "a".repeat(64), source: null, created_at: createdAt, approval_status: status,
        local_approval: {
          request_id: "approval", workflow_stage: stage, status, total: 1, approved: approved ? 1 : 0, scoring_standard_version: "manual-v1",
          approvers: [{ user_id: "reviewer", name: "评审人", status, comment: approved ? "材料清晰" : "", decided_at: approved ? createdAt : null }],
          ...(approved ? { score_summary: { scenario_value: 5, result_effectiveness: 5, ease_of_use: 5, reuse_value: 5, total: 20 } } : {}),
          ai_review: {
            status: "completed", attempt_id: "attempt", agent_id: "agent", updated_at: createdAt,
            report: { conclusion: approved ? "recommend_approve" : "recommend_reject", summary: "当前版本 AI 审核摘要", findings: [], suggested_scores: { scenario_value: 2, result_effectiveness: 3, ease_of_use: 4, reuse_value: 3 } }
          }
        }
      }]
    });
    vi.mocked(approvalsAdmin.detail).mockResolvedValue({ item: item("approval", { kind: "skill", type: "skill", channel: "local", status, business_status: status, workflow_stage: stage, version: "1.0.1", space_id: "space", space_name: "技能空间", content_digest: "a".repeat(64) }), skill, actions: {} });
    vi.mocked(approvalsAdmin.files).mockResolvedValue({ items: [] });
    mount("/admin/approvals/skill/approval");
    const state = await screen.findByRole("region", { name: "审批状态" });
    expect(within(state).getByText(approved ? "审核通过" : "需修改")).toBeInTheDocument();
    expect(screen.getByText("版本 1.0.1")).toBeInTheDocument();
    const metadata = within(state).getByRole("button", { name: "审批编号与校验信息" });
    expect(metadata).toHaveAttribute("aria-expanded", "false");
    expect(within(state).queryByText("a".repeat(64))).not.toBeInTheDocument();
    fireEvent.click(metadata);
    expect(within(state).getByText("approval")).toBeInTheDocument();
    expect(within(state).getByText("a".repeat(64))).toBeInTheDocument();
    const review = screen.getByRole("region", { name: "本轮审核记录" });
    const human = within(review).getByRole("region", { name: "人工审核与评分" });
    const ai = within(review).getByRole("region", { name: "AI 审核报告" });
    expect(within(ai).getByText("当前版本 AI 审核摘要")).toBeInTheDocument();
    expect(within(ai).getByText("场景价值：2 / 5")).toBeInTheDocument();
    expect(within(human).queryByText("当前版本 AI 审核摘要")).not.toBeInTheDocument();
    if (approved) expect(within(human).getByText("总分：20.00 / 20")).toBeInTheDocument();
    else expect(within(human).queryByRole("group", { name: "正式评分汇总" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "处理审批" })).not.toBeInTheDocument();
  });

  it("只有实际审批人显示个人处理入口", async () => {
    vi.mocked(approvalsAdmin.detail).mockResolvedValue(detail("a", { item: item("a", { can_process: true }) }));
    mount("/admin/approvals/workflow_instance/a");
    expect(await screen.findByRole("link", { name: "处理审批" })).toHaveAttribute("href", "/app/approvals/workflow/task-a");
    expect(screen.queryByRole("button", { name: "强制通过" })).not.toBeInTheDocument();
  });

  it("终止要求原因和确认，提交中禁止刷新和重复操作", async () => {
    let finish!: (value: Awaited<ReturnType<typeof workflowAdmin.terminate>>) => void;
    vi.mocked(workflowAdmin.terminate).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    mount("/admin/approvals/workflow_instance/a");
    const refreshButton = await screen.findByRole("button", { name: "刷新详情" });
    fireEvent.click(await screen.findByRole("button", { name: "终止工作流" }));
    expect(screen.getByRole("button", { name: "确认终止" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("终止原因（必填）"), { target: { value: "管理员核实后终止" } });
    fireEvent.click(screen.getByRole("button", { name: "确认终止" }));
    await waitFor(() => expect(workflowAdmin.terminate).toHaveBeenCalledWith("a", "管理员核实后终止"));
    expect(refreshButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "提交中..." })).toBeDisabled();
    await act(async () => finish(detail("a").workflow!));
    expect(await screen.findByText("操作已完成。")).toBeInTheDocument();
    expect(workflowAdmin.terminate).toHaveBeenCalledTimes(1);
  });

  it("后端未授权的管理动作不展示", async () => {
    vi.mocked(approvalsAdmin.detail).mockResolvedValue(detail("a", { actions: {} }));
    mount("/admin/approvals/workflow_instance/a");
    await screen.findByRole("heading", { name: "审批 a" });
    expect(screen.queryByRole("button", { name: "终止工作流" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "同步外部结果" })).not.toBeInTheDocument();
  });

  it("详情切换后迟到请求不覆盖新记录", async () => {
    let finish!: (value: AdminApprovalDetail) => void;
    vi.mocked(approvalsAdmin.detail).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    mount("/admin/approvals/workflow_instance/a");
    fireEvent.click(screen.getByRole("button", { name: "切换到 b" }));
    await screen.findByRole("heading", { name: "审批 b" });
    await act(async () => finish(detail("a")));
    expect(screen.queryByRole("heading", { name: "审批 a" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "审批 b" })).toBeInTheDocument();
  });

  it("外部同步需要确认，使用已有接口而不是本地审批接口", async () => {
    vi.mocked(approvalsAdmin.detail).mockResolvedValue({ item: item("external", { kind: "skill_external", type: "skill", channel: "dingtalk", skill_id: "skill", version_id: "version", status: "running" }), actions: { sync: true } });
    mount("/admin/approvals/skill_external/external");
    fireEvent.click(await screen.findByRole("button", { name: "同步外部结果" }));
    expect(syncSkillApproval).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认同步" }));
    await waitFor(() => expect(syncSkillApproval).toHaveBeenCalledWith("skill", "version"));
    expect(await screen.findByText("操作已完成。")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "处理审批" })).not.toBeInTheDocument();
  });

  it("异常核对要求实例 ID，可明确确认未创建", async () => {
    vi.mocked(approvalsAdmin.detail).mockResolvedValue({ item: item("external", { kind: "skill_external", type: "skill", channel: "dingtalk", business_status: "uncertain", status: "error" }), actions: { resolve: true } });
    mount("/admin/approvals/skill_external/external");
    fireEvent.click(await screen.findByRole("button", { name: "核对异常实例" }));
    expect(screen.getByRole("button", { name: "确认核对" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("核对结果"), { target: { value: "not_created" } });
    fireEvent.click(screen.getByRole("button", { name: "确认核对" }));
    await waitFor(() => expect(resolveSkillApproval).toHaveBeenCalledWith("external", "not_created", ""));
  });

  it("管理操作冲突不伪报成功，可刷新详情重新核对", async () => {
    vi.mocked(workflowAdmin.terminate).mockRejectedValue(new APIError("内部状态", 409, "conflict"));
    mount("/admin/approvals/workflow_instance/a");
    fireEvent.click(await screen.findByRole("button", { name: "终止工作流" }));
    fireEvent.change(screen.getByLabelText("终止原因（必填）"), { target: { value: "核对" } });
    fireEvent.click(screen.getByRole("button", { name: "确认终止" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("审批状态已变化");
    expect(screen.queryByText("操作已完成。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新详情" }));
    await waitFor(() => expect(approvalsAdmin.detail).toHaveBeenCalledTimes(2));
  });
});
