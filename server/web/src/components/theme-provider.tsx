import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  applyResolvedTheme,
  readThemeMode,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeMode
} from "@/lib/theme";

const systemThemeQuery = "(prefers-color-scheme: dark)";

type ThemeContextValue = {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function systemPrefersDark() {
  return typeof window.matchMedia === "function" && window.matchMedia(systemThemeQuery).matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(() => readThemeMode());
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const resolvedTheme = resolveTheme(theme, prefersDark);

  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme selection remains active for this page when storage is unavailable.
    }
  }, [resolvedTheme, theme]);

  useEffect(() => {
    if (theme !== "system" || typeof window.matchMedia !== "function") return;

    const mediaQuery = window.matchMedia(systemThemeQuery);
    setPrefersDark(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [resolvedTheme, theme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}
