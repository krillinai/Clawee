import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "@/lib/api";

import {
  addSkillSpaceMember,
  getSkillOAAvailability,
  listSkillSpaceCandidates,
  listSkillSpaceMembers,
  listSkillSpaces,
  removeSkillSpaceMember,
  updateSkillSpaceMember,
  listSkillSpaceApproverCandidates,
  listSkillSpaceApproverRoleCandidates,
  setSkillSpaceApproval,
  type SkillSpace
} from "@/lib/skillhub-api";

import { SkillSpacesPanel } from "./skill-spaces-panel";

vi.mock("@/lib/skillhub-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/skillhub-api")>("@/lib/skillhub-api");
  return {
    ...actual,
    addSkillSpaceMember: vi.fn(),
    getSkillOAAvailability: vi.fn(),
    listSkillSpaceCandidates: vi.fn(),
    listSkillSpaceMembers: vi.fn(),
    listSkillSpaces: vi.fn(),
    removeSkillSpaceMember: vi.fn(),
    updateSkillSpaceMember: vi.fn(),
    listSkillSpaceApproverCandidates: vi.fn(),
    listSkillSpaceApproverRoleCandidates: vi.fn(async () => []),
    setSkillSpaceApproval: vi.fn()
  };
});

const space = {
  spaceId: "skillspace_dev",
  name: "研发技能",
  description: "研发团队技能",
  approvers: [],
  actions: ["read", "write"] as Array<"read" | "write">,
  memberCount: 1,
  skillCount: 3,
  publishedCount: 2,
  createdBy: "usr_admin",
  updatedBy: "usr_admin",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-05T00:00:00Z"
};
const member = {
  userId: "usr_1",
  name: "张三",
  email: "zhang@example.com",
  accountStatus: "active",
  grantStatus: "complete",
  actions: ["read", "write"] as Array<"read" | "write">,
  joinedAt: "2026-08-02T00:00:00Z",
  updatedAt: "2026-08-05T00:00:00Z"
};

describe("SkillSpacesPanel", () => {
  it.each<{ name: string; config: Partial<SkillSpace>; summary: string }>([
    { name: "无审批", config: {}, summary: "无需审批" },
    { name: "仅账户", config: { approvers: [{ userId: "usr_2", name: "李四" }] }, summary: "李四" },
    { name: "多账户", config: { approvers: [{ userId: "usr_1", name: "张三" }, { userId: "usr_2", name: "李四" }, { userId: "usr_3", name: "王五" }] }, summary: "3 人" },
    { name: "仅角色", config: { approverRoleIds: ["reviewers"] }, summary: "1 个角色" },
    { name: "仅角色详情", config: { approverRoles: [{ roleId: "reviewers", name: "审核组" }] }, summary: "1 个角色" },
    { name: "账户与角色", config: { approvers: [{ userId: "usr_2", name: "李四" }], approverRoleIds: ["reviewers", "writers"] }, summary: "李四、2 个角色" },
    { name: "钉钉", config: { approvalProvider: "dingtalk", externalApprovalTemplateId: "PROC-1", approverRoleIds: ["reviewers"] }, summary: "钉钉 OA" }
  ])("$name 空间正确展示审批摘要", async ({ config, summary }) => {
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, ...config }]);
    renderPanel({ canCreate: false, canCreateMembers: false, canDeleteMembers: false, canUpdate: false, canUpdateMembers: false });
    const row = (await screen.findByText(space.name)).closest("tr")!;
    expect(within(row).getByRole("cell", { name: summary })).toBeInTheDocument();
    if (summary !== "无需审批") {
      expect(within(row).queryByText("无需审批")).not.toBeInTheDocument();
    }
  });

  it("仅角色配置保持审批开启，不要求选择角色内某个用户", async () => {
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, approverRoleIds: ["reviewers"], approverRoles: [{ roleId: "reviewers", name: "审核组" }] }]);
    vi.mocked(listSkillSpaceApproverRoleCandidates).mockResolvedValue([{ roleId: "reviewers", name: "审核组" }]);
    renderPanel({ canCreate: false, canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "设置 研发技能" }));
    const drawer = screen.getByRole("dialog", { name: "空间设置" });
    expect(within(drawer).getByRole("checkbox", { name: "开启审批" })).toBeChecked();
    expect(await within(drawer).findByRole("checkbox", { name: "审核组" })).toBeChecked();
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "保存" })).toBeEnabled());
    fireEvent.click(within(drawer).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(setSkillSpaceApproval).toHaveBeenCalledWith("skillspace_dev", "local", "", [], false, ["reviewers"]));
  });

  it("账户与多个角色可以同时配置，说明全员通过规则", async () => {
    vi.mocked(listSkillSpaceApproverRoleCandidates).mockResolvedValue([{ roleId: "reviewers", name: "审核组" }, { roleId: "writers", name: "编写组" }]);
    renderPanel({ canCreate: false, canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "设置 研发技能" }));
    const drawer = screen.getByRole("dialog", { name: "空间设置" });
    fireEvent.click(within(drawer).getByRole("checkbox", { name: "开启审批" }));
    fireEvent.click(await within(drawer).findByRole("checkbox", { name: /李四/ }));
    fireEvent.click(await within(drawer).findByRole("checkbox", { name: "审核组" }));
    fireEvent.click(within(drawer).getByRole("checkbox", { name: "编写组" }));
    expect(within(drawer).getByText(/账户与角色成员合并去重.*全员通过/)).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(setSkillSpaceApproval).toHaveBeenCalledWith("skillspace_dev", "local", "", ["usr_2"], false, ["reviewers", "writers"]));
  });

  it("角色候选加载失败时给出错误且禁止提交", async () => {
    vi.mocked(listSkillSpaceApproverRoleCandidates).mockRejectedValue(new Error("不可用"));
    renderPanel({ canCreate: false, canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "设置 研发技能" }));
    const drawer = screen.getByRole("dialog", { name: "空间设置" });
    fireEvent.click(within(drawer).getByRole("checkbox", { name: "开启审批" }));
    expect(await within(drawer).findByText("审批角色列表加载失败")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "保存" })).toBeDisabled();
  });
  it("hides DingTalk OA when disabled", async () => {
    vi.mocked(getSkillOAAvailability).mockResolvedValue(false);
    renderPanel({ canCreate: false, canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "设置 研发技能" }));
    const dialog = screen.getByRole("dialog", { name: "空间设置" });
    fireEvent.click(within(dialog).getByRole("combobox", { name: "审批方式" }));
    expect(screen.queryByRole("option", { name: "钉钉 OA" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "本地审批" })).toBeInTheDocument();
  });

  it("allows an existing DingTalk space to switch back without showing an OA option", async () => {
    vi.mocked(getSkillOAAvailability).mockResolvedValue(false);
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, approvalProvider: "dingtalk", externalApprovalTemplateId: "PROC-1" }]);
    renderPanel({ canCreate: false, canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "设置 研发技能" }));
    const dialog = screen.getByRole("dialog", { name: "空间设置" });
    expect(within(dialog).getByText("当前为钉钉 OA（已停用）")).toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: "审批方式" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "改为本地审批" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(setSkillSpaceApproval).toHaveBeenCalledWith("skillspace_dev", "local", "", [], false, []));
  });

  it("requires a reviewer when approval is enabled in the settings drawer", async () => {
    renderPanel({ canCreate: false, canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "设置 研发技能" }));
    const dialog = screen.getByRole("dialog", { name: "空间设置" });
    expect(within(dialog).queryByRole("textbox", { name: "空间技能审批人" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "开启审批" }));
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();
    const search = within(dialog).getByRole("textbox", { name: "直接审批账户" });
    await waitFor(() => expect(search).toBeEnabled());
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: /李四/ }));
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(setSkillSpaceApproval).toHaveBeenCalledWith("skillspace_dev", "local", "", ["usr_2"], false, []));
  });

  it("requires a template when switching to DingTalk OA", async () => {
    renderPanel({ canCreate: false, canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "设置 研发技能" }));
    const dialog = screen.getByRole("dialog", { name: "空间设置" });
    fireEvent.click(within(dialog).getByRole("combobox", { name: "审批方式" }));
    fireEvent.click(await screen.findByRole("option", { name: "钉钉 OA" }));
    expect(within(dialog).queryByRole("checkbox", { name: "开启审批" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: /钉钉审批模板 ID/ }), { target: { value: "PROC-1" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(setSkillSpaceApproval).toHaveBeenCalledWith("skillspace_dev", "dingtalk", "PROC-1", [], false, []));
  });

  it("turns approval off without requiring a reviewer", async () => {
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, approvers: [{ userId: "usr_2", name: "李四" }] }]);
    renderPanel({ canCreate: false, canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "设置 研发技能" }));
    const drawer = screen.getByRole("dialog", { name: "空间设置" });
    fireEvent.click(within(drawer).getByRole("checkbox", { name: "开启审批" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(setSkillSpaceApproval).toHaveBeenCalledWith("skillspace_dev", "local", "", [], false, []));
  });

  it("saves two approvers and confirms a reset only after the server requests it", async () => {
    vi.mocked(listSkillSpaceApproverCandidates).mockResolvedValue([
      { userId: "usr_2", name: "李四", email: "lisi@example.com" },
      { userId: "usr_3", name: "王五", email: "wangwu@example.com" }
    ]);
    vi.mocked(setSkillSpaceApproval).mockRejectedValueOnce(new APIError("需重审", 409, "approval_reset_required", [{ affected_versions: 3 }])).mockResolvedValue(undefined);
    renderPanel({ canCreate: false, canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "设置 研发技能" }));
    const drawer = screen.getByRole("dialog", { name: "空间设置" });
    fireEvent.click(within(drawer).getByRole("checkbox", { name: "开启审批" }));
    fireEvent.click(await within(drawer).findByRole("checkbox", { name: /李四/ }));
    fireEvent.click(within(drawer).getByRole("checkbox", { name: /王五/ }));
    fireEvent.click(within(drawer).getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/3 个未发布版本/)).toBeInTheDocument();
    expect(setSkillSpaceApproval).toHaveBeenCalledWith("skillspace_dev", "local", "", ["usr_2", "usr_3"], false, []);
    fireEvent.click(within(screen.getByRole("dialog", { name: "重新审批未发布版本" })).getByRole("button", { name: "确认修改" }));
    await waitFor(() => expect(setSkillSpaceApproval).toHaveBeenCalledWith("skillspace_dev", "local", "", ["usr_2", "usr_3"], true, []));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSkillOAAvailability).mockResolvedValue(true);
    vi.mocked(listSkillSpaces).mockResolvedValue([space]);
    vi.mocked(listSkillSpaceMembers).mockResolvedValue([member]);
    vi.mocked(listSkillSpaceCandidates).mockResolvedValue([
      { userId: "usr_2", name: "李四", email: "lisi@example.com" },
      { userId: "usr_3", name: "王五", email: "wangwu@example.com" }
    ]);
    vi.mocked(addSkillSpaceMember).mockResolvedValue({ ...member, userId: "usr_2" });
    vi.mocked(updateSkillSpaceMember).mockResolvedValue(member);
    vi.mocked(removeSkillSpaceMember).mockResolvedValue(undefined);
    vi.mocked(listSkillSpaceApproverCandidates).mockResolvedValue([{ userId: "usr_2", name: "李四", email: "lisi@example.com" }]);
    vi.mocked(listSkillSpaceApproverRoleCandidates).mockResolvedValue([]);
    vi.mocked(setSkillSpaceApproval).mockResolvedValue(undefined);
  });

  it("reuses the member authorization flow for adding, editing and removing members", async () => {
    renderPanel({ canCreate: true, canCreateMembers: true, canDeleteMembers: true, canUpdate: true, canUpdateMembers: true });

    const panel = screen.getByRole("region", { name: "技能空间" });
    expect(panel).toHaveClass("gap-5");
    expect(within(panel).queryByRole("heading", { name: "技能空间" })).not.toBeInTheDocument();
    expect(screen.queryByText("管理 Clawee Agent 客户端的技能查看和上传范围。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建空间" }).parentElement).toHaveClass("justify-end");
    expect(await screen.findByRole("table")).toHaveClass("text-sm");
    expect(await screen.findByText("研发团队技能")).toHaveClass("text-[13px]", "leading-5");
    expect(screen.getByRole("button", { name: "管理研发技能成员授权" })).toHaveClass("h-8", "bg-secondary");
    expect(screen.getByRole("button", { name: "编辑 研发技能" })).toHaveClass("h-8", "bg-secondary");

    fireEvent.click(await screen.findByRole("button", { name: "管理研发技能成员授权" }));
    const drawer = await screen.findByRole("dialog", { name: "研发技能" });
    expect(await within(drawer).findByText("zhang@example.com")).toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole("button", { name: "添加成员授权" }));
    const addDialog = await screen.findByRole("dialog", { name: "添加成员授权" });
    fireEvent.click(within(addDialog).getByRole("button", { name: "选择授权成员" }));
    fireEvent.click(await screen.findByRole("option", { name: /李四.*lisi@example.com/ }));
    fireEvent.click(await screen.findByRole("option", { name: /王五.*wangwu@example.com/ }));
    fireEvent.click(within(addDialog).getByRole("button", { name: "添加 2 位成员" }));

    await waitFor(() => {
      expect(addSkillSpaceMember).toHaveBeenNthCalledWith(1, { spaceId: "skillspace_dev", userId: "usr_2", actions: ["read", "write"] });
      expect(addSkillSpaceMember).toHaveBeenNthCalledWith(2, { spaceId: "skillspace_dev", userId: "usr_3", actions: ["read", "write"] });
    });

    fireEvent.click(within(drawer).getByRole("button", { name: "编辑张三成员授权" }));
    const editDialog = await screen.findByRole("dialog", { name: "编辑成员授权" });
    fireEvent.click(within(editDialog).getByRole("checkbox", { name: "上传技能" }));
    fireEvent.click(within(editDialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateSkillSpaceMember).toHaveBeenCalledWith({ spaceId: "skillspace_dev", userId: "usr_1", actions: ["read"] }));

    fireEvent.click(within(drawer).getByRole("button", { name: "删除张三成员授权" }));
    const confirm = await screen.findByRole("dialog", { name: "删除成员授权" });
    fireEvent.click(within(confirm).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(removeSkillSpaceMember).toHaveBeenCalledWith({ spaceId: "skillspace_dev", userId: "usr_1" }));
  });

  it("keeps the authorization drawer read-only when management is unavailable", async () => {
    renderPanel({ canCreate: false, canCreateMembers: false, canDeleteMembers: false, canUpdate: false, canUpdateMembers: false });

    fireEvent.click(await screen.findByRole("button", { name: "管理研发技能成员授权" }));
    const drawer = await screen.findByRole("dialog", { name: "研发技能" });
    expect(await within(drawer).findByText("zhang@example.com")).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "添加成员授权" })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /编辑.*成员授权/ })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /删除.*成员授权/ })).not.toBeInTheDocument();
  });

  it.each([
    { operation: "新增", canCreateMembers: true, canUpdateMembers: false, canDeleteMembers: false },
    { operation: "编辑", canCreateMembers: false, canUpdateMembers: true, canDeleteMembers: false },
    { operation: "删除", canCreateMembers: false, canUpdateMembers: false, canDeleteMembers: true }
  ])("shows only the independently granted $operation member action", async ({ canCreateMembers, canUpdateMembers, canDeleteMembers }) => {
    renderPanel({ canCreate: false, canCreateMembers, canDeleteMembers, canUpdate: false, canUpdateMembers });

    fireEvent.click(await screen.findByRole("button", { name: "管理研发技能成员授权" }));
    const drawer = await screen.findByRole("dialog", { name: "研发技能" });
    expect(await within(drawer).findByText("zhang@example.com")).toBeInTheDocument();
    expect(Boolean(within(drawer).queryByRole("button", { name: "添加成员授权" }))).toBe(canCreateMembers);
    expect(Boolean(within(drawer).queryByRole("button", { name: /编辑.*成员授权/ }))).toBe(canUpdateMembers);
    expect(Boolean(within(drawer).queryByRole("button", { name: /删除.*成员授权/ }))).toBe(canDeleteMembers);
  });
});

function renderPanel(permissions: Omit<Parameters<typeof SkillSpacesPanel>[0], "onOpenSpace">) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><SkillSpacesPanel {...permissions} onOpenSpace={vi.fn()} /></QueryClientProvider>);
}
