import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { THEME_STORAGE_KEY } from "@/lib/theme";

type MediaController = {
  setDark: (matches: boolean) => void;
};

function installMatchMedia(initialMatches: boolean): MediaController {
  let matches = initialMatches;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const mediaQuery = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.delete(listener);
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true
  } as MediaQueryList;

  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));

  return {
    setDark(nextMatches) {
      matches = nextMatches;
      const event = { matches, media: mediaQuery.media } as MediaQueryListEvent;
      listeners.forEach((listener) => {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      });
    }
  };
}

function ThemeProbe() {
  const { resolvedTheme, setTheme, theme } = useTheme();

  return (
    <div>
      <output aria-label="主题模式">{theme}</output>
      <output aria-label="解析主题">{resolvedTheme}</output>
      <button onClick={() => setTheme("light")}>浅色</button>
      <button onClick={() => setTheme("dark")}>深色</button>
      <button onClick={() => setTheme("system")}>系统</button>
    </div>
  );
}

describe("ThemeProvider", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
    vi.unstubAllGlobals();
  });

  it("uses the stored theme on first render", async () => {
    installMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );

    expect(screen.getByLabelText("主题模式")).toHaveTextContent("dark");
    expect(screen.getByLabelText("解析主题")).toHaveTextContent("dark");
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
  });

  it("applies and persists an explicit theme selection", async () => {
    installMatchMedia(false);

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "深色" }));

    expect(screen.getByLabelText("主题模式")).toHaveTextContent("dark");
    expect(document.documentElement).toHaveClass("dark");
    await waitFor(() => expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark"));
  });

  it("tracks system changes only while using the system theme", () => {
    const media = installMatchMedia(false);

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );

    expect(screen.getByLabelText("主题模式")).toHaveTextContent("system");
    expect(screen.getByLabelText("解析主题")).toHaveTextContent("light");

    act(() => media.setDark(true));
    expect(screen.getByLabelText("解析主题")).toHaveTextContent("dark");
    expect(document.documentElement).toHaveClass("dark");

    fireEvent.click(screen.getByRole("button", { name: "浅色" }));
    act(() => media.setDark(false));
    act(() => media.setDark(true));

    expect(screen.getByLabelText("主题模式")).toHaveTextContent("light");
    expect(screen.getByLabelText("解析主题")).toHaveTextContent("light");
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("throws when useTheme is called outside ThemeProvider", () => {
    function InvalidConsumer() {
      useTheme();
      return null;
    }

    expect(() => render(<InvalidConsumer />)).toThrow("useTheme must be used within ThemeProvider");
  });
});
