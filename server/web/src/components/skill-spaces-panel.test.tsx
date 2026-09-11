import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addSkillSpaceMember,
  listSkillSpaceCandidates,
  listSkillSpaceMembers,
  listSkillSpaces,
  removeSkillSpaceMember,
  updateSkillSpaceMember
} from "@/lib/skillhub-api";

import { SkillSpacesPanel } from "./skill-spaces-panel";

vi.mock("@/lib/skillhub-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/skillhub-api")>("@/lib/skillhub-api");
  return {
    ...actual,
    addSkillSpaceMember: vi.fn(),
    listSkillSpaceCandidates: vi.fn(),
    listSkillSpaceMembers: vi.fn(),
    listSkillSpaces: vi.fn(),
    removeSkillSpaceMember: vi.fn(),
    updateSkillSpaceMember: vi.fn()
  };
});

const space = {
  spaceId: "skillspace_dev",
  name: "研发技能",
  description: "研发团队技能",
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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSkillSpaces).mockResolvedValue([space]);
    vi.mocked(listSkillSpaceMembers).mockResolvedValue([member]);
    vi.mocked(listSkillSpaceCandidates).mockResolvedValue([
      { userId: "usr_2", name: "李四", email: "lisi@example.com" },
      { userId: "usr_3", name: "王五", email: "wangwu@example.com" }
    ]);
    vi.mocked(addSkillSpaceMember).mockResolvedValue({ ...member, userId: "usr_2" });
    vi.mocked(updateSkillSpaceMember).mockResolvedValue(member);
    vi.mocked(removeSkillSpaceMember).mockResolvedValue(undefined);
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

function renderPanel(permissions: Parameters<typeof SkillSpacesPanel>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><SkillSpacesPanel {...permissions} /></QueryClientProvider>);
}
