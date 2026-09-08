import type { ReactNode } from "react";

import { ThemeSwitcher } from "@/components/theme-switcher";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-[100dvh] bg-background text-foreground">
      <header className="h-16 border-b border-border bg-card">
        <div className="mx-auto flex h-full max-w-6xl flex-wrap items-center justify-between gap-4 px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="grid size-9 place-items-center rounded-md bg-primary/10 font-mono text-xs font-bold text-primary"
            >
              CG
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold">Clawee</div>
              <div className="text-xs text-muted-foreground">企业智能体操作系统</div>
            </div>
          </div>
          <ThemeSwitcher />
        </div>
      </header>
      <section className="grid min-h-[calc(100dvh-4rem)] place-items-center px-6 py-10 lg:py-12">
        {children}
      </section>
    </main>
  );
}
