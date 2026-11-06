import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, Boxes, ChartNoAxesCombined, ClipboardCheck, History, PackageOpen, type LucideIcon } from "lucide-react";
import { NavLink } from "react-router-dom";

import { appIconPaths } from "@/lib/app-icons";
import { canReadAgentActivity, canReadBusinessData, listMyDataViews } from "@/lib/data-views-api";
import { cn } from "@/lib/utils";

type AppNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  iconSrc?: string;
};

export function AppNavigation({ modelGatewayEnabled = true }: { modelGatewayEnabled?: boolean }) {
  const dataViewsQuery = useQuery({
    queryKey: ["app-data-views"],
    queryFn: listMyDataViews
  });
  const views = dataViewsQuery.data ?? [];
  // 菜单顺序固定为 我的 Agent → 审批中心 → Agent 动态 → 数据看板 → 技能 → MCP 授权 → 模型记录。
  // Agent 动态和数据看板按数据视图授权显示；模型记录在企业自有模型模式下隐藏。
  const items: AppNavItem[] = [
    { href: "/app/agents", label: "我的 Agent", icon: Bot },
    { href: "/app/approvals", label: "审批中心", icon: ClipboardCheck },
    ...(canReadAgentActivity(views) ? [{ href: "/app/activity", label: "Agent 动态", icon: Activity }] : []),
    ...(canReadBusinessData(views)
      ? [{ href: "/app/business-data", label: "数据看板", icon: ChartNoAxesCombined }]
      : []),
    { href: "/app/skills", label: "技能", icon: PackageOpen },
    { href: "/app/mcp-capabilities", label: "MCP 授权", icon: Boxes, iconSrc: appIconPaths.mcp },
    ...(modelGatewayEnabled ? [{ href: "/app/model-usage", label: "模型记录", icon: History }] : [])
  ];

  return (
    <nav aria-label="前台应用导航" className="mt-6 grid min-h-0 flex-1 content-start gap-1 overflow-y-auto pr-1">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            className={({ isActive }) => cn(
              "flex min-h-10 items-center gap-2 rounded-md px-3 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              isActive
                ? "bg-primary/10 font-semibold text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
            key={item.href}
            to={item.href}
          >
            {item.iconSrc ? (
              <img alt="" aria-hidden="true" className="size-4 shrink-0 rounded-sm object-cover" src={item.iconSrc} />
            ) : (
              <Icon className="size-4" aria-hidden="true" />
            )}
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
