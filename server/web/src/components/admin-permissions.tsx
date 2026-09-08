import { createContext, useContext, type ReactNode } from "react";

import type { Account } from "@/lib/auth-api";
import { hasAdminPermission } from "@/lib/auth-api";

const AdminAccountContext = createContext<Account | null>(null);

export function AdminPermissionsProvider({ account, children }: { account: Account; children: ReactNode }) {
  return <AdminAccountContext.Provider value={account}>{children}</AdminAccountContext.Provider>;
}

export function useAdminPermission(permissionCode: string) {
  const account = useContext(AdminAccountContext);
  return account ? hasAdminPermission(account, permissionCode) : true;
}
