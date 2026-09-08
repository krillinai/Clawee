import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DataResourceGrantsPage } from "./data-resource-grants";
import { AdminPermissionsProvider } from "@/components/admin-permissions";
import {
  createDataResourceGrant,
  listDataResourceGrantMemberCandidates,
  listDataResourceGrantMembers,
  listDataResourceTypes,
  removeDataResourceGrant,
  replaceDataResourceGrant,
  searchDataResourceGrantResources,
} from "@/lib/data-resource-grants-api";
import { permissions } from "@/lib/rbac-api";

vi.mock("@/lib/data-resource-grants-api", () => ({
  createDataResourceGrant: vi.fn(),
  listDataResourceGrantMemberCandidates: vi.fn(),
  listDataResourceGrantMembers: vi.fn(),
  listDataResourceTypes: vi.fn(),
  removeDataResourceGrant: vi.fn(),
  replaceDataResourceGrant: vi.fn(),
  searchDataResourceGrantResources: vi.fn(),
}));

const sharedSpace = {
  resourceType: "shared_space",
  resourceId: "space_001",
  name: "市场资料库",
  grantedActions: ["read", "write"],
  availableActions: [
    { action: "read", name: "查看空间与文件", description: "", required: true, defaultChecked: false },
    { action: "write", name: "上传及修改文件", description: "", required: false, defaultChecked: true }
  ],
  userCount: 1,
  updatedAt: "2026-08-07T10:30:00Z"
};

const agentActivity = {
  resourceType: "data_view",
  resourceId: "agent_activity",
  name: "Agent 动态",
  grantedActions: [],
  availableActions: [
    { action: "read", name: "查看 Agent 动态", description: "", required: true, defaultChecked: false }
  ],
  userCount: 0,
  updatedAt: null
};

describe("DataResourceGrantsPage", () => {
  beforeEach(() => {
    vi.mocked(listDataResourceTypes).mockResolvedValue([
      { resourceType: "shared_space", name: "共享空间", resourceCount: 1, actionCount: 2, userCount: 1, updatedAt: "2026-08-07T10:30:00Z" },
      { resourceType: "knowledge_base", name: "知识库", resourceCount: 0, actionCount: 0, userCount: 0, updatedAt: null },
      { resourceType: "skill_space", name: "技能空间", resourceCount: 2, actionCount: 2, userCount: 1, updatedAt: "2026-08-07T10:30:00Z" },
      { resourceType: "data_view", name: "数据视图", resourceCount: 1, actionCount: 1, userCount: 1, updatedAt: "2026-08-07T10:30:00Z" },
      { resourceType: "custom_resource", name: "未来资源", resourceCount: 1, actionCount: 1, userCount: 1, updatedAt: "2026-08-07T10:30:00Z" }
    ]);
    vi.mocked(searchDataResourceGrantResources).mockImplementation(async ({ resourceType }) => ({
      items: resourceType === "data_view" ? [agentActivity] : [sharedSpace],
      meta: { page: 1, page_size: 20, total: 1 }
    }));
    vi.mocked(listDataResourceGrantMembers).mockResolvedValue({
      items: [{ userId: "usr_001", name: "张三", email: "zhang@example.com", accountStatus: "active", actions: ["read", "write"], updatedAt: "2026-08-07T10:30:00Z" }],
      meta: { next_cursor: "", has_next: false }
    });
    vi.mocked(listDataResourceGrantMemberCandidates).mockResolvedValue({
      items: [{ userId: "usr_xugang", name: "徐刚", email: "xugang@test.com" }],
      meta: { next_cursor: "", has_next: false }
    });
    vi.mocked(createDataResourceGrant).mockResolvedValue(undefined);
    vi.mocked(replaceDataResourceGrant).mockResolvedValue(undefined);
    vi.mocked(removeDataResourceGrant).mockResolvedValue(undefined);
  });

  it("shows granted members without management controls for a read-only administrator", async () => {
    renderPage([permissions.dataResourceGrantRead]);

    expect(await screen.findByRole("heading", { name: "数据权限" })).toBeInTheDocument();
    expect(await screen.findByRole("radio", { name: /网盘空间/ })).toBeInTheDocument();
    expect(screen.queryByText("共享空间")).not.toBeInTheDocument();
    expect(await screen.findByText("市场资料库")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看授权" }));

    expect(await screen.findByText("张三")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveClass("overflow-x-hidden", "overflow-y-auto");
    expect(screen.queryByRole("button", { name: /新增|编辑|撤销|删除/ })).not.toBeInTheDocument();
    expect(listDataResourceGrantMembers).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: "shared_space", resourceId: "space_001"
    }));
  });

  it("grants the registered Agent activity read permission to a selected account", async () => {
    vi.mocked(listDataResourceGrantMembers).mockResolvedValue({ items: [], meta: { next_cursor: "", has_next: false } });
    vi.mocked(searchDataResourceGrantResources).mockImplementation(async ({ resourceType }) => ({
      items: resourceType === "data_view"
        ? [{ ...agentActivity, userCount: vi.mocked(createDataResourceGrant).mock.calls.length > 0 ? 1 : 0 }]
        : [sharedSpace],
      meta: { page: 1, page_size: 20, total: 1 }
    }));
    const queryClient = renderPage([permissions.dataResourceGrantRead, permissions.dataResourceGrantManage]);
    queryClient.setQueryData(["app-data-views"], []);

    fireEvent.click(await screen.findByRole("radio", { name: /数据视图/ }));
    await screen.findByText("Agent 动态");
    fireEvent.click(screen.getByRole("button", { name: "管理授权" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加成员授权" }));
    fireEvent.click(screen.getByRole("button", { name: "选择授权成员" }));
    fireEvent.click(await screen.findByText("徐刚"));
    fireEvent.click(screen.getByRole("button", { name: "添加 1 位成员" }));

    await waitFor(() => expect(createDataResourceGrant).toHaveBeenCalledWith({
      userId: "usr_xugang",
      resourceType: "data_view",
      resourceId: "agent_activity",
      actions: ["read"]
    }));
    expect(await screen.findByText("1 位成员")).toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryState(["app-data-views"])?.isInvalidated).toBe(true));
  });

  it("switches to resource types returned by the backend", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("radio", { name: /技能空间/ }));
    await waitFor(() => expect(searchDataResourceGrantResources).toHaveBeenCalledWith(expect.objectContaining({ resourceType: "skill_space" })));

    fireEvent.click(screen.getByRole("radio", { name: /数据视图/ }));
    await waitFor(() => expect(searchDataResourceGrantResources).toHaveBeenCalledWith(expect.objectContaining({ resourceType: "data_view" })));

    fireEvent.click(screen.getByRole("radio", { name: /未来资源/ }));
    await waitFor(() => expect(searchDataResourceGrantResources).toHaveBeenCalledWith(expect.objectContaining({ resourceType: "custom_resource" })));
  });

  it("keeps resource columns stable across resource types", async () => {
    renderPage();

    await screen.findByText("市场资料库");
    const resourceTable = within(screen.getByRole("region", { name: "数据资源" })).getByRole("table");
    const columns = resourceTable.querySelectorAll("colgroup col");

    expect(resourceTable).toHaveClass("table-fixed");
    expect(Array.from(columns).map((column) => column.className)).toEqual([
      "w-[30%]",
      "w-[15%]",
      "w-[15%]",
      "w-[11%]",
      "w-[16%]",
      "w-[13%]"
    ]);
    expect(screen.getByText("space_001")).toHaveClass("truncate");
  });
});

function renderPage(adminPermissions: string[] = [permissions.dataResourceGrantRead]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AdminPermissionsProvider account={{ userId: "usr_admin", email: "admin@example.com", name: "管理员", status: "active", adminPermissions }}>
        <MemoryRouter initialEntries={["/admin/data-permissions"]}>
          <DataResourceGrantsPage />
        </MemoryRouter>
      </AdminPermissionsProvider>
    </QueryClientProvider>
  );
  return queryClient;
}
