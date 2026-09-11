import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AdminLayout } from "./admin-layout";
import { ThemeProvider } from "./theme-provider";
import { permissions } from "@/lib/rbac-api";

describe("AdminLayout", () => {
  it("renders Chinese admin navigation labels and pins account pane below the scrollable navigation", () => {
    const { container } = render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/admin"]}>
          <Routes>
            <Route
              path="/admin/*"
        element={<AdminLayout account={{
          email: "admin@example.com",
          name: "管理员",
          status: "active",
          userId: "usr_admin",
          adminRoles: ["admin"],
          adminPermissions: Object.values(permissions)
        }} />}
            >
              <Route index element={<div>Admin Home</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    const navigation = screen.getByRole("navigation", { name: "管理后台导航" });
    const brandLink = screen.getByRole("link", { name: "返回管理后台总览" });
    expect(brandLink).toHaveAttribute("href", "/admin");
    expect([...brandLink.querySelectorAll("img")].map((logo) => logo.getAttribute("src"))).toEqual([
      "/logo-v2-black-logo.svg",
      "/logo-v2-white-logo.svg"
    ]);
    expect(brandLink.querySelector('img[src="/logo-v2-black-logo.svg"]')).toHaveClass("dark:hidden");
    expect(brandLink.querySelector('img[src="/logo-v2-white-logo.svg"]')).toHaveClass("hidden", "dark:block");
    expect(brandLink.querySelector('img[src="/favicon.ico"]')).not.toBeInTheDocument();
    expect(brandLink).not.toHaveTextContent("CG");
    expect(screen.getByText("Clawee管理后台")).toBeInTheDocument();
    expect(screen.queryByText("Clawee AI网关")).not.toBeInTheDocument();
    expect(screen.queryByText("企业治理控制台")).not.toBeInTheDocument();
    expect(within(navigation).getAllByRole("link").map((link) => link.textContent)).toEqual(["总览"]);
    expect(screen.queryByRole("link", { name: "我的智能体" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "总览" })).toHaveClass("h-10", "text-sm", "font-medium");
    expect(screen.getByRole("button", { name: "智能体活动" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "智能体活动" })).toHaveClass("text-sm", "font-medium");
    expect(screen.getByRole("button", { name: "智能体活动" })).not.toHaveClass("font-mono", "uppercase");
    expect(screen.queryByRole("link", { name: "智能体活动" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "智能体活动" }));
    expect(screen.getByRole("button", { name: "智能体活动" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "智能体管理" })).toHaveAttribute("href", "/admin/mcp/agents");
    expect(screen.getByRole("link", { name: "智能体管理" })).toHaveClass("h-9", "text-[13px]", "font-normal");
    expect(screen.getByRole("link", { name: "智能体活动" })).toHaveAttribute("href", "/admin/activity");
    expect(screen.queryByRole("link", { name: "采集器管理" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MCP 网关" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "上游服务" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "MCP 网关" }));
    expect(screen.getByRole("button", { name: "MCP 网关" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "智能体活动" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "智能体管理" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "上游服务" })).toHaveAttribute("href", "/admin/mcp/upstream-servers");
    expect(screen.getByRole("link", { name: "能力目录" })).toHaveAttribute("href", "/admin/mcp/capabilities");
    expect(screen.queryByRole("link", { name: "智能体与授权" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "门禁队列" })).toHaveAttribute("href", "/admin/mcp/gates");
    expect(screen.getByRole("link", { name: "代理审计" })).toHaveAttribute("href", "/admin/mcp/audits");
    expect(screen.getByRole("button", { name: "企业组件" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "企业组件" }));
    expect(screen.getByRole("button", { name: "企业组件" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "MCP 网关" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "上游服务" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "知识库" })).toHaveAttribute("href", "/admin/knowledge-bases");
    expect(screen.getByRole("link", { name: "知识库" }).querySelector("img")).toHaveAttribute(
      "src",
      "/assets/app-icons/knowledge-base-24aee5a4.png"
    );
    expect(screen.getByRole("link", { name: "技能管理" })).toHaveAttribute("href", "/admin/skills");
    expect(screen.queryByRole("button", { name: "企业知识" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "技能中心" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "系统管理" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "账号管理" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "系统管理" }));
    expect(screen.getByRole("button", { name: "系统管理" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "企业组件" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "知识库" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "账号管理" })).toHaveAttribute("href", "/admin/accounts");
    expect(screen.getByRole("link", { name: "角色管理" })).toHaveAttribute("href", "/admin/rbac/roles");
    expect(screen.getByRole("link", { name: "权限目录" })).toHaveAttribute("href", "/admin/rbac/permissions");
    expect(screen.getByRole("link", { name: "数据权限" })).toHaveAttribute("href", "/admin/data-permissions");
    expect(screen.queryByRole("link", { name: "智能体活动列表" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "智能体活动详情" })).not.toBeInTheDocument();
    expect(screen.getByText("管理员")).toBeInTheDocument();
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    const accountInformation = screen.getByRole("group", { name: "账户信息" });
    expect(screen.getByRole("link", { name: "进入用户中心" })).toHaveAttribute("href", "/app/agents");
    expect(screen.getByRole("radiogroup", { name: "界面主题" })).toBeInTheDocument();
    expect(within(accountInformation).queryByRole("link", { name: "进入用户中心" })).not.toBeInTheDocument();
    expect(within(accountInformation).queryByRole("radiogroup", { name: "界面主题" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "退出登录" })).not.toBeInTheDocument();
    fireEvent.click(within(accountInformation).getByRole("button", { name: "账户操作" }));
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();

    expect(screen.queryByText(["Agent", "Office"].join(" "))).not.toBeInTheDocument();
    expect(screen.queryByText(["Action", "Gateway"].join(" "))).not.toBeInTheDocument();
    expect(screen.queryByText("审计记录")).not.toBeInTheDocument();
    expect(container.querySelector('[data-sidebar="sidebar"]')).toHaveClass("admin-sidebar", "flex", "w-full");
    expect(container.querySelector('[data-sidebar="sidebar"]')).toHaveClass("border-b", "border-sidebar-border/50", "lg:border-r");
    expect(container.querySelector('[data-sidebar="separator"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="card"]')).toHaveClass("border-border/45", "bg-muted/50");
    expect(container.querySelector("main")).toHaveClass("[&_[data-slot=card]]:border-border/45");
    expect(container.querySelector('[data-sidebar="content"]')).toHaveClass("min-h-0", "flex-1", "overflow-auto", "px-3");
    expect(container.querySelectorAll('[data-sidebar="footer"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-sidebar="footer"]')[1]).toHaveClass("p-4", "pt-2");
    expect(container.querySelectorAll('[data-sidebar="footer"]')[1]).toHaveTextContent("admin@example.com");
  });

  it("只展示当前账号拥有权限的后台菜单", async () => {
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/admin/accounts"]}>
          <Routes>
            <Route
              path="/admin/*"
              element={<AdminLayout account={{
                email: "reader@example.com",
                name: "账号审计员",
                status: "active",
                userId: "usr_reader",
                adminPermissions: ["console:account:read", "console:rbac:read"]
              }} />}
            >
              <Route path="accounts" element={<div>Accounts</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    expect(screen.getByRole("link", { name: "总览" })).toHaveAttribute("href", "/admin");
    expect(screen.queryByRole("button", { name: "MCP 网关" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "系统管理" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "系统管理" })).toHaveClass("text-sidebar-foreground");
    expect(await screen.findByRole("link", { name: "账号管理" })).toHaveAttribute("href", "/admin/accounts");
    expect(screen.getByRole("link", { name: "角色管理" })).toHaveAttribute("href", "/admin/rbac/roles");
    expect(screen.getByRole("link", { name: "权限目录" })).toHaveAttribute("href", "/admin/rbac/permissions");
    expect(screen.queryByRole("link", { name: "智能体管理" })).not.toBeInTheDocument();
  });

  it("为仅有 MCP 授权权限的账号展示智能体管理入口", () => {
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/admin/mcp/agents"]}>
          <Routes>
            <Route
              path="/admin/*"
              element={<AdminLayout account={{
                email: "grant-reader@example.com",
                name: "授权审计员",
                status: "active",
                userId: "usr_grant_reader",
                adminPermissions: ["console:mcp:grant:read"]
              }} />}
            >
              <Route path="mcp/agents" element={<div>Agents</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    expect(screen.getByRole("button", { name: "智能体活动" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "智能体管理" })).toHaveAttribute("href", "/admin/mcp/agents");
  });
});
