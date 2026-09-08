export type ThemeMode = "light" | "dark" | "system";

export type ResolvedTheme = Exclude<ThemeMode, "system">;

export const THEME_STORAGE_KEY = "clawee-theme";

const themeModes: ThemeMode[] = ["light", "dark", "system"];

export function readThemeMode(storage: Pick<Storage, "getItem"> = window.localStorage): ThemeMode {
  try {
    const storedTheme = storage.getItem(THEME_STORAGE_KEY);
    return themeModes.includes(storedTheme as ThemeMode) ? (storedTheme as ThemeMode) : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

export function applyResolvedTheme(
  theme: ResolvedTheme,
  root: HTMLElement = document.documentElement
): void {
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}
