import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { EmptyState, ErrorAlert, LoadingState, PageHeader, PageShell } from "@/components/governance-ui";
import { Button } from "@/components/ui/button";
import { AdminFeaturesContext, useAdminFeatures } from "@/hooks/useAdminFeatures";
import type { AdminFeature } from "@/lib/admin-feature-api";

const featurePages: { path: string; feature: AdminFeature; title: string }[] = [
  { path: "/admin/accounts", feature: "accounts", title: "账号管理" },
  { path: "/admin/rbac", feature: "rbac", title: "角色与权限" },
  { path: "/admin/data-permissions", feature: "data_permissions", title: "数据权限" },
  { path: "/admin/platform-branding", feature: "platform_branding", title: "平台外观" },
  { path: "/admin/client-downloads", feature: "client_downloads", title: "客户端下载" },
  { path: "/admin/mcp", feature: "mcp", title: "MCP 网关" },
  { path: "/admin/activity", feature: "activity", title: "智能体活动" },
  { path: "/admin/knowledge-bases", feature: "knowledge", title: "知识库" },
  { path: "/admin/skills/source-detail", feature: "skill_sources", title: "GitHub 来源" },
  { path: "/admin/skills", feature: "skills", title: "技能管理" },
  { path: "/admin/shared-files/storage", feature: "shared_file_storage", title: "存储配置" },
  { path: "/admin/shared-files", feature: "shared_files", title: "网盘" },
  { path: "/admin/feedback", feature: "feedback", title: "问题反馈" }
];

export function AdminFeatureGate({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const page = featurePages.find(({ path }) => pathname === path || pathname.startsWith(`${path}/`));
  return page ? <FeaturePage feature={page.feature} title={page.title}>{children}</FeaturePage> : children;
}

function FeaturePage({ children, feature, title }: { children: ReactNode; feature: AdminFeature; title: string }) {
  const query = useAdminFeatures();
  if (query.isPending) return <PageShell><LoadingState label="正在检查功能状态" /></PageShell>;
  if (query.isError) return (
    <PageShell>
      <PageHeader title={title} />
      <ErrorAlert>功能状态暂时不可用，请稍后重试。 <Button variant="outline" onClick={() => void query.refetch()}>重试</Button></ErrorAlert>
    </PageShell>
  );
  if (!query.isEnabled(feature)) return <PageShell><PageHeader title={title} /><EmptyState title="功能未开启" /></PageShell>;
  return <AdminFeaturesContext.Provider value={query.data.features}>{children}</AdminFeaturesContext.Provider>;
}
