import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import type { Account } from "@/lib/accounts-api";
import { createAccount, listAccounts, mergeAccounts, resetAccountPassword, updateAccountName, updateAccountStatus } from "@/lib/accounts-api";
import {
  assignAccountRole,
  listAccountRoles,
  listRoles,
  permissions,
  removeAccountRole,
  type AccountRole,
  type Role
} from "@/lib/rbac-api";

import { UsersPage } from "./users";

vi.mock("@/lib/accounts-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/accounts-api")>("@/lib/accounts-api");
  return {
    ...actual,
    createAccount: vi.fn(),
    listAccounts: vi.fn(),
    mergeAccounts: vi.fn(),
    resetAccountPassword: vi.fn(),
    updateAccountName: vi.fn(),
    updateAccountStatus: vi.fn()
  };
});

vi.mock("@/lib/rbac-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rbac-api")>("@/lib/rbac-api");
  return {
    ...actual,
    assignAccountRole: vi.fn(),
    listAccountRoles: vi.fn(),
    listRoles: vi.fn(),
    removeAccountRole: vi.fn()
  };
});

const createAccountMock = vi.mocked(createAccount);
const listAccountsMock = vi.mocked(listAccounts);
const mergeAccountsMock = vi.mocked(mergeAccounts);
const resetAccountPasswordMock = vi.mocked(resetAccountPassword);
const updateAccountNameMock = vi.mocked(updateAccountName);
const updateAccountStatusMock = vi.mocked(updateAccountStatus);
const assignAccountRoleMock = vi.mocked(assignAccountRole);
const listAccountRolesMock = vi.mocked(listAccountRoles);
const listRolesMock = vi.mocked(listRoles);
const removeAccountRoleMock = vi.mocked(removeAccountRole);

const adminRole = role({ roleId: "role_admin", code: "admin", name: "系统管理员", isSystem: true });
const auditorRole = role({ roleId: "role_auditor", code: "auditor", name: "安全审计员" });
const adminAssignment = assignment(adminRole, "usr_admin");
const auditorAssignment = assignment(auditorRole, "usr_user");

const adminAccount = account({
  userId: "usr_admin",
  email: "admin@example.com",
  name: "平台管理员",
  agent: {
    agentId: "user_usr_admin_agent",
    clientId: "user_usr_admin",
    name: "平台管理员",
    status: "active",
    actorId: "usr_admin",
    updatedAt: "2026-06-12T00:00:00Z"
  }
});
const userAccount = account({ userId: "usr_user", email: "user@example.com", name: "普通用户" });
const disabledAccount = account({
  userId: "usr_disabled",
  email: "disabled@example.com",
  name: "离岗用户",
  status: "disabled"
});

describe("UsersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAccountsMock.mockResolvedValue([adminAccount, userAccount, disabledAccount]);
    listRolesMock.mockResolvedValue([adminRole, auditorRole]);
    listAccountRolesMock.mockImplementation(async (accountID) => {
      if (accountID === "usr_admin") return [adminAssignment];
      if (accountID === "usr_user") return [auditorAssignment];
      return [];
    });
    createAccountMock.mockResolvedValue(account({ userId: "usr_new", email: "new@example.com" }));
    resetAccountPasswordMock.mockResolvedValue(userAccount);
    updateAccountNameMock.mockResolvedValue({ ...userAccount, name: "新昵称" });
    updateAccountStatusMock.mockResolvedValue({ ...userAccount, status: "disabled" });
    assignAccountRoleMock.mockResolvedValue(undefined);
    removeAccountRoleMock.mockResolvedValue(undefined);
    mergeAccountsMock.mockResolvedValue({
      action: "account_merge", agentIds: [], sourceUserId: "usr_disabled", targetUserId: "usr_admin",
      tokensPreserved: true, grantsPreserved: true, tokenCount: 0, grantCount: 0, completedAt: "2026-08-18T03:00:00Z"
    });
  });

  it("展示账号、后台角色和绑定 Agent", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "账号管理" })).toBeInTheDocument();
    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(await screen.findByText("系统管理员")).toBeInTheDocument();
    expect(await screen.findByText("安全审计员")).toBeInTheDocument();
    expect(screen.getByText("user_usr_admin_agent")).toBeInTheDocument();
    expect(screen.getAllByText("未绑定")).toHaveLength(2);
  });

  it("创建账号时不再写入旧角色字段", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "新增账号" }));
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新增账号" } });
    fireEvent.change(screen.getByLabelText("初始密码"), { target: { value: "passw0rd!" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));

    await waitFor(() => expect(createAccountMock).toHaveBeenCalledWith({
      email: "new@example.com",
      name: "新增账号",
      password: "passw0rd!",
      status: "active"
    }));
    await waitFor(() => expect(listAccountsMock).toHaveBeenCalledTimes(2));
  });

  it("名称为空时不允许创建账号", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "新增账号" }));
    const dialog = screen.getByRole("dialog", { name: "新增账号" });
    const nameInput = within(dialog).getByLabelText("名称");
    const submit = within(dialog).getByRole("button", { name: "创建账号" });

    expect(nameInput).toBeRequired();
    expect(submit).toBeDisabled();
    fireEvent.change(nameInput, { target: { value: "   " } });
    expect(submit).toBeDisabled();
    fireEvent.change(nameInput, { target: { value: "新增账号" } });
    expect(submit).toBeEnabled();
  });

  it("支持启停账号和重置密码", async () => {
    renderPage();

    const userRow = await rowFor("user@example.com");
    fireEvent.click(within(userRow).getByRole("button", { name: "禁用" }));
    await waitFor(() => expect(updateAccountStatusMock).toHaveBeenCalledWith("usr_user", "disabled"));

    fireEvent.click(within(userRow).getByRole("button", { name: "重置密码" }));
    const submit = screen.getByRole("button", { name: "确认重置" });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "short" } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "newpassw0rd!" } });
    fireEvent.click(submit);
    await waitFor(() => expect(resetAccountPasswordMock).toHaveBeenCalledWith("usr_user", "newpassw0rd!"));
  });

  it("支持修改账户昵称", async () => {
    renderPage();

    const userRow = await rowFor("user@example.com");
    fireEvent.click(within(userRow).getByRole("button", { name: "修改昵称" }));
    const dialog = await screen.findByRole("dialog", { name: "修改账户昵称" });
    const input = within(dialog).getByLabelText("昵称");
    const submit = within(dialog).getByRole("button", { name: "保存昵称" });

    expect(input).toHaveValue("普通用户");
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "  新昵称  " } });
    fireEvent.click(submit);

    await waitFor(() => expect(updateAccountNameMock).toHaveBeenCalledWith("usr_user", "新昵称"));
    await waitFor(() => expect(listAccountsMock).toHaveBeenCalledTimes(2));
  });

  it("只允许将 disabled 账号合并到 active 账号且保留访问数据", async () => {
    renderPage();

    const disabledRow = await rowFor("disabled@example.com");
    fireEvent.click(within(disabledRow).getByRole("button", { name: "合并" }));
    const dialog = await screen.findByRole("dialog", { name: "合并账号" });
    expect(within(dialog).getByText(/现有 MCP Token 和 Agent 授权保持不变/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("合并原因"), { target: { value: "重复账号" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认合并" }));

    await waitFor(() => expect(mergeAccountsMock).toHaveBeenCalledWith({
      sourceUserId: "usr_disabled",
      targetUserId: "usr_admin",
      reason: "重复账号"
    }));
    expect(within(await rowFor("user@example.com")).queryByRole("button", { name: "合并" })).not.toBeInTheDocument();
  });

  it("按差异绑定和解除多个后台角色", async () => {
    renderPage();

    const userRow = await rowFor("user@example.com");
    fireEvent.click(within(userRow).getByRole("button", { name: "角色" }));
    const dialog = await screen.findByRole("dialog", { name: "管理后台角色" });
    const adminCheckbox = within(dialog).getByRole("checkbox", { name: "系统管理员" });
    const auditorCheckbox = within(dialog).getByRole("checkbox", { name: "安全审计员" });
    expect(auditorCheckbox).toBeChecked();
    fireEvent.click(adminCheckbox);
    fireEvent.click(auditorCheckbox);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存角色" }));

    await waitFor(() => expect(assignAccountRoleMock).toHaveBeenCalledWith("usr_user", "role_admin"));
    await waitFor(() => expect(removeAccountRoleMock).toHaveBeenCalledWith("usr_user", "role_auditor"));
  });

  it("只有 read 权限时隐藏所有管理操作", async () => {
    renderPage([permissions.accountRead, permissions.rbacRead]);

    await screen.findByText("user@example.com");
    expect(screen.queryByRole("button", { name: "新增账号" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "角色" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "修改昵称" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重置密码" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "禁用" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "合并" })).not.toBeInTheDocument();
  });

  it("展示列表和写操作错误", async () => {
    listAccountsMock.mockRejectedValueOnce(new Error("load accounts failed"));
    const first = renderPage();
    expect(await screen.findByText("load accounts failed")).toBeInTheDocument();
    first.unmount();

    listAccountsMock.mockResolvedValue([adminAccount, userAccount, disabledAccount]);
    createAccountMock.mockRejectedValueOnce(new Error("email already exists"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "新增账号" }));
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新增账号" } });
    fireEvent.change(screen.getByLabelText("初始密码"), { target: { value: "passw0rd!" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号" }));
    expect(await screen.findByText("email already exists")).toBeInTheDocument();
    expect(screen.getByLabelText("邮箱")).toHaveValue("new@example.com");
  });
});

function renderPage(adminPermissions?: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const page = <UsersPage />;
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/admin/accounts"]}>
        {adminPermissions ? (
          <AdminPermissionsProvider account={{
            userId: "usr_reader",
            email: "reader@example.com",
            name: "Reader",
            status: "active",
            adminPermissions
          }}>
            {page}
          </AdminPermissionsProvider>
        ) : page}
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

function account(overrides: Partial<Account>): Account {
  return {
    userId: "usr_default",
    email: "default@example.com",
    name: "Default",
    status: "active",
    agent: null,
    ...overrides
  };
}

function role(overrides: Partial<Role>): Role {
  return {
    roleId: "role_default",
    code: "default",
    name: "默认角色",
    isSystem: false,
    permissionCodes: [],
    createdAt: "2026-07-29T00:00:00Z",
    updatedAt: "2026-07-29T00:00:00Z",
    ...overrides
  };
}

function assignment(roleValue: Role, accountId: string): AccountRole {
  return {
    accountId,
    roleId: roleValue.roleId,
    roleCode: roleValue.code,
    roleName: roleValue.name,
    isSystem: roleValue.isSystem,
    createdAt: "2026-07-29T00:00:00Z"
  };
}
