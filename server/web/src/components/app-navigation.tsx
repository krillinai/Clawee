import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, Boxes, ChartNoAxesCombined, PackageOpen, type LucideIcon } from "lucide-react";
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

const baseItems: AppNavItem[] = [
  { href: "/app/agents", label: "Agent", icon: Bot },
  { href: "/app/mcp-capabilities", label: "MCP", icon: Boxes, iconSrc: appIconPaths.mcp },
  { href: "/app/skills", label: "技能", icon: PackageOpen }
];

export function AppNavigation() {
  const dataViewsQuery = useQuery({
    queryKey: ["app-data-views"],
    queryFn: listMyDataViews
  });
  const views = dataViewsQuery.data ?? [];
  const items: AppNavItem[] = [
    ...baseItems.slice(0, 2),
    ...(canReadAgentActivity(views) ? [{ href: "/app/activity", label: "动态", icon: Activity }] : []),
    ...(canReadBusinessData(views)
      ? [{ href: "/app/business-data", label: "数据看板", icon: ChartNoAxesCombined }]
      : []),
    ...baseItems.slice(2),
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
