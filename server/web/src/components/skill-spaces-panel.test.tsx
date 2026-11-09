import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "@/lib/api";
import { useAdminPermission } from "@/components/admin-permissions";
import { permissions } from "@/lib/rbac-api";
import { createDataResourceGrant, listDataResourceGrantRoleCandidates, listDataResourceGrantRoleMembers, removeDataResourceGrant, replaceDataResourceGrant } from "@/lib/data-resource-grants-api";

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

vi.mock("@/components/admin-permissions", () => ({ useAdminPermission: vi.fn(() => false) }));
vi.mock("@/lib/data-resource-grants-api", () => ({
  createDataResourceGrant: vi.fn(),
  listDataResourceGrantRoleCandidates: vi.fn(),
  listDataResourceGrantRoleMembers: vi.fn(),
  removeDataResourceGrant: vi.fn(),
  replaceDataResourceGrant: vi.fn()
}));

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
  it.each([false, true])("不再提供空间AI开关或Agent配置 canUpdate=%s", async canUpdate => {
    vi.mocked(listSkillSpaces).mockResolvedValue([space]);
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate, canUpdateMembers: false });
    await screen.findByText(space.name);
    expect(screen.queryByRole("button", { name: `配置 ${space.name} AI 审核` })).not.toBeInTheDocument();
  });
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
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: false, canUpdateMembers: false });
    const row = (await screen.findByText(space.name)).closest("tr")!;
    expect(within(row).getByRole("cell", { name: summary })).toBeInTheDocument();
    if (summary !== "无需审批") {
      expect(within(row).queryByText("无需审批")).not.toBeInTheDocument();
    }
  });

  it("仅角色配置保持审批开启，不要求选择角色内某个用户", async () => {
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, approverRoleIds: ["reviewers"], approverRoles: [{ roleId: "reviewers", name: "审核组" }] }]);
    vi.mocked(listSkillSpaceApproverRoleCandidates).mockResolvedValue([{ roleId: "reviewers", name: "审核组" }]);
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
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
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
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
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "设置 研发技能" }));
    const drawer = screen.getByRole("dialog", { name: "空间设置" });
    fireEvent.click(within(drawer).getByRole("checkbox", { name: "开启审批" }));
    expect(await within(drawer).findByText("审批角色列表加载失败")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "保存" })).toBeDisabled();
  });
  it("hides DingTalk OA when disabled", async () => {
    vi.mocked(getSkillOAAvailability).mockResolvedValue(false);
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "设置 研发技能" }));
    const dialog = screen.getByRole("dialog", { name: "空间设置" });
    fireEvent.click(within(dialog).getByRole("combobox", { name: "审批方式" }));
    expect(screen.queryByRole("option", { name: "钉钉 OA" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "本地审批" })).toBeInTheDocument();
  });

  it("allows an existing DingTalk space to switch back without showing an OA option", async () => {
    vi.mocked(getSkillOAAvailability).mockResolvedValue(false);
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, approvalProvider: "dingtalk", externalApprovalTemplateId: "PROC-1" }]);
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
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
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
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
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
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
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
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
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false });
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
    vi.mocked(useAdminPermission).mockReturnValue(false);
    vi.mocked(listDataResourceGrantRoleMembers).mockResolvedValue({ items: [{ roleId: "readers", name: "查看组", actions: ["read"], granted: true, updatedAt: member.updatedAt }], meta: { next_cursor: "", has_next: false, total: 1 } });
    vi.mocked(listDataResourceGrantRoleCandidates).mockResolvedValue({ items: [{ roleId: "writers", name: "编写组", actions: [], granted: false, updatedAt: "" }], meta: { next_cursor: "", has_next: false, total: 1 } });
    vi.mocked(createDataResourceGrant).mockResolvedValue(undefined);
    vi.mocked(replaceDataResourceGrant).mockResolvedValue(undefined);
    vi.mocked(removeDataResourceGrant).mockResolvedValue(undefined);
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

  it("空间授权区分直接账户、角色与有效授权人数，角色增删改只提交 roleId", async () => {
    vi.mocked(useAdminPermission).mockReturnValue(true);
    vi.mocked(listSkillSpaces).mockResolvedValue([{ ...space, memberCount: 7 }]);
    renderPanel({ canCreateMembers: true, canDeleteMembers: true, canUpdate: false, canUpdateMembers: true });
    fireEvent.click(await screen.findByRole("button", { name: "管理研发技能空间授权" }));
    const drawer = await screen.findByRole("dialog", { name: space.name });
    expect(await within(drawer).findByText("zhang@example.com")).toBeInTheDocument();
    expect(within(drawer).getByText("直接授权 1 位账户")).toBeInTheDocument();
    expect(within(drawer).getByText("有效授权 7 人")).toBeInTheDocument();
    expect(listDataResourceGrantRoleMembers).not.toHaveBeenCalled();
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: "角色授权" }), { button: 0, ctrlKey: false });
    expect(await within(drawer).findByText("查看组")).toBeInTheDocument();
    expect(within(drawer).getByText("授权角色 1 个")).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "添加角色授权" }));
    const addDialog = await screen.findByRole("dialog", { name: "添加角色授权" });
    fireEvent.click(within(addDialog).getByRole("button", { name: "选择授权角色" }));
    fireEvent.click(await screen.findByRole("option", { name: /编写组/ }));
    fireEvent.click(within(addDialog).getByRole("button", { name: "添加 1 个角色" }));
    await waitFor(() => expect(createDataResourceGrant).toHaveBeenCalledWith({ roleId: "writers", resourceType: "skill_space", resourceId: space.spaceId, actions: ["read", "write"] }));
    await waitFor(() => expect(addDialog).not.toBeInTheDocument());
    fireEvent.click(within(drawer).getByRole("button", { name: "编辑查看组角色授权" }));
    const editDialog = await screen.findByRole("dialog", { name: "编辑角色授权" });
    fireEvent.click(within(editDialog).getByRole("checkbox", { name: "上传技能" }));
    fireEvent.click(within(editDialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(replaceDataResourceGrant).toHaveBeenCalledWith({ roleId: "readers", resourceType: "skill_space", resourceId: space.spaceId, actions: ["read", "write"] }));
    await waitFor(() => expect(editDialog).not.toBeInTheDocument());
    fireEvent.click(within(drawer).getByRole("button", { name: "删除查看组角色授权" }));
    const confirm = await screen.findByRole("dialog", { name: "删除角色授权" });
    expect(within(confirm).getByText(/其他直接或角色授权来源仍然保留/)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(removeDataResourceGrant).toHaveBeenCalledWith({ roleId: "readers", resourceType: "skill_space", resourceId: space.spaceId }));
    expect(addSkillSpaceMember).not.toHaveBeenCalled();
    expect(updateSkillSpaceMember).not.toHaveBeenCalled();
    expect(removeSkillSpaceMember).not.toHaveBeenCalled();
  });

  it("账户管理权限不授予角色查看权限，也不请求角色接口", async () => {
    renderPanel({ canCreateMembers: true, canDeleteMembers: true, canUpdate: false, canUpdateMembers: true });
    fireEvent.click(await screen.findByRole("button", { name: "管理研发技能空间授权" }));
    expect(screen.getByRole("tab", { name: "角色授权" })).toBeDisabled();
    expect(screen.getByText("查看角色授权需要数据资源授权查看权限。")).toBeInTheDocument();
    expect(listDataResourceGrantRoleMembers).not.toHaveBeenCalled();
    expect(listDataResourceGrantRoleCandidates).not.toHaveBeenCalled();
  });

  it.each([
    { permission: permissions.dataResourceGrantRead, add: false, edit: false, remove: false },
    { permission: permissions.dataResourceGrantCreate, add: true, edit: false, remove: false },
    { permission: permissions.dataResourceGrantUpdate, add: false, edit: true, remove: false },
    { permission: permissions.dataResourceGrantDelete, add: false, edit: false, remove: true }
  ])("角色操作独立遵循 $permission 权限", async ({ permission, add, edit, remove }) => {
    vi.mocked(useAdminPermission).mockImplementation((code) => code === permissions.dataResourceGrantRead || code === permission);
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: false, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "管理研发技能空间授权" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "角色授权" }), { button: 0, ctrlKey: false });
    const drawer = screen.getByRole("dialog", { name: space.name });
    expect(await within(drawer).findByText("查看组")).toBeInTheDocument();
    expect(Boolean(within(drawer).queryByRole("button", { name: "添加角色授权" }))).toBe(add);
    expect(Boolean(within(drawer).queryByRole("button", { name: "编辑查看组角色授权" }))).toBe(edit);
    expect(Boolean(within(drawer).queryByRole("button", { name: "删除查看组角色授权" }))).toBe(remove);
  });

  it("切换授权来源重置搜索与分页，加载时不展示另一来源的数据", async () => {
    vi.mocked(useAdminPermission).mockReturnValue(true);
    vi.mocked(listDataResourceGrantRoleMembers).mockImplementation(() => new Promise(() => {}));
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: false, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "管理研发技能空间授权" }));
    const drawer = screen.getByRole("dialog", { name: space.name });
    expect(await within(drawer).findByText("zhang@example.com")).toBeInTheDocument();
    fireEvent.change(within(drawer).getByRole("textbox", { name: "搜索授权成员" }), { target: { value: "张三" } });
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: "角色授权" }), { button: 0, ctrlKey: false });
    expect(within(drawer).queryByText("zhang@example.com")).not.toBeInTheDocument();
    expect(within(drawer).getByRole("textbox", { name: "搜索授权角色" })).toHaveValue("");
    await waitFor(() => expect(listDataResourceGrantRoleMembers).toHaveBeenLastCalledWith({ resourceType: "skill_space", resourceId: space.spaceId, query: "", cursor: "" }));
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: "账户授权" }), { button: 0, ctrlKey: false });
    expect(await within(drawer).findByText("zhang@example.com")).toBeInTheDocument();
  });

  it("角色分页使用服务端总数，切换后从第一页重新查询", async () => {
    vi.mocked(useAdminPermission).mockReturnValue(true);
    const role = { roleId: "readers", name: "查看组", actions: ["read"], granted: true, updatedAt: member.updatedAt };
    vi.mocked(listDataResourceGrantRoleMembers).mockImplementation(async ({ cursor }) => ({
      items: [{ ...role, name: cursor ? "第二页角色" : role.name }],
      meta: { next_cursor: cursor ? "" : "2", has_next: !cursor, total: 21 }
    }));
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: false, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "管理研发技能空间授权" }));
    const drawer = screen.getByRole("dialog", { name: space.name });
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: "角色授权" }), { button: 0, ctrlKey: false });
    expect(await within(drawer).findByText("授权角色 21 个")).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "下一页" }));
    expect(await within(drawer).findByText("第二页角色")).toBeInTheDocument();
    expect(listDataResourceGrantRoleMembers).toHaveBeenLastCalledWith({ resourceType: "skill_space", resourceId: space.spaceId, query: "", cursor: "2" });
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: "账户授权" }), { button: 0, ctrlKey: false });
    expect(await within(drawer).findByText("zhang@example.com")).toBeInTheDocument();
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: "角色授权" }), { button: 0, ctrlKey: false });
    expect(await within(drawer).findByText("查看组")).toBeInTheDocument();
    await waitFor(() => expect(listDataResourceGrantRoleMembers).toHaveBeenLastCalledWith({ resourceType: "skill_space", resourceId: space.spaceId, query: "", cursor: "" }));
  });

  it("角色授权查询失败保留错误状态，仍可返回账户授权", async () => {
    vi.mocked(useAdminPermission).mockReturnValue(true);
    vi.mocked(listDataResourceGrantRoleMembers).mockRejectedValue(new Error("角色列表暂不可用"));
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: false, canUpdateMembers: false });
    fireEvent.click(await screen.findByRole("button", { name: "管理研发技能空间授权" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "角色授权" }), { button: 0, ctrlKey: false });
    expect(await screen.findByText(/角色授权加载失败：角色列表暂不可用/)).toBeInTheDocument();
    expect(screen.queryByText("暂无角色授权")).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "账户授权" }), { button: 0, ctrlKey: false });
    expect(await screen.findByText("zhang@example.com")).toBeInTheDocument();
  });

  it("reuses the member authorization flow for adding, editing and removing members", async () => {
    renderPanel({ canCreateMembers: true, canDeleteMembers: true, canUpdate: true, canUpdateMembers: true });

    const panel = screen.getByRole("region", { name: "技能空间" });
    expect(panel).toHaveClass("gap-5");
    expect(within(panel).queryByRole("heading", { name: "技能空间" })).not.toBeInTheDocument();
    expect(screen.queryByText("管理 Clawee Agent 客户端的技能查看和上传范围。")).not.toBeInTheDocument();
    expect(await screen.findByRole("table")).toHaveClass("text-sm");
    expect(await screen.findByText("研发团队技能")).toHaveClass("text-[13px]", "leading-5");
    expect(screen.getByRole("button", { name: "管理研发技能空间授权" })).toHaveClass("h-8", "bg-secondary");
    expect(screen.getByRole("button", { name: "编辑 研发技能" })).toHaveClass("h-8", "bg-secondary");

    fireEvent.click(await screen.findByRole("button", { name: "管理研发技能空间授权" }));
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
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: false, canUpdateMembers: false });

    fireEvent.click(await screen.findByRole("button", { name: "管理研发技能空间授权" }));
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
    renderPanel({ canCreateMembers, canDeleteMembers, canUpdate: false, canUpdateMembers });

    fireEvent.click(await screen.findByRole("button", { name: "管理研发技能空间授权" }));
    const drawer = await screen.findByRole("dialog", { name: "研发技能" });
    expect(await within(drawer).findByText("zhang@example.com")).toBeInTheDocument();
    expect(Boolean(within(drawer).queryByRole("button", { name: "添加成员授权" }))).toBe(canCreateMembers);
    expect(Boolean(within(drawer).queryByRole("button", { name: /编辑.*成员授权/ }))).toBe(canUpdateMembers);
    expect(Boolean(within(drawer).queryByRole("button", { name: /删除.*成员授权/ }))).toBe(canDeleteMembers);
  });

  it("delegates space editing to the page and keeps table headers on one line", async () => {
    const onEditSpace = vi.fn();
    renderPanel({ canCreateMembers: false, canDeleteMembers: false, canUpdate: true, canUpdateMembers: false, onEditSpace });

    fireEvent.click(await screen.findByRole("button", { name: "编辑 研发技能" }));
    expect(onEditSpace).toHaveBeenCalledWith(expect.objectContaining({ spaceId: "skillspace_dev" }));
    expect(screen.getByRole("columnheader", { name: "技能" })).toHaveClass("whitespace-nowrap");
    expect(screen.getByRole("columnheader", { name: "已发布" })).toHaveClass("whitespace-nowrap");
  });
});

function renderPanel(props: Omit<Parameters<typeof SkillSpacesPanel>[0], "onEditSpace" | "onOpenSpace"> & { onEditSpace?: (space: SkillSpace) => void }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><SkillSpacesPanel {...props} onEditSpace={props.onEditSpace ?? vi.fn()} onOpenSpace={vi.fn()} /></QueryClientProvider>);
}
