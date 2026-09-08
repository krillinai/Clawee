import { afterEach, describe, expect, it } from "vitest";

import {
  applyResolvedTheme,
  readThemeMode,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemeMode
} from "@/lib/theme";

describe("theme", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
  });

  it.each<ThemeMode>(["light", "dark", "system"])("reads the stored %s theme", (theme) => {
    const storage = {
      getItem: (key: string) => (key === THEME_STORAGE_KEY ? theme : null)
    };

    expect(readThemeMode(storage)).toBe(theme);
  });

  it.each([null, "", "sepia", "DARK"])("falls back to system for invalid stored value %s", (value) => {
    const storage = { getItem: () => value };

    expect(readThemeMode(storage)).toBe("system");
  });

  it("falls back to system when storage cannot be read", () => {
    const storage = {
      getItem: () => {
        throw new Error("storage unavailable");
      }
    };

    expect(readThemeMode(storage)).toBe("system");
  });

  it.each([
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["system", true, "dark"],
    ["system", false, "light"]
  ] as const)("resolves %s with system dark=%s to %s", (mode, systemPrefersDark, expected) => {
    expect(resolveTheme(mode, systemPrefersDark)).toBe(expected);
  });

  it("applies the resolved theme to the document root", () => {
    applyResolvedTheme("dark");

    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyResolvedTheme("light");

    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});
