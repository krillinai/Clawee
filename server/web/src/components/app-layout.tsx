import { Outlet } from "react-router-dom";

import { AccountPane } from "@/components/account-pane";
import { AppNavigation } from "@/components/app-navigation";
import { Card } from "@/components/ui/card";
import type { Account } from "@/lib/auth-api";

export function AppLayout({ account }: { account: Account }) {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="flex max-h-[100dvh] flex-col overflow-hidden border-b border-border bg-card p-5 lg:sticky lg:top-0 lg:h-[100dvh] lg:border-b-0 lg:border-r">
        <div className="flex min-h-11 shrink-0 items-center gap-3">
          <Card className="grid size-9 place-items-center rounded-md bg-primary/10 p-0 font-mono text-sm font-bold text-primary shadow-none">
            CG
          </Card>
          <div>
            <div className="text-base font-semibold">Clawee</div>
            <div className="text-xs text-muted-foreground">个人 Agent 接入</div>
          </div>
        </div>
        <AppNavigation modelGatewayEnabled={account.modelGatewayEnabled} />
        <div className="mt-6 grid shrink-0 gap-2">
          <AccountPane account={account} switchTo="admin" />
        </div>
      </aside>

      <main className="min-w-0 p-4 lg:p-6">
        <Outlet />
      </main>
    </div>
  );
}
