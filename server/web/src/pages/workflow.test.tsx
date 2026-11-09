import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import { APIError } from "@/lib/api";
import type { Account } from "@/lib/auth-api";
import { permissions } from "@/lib/rbac-api";
import { skillReviewWorkflowApi } from "@/lib/skill-review-workflow-api";
import { workflowAdmin, type WorkflowTemplate } from "@/lib/workflow-api";
import { WorkflowInstanceDetailPage, WorkflowInstancesPage, WorkflowTemplateEditorPage, WorkflowTemplatesPage } from "./workflow";

vi.mock("@/lib/workflow-api", () => ({
  workflowAdmin: {
    templates: vi.fn(), template: vi.fn(), assignees: vi.fn(), roles: vi.fn(async () => ({ items: [], meta: { next_cursor: "" } })), save: vi.fn(), status: vi.fn(), start: vi.fn(), instances: vi.fn(), instance: vi.fn(), terminate: vi.fn()
  }
}));

vi.mock("@/lib/skill-review-workflow-api", () => ({ skillReviewWorkflowApi: { definition: vi.fn(), runs: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(skillReviewWorkflowApi.definition).mockResolvedValue({ id: "builtin:skill-review", name: "Skill 审批工作流", read_only: true, trigger: "upload", review_skill: "skill-review", steps: [{ name: "上传", rule: "上传触发" }, { name: "AI 评估", rule: "静态分析" }] });
  vi.mocked(skillReviewWorkflowApi.runs).mockResolvedValue({ items: [], meta: { next_cursor: "" } });
});

describe("工作流结果文件入口", () => {
  it("流程模板提供绑定空间入口", async () => {
    vi.mocked(workflowAdmin.templates).mockResolvedValue({ items: [{ id: "template-files", name: "结果流程", description: "", status: "enabled", revision: 1, nodes: [], created_at: "", shared_space_id: "space-files" }], meta: { next_cursor: "" } });
    renderTemplates();
    expect(await screen.findByRole("link", { name: "共享空间" })).toHaveAttribute("href", "/admin/shared-files/detail?space_id=space-files&logical_path_prefix=");
  });

  it("流程任务展示独立目录及正式文件版本", async () => {
    const prefix = "instances/instance-files/";
    const path = `${prefix}nodes/first/sub/result.md`;
    vi.mocked(workflowAdmin.instance).mockResolvedValue({ id: "instance-files", template_id: "template-files", template_revision: 1, status: "succeeded", started_by: "a", started_at: "2026-10-13T00:00:00Z", shared_space_id: "space-files", instance_path_prefix: prefix, nodes: [{ node_id: "first", order: 0, title: "生成", instruction: "生成", type: "agent", assignee_user_id: "a" }], tasks: [{ task_id: "task-files", node_id: "first", status: "completed", assignee_user_id: "a", input: {}, output: { text: "正文" }, artifacts: [{ file_id: "file-files", logical_path: path, revision: 2, sha256: "a".repeat(64), file_name: "result.md" }] }] });
    renderTemplates("/admin/workflow-instances/instance-files");
    expect(await screen.findByRole("link", { name: prefix })).toHaveAttribute("href", `/admin/shared-files/detail?${new URLSearchParams({ space_id: "space-files", logical_path_prefix: prefix })}`);
    fireEvent.click(screen.getByRole("button", { name: "展开节点“生成”的内容" }));
    expect(await screen.findByRole("link", { name: "result.md" })).toHaveAttribute("href", `/api/v1/admin/shared-files/content?${new URLSearchParams({ file_id: "file-files", preview: "1" })}`);
    expect(screen.getByText("文件 ID：")).toBeInTheDocument();
    expect(screen.getByText("版本 2")).toBeInTheDocument();
  });

  it("无网盘管理权限时不展示流程模板空间链接", async () => {
    vi.mocked(workflowAdmin.templates).mockResolvedValue({ items: [{ id: "template-files", name: "结果流程", description: "", status: "enabled", revision: 1, nodes: [], created_at: "", shared_space_id: "space-files" }], meta: { next_cursor: "" } });
    renderTemplates("/admin/workflow-templates", { userId: "a", email: "a@workflow.test", name: "A", status: "active", adminPermissions: [permissions.workflowTemplateManage] });
    expect(await screen.findByText("结果流程")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "共享空间" })).not.toBeInTheDocument();
  });

  it("无网盘管理权限时保留目录和文件名称，但不提供管理链接", async () => {
    const prefix = "instances/instance-files/";
    const path = `${prefix}nodes/first/sub/result.md`;
    vi.mocked(workflowAdmin.instance).mockResolvedValue({ id: "instance-files", template_id: "template-files", template_revision: 1, status: "succeeded", started_by: "a", started_at: "2026-10-13T00:00:00Z", shared_space_id: "space-files", instance_path_prefix: prefix, nodes: [{ node_id: "first", order: 0, title: "生成", instruction: "生成", type: "agent", assignee_user_id: "a" }], tasks: [{ task_id: "task-files", node_id: "first", status: "completed", assignee_user_id: "a", input: {}, artifacts: [{ file_id: "file-files", logical_path: path, revision: 2, sha256: "a".repeat(64), file_name: "result.md" }] }] });
    renderTemplates("/admin/workflow-instances/instance-files", { userId: "a", email: "a@workflow.test", name: "A", status: "active", adminPermissions: [permissions.workflowInstanceRead] });
    expect(await screen.findByText(prefix)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: prefix })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开节点“生成”的内容" }));
    expect(await screen.findByText("result.md")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "result.md" })).not.toBeInTheDocument();
    expect(screen.getByText("版本 2")).toBeInTheDocument();
  });
});

function renderTemplates(path = "/admin/workflow-templates", account?: Account) {
  const routes = <MemoryRouter initialEntries={[path]}><Routes>
    <Route element={<WorkflowTemplatesPage />} path="/admin/workflow-templates" />
    <Route element={<WorkflowTemplateEditorPage />} path="/admin/workflow-templates/new" />
    <Route element={<WorkflowTemplateEditorPage />} path="/admin/workflow-templates/:id" />
    <Route element={<WorkflowInstanceDetailPage />} path="/admin/workflow-instances/:id" />
  </Routes></MemoryRouter>;
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {account ? <AdminPermissionsProvider account={account}>{routes}</AdminPermissionsProvider> : routes}
  </QueryClientProvider>);
}

describe("后台手动发起工作流", () => {
  const template: WorkflowTemplate = { id: "start-template", name: "发布流程", description: "", status: "enabled", revision: 1, nodes: [], created_at: "" };
  beforeEach(() => {
    vi.mocked(workflowAdmin.templates).mockResolvedValue({ items: [template, { ...template, id: "draft", name: "草稿流程", status: "draft" }, { ...template, id: "disabled", name: "停用流程", status: "disabled" }], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.start).mockReset();
  });

  it("仅已启用流程模板提供发起入口，并说明首节点资格与不自动执行", async () => {
    renderTemplates();
    fireEvent.click(await screen.findByRole("button", { name: "发起发布流程" }));
    expect(screen.queryByRole("button", { name: "发起草稿流程" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发起停用流程" })).not.toBeInTheDocument();
    expect(screen.getByText(/当前账号必须是首节点的有效负责人/)).toBeInTheDocument();
    expect(screen.getByText(/不自动执行节点/)).toBeInTheDocument();
  });

  it.each(["[]", "null", "1", '"输入"', "{broken"])("拒绝非JSON对象：%s", async input => {
    renderTemplates();
    fireEvent.click(await screen.findByRole("button", { name: "发起发布流程" }));
    fireEvent.change(screen.getByLabelText("初始输入（JSON 对象）"), { target: { value: input } });
    fireEvent.click(screen.getByRole("button", { name: "确认发起" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("初始输入必须是 JSON 对象");
    expect(workflowAdmin.start).not.toHaveBeenCalled();
  });

  it("按UTF-8字节拒绝超过1MiB的对象", async () => {
    renderTemplates();
    fireEvent.click(await screen.findByRole("button", { name: "发起发布流程" }));
    fireEvent.change(screen.getByLabelText("初始输入（JSON 对象）"), { target: { value: JSON.stringify({ text: "中".repeat(350000) }) } });
    fireEvent.click(screen.getByRole("button", { name: "确认发起" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("初始输入不能超过 1 MiB");
    expect(workflowAdmin.start).not.toHaveBeenCalled();
  });

  it("发起成功返回关联流程任务并复用现有详情", async () => {
    vi.mocked(workflowAdmin.start).mockResolvedValue({ instance_id: "new-instance", task_id: "first-task", status: "running" });
    vi.mocked(workflowAdmin.instance).mockResolvedValue({ id: "new-instance", template_id: template.id, template_revision: 1, nodes: [], status: "running", started_by: "a", started_at: "2026-10-09T00:00:00Z" });
    renderTemplates();
    fireEvent.click(await screen.findByRole("button", { name: "发起发布流程" }));
    fireEvent.change(screen.getByLabelText("初始输入（JSON 对象）"), { target: { value: '{"text":"内容"}' } });
    fireEvent.click(screen.getByRole("button", { name: "确认发起" }));
    const link = await screen.findByRole("link", { name: "查看流程任务详情" });
    expect(workflowAdmin.start).toHaveBeenCalledWith(template.id, { text: "内容" }, expect.any(String));
    expect(link).toHaveAttribute("href", "/admin/workflow-instances/new-instance");
    fireEvent.click(link);
    expect(await screen.findByRole("heading", { name: "流程任务详情" })).toBeInTheDocument();
    expect(workflowAdmin.instance).toHaveBeenCalledWith("new-instance");
  });

  it.each([new TypeError("网络中断"), new APIError("服务暂不可用", 500, "internal_error")])("未知结果锁定输入、阻止关闭，并使用同一输入同key重试", async error => {
    vi.mocked(workflowAdmin.start).mockRejectedValueOnce(error).mockResolvedValueOnce({ instance_id: "retry-instance", task_id: "task", status: "running" });
    renderTemplates();
    fireEvent.click(await screen.findByRole("button", { name: "发起发布流程" }));
    fireEvent.change(screen.getByLabelText("初始输入（JSON 对象）"), { target: { value: '{"text":"原始输入"}' } });
    fireEvent.click(screen.getByRole("button", { name: "确认发起" }));
    const retry = await screen.findByRole("button", { name: "使用原输入重试" });
    expect(screen.getByLabelText("初始输入（JSON 对象）")).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(retry);
    await screen.findByRole("link", { name: "查看流程任务详情" });
    expect(workflowAdmin.start).toHaveBeenCalledTimes(2);
    expect(vi.mocked(workflowAdmin.start).mock.calls[1]).toEqual(vi.mocked(workflowAdmin.start).mock.calls[0]);
    expect(vi.mocked(workflowAdmin.start).mock.calls[0][2].length).toBeLessThanOrEqual(200);
  });

  it.each([400, 403, 404, 409, 413])("明确拒绝（%s）后允许修正输入且展示错误", async status => {
    vi.mocked(workflowAdmin.start).mockRejectedValueOnce(new APIError("发起被拒绝", status, "invalid_request"));
    renderTemplates();
    fireEvent.click(await screen.findByRole("button", { name: "发起发布流程" }));
    fireEvent.click(screen.getByRole("button", { name: "确认发起" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByLabelText("初始输入（JSON 对象）")).not.toBeDisabled());
    expect(screen.queryByRole("button", { name: "使用原输入重试" })).not.toBeInTheDocument();
  });

  it("提交中阻止重复请求", async () => {
    vi.mocked(workflowAdmin.start).mockReturnValue(new Promise(() => {}));
    renderTemplates();
    fireEvent.click(await screen.findByRole("button", { name: "发起发布流程" }));
    fireEvent.click(screen.getByRole("button", { name: "确认发起" }));
    expect(screen.getByRole("button", { name: "正在发起..." })).toBeDisabled();
    expect(workflowAdmin.start).toHaveBeenCalledTimes(1);
  });

  it("未知结果之后权限拒绝仍保留原请求，恢复后继续同key", async () => {
    vi.mocked(workflowAdmin.start).mockRejectedValueOnce(new TypeError("网络中断")).mockRejectedValueOnce(new APIError("权限不足", 403, "forbidden")).mockResolvedValueOnce({ instance_id: "recovered-instance", task_id: "first-task", status: "running" });
    renderTemplates();
    fireEvent.click(await screen.findByRole("button", { name: "发起发布流程" }));
    fireEvent.change(screen.getByLabelText("初始输入（JSON 对象）"), { target: { value: '{"text":"原输入"}' } });
    fireEvent.click(screen.getByRole("button", { name: "确认发起" }));
    fireEvent.click(await screen.findByRole("button", { name: "使用原输入重试" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("暂无访问权限"));
    expect(screen.getByLabelText("初始输入（JSON 对象）")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "使用原输入重试" }));
    await screen.findByRole("link", { name: "查看流程任务详情" });
    const calls = vi.mocked(workflowAdmin.start).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toEqual(calls[0]);
  });

  it("缺少流程模板管理权限时不提供发起入口", async () => {
    renderTemplates(undefined, { userId: "reader", email: "reader@example.com", name: "查看员", status: "active", adminPermissions: [permissions.workflowInstanceRead] });
    await screen.findByText("发布流程");
    expect(screen.queryByRole("button", { name: "发起发布流程" })).not.toBeInTheDocument();
  });

  it("只有流程模板管理权限时显示成功流程任务ID，不提供无权访问的详情入口", async () => {
    vi.mocked(workflowAdmin.start).mockResolvedValue({ instance_id: "limited-instance", task_id: "first-task", status: "running" });
    renderTemplates(undefined, { userId: "manager", email: "manager@example.com", name: "流程模板管理员", status: "active", adminPermissions: [permissions.workflowTemplateManage] });
    fireEvent.click(await screen.findByRole("button", { name: "发起发布流程" }));
    fireEvent.click(screen.getByRole("button", { name: "确认发起" }));
    expect(await screen.findByText(/limited-instance/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查看流程任务详情" })).not.toBeInTheDocument();
  });
});

function renderInstances(path = "/admin/workflow-instances") {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[path]}><Routes>
      <Route element={<WorkflowInstancesPage />} path="/admin/workflow-instances" />
      <Route element={<WorkflowInstanceDetailPage />} path="/admin/workflow-instances/:id" />
    </Routes></MemoryRouter>
  </QueryClientProvider>);
}

describe("WorkflowTemplatesPage", () => {
  it.each(["draft", "enabled", "disabled"] as const)("普通模板在 %s 状态可只读查看完整流程", async status => {
    const template: WorkflowTemplate = { id: "preview", name: "内容生产流程", description: "先生成内容，再人工审核", status, revision: 3, created_at: "", nodes: [
      { node_id: "generate", order: 0, type: "agent", title: "生成内容", instruction: "根据主题生成正文", assignee_user_id: "a" },
      { node_id: "review", order: 1, type: "approval", title: "人工审核", instruction: "核对内容后确认", assignee_user_ids: ["b"], assignee_role_ids: ["reviewers"] }
    ] };
    vi.mocked(workflowAdmin.templates).mockResolvedValue({ items: [template], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.assignees).mockResolvedValue({ items: [{ user_id: "a", name: "张三", email: "a@example.com" }, { user_id: "b", name: "李四", email: "b@example.com" }], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.roles).mockResolvedValue({ items: [{ role_id: "reviewers", name: "审核组" }], meta: { next_cursor: "" } });
    renderTemplates();
    const row = await screen.findByRole("row", { name: /内容生产流程/ });
    fireEvent.click(within(row).getByRole("button", { name: "查看流程" }));
    const preview = screen.getByRole("dialog");
    expect(within(preview).getByText("ID：")).toBeInTheDocument();
    expect(within(preview).getByText("preview", { selector: "code" })).toBeInTheDocument();
    expect(within(preview).getByText("先生成内容，再人工审核")).toBeInTheDocument();
    expect(within(preview).getAllByRole("heading", { level: 3 }).map(item => item.textContent)).toEqual(["1. 生成内容", "2. 人工审核"]);
    expect(within(preview).getByText("根据主题生成正文")).toBeInTheDocument();
    expect(within(preview).getByText("核对内容后确认")).toBeInTheDocument();
    expect(await within(preview).findByText("负责人：李四、角色：审核组")).toBeInTheDocument();
    expect(within(preview).getByText("Agent")).toBeInTheDocument();
    expect(within(preview).getByText("审批")).toBeInTheDocument();
    expect(within(preview).queryByRole("textbox")).not.toBeInTheDocument();
    expect(workflowAdmin.save).not.toHaveBeenCalled();
    expect(workflowAdmin.status).not.toHaveBeenCalled();
    expect(workflowAdmin.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭详情抽屉" }));
    expect(within(row).getByRole("link", { name: /编辑内容生产流程/ })).toBeInTheDocument();
  });

  it("普通草稿模板没有节点时展示空状态", async () => {
    vi.mocked(workflowAdmin.templates).mockResolvedValue({ items: [{ id: "empty-preview", name: "空草稿", description: "", status: "draft", revision: 1, nodes: [], created_at: "" }], meta: { next_cursor: "" } });
    renderTemplates();
    fireEvent.click(within(await screen.findByRole("row", { name: /空草稿/ })).getByRole("button", { name: "查看流程" }));
    expect(within(screen.getByRole("dialog")).getByText("暂无执行节点")).toBeInTheDocument();
  });

  it("内置模板与普通模板共用表格，保留只读入口", async () => {
    vi.mocked(workflowAdmin.templates).mockResolvedValue({ items: [{ id: "normal", name: "普通模板", description: "", status: "enabled", revision: 1, nodes: [], created_at: "" }], meta: { next_cursor: "" } });
    renderTemplates();
    const builtin = await screen.findByRole("row", { name: /Skill 审批工作流/ });
    const table = screen.getByRole("table");
    expect(table).toContainElement(builtin);
    expect(table).toContainElement(screen.getByRole("row", { name: /普通模板/ }));
    expect(within(builtin).getByText("内置 · 只读")).toBeInTheDocument();
    expect(within(builtin).queryByRole("button", { name: /发起|编辑/ })).not.toBeInTheDocument();
    fireEvent.click(within(builtin).getByRole("button", { name: "查看流程" }));
    expect(screen.queryByText(/^ID：/)).not.toBeInTheDocument();
    expect(await screen.findByText("静态分析")).toBeInTheDocument();
    expect(skillReviewWorkflowApi.runs).not.toHaveBeenCalled();
  });

  it("可多选账户与角色，保存全部主体而不是第一人", async () => {
    vi.mocked(workflowAdmin.assignees).mockResolvedValue({ items: [{ user_id: "a", name: "张三", email: "a@example.com" }, { user_id: "b", name: "李四", email: "b@example.com" }], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.roles).mockResolvedValue({ items: [{ role_id: "reviewers", name: "审核组" }, { role_id: "writers", name: "编写组" }], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.save).mockImplementation(async input => ({ ...input, id: "multi", status: "draft", revision: 1, created_at: "" }) as WorkflowTemplate);
    renderTemplates("/admin/workflow-templates/new");
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "多人审核" } });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.click(screen.getByRole("button", { name: "选择负责人" }));
    fireEvent.click(await screen.findByRole("option", { name: /张三/ }));
    fireEvent.click(screen.getByRole("option", { name: /李四/ }));
    await act(async () => { fireEvent.keyDown(screen.getByLabelText("搜索负责人"), { key: "Escape" }); });
    await waitFor(() => expect(screen.queryByLabelText("搜索负责人")).not.toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "选择负责人角色" })); });
    fireEvent.click(await screen.findByRole("option", { name: /审核组/ }));
    fireEvent.click(screen.getByRole("option", { name: /编写组/ }));
    await act(async () => { fireEvent.keyDown(screen.getByLabelText("搜索负责人角色"), { key: "Escape" }); });
    expect(screen.getByText(/任一候选完成即可流转/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(workflowAdmin.save).toHaveBeenCalledWith(expect.objectContaining({ nodes: [expect.objectContaining({ assignee_user_ids: ["a", "b"], assignee_role_ids: ["reviewers", "writers"] })] })));
  });

  it("仅后续节点可选择发起人并保存动态负责人", async () => {
    vi.mocked(workflowAdmin.assignees).mockResolvedValue({ items: [], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.save).mockImplementation(async input => ({ ...input, id: "initiator-template", status: "draft", revision: 1, created_at: "" }) as WorkflowTemplate);
    renderTemplates("/admin/workflow-templates/new");
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "发起人参与" } });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.click(screen.getByRole("button", { name: "选择负责人" }));
    expect(screen.queryByRole("option", { name: /发起人/ })).not.toBeInTheDocument();
    await act(async () => { fireEvent.keyDown(screen.getByLabelText("搜索负责人"), { key: "Escape" }); });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.click(screen.getByRole("button", { name: "选择负责人" }));
    fireEvent.click(screen.getByRole("option", { name: /发起人/ }));
    expect(screen.getByRole("button", { name: "选择负责人" })).toHaveTextContent("发起人");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(workflowAdmin.save).toHaveBeenCalledWith(expect.objectContaining({ nodes: [expect.anything(), expect.objectContaining({ assignee_initiator: true })] })));
  });

  it("仅角色节点可以通过前端启用校验", async () => {
    const template: WorkflowTemplate = { id: "role-template", name: "角色审核", description: "", status: "draft", revision: 1, created_at: "", nodes: [{ node_id: "review", order: 0, type: "approval", title: "审核", instruction: "审核", assignee_user_ids: [], assignee_role_ids: ["reviewers"] }] };
    vi.mocked(workflowAdmin.template).mockResolvedValue(template);
    vi.mocked(workflowAdmin.status).mockResolvedValue({ ...template, status: "enabled" });
    renderTemplates("/admin/workflow-templates/role-template");
    fireEvent.click(await screen.findByRole("button", { name: "启用" }));
    await waitFor(() => expect(workflowAdmin.status).toHaveBeenCalledWith("role-template", true));
  });
  it("shows both editor sections before nodes are added and after the last node is removed", () => {
    renderTemplates("/admin/workflow-templates/new");
    expect(screen.getByRole("heading", { name: "执行顺序" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "节点配置" })).toBeInTheDocument();
    expect(screen.getByText("暂无执行节点")).toBeInTheDocument();
    expect(screen.getByText("暂无节点配置")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    expect(screen.queryByText("暂无执行节点")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无节点配置")).not.toBeInTheDocument();
    expect(screen.getByText("第 1 步")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /未命名节点/ })).toHaveAttribute("aria-current", "step");
    expect(screen.getByLabelText("标题")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除节点" }));
    expect(screen.getByText("暂无执行节点")).toBeInTheDocument();
    expect(screen.getByText("暂无节点配置")).toBeInTheDocument();
  });

  it("adds distinct nodes when randomUUID is unavailable", async () => {
    const browserCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: browserCrypto.getRandomValues.bind(browserCrypto) });
    try {
      vi.mocked(workflowAdmin.templates).mockResolvedValue({ items: [], meta: { next_cursor: "" } });
      vi.mocked(workflowAdmin.assignees).mockResolvedValue({ items: [], meta: { next_cursor: "" } });
      vi.mocked(workflowAdmin.save).mockResolvedValue({ id: "template-1", name: "选题", description: "", nodes: [], status: "draft", revision: 1, created_at: "" });
      renderTemplates();
      fireEvent.click(screen.getByRole("link", { name: "新建流程模板" }));
      fireEvent.change(screen.getByLabelText("名称"), { target: { value: "选题" } });
      fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
      fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
      expect(screen.getAllByRole("button", { name: /未命名节点/ })).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      await waitFor(() => expect(workflowAdmin.save).toHaveBeenCalled());
      const ids = vi.mocked(workflowAdmin.save).mock.calls[0][0].nodes.map((node) => node.node_id);
      expect(ids).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/), expect.stringMatching(/^[0-9a-f]{32}$/)]);
      expect(new Set(ids).size).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("saves node order after keyboard-accessible move", async () => {
    vi.mocked(workflowAdmin.templates).mockResolvedValue({ items: [], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.assignees).mockResolvedValue({ items: [{ user_id: "a", name: "负责人", email: "a@example.com" }], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.save).mockImplementation(async input => ({ ...input, id: "template-1", status: "draft", revision: 1, created_at: "" }) as WorkflowTemplate);
    vi.mocked(workflowAdmin.template).mockResolvedValue({ id: "template-1", name: "选题", description: "", nodes: [], status: "draft", revision: 1, created_at: "" });
    renderTemplates();
    fireEvent.click(screen.getByRole("link", { name: "新建流程模板" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "选题" } });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "第一步" } });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "第二步" } });
    fireEvent.click(screen.getByRole("button", { name: "上移节点" }));
    expect(screen.getByText("第 1 步")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /第二步/ })).toHaveAttribute("aria-current", "step");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(workflowAdmin.save).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({ title: "第二步", order: 0 }), expect.objectContaining({ title: "第一步", order: 1 })]
    })));
  });

  it("selects the invalid node before enabling and searches assignees", async () => {
    const template: WorkflowTemplate = { id: "template-2", name: "选题", description: "", status: "draft", revision: 1, created_at: "", nodes: [
      { node_id: "one", order: 0, type: "agent", title: "生成", instruction: "生成", assignee_user_id: "a" },
      { node_id: "two", order: 1, type: "approval", title: "", instruction: "审核", assignee_user_id: "a" }
    ] };
    vi.mocked(workflowAdmin.templates).mockResolvedValue({ items: [template], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.template).mockResolvedValue(template);
    vi.mocked(workflowAdmin.assignees).mockResolvedValue({ items: [{ user_id: "a", name: "负责人", email: "a@example.com" }], meta: { next_cursor: "" } });
    renderTemplates();
    expect(await screen.findByText("负责人")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("link", { name: /编辑选题.*版本 1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "启用" }));
    expect(screen.getByText("节点 2：请填写标题")).toBeInTheDocument();
    expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe("");
    expect(workflowAdmin.status).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "选择负责人" }));
    fireEvent.change(screen.getByLabelText("搜索负责人"), { target: { value: "负责人" } });
    await waitFor(() => expect(workflowAdmin.assignees).toHaveBeenCalledWith("负责人"));
  });

  it("selects an assignee by name and saves its ID", async () => {
    vi.mocked(workflowAdmin.assignees).mockResolvedValue({ items: [{ user_id: "user-1", name: "张三", email: "zhang@example.com" }], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.save).mockImplementation(async input => ({ ...input, id: "template-1", status: "draft", revision: 1, created_at: "" }) as WorkflowTemplate);
    renderTemplates("/admin/workflow-templates/new");
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "选题" } });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.click(screen.getByRole("button", { name: "选择负责人" }));
    fireEvent.click(await screen.findByRole("option", { name: /张三/ }));
    expect(screen.getByRole("button", { name: "选择负责人" })).toHaveTextContent("张三");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(workflowAdmin.save).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({ assignee_user_ids: ["user-1"] })]
    })));
    expect(await screen.findByRole("heading", { name: "编辑流程模板" })).toBeInTheDocument();
  });
});

describe("WorkflowInstancesPage", () => {
  it("Skill AI 审核与普通流程任务共用按时间排序的任务列表", async () => {
    vi.mocked(workflowAdmin.instances).mockResolvedValue({ items: [{ id: "normal-task", template_id: "normal", template_revision: 1, nodes: [{ node_id: "one", order: 0, type: "agent", title: "整理内容", instruction: "整理" }], status: "running", started_by: "a", user_names: { a: "张三" }, started_at: "2026-10-20T00:00:00Z" }], meta: { next_cursor: "" } });
    vi.mocked(skillReviewWorkflowApi.runs).mockResolvedValue({ items: [{ request_id: "round/1", skill_id: "skill", skill_name: "测试 Skill", version_id: "v1", version: "1.0", uploaded_by: "writer", workflow_stage: "ai_running", approved: 0, total: 2, created_at: "2026-10-21T00:00:00Z" }], meta: { next_cursor: "" } });
    renderInstances();
    const skill = await screen.findByRole("row", { name: /测试 Skill/ });
    expect(screen.getByRole("table")).toContainElement(skill);
    expect(screen.getByRole("table")).toContainElement(screen.getByRole("row", { name: /整理内容/ }));
    expect(screen.getAllByRole("row")[1]).toBe(skill);
    expect(within(skill).getByText("AI 评估中")).toBeInTheDocument();
    expect(within(skill).getByRole("link", { name: /查看.*详情/ })).toHaveAttribute("href", "/admin/approvals/skill/round%2F1");
  });

  it("展示流程任务候选快照和实际处理人，不依赖角色当前成员", async () => {
    vi.mocked(workflowAdmin.instance).mockResolvedValue({ id: "shared-instance", template_id: "template-1", template_revision: 1, status: "succeeded", started_by: "a", started_at: "2026-09-30T00:00:00Z", user_names: { a: "张三", b: "李四" }, nodes: [{ node_id: "review", order: 0, type: "approval", title: "审核", instruction: "审核", assignee_user_id: "a", assignee_role_ids: ["reviewers"], resolved_user_ids: ["a", "b"] }], tasks: [{ task_id: "task-1", node_id: "review", status: "completed", input: {}, assignee_user_id: "a", assignee_user_ids: ["a", "b"], handled_by: "b" }] });
    renderInstances("/admin/workflow-instances/shared-instance");
    expect(await screen.findByText("负责人：张三、李四")).toBeInTheDocument();
    expect(screen.getByText("实际处理人：李四")).toBeInTheDocument();
  });
  it("shows an empty state when no instances match", async () => {
    vi.mocked(workflowAdmin.instances).mockResolvedValue({ items: [], meta: { next_cursor: "" } });
    renderInstances();
    expect(await screen.findByText("暂无流程任务")).toBeInTheDocument();
  });

  it("shows the assignee, completion time and actual handler", async () => {
    vi.mocked(workflowAdmin.instances).mockResolvedValue({ items: [{ id: "instance-1", template_id: "template-1", template_revision: 1, nodes: [], status: "succeeded", started_by: "a", user_names: { a: "发起人姓名" }, started_at: "2026-09-21T00:00:00Z" }], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.instance).mockResolvedValue({ id: "instance-1", template_id: "template-1", template_revision: 1, status: "succeeded", started_by: "a", user_names: { a: "发起人姓名", b: "负责人姓名", c: "处理人姓名" }, started_at: "2026-09-21T00:00:00Z", nodes: [{ node_id: "one", order: 0, type: "agent", title: "生成", instruction: "生成", assignee_user_id: "b" }], tasks: [{ task_id: "task-1", node_id: "one", status: "completed", assignee_user_id: "b", input: { text: "初始内容", internal: "不展示" }, output: { text: "**完成**\n\n[参考](https://example.com)\n<script>unsafe()</script>", internal: "也不展示" }, handled_by: "c", completed_at: "2026-09-21T01:00:00Z" }] });
    renderInstances();
    expect(await screen.findByText("发起人姓名")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("link", { name: /查看流程任务 instance-1 详情/ }));
    expect(await screen.findByRole("heading", { name: "流程任务详情" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回列表" })).toHaveAttribute("href", "/admin/workflow-instances");
    expect(await screen.findByText(/负责人：负责人姓名 · 完成于 /)).toBeInTheDocument();
    expect(screen.getByText(/实际处理人：/)).toBeInTheDocument();
    expect(screen.getByText("发起人姓名")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开节点“生成”的内容" }));
    expect(screen.getByText("初始内容")).toBeInTheDocument();
    expect(screen.getByText("完成")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "参考" })).toHaveAttribute("href", "https://example.com");
    expect(screen.queryByText("unsafe()")).not.toBeInTheDocument();
    expect(screen.queryByText(/internal|不展示|也不展示|"text"/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起节点“生成”的内容" }));
    expect(screen.queryByText("初始内容")).not.toBeInTheDocument();
  });

  it("loads an instance directly from its detail URL", async () => {
    vi.mocked(workflowAdmin.instance).mockResolvedValue({ id: "instance-direct", template_id: "template-1", template_revision: 2, nodes: [], status: "rejected", started_by: "a", started_at: "2026-09-21T00:00:00Z" });
    vi.mocked(workflowAdmin.instances).mockClear();
    renderInstances("/admin/workflow-instances/instance-direct");
    expect(await screen.findByRole("heading", { name: "流程任务 e-direct" })).toBeInTheDocument();
    expect(workflowAdmin.instance).toHaveBeenCalledWith("instance-direct");
    expect(workflowAdmin.instances).not.toHaveBeenCalled();
  });

  it("shows approval input, output and comment as text when expanded", async () => {
    vi.mocked(workflowAdmin.instance).mockResolvedValue({ id: "instance-approval", template_id: "template-1", template_revision: 1, status: "succeeded", started_by: "a", started_at: "2026-09-21T00:00:00Z", nodes: [{ node_id: "approve", order: 0, type: "approval", title: "确认内容", instruction: "确认后继续", assignee_user_id: "a" }], tasks: [{ task_id: "task-1", node_id: "approve", status: "completed", assignee_user_id: "a", input: { text: "待审核正文" }, output: { text: "待审核正文" }, decision: "approve", comment: "通过验收" }] });
    renderInstances("/admin/workflow-instances/instance-approval");
    fireEvent.click(await screen.findByRole("button", { name: "展开节点“确认内容”的内容" }));
    expect(screen.getByText("确认后继续")).toBeInTheDocument();
    expect(screen.getAllByText("待审核正文")).toHaveLength(2);
    expect(screen.getByText("审批：批准 · 通过验收")).toBeInTheDocument();
  });

  it("shows an error when an instance cannot be loaded", async () => {
    vi.mocked(workflowAdmin.instance).mockRejectedValue(new Error("流程任务不存在"));
    renderInstances("/admin/workflow-instances/missing");
    expect(await screen.findByText("流程任务详情加载失败：流程任务不存在")).toBeInTheDocument();
  });

  it("confirms before terminating a running instance", async () => {
    const instance = { id: "instance-2", template_id: "template-1", template_revision: 1, nodes: [], status: "running", started_by: "a", started_at: "2026-09-21T00:00:00Z" };
    vi.mocked(workflowAdmin.instances).mockResolvedValue({ items: [instance], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.instance).mockResolvedValue(instance);
    vi.mocked(workflowAdmin.terminate).mockResolvedValue({ ...instance, status: "terminated" });
    renderInstances();
    fireEvent.click(await screen.findByRole("link", { name: "查看流程任务 instance-2 详情" }));
    fireEvent.change(await screen.findByLabelText("终止原因"), { target: { value: "停止测试" } });
    fireEvent.click(screen.getByRole("button", { name: "终止流程任务" }));
    expect(workflowAdmin.terminate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认终止" }));
    await waitFor(() => expect(workflowAdmin.terminate).toHaveBeenCalledWith("instance-2", "停止测试"));
  });
});
