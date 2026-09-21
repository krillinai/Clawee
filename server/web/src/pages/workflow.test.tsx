import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { workflowAdmin, type WorkflowTemplate } from "@/lib/workflow-api";
import { WorkflowInstancesPage, WorkflowTemplateEditorPage, WorkflowTemplatesPage } from "./workflow";

vi.mock("@/lib/workflow-api", () => ({
  workflowAdmin: {
    templates: vi.fn(), template: vi.fn(), assignees: vi.fn(), save: vi.fn(), status: vi.fn(), instances: vi.fn(), instance: vi.fn(), terminate: vi.fn()
  }
}));

function renderTemplates(path = "/admin/workflow-templates") {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[path]}><Routes>
      <Route element={<WorkflowTemplatesPage />} path="/admin/workflow-templates" />
      <Route element={<WorkflowTemplateEditorPage />} path="/admin/workflow-templates/new" />
      <Route element={<WorkflowTemplateEditorPage />} path="/admin/workflow-templates/:id" />
    </Routes></MemoryRouter>
  </QueryClientProvider>);
}

describe("WorkflowTemplatesPage", () => {
  it("adds distinct nodes when randomUUID is unavailable", async () => {
    const browserCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: browserCrypto.getRandomValues.bind(browserCrypto) });
    try {
      vi.mocked(workflowAdmin.templates).mockResolvedValue({ items: [], meta: { next_cursor: "" } });
      vi.mocked(workflowAdmin.assignees).mockResolvedValue({ items: [], meta: { next_cursor: "" } });
      vi.mocked(workflowAdmin.save).mockResolvedValue({ id: "template-1", name: "选题", description: "", nodes: [], status: "draft", revision: 1, created_at: "" });
      renderTemplates();
      fireEvent.click(screen.getByRole("link", { name: "新建模板" }));
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
    fireEvent.click(screen.getByRole("link", { name: "新建模板" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "选题" } });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "第一步" } });
    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "第二步" } });
    fireEvent.click(screen.getByRole("button", { name: "上移节点" }));
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
      nodes: [expect.objectContaining({ assignee_user_id: "user-1" })]
    })));
    expect(await screen.findByRole("heading", { name: "编辑工作流模板" })).toBeInTheDocument();
  });
});

describe("WorkflowInstancesPage", () => {
  it("shows an empty state when no instances match", async () => {
    vi.mocked(workflowAdmin.instances).mockResolvedValue({ items: [], meta: { next_cursor: "" } });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><WorkflowInstancesPage /></QueryClientProvider>);
    expect(await screen.findByText("暂无工作流实例")).toBeInTheDocument();
  });

  it("shows the handler and completion time", async () => {
    vi.mocked(workflowAdmin.instances).mockResolvedValue({ items: [{ id: "instance-1", template_id: "template-1", template_revision: 1, nodes: [], status: "succeeded", started_by: "a", started_at: "2026-09-21T00:00:00Z" }], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.instance).mockResolvedValue({ id: "instance-1", template_id: "template-1", template_revision: 1, status: "succeeded", started_by: "a", started_at: "2026-09-21T00:00:00Z", nodes: [{ node_id: "one", order: 0, type: "agent", title: "生成", instruction: "生成", assignee_user_id: "a" }], tasks: [{ task_id: "task-1", node_id: "one", status: "completed", assignee_user_id: "a", input: {}, output: { text: "完成" }, handled_by: "a", completed_at: "2026-09-21T01:00:00Z" }] });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><WorkflowInstancesPage /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /instance-1/ }));
    expect(await screen.findByText(/处理人：a/)).toBeInTheDocument();
  });

  it("confirms before terminating a running instance", async () => {
    const instance = { id: "instance-2", template_id: "template-1", template_revision: 1, nodes: [], status: "running", started_by: "a", started_at: "2026-09-21T00:00:00Z" };
    vi.mocked(workflowAdmin.instances).mockResolvedValue({ items: [instance], meta: { next_cursor: "" } });
    vi.mocked(workflowAdmin.instance).mockResolvedValue(instance);
    vi.mocked(workflowAdmin.terminate).mockResolvedValue({ ...instance, status: "terminated" });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><WorkflowInstancesPage /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "查看实例 instance-2 详情" }));
    fireEvent.change(await screen.findByLabelText("终止原因"), { target: { value: "停止测试" } });
    fireEvent.click(screen.getByRole("button", { name: "终止实例" }));
    expect(workflowAdmin.terminate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认终止" }));
    await waitFor(() => expect(workflowAdmin.terminate).toHaveBeenCalledWith("instance-2", "停止测试"));
  });
});
