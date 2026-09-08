import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function HelpTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          type="button"
        >
          <CircleHelp aria-hidden="true" className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 leading-5">{children}</TooltipContent>
    </Tooltip>
  );
}
