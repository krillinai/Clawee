import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listPermissions, type Permission } from "@/lib/rbac-api";

import { RBACPermissionsPage } from "./rbac-permissions";

vi.mock("@/lib/rbac-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rbac-api")>("@/lib/rbac-api");
  return { ...actual, listPermissions: vi.fn() };
});

const listPermissionsMock = vi.mocked(listPermissions);
const permissions: Permission[] = [
  { code: "console:account:read", module: "account", action: "read", name: "账号查看", description: "查看账号" },
  { code: "console:account:manage", module: "account", action: "manage", name: "账号管理", description: "查看并管理账号" },
  { code: "console:mcp:upstream:read", module: "mcp_upstream", action: "read", name: "MCP 上游查看", description: "查看上游服务" },
  { code: "console:mcp:audit:read", module: "mcp_audit", action: "read", name: "MCP 审计查看", description: "查看调用审计" }
];

describe("RBACPermissionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPermissionsMock.mockResolvedValue(permissions);
  });

  it("groups mixed-depth permission codes and hides the fixed console root", async () => {
    renderPage();

    expect(await screen.findByText("console:account:read")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "账号" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "MCP 治理" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("button", { name: /console/i })).not.toBeInTheDocument();
    expect(screen.queryByText("console:mcp:upstream:read")).not.toBeInTheDocument();
  });

  it("keeps nested groups collapsed until requested and then shows full leaf details", async () => {
    renderPage();

    const upstream = await screen.findByRole("button", { name: "上游服务" });
    expect(upstream).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(upstream);

    expect(upstream).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("console:mcp:upstream:read")).toBeInTheDocument();
    expect(screen.getByText("查看上游服务")).toBeInTheDocument();
  });

  it("keeps the three leaf columns compact on wider screens", async () => {
    renderPage();

    const code = await screen.findByText("console:account:read");
    expect(code.closest("li")).toHaveClass(
      "sm:grid-cols-[minmax(200px,260px)_minmax(180px,360px)_auto]",
      "sm:justify-start",
      "sm:gap-3"
    );
  });

  it("renders the existing empty state when the catalog has no permissions", async () => {
    listPermissionsMock.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("暂无权限节点")).toBeInTheDocument();
  });
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RBACPermissionsPage />
    </QueryClientProvider>
  );
}
