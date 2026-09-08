import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyButton } from "./copy-button";

describe("CopyButton", () => {
  afterEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: undefined,
    });
  });

  it("copies text with the Clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<CopyButton value="reg_visible" />);

    fireEvent.click(screen.getByRole("button", { name: "复制" }));

    expect(writeText).toHaveBeenCalledWith("reg_visible");
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("falls back to execCommand when the Clipboard API is unavailable", async () => {
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(<CopyButton value="reg_visible" />);

    fireEvent.click(screen.getByRole("button", { name: "复制" }));

    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith("copy");
    });
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
    expect(document.querySelector("textarea")).not.toBeInTheDocument();
  });

  it("skips the Clipboard API on non-secure origins", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("not allowed"));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(<CopyButton value="reg_visible" />);

    fireEvent.click(screen.getByRole("button", { name: "复制" }));

    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("falls back when the Clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("not allowed"));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(<CopyButton value="reg_visible" />);

    fireEvent.click(screen.getByRole("button", { name: "复制" }));

    expect(writeText).toHaveBeenCalledWith("reg_visible");
    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith("copy");
    });
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
  });

  it("shows failure when all copy methods are denied", async () => {
    const execCommand = vi.fn().mockReturnValue(false);
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(<CopyButton value="reg_visible" />);

    fireEvent.click(screen.getByRole("button", { name: "复制" }));

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(await screen.findByRole("button", { name: "复制失败" })).toBeInTheDocument();
    expect(document.querySelector("textarea")).not.toBeInTheDocument();
  });
});
