import * as React from "react"

import { cn } from "@/lib/utils"

const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<"select">
>(({ className, children, ...props }, ref) => {
  return (
    <select
      className={cn(
        "flex h-9 w-full appearance-none rounded-md border border-input bg-card px-3 py-1 text-base shadow-none transition-colors duration-150 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      ref={ref}
      {...props}
    >
      {children}
    </select>
  )
})
NativeSelect.displayName = "NativeSelect"

export { NativeSelect }
