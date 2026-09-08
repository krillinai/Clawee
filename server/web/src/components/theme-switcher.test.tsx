import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/components/theme-provider";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { THEME_STORAGE_KEY } from "@/lib/theme";

function installMatchMedia() {
  const mediaQuery = {
    matches: false,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true
  } satisfies MediaQueryList;

  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));
}

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    installMatchMedia();
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
    vi.unstubAllGlobals();
  });

  it("renders an accessible three-option single-select control", () => {
    render(
      <ThemeProvider>
        <ThemeSwitcher />
      </ThemeProvider>
    );

    expect(screen.getByRole("radiogroup", { name: "界面主题" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "浅色主题" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "深色主题" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "跟随系统" })).toHaveAttribute("aria-checked", "true");
  });

  it("switches and persists all three theme modes", async () => {
    render(
      <ThemeProvider>
        <ThemeSwitcher />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole("radio", { name: "深色主题" }));
    expect(document.documentElement).toHaveClass("dark");
    await waitFor(() => expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark"));

    fireEvent.click(screen.getByRole("radio", { name: "浅色主题" }));
    expect(document.documentElement).not.toHaveClass("dark");
    await waitFor(() => expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light"));

    fireEvent.click(screen.getByRole("radio", { name: "跟随系统" }));
    expect(screen.getByRole("radio", { name: "跟随系统" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system"));
  });

  it("keeps the current mode when the selected option is pressed again", () => {
    render(
      <ThemeProvider>
        <ThemeSwitcher />
      </ThemeProvider>
    );

    const systemOption = screen.getByRole("radio", { name: "跟随系统" });
    fireEvent.click(systemOption);

    expect(systemOption).toHaveAttribute("aria-checked", "true");
  });

  it("supports a compact size for dense account panels", () => {
    render(
      <ThemeProvider>
        <ThemeSwitcher compact />
      </ThemeProvider>
    );

    expect(screen.getByRole("radiogroup", { name: "界面主题" })).toHaveClass("gap-0.5");
    expect(screen.getByRole("radio", { name: "浅色主题" })).toHaveClass("h-6", "min-w-6");
  });
});
