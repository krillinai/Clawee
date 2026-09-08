/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const html = readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");

function themeInitScript() {
  return html.match(/<script data-theme-init>([\s\S]*?)<\/script>/)?.[1] ?? "";
}

function runThemeInit(storedTheme: string | null, systemPrefersDark: boolean) {
  const toggle = vi.fn();
  const style: { colorScheme?: string } = {};
  const storage = { getItem: vi.fn(() => storedTheme) };
  const windowMock = { matchMedia: vi.fn(() => ({ matches: systemPrefersDark })) };
  const documentMock = { documentElement: { classList: { toggle }, style } };

  new Function("window", "document", "localStorage", themeInitScript())(
    windowMock,
    documentMock,
    storage
  );

  return { style, toggle };
}

describe("theme init", () => {
  it("runs before the React entry module", () => {
    const initIndex = html.indexOf("<script data-theme-init>");
    const reactIndex = html.indexOf('<script type="module" src="/src/main.tsx"></script>');

    expect(initIndex).toBeGreaterThan(-1);
    expect(reactIndex).toBeGreaterThan(initIndex);
  });

  it.each([
    ["dark", false, true, "dark"],
    ["light", true, false, "light"],
    ["system", true, true, "dark"],
    [null, true, true, "dark"],
    ["sepia", false, false, "light"]
  ] as const)(
    "applies stored theme %s with system dark=%s before first paint",
    (storedTheme, systemPrefersDark, expectedDark, expectedScheme) => {
      const { style, toggle } = runThemeInit(storedTheme, systemPrefersDark);

      expect(toggle).toHaveBeenCalledWith("dark", expectedDark);
      expect(style.colorScheme).toBe(expectedScheme);
    }
  );
});
