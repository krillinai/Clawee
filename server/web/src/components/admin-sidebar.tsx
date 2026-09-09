import "@/styles/admin-font.css";

import {
  Boxes,
  BookOpenText,
  CheckSquare,
  ChevronRight,
  Cpu,
  Database,
  FileSearch,
  FolderOpen,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  PackageOpen,
  Palette,
  Radio,
  Server,
  Shield,
  UserRound,
  Users,
  type LucideIcon
} from "lucide-react";
import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { AccountPane } from "@/components/account-pane";
import { AdminBrand } from "@/components/admin-brand";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from "@/components/ui/sidebar";
import { hasAdminPermission, type Account } from "@/lib/auth-api";
import { appIconPaths } from "@/lib/app-icons";
import { permissions } from "@/lib/rbac-api";
import { cn } from "@/lib/utils";

type AdminNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  iconSrc?: string;
  permission?: string;
  permissions?: readonly string[];
};

const overviewNavItem: AdminNavItem = {
  label: "总览",
  href: "/admin",
  icon: LayoutDashboard
};

const navGroups: { label: string; items: AdminNavItem[] }[] = [
  {
    label: "智能体活动",
    items: [
      { label: "智能体管理", href: "/admin/mcp/agents", icon: KeyRound, permissions: [permissions.agentRead, permissions.mcpGrantRead] },
      { label: "智能体活动", href: "/admin/activity", icon: Radio, permission: permissions.activityRead },
      { label: "采集器管理", href: "/admin/collectors", icon: Cpu, permission: permissions.collectorRead }
    ]
  },
  {
    label: "企业组件",
    items: [
      { label: "知识库", href: "/admin/knowledge-bases", icon: BookOpenText, iconSrc: appIconPaths.knowledgeBase, permission: permissions.knowledgeRead },
      { label: "技能管理", href: "/admin/skills", icon: PackageOpen, permission: permissions.skillRead },
      { label: "网盘", href: "/admin/shared-files", icon: FolderOpen, permission: permissions.sharedFilesRead }
    ]
  },
  {
    label: "MCP 网关",
    items: [
      { label: "上游服务", href: "/admin/mcp/upstream-servers", icon: Server, permission: permissions.mcpUpstreamRead },
      { label: "能力目录", href: "/admin/mcp/capabilities", icon: Boxes, permission: permissions.mcpCapabilityRead },
      { label: "门禁队列", href: "/admin/mcp/gates", icon: CheckSquare, permission: permissions.mcpGateRead },
      { label: "代理审计", href: "/admin/mcp/audits", icon: FileSearch, permission: permissions.mcpAuditRead }
    ]
  },
  {
    label: "系统管理",
    items: [
      { label: "账号管理", href: "/admin/accounts", icon: Users, permission: permissions.accountRead },
      { label: "角色管理", href: "/admin/rbac/roles", icon: Shield, permission: permissions.rbacRead },
      { label: "权限目录", href: "/admin/rbac/permissions", icon: ListChecks, permission: permissions.rbacRead },
      { label: "数据权限", href: "/admin/data-permissions", icon: Database, permission: permissions.dataResourceGrantRead },
      { label: "平台外观", href: "/admin/platform-branding", icon: Palette, permission: permissions.platformBrandingManage }
    ]
  }
];

function matchesPath(pathname: string, href: string, end = false) {
  return pathname === href || (!end && pathname.startsWith(`${href}/`));
}

export function AdminSidebar({ account }: { account?: Account }) {
  const location = useLocation();
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        !account || (item.permissions
          ? item.permissions.some((permission) => hasAdminPermission(account, permission))
          : Boolean(item.permission && hasAdminPermission(account, item.permission)))
      )
    }))
    .filter((group) => group.items.length > 0);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(() =>
    visibleGroups.find((group) =>
      group.items.some((item) => matchesPath(location.pathname, item.href))
    )?.label ?? null
  );

  return (
    <Sidebar
      className="admin-sidebar h-auto w-full border-b border-sidebar-border/50 lg:sticky lg:top-0 lg:h-[100dvh] lg:w-[--sidebar-width] lg:border-b-0 lg:border-r"
      collapsible="none"
      data-sidebar="sidebar"
    >
      <SidebarHeader className="p-3 pb-2">
        <AdminBrand />
      </SidebarHeader>

      <SidebarContent className="gap-4 px-3 py-2">
        <nav aria-label="管理后台导航" className="grid gap-4">
          <SidebarGroup className="p-0">
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    className="h-10 gap-2.5 px-3 text-sm font-medium"
                    isActive={matchesPath(location.pathname, overviewNavItem.href, true)}
                  >
                    <NavLink end to={overviewNavItem.href}>
                      <overviewNavItem.icon aria-hidden="true" />
                      <span>{overviewNavItem.label}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {visibleGroups.map((group) => {
            const isExpanded = expandedGroup === group.label;
            const containsCurrentPage = group.items.some((item) => matchesPath(location.pathname, item.href));

            return (
              <Collapsible
                className="group/collapsible"
                key={group.label}
                onOpenChange={(open) => setExpandedGroup((current) =>
                  open ? group.label : current === group.label ? null : current
                )}
                open={isExpanded}
              >
                <SidebarGroup className="p-0">
                  <SidebarGroupLabel
                    asChild
                    className={cn(
                      "h-9 cursor-pointer px-3 text-sm font-medium hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      containsCurrentPage || isExpanded ? "text-sidebar-foreground" : "text-sidebar-foreground/65"
                    )}
                  >
                    <CollapsibleTrigger>
                      <span>{group.label}</span>
                      <ChevronRight
                        aria-hidden="true"
                        className="ml-auto transition-transform duration-150 group-data-[state=open]/collapsible:rotate-90"
                      />
                    </CollapsibleTrigger>
                  </SidebarGroupLabel>
                  <CollapsibleContent>
                    <SidebarGroupContent className="pt-1">
                      <SidebarMenu>
                        {group.items.map((item) => (
                          <SidebarMenuItem key={item.href}>
                            <SidebarMenuButton
                              asChild
                              className="h-9 gap-2.5 px-3 text-[13px] font-normal text-sidebar-foreground/75"
                              isActive={matchesPath(location.pathname, item.href)}
                            >
                              <NavLink to={item.href}>
                                {item.iconSrc ? (
                                  <img alt="" aria-hidden="true" className="size-4 shrink-0 rounded-sm object-cover" src={item.iconSrc} />
                                ) : (
                                  <item.icon aria-hidden="true" />
                                )}
                                <span>{item.label}</span>
                              </NavLink>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </CollapsibleContent>
                </SidebarGroup>
              </Collapsible>
            );
          })}
        </nav>
      </SidebarContent>

      <SidebarFooter className="p-3 pb-2">
        <div className="flex items-center gap-2">
          <Button asChild className="min-w-0 flex-1 justify-start" size="sm" variant="ghost">
            <NavLink to="/app/agents">
              <UserRound aria-hidden="true" data-icon="inline-start" />
              进入用户中心
            </NavLink>
          </Button>
          <ThemeSwitcher compact />
        </div>
      </SidebarFooter>
      <SidebarFooter className="p-4 pt-2">
        <AccountPane account={account} collapseLogout showThemeSwitcher={false} />
      </SidebarFooter>
    </Sidebar>
  );
}
