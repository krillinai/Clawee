import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPermissionsProvider } from "./admin-permissions";
import { Table, TableBody } from "./ui/table";
import { SkillReviewWorkflow } from "./skill-review-workflow";
import { skillReviewWorkflowApi } from "@/lib/skill-review-workflow-api";
import { permissions } from "@/lib/rbac-api";

vi.mock("@/lib/skill-review-workflow-api", () => ({ skillReviewWorkflowApi: { definition: vi.fn(), runs: vi.fn() } }));

function mount(grants = [permissions.workflowTemplateManage, permissions.workflowInstanceRead, permissions.skillRead]) {
 const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
 render(<QueryClientProvider client={cache}><AdminPermissionsProvider account={{ userId: "admin", email: "admin@test.invalid", name: "管理员", status: "active", adminPermissions: grants }}><MemoryRouter><Table><TableBody><SkillReviewWorkflow /></TableBody></Table></MemoryRouter></AdminPermissionsProvider></QueryClientProvider>);
}

beforeEach(() => {
 vi.clearAllMocks();
 vi.mocked(skillReviewWorkflowApi.definition).mockResolvedValue({ id: "builtin:skill-review", name: "Skill 审批工作流", trigger: "upload", read_only: true, review_skill: "skill-review", steps: [{ name: "AI 评估", rule: "只有有效通过才进入人工" }] });
 vi.mocked(skillReviewWorkflowApi.runs).mockResolvedValue({ items: [{ request_id: "round-a", skill_id: "skill-a", skill_name: "测试Skill", version_id: "version-a", version: "1", uploaded_by: "writer", workflow_stage: "approved", ai_conclusion: "recommend_approve", review_skill_version: "1.0.0", approved: 2, total: 2, score_total: 20, created_at: "2026-10-20T00:00:00Z" }], meta: { next_cursor: "next" } });
});

describe("内置Skill审批工作流", () => {
 it("展示模板表格行，详情只展示只读流程定义", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "查看流程" }));
  expect(await screen.findByText("只有有效通过才进入人工")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看流程任务" })).toHaveAttribute("href", "/admin/workflow-instances");
  expect(screen.queryByRole("button", { name: /编辑|启用|删除|手工发起|终止/ })).not.toBeInTheDocument();
  expect(skillReviewWorkflowApi.runs).not.toHaveBeenCalled();
 });
 it("仅定义权限不能请求运行记录", async () => {
  mount([permissions.workflowTemplateManage]);
  fireEvent.click(await screen.findByRole("button", { name: "查看流程" }));
  await screen.findByText("只有有效通过才进入人工");
  expect(screen.queryByRole("link", { name: "查看流程任务" })).not.toBeInTheDocument();
  expect(skillReviewWorkflowApi.runs).not.toHaveBeenCalled();
 });
 it("定义加载失败可以重试，错误不展示内部正文", async () => {
  const definition = await vi.mocked(skillReviewWorkflowApi.definition)();
  vi.mocked(skillReviewWorkflowApi.definition).mockRejectedValueOnce(new Error("内部凭据")).mockResolvedValue(definition);
  mount();
  await screen.findByText("内置流程模板加载失败。");
  expect(screen.queryByText("内部凭据")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "查看流程" })).toBeInTheDocument());
 });
});
