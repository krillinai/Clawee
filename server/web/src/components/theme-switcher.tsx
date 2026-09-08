import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme } from "@/components/theme-provider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

const themeOptions = [
  { value: "light", label: "浅色主题", icon: Sun },
  { value: "dark", label: "深色主题", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor }
] satisfies Array<{ value: ThemeMode; label: string; icon: typeof Sun }>;

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { setTheme, theme } = useTheme();

  return (
    <TooltipProvider delayDuration={200}>
      <ToggleGroup
        aria-label="界面主题"
        className={cn(compact && "gap-0.5")}
        onValueChange={(value) => {
          if (value) setTheme(value as ThemeMode);
        }}
        size="sm"
        type="single"
        value={theme}
        variant="outline"
      >
        {themeOptions.map((option) => (
          <ToggleGroupItem
            aria-label={option.label}
            className={cn(compact && "h-6 min-w-6 px-1 [&_svg]:size-3.5")}
            key={option.value}
            value={option.value}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex size-full items-center justify-center">
                  <option.icon aria-hidden="true" />
                </span>
              </TooltipTrigger>
              <TooltipContent>{option.label}</TooltipContent>
            </Tooltip>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </TooltipProvider>
  );
}
