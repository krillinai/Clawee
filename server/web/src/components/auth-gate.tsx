import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Navigate, useLocation } from "react-router-dom";

import {
  currentAccount,
  hasAdminPermission,
  hasAnyAdminPermission,
  validateAdminSession,
  type Account
} from "@/lib/auth-api";

type AuthGateProps = {
  requireAdmin?: boolean;
  requiredPermission?: string;
  requiredAnyPermissions?: string[];
  children: ReactNode | ((account: Account) => ReactNode);
};

export function AuthGate({ requireAdmin = false, requiredPermission, requiredAnyPermissions, children }: AuthGateProps) {
  const location = useLocation();
  const authQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: currentAccount,
    retry: false
  });
  const currentAccountData = authQuery.data?.user;
  const adminSessionQuery = useQuery({
    queryKey: ["auth", "admin-session"],
    queryFn: validateAdminSession,
    retry: false,
    enabled: requireAdmin && currentAccountData !== undefined && hasAnyAdminPermission(currentAccountData)
  });

  if (authQuery.isLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
        正在校验登录状态
      </div>
    );
  }

  if (authQuery.isError || !authQuery.data) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  const account = authQuery.data.user;
  if (requireAdmin && !hasAnyAdminPermission(account)) {
    return <Navigate to="/app" replace />;
  }
  if (requireAdmin && adminSessionQuery.isLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
        正在校验后台会话
      </div>
    );
  }
  if (requireAdmin && adminSessionQuery.isError) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  if (requiredPermission && !hasAdminPermission(account, requiredPermission)) {
    return <Navigate to={adminHome(account)} replace />;
  }
  if (requiredAnyPermissions && !requiredAnyPermissions.some((permission) => hasAdminPermission(account, permission))) {
    return <Navigate to={adminHome(account)} replace />;
  }

  return typeof children === "function" ? children(account) : children;
}

function adminHome(account: Account) {
  return hasAnyAdminPermission(account) ? "/admin" : "/app";
}
