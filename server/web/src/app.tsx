import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AdminLayout } from "./components/admin-layout";
import { AppLayout } from "./components/app-layout";
import { AuthGate } from "./components/auth-gate";
import { permissions } from "./lib/rbac-api";
import { NotFoundPage } from "./pages/not-found";

const AgentAccessPage = lazy(() =>
  import("./pages/agent-access").then((module) => ({ default: module.AgentAccessPage }))
);
const AppMCPCapabilitiesPage = lazy(() =>
  import("./pages/app-mcp-capabilities").then((module) => ({ default: module.AppMCPCapabilitiesPage }))
);
const AppSkillsPage = lazy(() =>
  import("./pages/app-skills").then((module) => ({ default: module.AppSkillsPage }))
);
const AppActivityPage = lazy(() =>
  import("./pages/app-activity").then((module) => ({ default: module.AppActivityPage }))
);
const AppRechargeRecordsPage = lazy(() =>
  import("./pages/app-recharge-records").then((module) => ({ default: module.AppRechargeRecordsPage }))
);
const AppBusinessDataPage = lazy(() =>
  import("./pages/app-business-data").then((module) => ({ default: module.AppBusinessDataPage }))
);
const AdminOverviewPage = lazy(() =>
  import("./pages/admin-overview").then((module) => ({ default: module.AdminOverviewPage }))
);
const LoginPage = lazy(() =>
  import("./pages/login").then((module) => ({ default: module.LoginPage }))
);
const MCPAgentsGrantsPage = lazy(() =>
  import("./pages/mcp-agents-grants").then((module) => ({ default: module.MCPAgentsGrantsPage }))
);
const MCPCapabilitiesPage = lazy(() =>
  import("./pages/mcp-capabilities").then((module) => ({ default: module.MCPCapabilitiesPage }))
);
const MCPGatesPage = lazy(() =>
  import("./pages/mcp-gates").then((module) => ({ default: module.MCPGatesPage }))
);
const MCPProxyAuditPage = lazy(() =>
  import("./pages/mcp-proxy-audit").then((module) => ({ default: module.MCPProxyAuditPage }))
);
const MCPUpstreamServersPage = lazy(() =>
  import("./pages/mcp-upstream-servers").then((module) => ({
    default: module.MCPUpstreamServersPage
  }))
);
const KnowledgeBasesPage = lazy(() =>
  import("./pages/knowledge-bases").then((module) => ({ default: module.KnowledgeBasesPage }))
);
const KnowledgeBaseDocumentsPage = lazy(() =>
  import("./pages/knowledge-base-documents").then((module) => ({
    default: module.KnowledgeBaseDocumentsPage
  }))
);
const SkillsPage = lazy(() =>
  import("./pages/skills").then((module) => ({ default: module.SkillsPage }))
);
const SkillDetailPage = lazy(() =>
  import("./pages/skill-detail").then((module) => ({ default: module.SkillDetailPage }))
);
const SkillSourceDetailPage = lazy(() =>
  import("./pages/skill-source-detail").then((module) => ({ default: module.SkillSourceDetailPage }))
);
const SharedFilesPage = lazy(() =>
  import("./pages/shared-files").then((module) => ({ default: module.SharedFilesPage }))
);
const SharedSpaceFilesPage = lazy(() =>
  import("./pages/shared-space-files").then((module) => ({ default: module.SharedSpaceFilesPage }))
);
const SharedFileStoragePage = lazy(() =>
  import("./pages/shared-file-storage").then((module) => ({ default: module.SharedFileStoragePage }))
);
const OfficeAgentActivityPage = lazy(() =>
  import("./pages/office-agent-activity").then((module) => ({
    default: module.OfficeAgentActivityPage
  }))
);
const OfficeAgentDetailPage = lazy(() =>
  import("./pages/office-agent-detail").then((module) => ({ default: module.OfficeAgentDetailPage }))
);
const RegisterPage = lazy(() =>
  import("./pages/register").then((module) => ({ default: module.RegisterPage }))
);
const UsersPage = lazy(() => import("./pages/users").then((module) => ({ default: module.UsersPage })));
const RBACRolesPage = lazy(() => import("./pages/rbac-roles").then((module) => ({ default: module.RBACRolesPage })));
const RBACPermissionsPage = lazy(() => import("./pages/rbac-permissions").then((module) => ({ default: module.RBACPermissionsPage })));
const DataResourceGrantsPage = lazy(() => import("./pages/data-resource-grants").then((module) => ({ default: module.DataResourceGrantsPage })));
const PlatformBrandingPage = lazy(() => import("./pages/platform-branding").then((module) => ({ default: module.PlatformBrandingPage })));

function adminPage(permission: string, element: React.ReactNode) {
  return <AuthGate requiredPermission={permission}>{element}</AuthGate>;
}

function adminPageAny(requiredPermissions: string[], element: React.ReactNode) {
  return <AuthGate requiredAnyPermissions={requiredPermissions}>{element}</AuthGate>;
}

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1
          }
        }
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/" element={<Navigate to="/app" replace />} />
            <Route path="/app" element={<Navigate to="/app/agents" replace />} />
            <Route
              element={
                <AuthGate>
                  {(account) => <AppLayout account={account} />}
                </AuthGate>
              }
            >
              <Route path="/app/agents" element={<AgentAccessPage />} />
              <Route path="/app/agents/detail" element={<AgentAccessPage />} />
              <Route path="/app/mcp-capabilities" element={<AppMCPCapabilitiesPage />} />
              <Route path="/app/activity" element={<AppActivityPage />} />
              <Route path="/app/activity/detail" element={<AppActivityPage detail />} />
              <Route path="/app/activity/recharge-records" element={<AppRechargeRecordsPage />} />
              <Route path="/app/business-data" element={<AppBusinessDataPage />} />
              <Route
                path="/app/business-data/xiaohongshu-operation"
                element={<AppBusinessDataPage requestedView="xiaohongshu_operation" />}
              />
              <Route
                path="/app/business-data/douyin-ads"
                element={<AppBusinessDataPage requestedView="douyin_ads" />}
              />
              <Route
                path="/app/business-data/bilibili-operation"
                element={<AppBusinessDataPage requestedView="bilibili_operation" />}
              />
              <Route path="/app/skills" element={<AppSkillsPage />} />
              <Route path="/app/skills/detail" element={<AppSkillsPage />} />
            </Route>
            <Route
              element={
                <AuthGate requireAdmin>
                  {(account) => <AdminLayout account={account} />}
                </AuthGate>
              }
            >
              <Route path="/admin" element={<AdminOverviewPage />} />
              <Route path="/admin/accounts" element={adminPage(permissions.accountRead, <UsersPage />)} />
              <Route path="/admin/rbac/roles" element={adminPage(permissions.rbacRead, <RBACRolesPage />)} />
              <Route path="/admin/rbac/permissions" element={adminPage(permissions.rbacRead, <RBACPermissionsPage />)} />
              <Route path="/admin/data-permissions" element={adminPage(permissions.dataResourceGrantRead, <DataResourceGrantsPage />)} />
              <Route path="/admin/platform-branding" element={adminPage(permissions.platformBrandingRead, <PlatformBrandingPage />)} />
              <Route path="/admin/mcp/upstream-servers" element={adminPage(permissions.mcpUpstreamRead, <MCPUpstreamServersPage />)} />
              <Route path="/admin/mcp/upstream-servers/detail" element={adminPage(permissions.mcpUpstreamRead, <MCPUpstreamServersPage />)} />
              <Route path="/admin/mcp/capabilities" element={adminPage(permissions.mcpCapabilityRead, <MCPCapabilitiesPage />)} />
              <Route path="/admin/mcp/agents" element={adminPageAny([permissions.agentRead, permissions.mcpGrantRead], <MCPAgentsGrantsPage />)} />
              <Route path="/admin/mcp/agents/detail" element={adminPageAny([permissions.agentRead, permissions.mcpGrantRead], <MCPAgentsGrantsPage />)} />
              <Route path="/admin/mcp/gates" element={adminPage(permissions.mcpGateRead, <MCPGatesPage />)} />
              <Route path="/admin/mcp/gates/detail" element={adminPage(permissions.mcpGateRead, <MCPGatesPage />)} />
              <Route path="/admin/mcp/audits" element={adminPage(permissions.mcpAuditRead, <MCPProxyAuditPage />)} />
              <Route path="/admin/knowledge-bases" element={adminPage(permissions.knowledgeRead, <KnowledgeBasesPage />)} />
              <Route path="/admin/skills" element={adminPage(permissions.skillRead, <SkillsPage />)} />
              <Route path="/admin/skills/detail" element={adminPage(permissions.skillRead, <SkillDetailPage />)} />
              <Route path="/admin/skills/source-detail" element={adminPage(permissions.skillRead, <SkillSourceDetailPage />)} />
              <Route path="/admin/shared-files" element={adminPage(permissions.sharedFilesRead, <SharedFilesPage />)} />
              <Route path="/admin/shared-files/detail" element={adminPage(permissions.sharedFilesRead, <SharedSpaceFilesPage />)} />
              <Route path="/admin/shared-files/storage" element={adminPage(permissions.sharedFilesStorageRead, <SharedFileStoragePage />)} />
              <Route
                path="/admin/knowledge-bases/documents"
                element={adminPage(permissions.knowledgeRead, <KnowledgeBaseDocumentsPage />)}
              />
              <Route path="/admin/activity" element={adminPage(permissions.activityRead, <OfficeAgentActivityPage />)} />
              <Route
                path="/admin/activity/detail"
                element={adminPage(permissions.activityRead, <OfficeAgentDetailPage />)}
              />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
