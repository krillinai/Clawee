import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import {
  createRole,
  listPermissions,
  listRoles,
  permissions,
  type Permission,
  type Role
} from "@/lib/rbac-api";

import { RBACRolesPage } from "./rbac-roles";

vi.mock("@/lib/rbac-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rbac-api")>("@/lib/rbac-api");
  return {
    ...actual,
    createRole: vi.fn(),
    listPermissions: vi.fn(),
    listRoles: vi.fn(),
    removeRole: vi.fn(),
    updateRole: vi.fn()
  };
});

const createRoleMock = vi.mocked(createRole);
const listPermissionsMock = vi.mocked(listPermissions);
const listRolesMock = vi.mocked(listRoles);

const adminRole: Role = {
  roleId: "role_admin",
  code: "admin",
  name: "系统管理员",
  isSystem: true,
  permissionCodes: [permissions.rbacManage],
  createdAt: "2026-07-29T00:00:00Z",
  updatedAt: "2026-07-29T00:00:00Z"
};
const auditorRole: Role = {
  ...adminRole,
  roleId: "role_auditor",
  code: "auditor",
  name: "安全审计员",
  isSystem: false,
  permissionCodes: [permissions.mcpAuditRead]
};
const permissionCatalog: Permission[] = [{
  code: permissions.mcpAuditRead,
  module: "mcp_audit",
  action: "read",
  name: "MCP 审计查看",
  description: "查看企业 MCP 调用审计"
}];

const groupedPermissionCatalog: Permission[] = [
  {
    code: permissions.accountRead,
    module: "account",
    action: "read",
    name: "账号查看",
    description: "查看账号"
  },
  {
    code: permissions.accountManage,
    module: "account",
    action: "manage",
    name: "账号管理",
    description: "查看、创建、启停账号和重置密码"
  },
  {
    code: permissions.agentRead,
    module: "agent",
    action: "read",
    name: "Agent 查看",
    description: "查看企业 Agent"
  }
];

const nestedPermissionCatalog: Permission[] = [
  {
    code: permissions.mcpUpstreamRead,
    module: "mcp_upstream",
    action: "read",
    name: "上游服务查看",
    description: "查看上游服务"
  },
  {
    code: permissions.mcpUpstreamManage,
    module: "mcp_upstream",
    action: "manage",
    name: "上游服务管理",
    description: "管理上游服务"
  },
  {
    code: permissions.mcpAuditRead,
    module: "mcp_audit",
    action: "read",
    name: "调用审计查看",
    description: "查看调用审计"
  }
];

describe("RBACRolesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listRolesMock.mockResolvedValue([adminRole, auditorRole]);
    listPermissionsMock.mockResolvedValue(permissionCatalog);
    createRoleMock.mockResolvedValue(auditorRole);
  });

  it("系统角色只读，自定义角色可管理", async () => {
    renderPage();

    const systemRow = await rowFor("系统管理员");
    expect(within(systemRow).getByText("只读")).toBeInTheDocument();
    expect(within(systemRow).queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();

    const customRow = await rowFor("安全审计员");
    expect(within(customRow).getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(within(customRow).getByRole("button", { name: "删除 安全审计员" })).toBeInTheDocument();
  });

  it("创建自定义角色并提交固定目录中的权限", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "创建角色" }));
    fireEvent.change(screen.getByLabelText("角色编码"), { target: { value: "security_reader" } });
    fireEvent.change(screen.getByLabelText("角色名称"), { target: { value: "安全只读" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 MCP 治理 全部权限" }));
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));

    await waitFor(() => expect(createRoleMock).toHaveBeenCalledWith({
      code: "security_reader",
      name: "安全只读",
      permissionCodes: [permissions.mcpAuditRead]
    }));
  });

  it("支持按模块批量选择权限并显示半选状态", async () => {
    listPermissionsMock.mockResolvedValue(groupedPermissionCatalog);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "创建角色" }));
    const accountGroup = screen.getByRole("checkbox", { name: "选择 账号 全部权限" });

    expect(accountGroup).not.toBeChecked();
    expect(screen.getByText("0 / 2")).toBeInTheDocument();

    fireEvent.click(accountGroup);
    expect(accountGroup).toBeChecked();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看 账号 权限明细" }));
    expect(screen.getByRole("checkbox", { name: "账号查看" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "账号管理" })).toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "账号管理" }));
    expect(accountGroup).toBePartiallyChecked();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("支持父节点选择所有后代权限并联动多级半选状态", async () => {
    listPermissionsMock.mockResolvedValue(nestedPermissionCatalog);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "创建角色" }));
    const mcpGroup = screen.getByRole("checkbox", { name: "选择 MCP 治理 全部权限" });

    fireEvent.click(mcpGroup);
    expect(mcpGroup).toBeChecked();
    expect(screen.getByText("已选 3 / 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看 MCP 治理 权限明细" }));
    const upstreamGroup = screen.getByRole("checkbox", { name: "选择 上游服务 全部权限" });
    expect(upstreamGroup).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "选择 调用审计 全部权限" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "查看 上游服务 权限明细" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "上游服务管理" }));

    expect(upstreamGroup).toBePartiallyChecked();
    expect(mcpGroup).toBePartiallyChecked();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("只有 read 权限时隐藏角色写操作", async () => {
    renderPage([permissions.rbacRead]);

    await screen.findByText("安全审计员");
    expect(screen.queryByRole("button", { name: "创建角色" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除 安全审计员" })).not.toBeInTheDocument();
  });
});

function renderPage(adminPermissions?: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const page = <RBACRolesPage />;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {adminPermissions ? <AdminPermissionsProvider account={{
          userId: "usr_reader",
          email: "reader@example.com",
          name: "Reader",
          status: "active",
          adminPermissions
        }}>{page}</AdminPermissionsProvider> : page}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function rowFor(text: string) {
  const cell = await screen.findByText(text);
  const row = cell.closest("tr");
  if (!row) throw new Error(`row not found for ${text}`);
  return row;
}
