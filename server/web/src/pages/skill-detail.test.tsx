import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPermissionsProvider } from "@/components/admin-permissions";
import { permissions } from "@/lib/rbac-api";
import { APIError } from "@/lib/api";

import {
  clearCurrentSkillVersion,
  getSkill,
  getSkillVersionFile,
  listSkillSpaces,
  listSkillVersionFiles,
  publishOwnSkillVersion,
  setCurrentSkillVersion,
  reviewSkillVersion,
  resubmitSkillReview,
  SkillHubAPIError,
  type AdminSkillDetail,
  type SkillSpace,
  type SkillVersion
} from "@/lib/skillhub-api";

import { SkillDetailPage } from "./skill-detail";

vi.mock("@/lib/skillhub-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/skillhub-api")>("@/lib/skillhub-api");
  return {
    ...actual,
    clearCurrentSkillVersion: vi.fn(),
    getSkill: vi.fn(),
    getSkillVersionFile: vi.fn(),
    listSkillSpaces: vi.fn(),
    listSkillVersionFiles: vi.fn(),
    publishOwnSkillVersion: vi.fn(),
    setCurrentSkillVersion: vi.fn(),
    reviewSkillVersion: vi.fn(),
    resubmitSkillReview: vi.fn()
  };
});

const getSkillMock = vi.mocked(getSkill);
const listSkillVersionFilesMock = vi.mocked(listSkillVersionFiles);
const getSkillVersionFileMock = vi.mocked(getSkillVersionFile);
const setCurrentSkillVersionMock = vi.mocked(setCurrentSkillVersion);
const clearCurrentSkillVersionMock = vi.mocked(clearCurrentSkillVersion);

const detail: AdminSkillDetail = {
  skill: {
    skillId: "skill-1",
    spaceId: "skillspace_default",
    name: "web-tools-guide",
    description: "为企业 Agent 提供网页工具使用规范。",
    currentVersionId: "version-2",
    createdBy: "usr_admin",
    createdAt: "2026-07-27T08:00:00Z",
    updatedAt: "2026-07-27T10:00:00Z"
  },
  versions: [
    version({ versionId: "version-1", version: "1.0.0", createdAt: "2026-07-27T08:30:00Z" }),
    version({ versionId: "version-2", version: "1.1.0", createdAt: "2026-07-27T09:30:00Z" }),
    version({ versionId: "version-3", version: "1.2.0", createdAt: "2026-07-27T10:30:00Z" })
  ]
};

const approvalConfigurations: Array<{ name: string; config: Partial<SkillSpace> }> = [
  { name: "仅账户", config: { approvers: [{ userId: "reviewer", name: "审批人" }] } },
  { name: "仅角色", config: { approvers: [], approverRoleIds: ["reviewers"] } },
  { name: "账户与角色", config: { approvers: [{ userId: "reviewer", name: "审批人" }], approverRoleIds: ["reviewers"] } },
  { name: "仅角色详情", config: { approvers: [], approverRoles: [{ roleId: "reviewers", name: "审核组" }] } }
];

describe("SkillDetailPage", () => {
  it.each(["pending", "running", "failed"] as const)("旧管理入口 %s 展示本轮 AI 报告与审批中心链接，不开放评分", async status => {
    getSkillMock.mockResolvedValue(reviewDetail({ localApproval: { ...reviewerProgress(), aiReview: { status, attemptId: "attempt", agentId: "agent", updatedAt: "2026-10-09T09:00:00Z", report: { conclusion: "needs_attention", summary: "管理入口本轮摘要", findings: [] } } } }));
    renderPage();
    expect(await screen.findByText("管理入口本轮摘要")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往审批中心处理 AI 审核" })).toHaveAttribute("href", "/app/approvals/skill/request-1");
    expect(screen.queryByRole("button", { name: "审批通过" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "驳回" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试 AI 审核" })).not.toBeInTheDocument();
    expect(reviewSkillVersion).not.toHaveBeenCalled();
  });

  it.each(["completed", "manual"] as const)("旧管理入口 %s 仍按原人工四维评分，不预填 AI 建议", async status => {
    getSkillMock.mockResolvedValue(reviewDetail({ localApproval: { ...reviewerProgress(), aiReview: { status, attemptId: "attempt", agentId: "agent", updatedAt: "2026-10-09T09:00:00Z", report: { conclusion: "recommend_approve", summary: "建议通过", findings: [], suggestedScores: { scenario_value: 5, result_effectiveness: 5, ease_of_use: 5, reuse_value: 5 } } } } }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "审批通过" }));
    const dialog = screen.getByRole("dialog", { name: "通过版本审批" });
    expect(within(dialog).getByRole("button", { name: "确认" })).toBeDisabled();
    expect(within(dialog).getByRole("combobox", { name: "场景价值" })).not.toHaveTextContent("5 分");
  });
  it.each(approvalConfigurations)("$name 审批全员通过后，非上传者管理员使用正常发布接口", async ({ config }) => {
    const [space] = await listSkillSpaces();
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, ...config }]);
    const approvedVersion = version({
      uploadedByUserId: "writer-id",
      localApproval: { status: "approved", total: 2, approved: 2, approvers: [
        { userId: "reviewer", name: "审批人", status: "approved", comment: "", decidedAt: null },
        { userId: "role-reviewer", name: "角色审批人", status: "approved", comment: "", decidedAt: null }
      ] }
    });
    getSkillMock.mockResolvedValue({ ...detail, skill: { ...detail.skill, currentVersionId: null }, versions: [approvedVersion] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "设为当前查看版本 1.0.0" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "设为当前版本" })).getByRole("button", { name: /确认发布/ }));
    await waitFor(() => expect(setCurrentSkillVersionMock).toHaveBeenCalledWith("skill-1", "version-default"));
    expect(publishOwnSkillVersion).not.toHaveBeenCalled();
  });

  it.each(approvalConfigurations)("$name 审批待审时，上传者没有免审发布入口", async ({ config }) => {
    const [space] = await listSkillSpaces();
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, ...config }]);
    getSkillMock.mockResolvedValue({ ...detail, skill: { ...detail.skill, currentVersionId: null }, versions: [version({ approvalStatus: "pending", uploadedByUserId: "writer-id", localApproval: reviewerProgress() })] });
    renderPage(true);
    await screen.findByText("当前查看版本 1.0.0");
    expect(screen.queryByRole("button", { name: /设为当前/ })).not.toBeInTheDocument();
    expect(publishOwnSkillVersion).not.toHaveBeenCalled();
  });

  it("仅角色审批部分通过时，管理员不能发布", async () => {
    const [space] = await listSkillSpaces();
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, approvers: [], approverRoleIds: ["reviewers"] }]);
    getSkillMock.mockResolvedValue({ ...detail, skill: { ...detail.skill, currentVersionId: null }, versions: [version({ approvalStatus: "pending", localApproval: { ...reviewerProgress(), total: 2, approved: 1 } })] });
    renderPage();
    expect(await screen.findByRole("button", { name: "设为当前查看版本 1.0.0" })).toBeDisabled();
    expect(setCurrentSkillVersionMock).not.toHaveBeenCalled();
  });

  it("无审批配置时，非上传者管理员不获得发布入口", async () => {
    const [space] = await listSkillSpaces();
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, approvers: [] }]);
    getSkillMock.mockResolvedValue({ ...detail, skill: { ...detail.skill, currentVersionId: null }, versions: [version({ uploadedByUserId: "writer-id" })] });
    renderPage();
    await screen.findByText("当前查看版本 1.0.0");
    expect(screen.queryByRole("button", { name: /设为当前/ })).not.toBeInTheDocument();
  });

  it("钉钉待审仍提供提交审批入口，上传者不能免审发布", async () => {
    const [space] = await listSkillSpaces();
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, approvalProvider: "dingtalk", approvers: [], externalApprovalTemplateId: "PROC-1" }]);
    getSkillMock.mockResolvedValue({ ...detail, skill: { ...detail.skill, currentVersionId: null }, versions: [version({ approvalStatus: "pending", uploadedByUserId: "writer-id" })] });
    renderPage(true);
    expect(await screen.findByRole("button", { name: "提交钉钉审批" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /设为当前/ })).not.toBeInTheDocument();
    expect(publishOwnSkillVersion).not.toHaveBeenCalled();
  });

  it("钉钉审批通过后，管理员仍使用正常发布接口", async () => {
    const [space] = await listSkillSpaces();
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, approvalProvider: "dingtalk", approvers: [], externalApprovalTemplateId: "PROC-1" }]);
    getSkillMock.mockResolvedValue({ ...detail, skill: { ...detail.skill, currentVersionId: null }, versions: [version({ uploadedByUserId: "writer-id", approvalInstance: { id: "approval-1", status: "finished", decision: "approved", providerInstanceId: "oa-1" } })] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "设为当前查看版本 1.0.0" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "设为当前版本" })).getByRole("button", { name: /确认发布/ }));
    await waitFor(() => expect(setCurrentSkillVersionMock).toHaveBeenCalledWith("skill-1", "version-default"));
    expect(publishOwnSkillVersion).not.toHaveBeenCalled();
  });

  it("allows the uploader to publish a pending version when approval is off", async () => {
    vi.mocked(listSkillSpaces).mockResolvedValue([{ spaceId: "skillspace_default", name: "默认技能空间", description: "", approvers: [], actions: [], memberCount: 0, skillCount: 1, publishedCount: 0, createdBy: "admin", updatedBy: "admin", createdAt: "2026-07-27T08:00:00Z", updatedAt: "2026-07-27T08:00:00Z" }]);
    getSkillMock.mockResolvedValue({ ...detail, skill: { ...detail.skill, currentVersionId: null }, versions: [version({ approvalStatus: "pending", uploadedByUserId: "writer-id" })] });
    vi.mocked(publishOwnSkillVersion).mockResolvedValue({ skill: detail.skill, version: version({}) });
    renderPage(true);
    fireEvent.click(await screen.findByRole("button", { name: "设为当前查看版本 1.0.0" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "设为当前版本" })).getByRole("button", { name: /确认发布/ }));
    await waitFor(() => expect(publishOwnSkillVersion).toHaveBeenCalledWith("skill-1", "version-default"));
    expect(setCurrentSkillVersionMock).not.toHaveBeenCalled();
  });

  it("keeps the reviewed update selected after approval so it can be published", async () => {
    const pending = { ...detail, canReview: true, versions: detail.versions.map((item) => item.versionId === "version-3" ? { ...item, approvalStatus: "pending" as const, localApproval: reviewerProgress() } : item) };
    getSkillMock.mockResolvedValueOnce(pending).mockResolvedValue({ ...detail, canReview: true });
    vi.mocked(reviewSkillVersion).mockResolvedValue(detail.versions[2]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "审批通过" }));
    const dialog = screen.getByRole("dialog", { name: "通过版本审批" });
    await fillScores(dialog);
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(screen.getByRole("button", { name: "设为当前查看版本 1.2.0" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "取消当前发布" })).not.toBeInTheDocument();
  });

  it.each(["approved", "rejected"] as const)("allows the space reviewer to submit an %s decision", async (decision) => {
    getSkillMock.mockResolvedValue({ ...detail, canReview: true, skill: { ...detail.skill, currentVersionId: null }, versions: [version({ versionId: "pending-version", approvalStatus: "pending", localApproval: reviewerProgress() })] });
    vi.mocked(reviewSkillVersion).mockResolvedValue(version({ approvalStatus: decision }));
    renderPage();
    const approve = await screen.findByRole("button", { name: "审批通过" });
    expect(screen.getByRole("button", { name: /设为当前查看版本/ })).toBeDisabled();
    fireEvent.click(decision === "approved" ? approve : screen.getByRole("button", { name: "驳回" }));
    const dialog = screen.getByRole("dialog", { name: decision === "approved" ? "通过版本审批" : "驳回版本" });
    if (decision === "approved") await fillScores(dialog);
    fireEvent.change(within(dialog).getByLabelText("审批意见"), { target: { value: "审核意见" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(reviewSkillVersion).toHaveBeenCalledWith("skill-1", "pending-version", "request-1", decision, "审核意见", decision === "approved" ? scores : {}));
  });

  it("旧 pending 通过仍需四项评分，不预填也不接受缺项", async () => {
    getSkillMock.mockResolvedValue(reviewDetail());
    vi.mocked(reviewSkillVersion).mockResolvedValue(version({}));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "审批通过" }));
    const dialog = screen.getByRole("dialog", { name: "通过版本审批" });
    expect(within(dialog).getByText(/manual-v1/)).toBeInTheDocument();
    expect(within(dialog).getAllByRole("combobox")).toHaveLength(4);
    for (const select of within(dialog).getAllByRole("combobox")) expect(select).toHaveTextContent("未评分");
    fireEvent.submit(dialog.querySelector("form")!);
    expect(reviewSkillVersion).not.toHaveBeenCalled();
    await selectScore(dialog, "场景价值", 1);
    await selectScore(dialog, "结果有效", 5);
    await selectScore(dialog, "使用友好", 3);
    expect(within(dialog).getByRole("button", { name: "确认" })).toBeDisabled();
    await selectScore(dialog, "复用价值", 4);
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(reviewSkillVersion).toHaveBeenCalledWith("skill-1", "pending-version", "request-1", "approved", "", { scenario_value: 1, result_effectiveness: 5, ease_of_use: 3, reuse_value: 4 }));
  });

  it("驳回拒绝空白意见，允许部分分值并在取消后清空", async () => {
    getSkillMock.mockResolvedValue(reviewDetail());
    vi.mocked(reviewSkillVersion).mockResolvedValue(version({ approvalStatus: "rejected" }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "驳回" }));
    let dialog = screen.getByRole("dialog", { name: "驳回版本" });
    fireEvent.change(within(dialog).getByLabelText("审批意见"), { target: { value: "   " } });
    fireEvent.submit(dialog.querySelector("form")!);
    expect(reviewSkillVersion).not.toHaveBeenCalled();
    await selectScore(dialog, "使用友好", 2);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "驳回" }));
    dialog = screen.getByRole("dialog", { name: "驳回版本" });
    expect(within(dialog).getByRole("combobox", { name: "使用友好" })).toHaveTextContent("未评分");
    expect(within(dialog).getByLabelText("审批意见")).toHaveValue("");
    await selectScore(dialog, "使用友好", 2);
    fireEvent.change(within(dialog).getByLabelText("审批意见"), { target: { value: "  说明不足  " } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(reviewSkillVersion).toHaveBeenCalledWith("skill-1", "pending-version", "request-1", "rejected", "说明不足", { ease_of_use: 2 }));
  });

  it("请求切换后关闭旧表单，重新打开不继承旧分值", async () => {
    getSkillMock.mockResolvedValue(reviewDetail());
    const { queryClient } = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "审批通过" }));
    const dialog = screen.getByRole("dialog", { name: "通过版本审批" });
    await selectScore(dialog, "场景价值", 4);
    getSkillMock.mockResolvedValue(reviewDetail({ localApproval: { ...reviewerProgress(), requestId: "request-2" } }));
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["skill", "skill-1"] }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "审批通过" }));
    expect(within(screen.getByRole("dialog")).getByRole("combobox", { name: "场景价值" })).toHaveTextContent("未评分");
  });

  it("切换查看版本后重新评分，不复用另一版本的输入", async () => {
    getSkillMock.mockResolvedValue({ ...detail, skill: { ...detail.skill, currentVersionId: null }, versions: [version({ versionId: "version-1", version: "1.0.0", localApproval: reviewerProgress(), approvalStatus: "pending" }), version({ versionId: "version-3", version: "1.2.0", createdAt: "2026-07-27T10:30:00Z", localApproval: { ...reviewerProgress(), requestId: "request-3" }, approvalStatus: "pending" })] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "审批通过" }));
    const dialog = screen.getByRole("dialog", { name: "通过版本审批" });
    await selectScore(dialog, "复用价值", 5);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    clickTab(screen.getByRole("tab", { name: "版本历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看此版本 1.0.0" }));
    fireEvent.click(screen.getByRole("button", { name: "审批通过" }));
    expect(within(screen.getByRole("dialog")).getByRole("combobox", { name: "复用价值" })).toHaveTextContent("未评分");
  });

  it("评分选项仅 1–5 整数，超长意见不能提交", async () => {
    getSkillMock.mockResolvedValue(reviewDetail());
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "驳回" }));
    const dialog = screen.getByRole("dialog", { name: "驳回版本" });
    fireEvent.click(within(dialog).getByRole("combobox", { name: "场景价值" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["未评分", "1 分", "2 分", "3 分", "4 分", "5 分"]);
    fireEvent.click(screen.getByRole("option", { name: "未评分" }));
    fireEvent.change(within(dialog).getByLabelText("审批意见"), { target: { value: "字".repeat(2001) } });
    fireEvent.submit(dialog.querySelector("form")!);
    expect(reviewSkillVersion).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "确认" })).toBeDisabled();
  });

  it.each(["pending", "approved", "rejected"])("%s 历史缺分不补零或自行汇总", async (status) => {
    const localApproval = { ...reviewerProgress(), status, approved: 1, approvers: [{ ...reviewerProgress().approvers[0], status: "approved" as const, scores: { scenario_value: 4 }, comment: "历史意见" }] };
    getSkillMock.mockResolvedValue(reviewDetail({ approvalStatus: status as SkillVersion["approvalStatus"], localApproval }));
    renderPage();
    expect(await screen.findByText("历史评分不完整")).toBeInTheDocument();
    expect(screen.getByText("场景价值：4 分")).toBeInTheDocument();
    expect(screen.getByText("结果有效：未评分")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "正式评分汇总" })).not.toBeInTheDocument();
    expect(screen.queryByText(/：0 分/)).not.toBeInTheDocument();
  });

  it("历史已结束无评分显示未评分，完整原始分也不代替后端汇总", async () => {
    getSkillMock.mockResolvedValue(reviewDetail({ approvalStatus: "approved", localApproval: { ...reviewerProgress(), status: "approved", approved: 1, approvers: [{ ...reviewerProgress().approvers[0], status: "approved" }] } }));
    const { queryClient } = renderPage();
    expect(await screen.findByText("历史记录未评分")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "正式评分汇总" })).not.toBeInTheDocument();
    getSkillMock.mockResolvedValue(reviewDetail({ approvalStatus: "approved", localApproval: { ...reviewerProgress(), status: "approved", approved: 1, approvers: [{ ...reviewerProgress().approvers[0], status: "approved", scores }] } }));
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["skill", "skill-1"] }); });
    expect(screen.queryByRole("group", { name: "正式评分汇总" })).not.toBeInTheDocument();
  });

  it("QA-B-01 全员通过且原始评分完整但无正式汇总时明确历史评分不完整", async () => {
    getSkillMock.mockResolvedValue(reviewDetail({ approvalStatus: "approved", localApproval: { ...reviewerProgress(), status: "approved", approved: 1, scoringStandardVersion: "manual-v1", approvers: [{ ...reviewerProgress().approvers[0], status: "approved", scores }] } }));
    renderPage();
    expect(await screen.findByText("已通过 1/1")).toBeInTheDocument();
    for (const label of ["场景价值", "结果有效", "使用友好", "复用价值"]) expect(screen.getByText(`${label}：4 分`)).toBeInTheDocument();
    expect(screen.getByText("历史评分不完整")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "正式评分汇总" })).not.toBeInTheDocument();
    expect(screen.queryByText(/总分：/)).not.toBeInTheDocument();
  });

  it("正式汇总只展示后端值且两位小数，pending 不展示总分", async () => {
    const localApproval = { ...reviewerProgress(), status: "approved", approved: 1, scoringStandardVersion: "manual-v1", approvers: [{ ...reviewerProgress().approvers[0], status: "approved" as const, scores }], scoreSummary: { scenario_value: 10 / 3, result_effectiveness: 11 / 3, ease_of_use: 13 / 3, reuse_value: 14 / 3, total: 16.125 } };
    getSkillMock.mockResolvedValue(reviewDetail({ approvalStatus: "approved", localApproval }));
    const { queryClient } = renderPage();
    const summary = await screen.findByRole("group", { name: "正式评分汇总" });
    expect(within(summary).getByText("场景价值：3.33")).toBeInTheDocument();
    expect(within(summary).getByText("复用价值：4.67")).toBeInTheDocument();
    expect(within(summary).getByText("总分：16.13 / 20")).toBeInTheDocument();
    getSkillMock.mockResolvedValue(reviewDetail({ localApproval: { ...localApproval, status: "pending" } }));
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["skill", "skill-1"] }); });
    expect(screen.queryByRole("group", { name: "正式评分汇总" })).not.toBeInTheDocument();
  });

  it.each([403, 409])("审批 %s 捕获原请求、禁止重复提交并刷新，不重试新请求", async (status) => {
    getSkillMock.mockResolvedValue(reviewDetail());
    let rejectReview: (error: Error) => void = () => {};
    vi.mocked(reviewSkillVersion).mockReturnValue(new Promise((_resolve, reject) => { rejectReview = reject; }));
    const { queryClient } = renderPage();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(await screen.findByRole("button", { name: "审批通过" }));
    const dialog = screen.getByRole("dialog", { name: "通过版本审批" });
    await fillScores(dialog);
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "提交中..." })).toBeDisabled());
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    for (const select of within(dialog).getAllByRole("combobox")) expect(select).toBeDisabled();
    fireEvent.submit(dialog.querySelector("form")!);
    getSkillMock.mockResolvedValue(reviewDetail({ localApproval: { ...reviewerProgress(), requestId: "request-2" } }));
    await act(async () => { rejectReview(new APIError("审核冲突", status, "approval_conflict")); });
    expect(await screen.findByText(status === 403 ? /审核权限已变化/ : /审核状态已变化/)).toBeInTheDocument();
    expect(reviewSkillVersion).toHaveBeenCalledExactlyOnceWith("skill-1", "pending-version", "request-1", "approved", "", scores);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["skill", "skill-1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["skills"] });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("原上传者重提捕获原请求，取消不提交，成功刷新新请求", async () => {
    getSkillMock.mockResolvedValue(rejectedDetail());
    let finishResubmit: (result: SkillVersion) => void = () => {};
    vi.mocked(resubmitSkillReview).mockReturnValue(new Promise((resolve) => { finishResubmit = resolve; }));
    const { queryClient } = renderPage(true, [permissions.skillRead, permissions.skillVersionUpload]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(await screen.findByRole("button", { name: "重新提交审核" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
    expect(resubmitSkillReview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新提交审核" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认重提" }));
    await waitFor(() => expect(resubmitSkillReview).toHaveBeenCalledExactlyOnceWith("skill-1", "pending-version", "request-1"));
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" })).toBeDisabled();
    getSkillMock.mockResolvedValue(reviewDetail({ uploadedByUserId: "writer-id", localApproval: { ...reviewerProgress(), requestId: "request-2" } }));
    await act(async () => { finishResubmit(version({})); });
    expect(await screen.findByText("已重新提交审核")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新提交审核" })).not.toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["skill", "skill-1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["skills"] });
  });

  it.each(["非上传者", "无上传权限", "来源版本", "已发布", "非驳回", "缺请求ID"])("%s 不显示重提入口", async (condition) => {
    const rejected = rejectedDetail();
    if (condition === "来源版本") rejected.versions[0].source = { sourceId: "source", repositoryOwner: "org", repositoryName: "repo", path: "skill", commitSha: "sha", contentSha256: "digest" };
    if (condition === "已发布") rejected.skill.currentVersionId = "pending-version";
    if (condition === "非驳回") rejected.versions[0].localApproval!.status = "pending";
    if (condition === "缺请求ID") rejected.versions[0].localApproval!.requestId = undefined;
    getSkillMock.mockResolvedValue(rejected);
    renderPage(condition !== "非上传者", condition === "无上传权限" ? [permissions.skillRead] : [permissions.skillRead, permissions.skillVersionUpload]);
    await screen.findByRole("heading", { name: "web-tools-guide" });
    expect(screen.queryByRole("button", { name: "重新提交审核" })).not.toBeInTheDocument();
  });

  it.each([403, 409])("重提 %s 刷新状态，保留原请求边界且不自动重试", async (status) => {
    getSkillMock.mockResolvedValue(rejectedDetail());
    vi.mocked(resubmitSkillReview).mockRejectedValue(new APIError("重提冲突", status, "approval_conflict"));
    const { queryClient } = renderPage(true, [permissions.skillRead, permissions.skillVersionUpload]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(await screen.findByRole("button", { name: "重新提交审核" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认重提" }));
    expect(await screen.findByText(status === 403 ? /审核权限已变化/ : /审核状态已变化/)).toBeInTheDocument();
    expect(resubmitSkillReview).toHaveBeenCalledExactlyOnceWith("skill-1", "pending-version", "request-1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["skill", "skill-1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["skills"] });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps review unavailable for users who are not space reviewers", async () => {
    getSkillMock.mockResolvedValue({ ...detail, canReview: false, skill: { ...detail.skill, currentVersionId: null }, versions: [version({ approvalStatus: "pending" })] });
    renderPage();
    expect(await screen.findByRole("button", { name: /设为当前查看版本/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "审批通过" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "驳回" })).not.toBeInTheDocument();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(reviewSkillVersion).mockReset();
    vi.mocked(resubmitSkillReview).mockReset();
    vi.mocked(listSkillSpaces).mockResolvedValue([{ spaceId: "skillspace_default", name: "默认技能空间", approvers: [{ userId: "reviewer", name: "审批人" }], description: "", actions: [], memberCount: 0, skillCount: 1, publishedCount: 1, createdBy: "admin", updatedBy: "admin", createdAt: "2026-07-27T08:00:00Z", updatedAt: "2026-07-27T08:00:00Z" }]);
    getSkillMock.mockResolvedValue(detail);
    listSkillVersionFilesMock.mockImplementation(async (_skillId, versionId) => ({
      items: versionId === "version-3"
        ? [{ path: "SKILL.md", size: 86 }, { path: "assets/logo.png", size: 2048 }]
        : [{ path: "SKILL.md", size: 96 }, { path: "scripts/install.sh", size: 42 }, { path: "scripts/Makefile", size: 24 }]
    }));
    getSkillVersionFileMock.mockImplementation(async (_skillId, versionId, path) => {
      if (path === "assets/logo.png") {
        throw new SkillHubAPIError("该文件不支持在线预览", 422, "file_not_previewable");
      }
      return {
        path,
        size: 96,
        content: path === "SKILL.md"
          ? `---\nname: hidden-name\ndescription: hidden-description\n---\n# ${versionId === "version-3" ? "最新版概述" : "当前版概述"}\n\n| 能力 | 状态 |\n| --- | --- |\n| 网页读取 | 可用 |\n\n<script>alert("unsafe")</script>`
          : path.endsWith("Makefile") ? "build:\n\tmake test" : "#!/bin/sh\necho install"
      };
    });
    setCurrentSkillVersionMock.mockResolvedValue({ skill: { ...detail.skill, currentVersionId: "version-3" }, version: detail.versions[2] });
    clearCurrentSkillVersionMock.mockResolvedValue(undefined);
  });

  it("defaults to the published version and safely renders its overview", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "web-tools-guide" })).toBeInTheDocument();
    expect(screen.getByText("为企业 Agent 提供网页工具使用规范。")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "当前版概述" })).toBeInTheDocument();
    expect(getSkillVersionFileMock).toHaveBeenCalledWith("skill-1", "version-2", "SKILL.md");
    expect(screen.queryByText("hidden-name", { exact: false })).not.toBeInTheDocument();
    expect(document.querySelector("script")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载 ZIP 包安装" })).toHaveAttribute(
      "href",
      "/api/v1/admin/skills/version-package?skill_id=skill-1&version_id=version-2"
    );
    expect(screen.getByRole("link", { name: "下载 ZIP 包安装" })).toHaveAttribute(
      "download",
      "web-tools-guide-1.1.0.zip"
    );
  });

  it("switches overview, files, and package target when viewing a historical version", async () => {
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "版本历史" }));
    const history = screen.getByRole("tabpanel", { name: "版本历史" });
    const rows = within(history).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("1.2.0");
    expect(rows[1]).toHaveTextContent("最新上传");
    expect(rows[2]).toHaveTextContent("1.1.0");
    expect(rows[2]).toHaveTextContent("当前");

    fireEvent.click(within(history).getByRole("button", { name: "查看此版本 1.2.0" }));
    clickTab(screen.getByRole("tab", { name: "概述" }));

    expect(await screen.findByRole("heading", { name: "最新版概述" })).toBeInTheDocument();
    expect(screen.getByText("当前查看版本 1.2.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设为当前查看版本 1.2.0" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载 ZIP 包安装" })).toHaveAttribute(
      "href",
      "/api/v1/admin/skills/version-package?skill_id=skill-1&version_id=version-3"
    );

    clickTab(screen.getByRole("tab", { name: "文件" }));
    expect(await screen.findByRole("button", { name: "预览 assets/logo.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "预览 assets/logo.png" }));
    expect(await screen.findByText("该文件不支持在线预览")).toBeInTheDocument();
    expect(getSkillVersionFileMock).toHaveBeenCalledWith("skill-1", "version-3", "assets/logo.png");
  });

  it("lets the backend preview unknown extensions and uses ordinary nested list semantics", async () => {
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "文件" }));
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(document.querySelector('[role="treeitem"], [role="group"], [aria-expanded]')).not.toBeInTheDocument();
    const makefileButton = await screen.findByRole("button", { name: "预览 scripts/Makefile" });
    fireEvent.click(makefileButton);

    expect(await screen.findByText("make test", { exact: false })).toBeInTheDocument();
    expect(getSkillVersionFileMock).toHaveBeenCalledWith("skill-1", "version-2", "scripts/Makefile");
    expect(makefileButton).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "返回文件列表" })).toBeInTheDocument();
  });

  it("shows ordinary file loading errors instead of the unsupported preview state", async () => {
    listSkillVersionFilesMock.mockResolvedValue({ items: [{ path: "SKILL.md", size: 96 }, { path: "notes.custom", size: 24 }] });
    getSkillVersionFileMock.mockImplementation(async (_skillId, _versionId, path) => {
      if (path === "notes.custom") throw new SkillHubAPIError("文件不存在", 404, "not_found");
      return { path, size: 96, content: "---\nname: test\ndescription: test\n---\n# 概述" };
    });
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "预览 notes.custom" }));

    expect(await screen.findByText("文件预览加载失败：文件不存在。")).toBeInTheDocument();
    expect(screen.queryByText("该文件不支持在线预览")).not.toBeInTheDocument();
  });

  it("shows the files request error in overview instead of a missing SKILL.md state", async () => {
    listSkillVersionFilesMock.mockRejectedValue(new Error("目录读取失败"));
    renderPage();

    expect(await screen.findByText("概述加载失败：目录读取失败。")).toBeInTheDocument();
    expect(screen.queryByText("暂无概述")).not.toBeInTheDocument();
    expect(getSkillVersionFileMock).not.toHaveBeenCalled();
  });

  it("allows long version and directory names to shrink and wrap", async () => {
    const longVersion = "release-2026-07-28-with-a-very-long-enterprise-version-name";
    const longDirectory = "enterprise-web-automation-reference-materials-with-a-very-long-directory-name";
    getSkillMock.mockResolvedValue({
      skill: { ...detail.skill, currentVersionId: "version-long" },
      versions: [version({ versionId: "version-long", version: longVersion })]
    });
    listSkillVersionFilesMock.mockResolvedValue({
      items: [{ path: "SKILL.md", size: 96 }, { path: `${longDirectory}/guide.txt`, size: 24 }]
    });
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "版本历史" }));
    expect(screen.getByText(longVersion)).toHaveClass("min-w-0", "break-all");
    clickTab(screen.getByRole("tab", { name: "文件" }));
    expect(await screen.findByText(longDirectory)).toHaveClass("min-w-0", "break-all");
  });

  it("keeps publish and unpublish actions behind confirmations", async () => {
    renderPage();

    clickTab(await screen.findByRole("tab", { name: "版本历史" }));
    fireEvent.click(screen.getByRole("button", { name: "设为当前版本 1.2.0" }));
    let confirm = screen.getByRole("dialog", { name: "设为当前版本" });
    expect(setCurrentSkillVersionMock).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "确认发布" }));
    await waitFor(() => expect(setCurrentSkillVersionMock).toHaveBeenCalledWith("skill-1", "version-3"));

    fireEvent.click(screen.getByRole("button", { name: "取消当前发布" }));
    confirm = screen.getByRole("dialog", { name: "取消当前发布" });
    fireEvent.click(within(confirm).getByRole("button", { name: "确认取消发布" }));
    await waitFor(() => expect(clearCurrentSkillVersionMock).toHaveBeenCalledWith("skill-1"));
  });

  it("falls back to the newest uploaded version when no version is published", async () => {
    getSkillMock.mockResolvedValue({ skill: { ...detail.skill, currentVersionId: null }, versions: detail.versions });

    renderPage();

    expect(await screen.findByText("当前查看版本 1.2.0")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "最新版概述" })).toBeInTheDocument();
    expect(getSkillVersionFileMock).toHaveBeenCalledWith("skill-1", "version-3", "SKILL.md");
  });

  it("shows GitHub repository, path, and the full Commit evidence for sourced versions", async () => {
    const commitSha = "b".repeat(40);
    getSkillMock.mockResolvedValue({
      ...detail,
      versions: detail.versions.map((item) => item.versionId === "version-2" ? {
        ...item,
        source: {
          sourceId: "source-1",
          repositoryOwner: "acme",
          repositoryName: "skills",
          path: "engineering/code-review/SKILL.md",
          commitSha,
          contentSha256: "c".repeat(64)
        }
      } : item)
    });

    renderPage();

    expect(await screen.findByText("acme/skills")).toBeInTheDocument();
    expect(screen.getByText("engineering/code-review/SKILL.md")).toBeInTheDocument();
    const commit = screen.getByRole("link", { name: `查看 Commit ${commitSha}` });
    expect(commit).toHaveAttribute("href", `https://github.com/acme/skills/commit/${commitSha}`);
    expect(commit).toHaveAttribute("target", "_blank");
    expect(commit).toHaveAttribute("rel", "noreferrer");

    clickTab(screen.getByRole("tab", { name: "版本历史" }));
    expect(within(screen.getByRole("tabpanel", { name: "版本历史" })).getByText("engineering/code-review/SKILL.md")).toBeInTheDocument();
  });

  it("does not render a source evidence block for manually uploaded versions", async () => {
    renderPage();

    await screen.findByRole("heading", { name: "web-tools-guide" });
    expect(screen.queryByText("GitHub 来源")).not.toBeInTheDocument();
  });
});

function clickTab(tab: HTMLElement) {
  fireEvent.pointerDown(tab);
  fireEvent.mouseDown(tab);
  fireEvent.mouseUp(tab);
  fireEvent.click(tab);
}

function renderPage(asUploader = false, adminPermissions?: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/admin/skills/detail?skill_id=skill-1"]}>
        <Routes>
          <Route path="/admin/skills/detail" element={<AdminPermissionsProvider account={{ userId: asUploader ? "writer-id" : "reviewer", email: "reviewer@example.com", name: "审批人", status: "active", adminPermissions: adminPermissions ?? (asUploader ? [permissions.skillRead] : [permissions.skillRead, permissions.skillPublish, permissions.skillUnpublish]) }}><SkillDetailPage /></AdminPermissionsProvider>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...result, queryClient };
}

function reviewerProgress(): NonNullable<SkillVersion["localApproval"]> {
  return { requestId: "request-1", contentDigest: "digest-1", status: "pending", total: 1, approved: 0, approvers: [{ userId: "reviewer", name: "审批人", status: "pending", comment: "", decidedAt: null }] };
}

const scores = { scenario_value: 4, result_effectiveness: 4, ease_of_use: 4, reuse_value: 4 };

async function selectScore(dialog: HTMLElement, label: string, score: number) {
  fireEvent.click(within(dialog).getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: `${score} 分` }));
}

async function fillScores(dialog: HTMLElement) {
  for (const label of ["场景价值", "结果有效", "使用友好", "复用价值"]) await selectScore(dialog, label, 4);
}

function reviewDetail(overrides: Partial<SkillVersion> = {}): AdminSkillDetail {
  return { ...detail, skill: { ...detail.skill, currentVersionId: null }, versions: [version({ versionId: "pending-version", approvalStatus: "pending", localApproval: reviewerProgress(), ...overrides })] };
}

function rejectedDetail(): AdminSkillDetail {
  return reviewDetail({ approvalStatus: "rejected", uploadedByUserId: "writer-id", localApproval: { ...reviewerProgress(), status: "rejected", approvers: [{ ...reviewerProgress().approvers[0], status: "rejected", comment: "需要修改" }] } });
}

function version(overrides: Partial<SkillVersion>): SkillVersion {
  return {
    approvalStatus: "approved",
    versionId: "version-default",
    skillId: "skill-1",
    version: "1.0.0",
    description: "企业网页工具规范",
    changelog: "更新说明",
    packageSha256: "a".repeat(64),
    source: null,
    createdAt: "2026-07-27T08:30:00Z",
    ...overrides
  };
}
