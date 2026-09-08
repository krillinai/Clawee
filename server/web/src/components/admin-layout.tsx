import type { CSSProperties } from "react";
import { Outlet } from "react-router-dom";

import { AdminPermissionsProvider } from "@/components/admin-permissions";
import { AdminSidebar } from "@/components/admin-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import type { Account } from "@/lib/auth-api";

export function AdminLayout({ account }: { account?: Account }) {
  return (
    <SidebarProvider
      className="block min-h-[100dvh] bg-background text-foreground lg:flex"
      style={{ "--sidebar-width": "15.5rem" } as CSSProperties}
    >
      <AdminSidebar account={account} />

      <SidebarInset className="min-w-0 p-4 [&_[data-slot=card]]:border-border/45 lg:p-6">
        {account ? (
          <AdminPermissionsProvider account={account}>
            <Outlet />
          </AdminPermissionsProvider>
        ) : (
          <Outlet />
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
