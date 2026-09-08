import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import { permissions } from "@/lib/rbac-api";
import {
  addSharedSpaceMember,
  createSharedSpace,
  getSharedSpace,
  listSharedSpaceCandidates,
  listSharedSpaceMembers,
  listSharedSpaces,
  removeSharedSpaceMember,
  updateSharedSpaceMember,
  updateSharedSpace
} from "@/lib/shared-files-api";

import { SharedFilesPage } from "./shared-files";

vi.mock("@/lib/shared-files-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shared-files-api")>("@/lib/shared-files-api");
  return { ...actual, addSharedSpaceMember: vi.fn(), createSharedSpace: vi.fn(), getSharedSpace: vi.fn(), listSharedSpaceCandidates: vi.fn(), listSharedSpaceMembers: vi.fn(), listSharedSpaces: vi.fn(), removeSharedSpaceMember: vi.fn(), updateSharedSpaceMember: vi.fn(), updateSharedSpace: vi.fn() };
});

const space = { spaceId: "space_1", name: "季度空间", description: "协作文件", memberCount: 1, fileCount: 3, sizeBytes: 1024, createdBy: "admin", createdAt: "2026-08-01T00:00:00Z", updatedBy: "admin", updatedAt: "2026-08-05T00:00:00Z" };
const member = { userId: "usr_1", name: "张三", email: "zhang@example.com", accountStatus: "active", grantStatus: "complete" as const, actions: ["read", "write"] as Array<"read" | "write">, joinedAt: "2026-08-02T00:00:00Z", updatedAt: "2026-08-05T00:00:00Z" };

describe("SharedFilesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSharedSpaces).mockResolvedValue({ items: [space], meta: { next_cursor: "", has_next: false } });
    vi.mocked(getSharedSpace).mockResolvedValue(space);
    vi.mocked(listSharedSpaceMembers).mockResolvedValue({ items: [member], meta: { next_cursor: "", has_next: false } });
    vi.mocked(listSharedSpaceCandidates).mockResolvedValue({ items: [{ userId: "usr_2", name: "李四", email: "lisi@example.com" }], meta: { next_cursor: "", has_next: false } });
    vi.mocked(createSharedSpace).mockResolvedValue({ ...space, spaceId: "space_2", name: "新空间" });
    vi.mocked(updateSharedSpace).mockResolvedValue(space);
    vi.mocked(addSharedSpaceMember).mockResolvedValue({ ...member, userId: "usr_2", name: "李四" });
    vi.mocked(updateSharedSpaceMember).mockResolvedValue(member);
    vi.mocked(removeSharedSpaceMember).mockResolvedValue(undefined);
  });

  it("creates a space with shadcn field composition", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "网盘" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "创建共享空间" }));
    const dialog = screen.getByRole("dialog", { name: "创建共享空间" });
    expect(dialog.querySelector('[data-slot="field-group"]')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("空间名称"), { target: { value: " 新空间 " } });
    fireEvent.change(within(dialog).getByLabelText("空间说明"), { target: { value: " 共享资料 " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(createSharedSpace).toHaveBeenCalledWith({ name: "新空间", description: "共享资料" }));
  });

  it("edits an existing space", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "查看季度空间详情" }));
    const drawer = await screen.findByRole("dialog", { name: "季度空间" });
    fireEvent.click(within(drawer).getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑共享空间" });
    fireEvent.change(within(dialog).getByLabelText("空间名称"), { target: { value: "季度空间归档" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateSharedSpace).toHaveBeenCalledWith({ spaceId: "space_1", name: "季度空间归档", description: "协作文件" }));
  });

  it("keeps loaded spaces when a filtered request fails", async () => {
    vi.mocked(listSharedSpaces).mockImplementation(({ query }) => query
      ? Promise.reject(new Error("共享空间加载失败"))
      : Promise.resolve({ items: [space], meta: { next_cursor: "", has_next: false } }));
    renderPage();
    expect(await screen.findByText("季度空间")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索共享空间"), { target: { value: "失败" } });
    expect(await screen.findByText("共享空间加载失败")).toBeInTheDocument();
    expect(screen.getByText("季度空间")).toBeInTheDocument();
  });

  it("adds, edits and removes members from the authorization drawer", async () => {
    const candidateLi = { userId: "usr_2", name: "李四", email: "lisi@example.com" };
    const candidateWang = { userId: "usr_3", name: "王五", email: "wangwu@example.com" };
    vi.mocked(listSharedSpaceCandidates).mockImplementation(({ query }) => Promise.resolve({
      items: query ? [candidateWang] : [candidateLi, candidateWang],
      meta: { next_cursor: "", has_next: false }
    }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "管理季度空间成员授权" }));
    const drawer = await screen.findByRole("dialog", { name: "季度空间" });
    expect(await within(drawer).findByText("zhang@example.com")).toBeInTheDocument();
    fireEvent.click(await within(drawer).findByRole("button", { name: "添加成员授权" }));
    const addDialog = await screen.findByRole("dialog", { name: "添加成员授权" });
    fireEvent.click(within(addDialog).getByRole("button", { name: "选择授权成员" }));
    fireEvent.click(await screen.findByRole("option", { name: /李四.*lisi@example.com/ }));
    fireEvent.change(screen.getByLabelText("搜索候选成员"), { target: { value: "王五" } });
    await waitFor(() => expect(listSharedSpaceCandidates).toHaveBeenCalledWith(expect.objectContaining({ query: "王五" })));
    fireEvent.click(await screen.findByRole("option", { name: /王五.*wangwu@example.com/ }));
    fireEvent.click(within(addDialog).getByRole("button", { name: "添加 2 位成员" }));
    await waitFor(() => {
      expect(addSharedSpaceMember).toHaveBeenNthCalledWith(1, { spaceId: "space_1", userId: "usr_2", actions: ["read", "write"] });
      expect(addSharedSpaceMember).toHaveBeenNthCalledWith(2, { spaceId: "space_1", userId: "usr_3", actions: ["read", "write"] });
    });

    fireEvent.click(within(drawer).getByRole("button", { name: "编辑张三成员授权" }));
    const editDialog = await screen.findByRole("dialog", { name: "编辑成员授权" });
    fireEvent.click(within(editDialog).getByRole("checkbox", { name: "上传及修改文件" }));
    fireEvent.click(within(editDialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateSharedSpaceMember).toHaveBeenCalledWith({ spaceId: "space_1", userId: "usr_1", actions: ["read"] }));

    fireEvent.click(within(drawer).getByRole("button", { name: "删除张三成员授权" }));
    const confirm = await screen.findByRole("dialog", { name: "删除成员授权" });
    fireEvent.click(within(confirm).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(removeSharedSpaceMember).toHaveBeenCalledWith({ spaceId: "space_1", userId: "usr_1" }));
  });

  it("shows candidate query errors in the add-member dialog", async () => {
    vi.mocked(listSharedSpaceCandidates).mockRejectedValue(new Error("候选账号加载失败"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "管理季度空间成员授权" }));
    const drawer = await screen.findByRole("dialog", { name: "季度空间" });
    fireEvent.click(await within(drawer).findByRole("button", { name: "添加成员授权" }));
    const dialog = await screen.findByRole("dialog", { name: "添加成员授权" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("候选账号加载失败");
  });

  it("links file management to a standalone page", async () => {
    renderPage();
    expect(await screen.findByRole("link", { name: "管理季度空间文件" })).toHaveAttribute("href", "/admin/shared-files/detail?space_id=space_1");
  });

  it("hides management controls for read-only administrators", async () => {
    renderPage([permissions.sharedFilesRead]);
    expect(await screen.findByText("季度空间")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建共享空间" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "管理季度空间成员授权" }));
    const drawer = await screen.findByRole("dialog", { name: "季度空间" });
    expect(within(drawer).queryByRole("button", { name: "添加成员授权" })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /编辑.*成员授权/ })).not.toBeInTheDocument();
  });
});

function renderPage(adminPermissions?: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const page = <MemoryRouter><SharedFilesPage /></MemoryRouter>;
  return render(<QueryClientProvider client={queryClient}>{adminPermissions ? <AdminPermissionsProvider account={{ userId: "reader", email: "reader@example.com", name: "只读管理员", status: "active", adminPermissions }}>{page}</AdminPermissionsProvider> : page}</QueryClientProvider>);
}
