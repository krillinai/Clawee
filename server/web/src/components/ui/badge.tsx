import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring/40 focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-sm shadow-primary/10 hover:bg-primary/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline: "text-foreground",
        accent:
          "border-transparent bg-accent text-accent-foreground hover:bg-accent/80",
        success:
          "border-success/15 bg-success/10 text-success hover:bg-success/10",
        muted:
          "border-border bg-muted text-muted-foreground hover:bg-muted/80",
        warning:
          "border-warning/20 bg-warning/10 text-warning hover:bg-warning/10",
        danger:
          "border-transparent bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
