import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentAccount } from "@/lib/auth-api";
import { approvalsAdmin } from "@/lib/admin-approvals-api";
import { permissions } from "@/lib/rbac-api";
import { ThemeProvider } from "@/components/theme-provider";
import { App } from "./app";

vi.mock("@/lib/auth-api", async () => ({ ...await vi.importActual<typeof import("@/lib/auth-api")>("@/lib/auth-api"), currentAccount: vi.fn() }));
vi.mock("@/lib/admin-approvals-api", () => ({ approvalsAdmin: { list: vi.fn(), summary: vi.fn(), detail: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { features: {} } })));
  vi.mocked(approvalsAdmin.list).mockResolvedValue({ items: [], meta: { has_next: false, next_cursor: "" } });
  vi.mocked(approvalsAdmin.summary).mockResolvedValue({ total: 0, pending: 0, running: 0, abnormal: 0 });
});
afterEach(() => vi.unstubAllGlobals());

describe("审批管理路由权限", () => {
  it.each([permissions.skillRead, permissions.workflowInstanceRead])("单领域权限 %s 可进入统一入口", async permission => {
    vi.mocked(currentAccount).mockResolvedValue({ user: { userId: "admin", email: "admin@test.invalid", name: "管理员", status: "active", applications: { admin: true, frontend: true }, adminPermissions: [permission] }, redirectTo: "/admin" });
    window.history.pushState({}, "", "/admin/approvals");
    render(<ThemeProvider><App /></ThemeProvider>);
    expect(await screen.findByRole("heading", { name: "审批管理" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "审批管理" })).toHaveAttribute("href", "/admin/approvals");
  });

  it("其他领域管理员不能直接进入，也不显示导航", async () => {
    vi.mocked(currentAccount).mockResolvedValue({ user: { userId: "admin", email: "admin@test.invalid", name: "管理员", status: "active", applications: { admin: true, frontend: true }, adminPermissions: [permissions.accountRead] }, redirectTo: "/admin" });
    window.history.pushState({}, "", "/admin/approvals");
    render(<ThemeProvider><App /></ThemeProvider>);
    await waitFor(() => expect(window.location.pathname).toBe("/admin"));
    expect(screen.queryByRole("link", { name: "审批管理" })).not.toBeInTheDocument();
    expect(approvalsAdmin.list).not.toHaveBeenCalled();
  });
});
