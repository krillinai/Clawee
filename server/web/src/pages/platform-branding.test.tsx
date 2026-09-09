import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPlatformBranding, updatePlatformBranding } from "@/lib/platform-branding-api";
import { PlatformBrandingPage } from "./platform-branding";

vi.mock("@/lib/platform-branding-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform-branding-api")>();
  return { ...actual, getPlatformBranding: vi.fn(), updatePlatformBranding: vi.fn() };
});

const getBrandingMock = vi.mocked(getPlatformBranding);
const updateBrandingMock = vi.mocked(updatePlatformBranding);

describe("PlatformBrandingPage", () => {
  beforeEach(() => {
    getBrandingMock.mockResolvedValue({
      sidebarLogoConfigured: false,
      sidebarLogoUrl: null,
      sidebarCompactLogoConfigured: false,
      sidebarCompactLogoUrl: null
    });
    updateBrandingMock.mockResolvedValue({
      sidebarLogoConfigured: true,
      sidebarLogoUrl: "/api/v1/admin/platform-branding/sidebar-logo",
      sidebarCompactLogoConfigured: false,
      sidebarCompactLogoUrl: null
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation((file) => `blob:${(file as File).name}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  it("previews both files locally, preserves them across backgrounds, and resets one position", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "平台外观" });

    const expanded = new File(["expanded"], "expanded.png", { type: "image/png" });
    const compact = new File(["compact"], "compact.jpg", { type: "image/jpeg" });
    fireEvent.change(document.querySelector("#sidebar-logo-file")!, { target: { files: [expanded] } });
    fireEvent.change(document.querySelector("#sidebar-compact-logo-file")!, { target: { files: [compact] } });

    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "blob:expanded.png");
    expect(screen.getByAltText("折叠态 Logo 预览")).toHaveAttribute("src", "blob:compact.jpg");
    expect(updateBrandingMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: "深色背景" }));
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "blob:expanded.png");
    fireEvent.click(screen.getByRole("button", { name: "恢复折叠态小 Logo 默认值" }));
    expect(screen.getByAltText("折叠态 Logo 预览")).toHaveAttribute("src", "/krillinai-mark-white.png");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateBrandingMock).toHaveBeenCalledWith({
      sidebarLogoAction: "replace",
      sidebarLogo: expanded,
      sidebarCompactLogoAction: "reset",
      sidebarCompactLogo: undefined
    }));
    expect(await screen.findByText("平台外观已保存。")).toBeInTheDocument();
  });

  it("keeps a pending file when saving fails", async () => {
    updateBrandingMock.mockRejectedValue(new Error("network"));
    renderPage();
    await screen.findByRole("heading", { name: "平台外观" });
    const expanded = new File(["expanded"], "expanded.png", { type: "image/png" });
    fireEvent.change(document.querySelector("#sidebar-logo-file")!, { target: { files: [expanded] } });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("平台外观保存失败，请稍后重试。")).toBeInTheDocument();
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "blob:expanded.png");
  });
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PlatformBrandingPage />
    </QueryClientProvider>
  );
}
