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
  it("预览使用客户端当前的品牌行，不显示旧版产品名和版本号", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "平台外观" });
    expect(screen.getByAltText("展开态 Logo 预览")).toBeInTheDocument();
    expect(screen.getByAltText("折叠态 Logo 预览")).toBeInTheDocument();
    expect(screen.queryByText("Clawee", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/^v\d+\.\d+\.\d+$/)).not.toBeInTheDocument();
  });

  it("清除深色版后沿用浅色版，保存并重新打开仍各自独立", async () => {
    const saved = {
      sidebarLogoConfigured: true, sidebarLogoUrl: "/light", sidebarCompactLogoConfigured: false, sidebarCompactLogoUrl: null,
      sidebarLogoDarkConfigured: true, sidebarLogoDarkUrl: "/dark", sidebarCompactLogoDarkConfigured: false, sidebarCompactLogoDarkUrl: null
    };
    getBrandingMock.mockResolvedValue(saved);
    updateBrandingMock.mockResolvedValue({ ...saved, sidebarLogoDarkConfigured: false, sidebarLogoDarkUrl: null });
    const view = renderPage();
    await screen.findByRole("heading", { name: "平台外观" });
    fireEvent.click(screen.getByRole("radio", { name: "深色模式" }));
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "/dark?v=0");
    fireEvent.click(screen.getByRole("button", { name: "清除展开态 Logo 配置" }));
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "/light?v=0");
    expect(screen.getByText("未配置深色版，沿用浅色版")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("平台外观已保存。");
    expect(updateBrandingMock).toHaveBeenCalledWith(expect.objectContaining({ sidebarLogoAction: "keep", sidebarLogoDarkAction: "reset" }));
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "/light?v=1");
    view.unmount();
    getBrandingMock.mockResolvedValue({ ...saved, sidebarLogoDarkConfigured: false, sidebarLogoDarkUrl: null });
    renderPage();
    await screen.findByRole("heading", { name: "平台外观" });
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "/light?v=0");
    fireEvent.click(screen.getByRole("radio", { name: "深色模式" }));
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "/light?v=0");
  });

  it("分别保留浅色和深色草稿，深色版未配置时预览浅色版", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "平台外观" });
    const light = new File(["light"], "light.png", { type: "image/png" });
    const dark = new File(["dark"], "dark.png", { type: "image/png" });
    fireEvent.change(document.querySelector("#sidebar-logo-file")!, { target: { files: [light] } });
    fireEvent.click(screen.getByRole("radio", { name: "深色模式" }));
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "blob:light.png");
    expect(screen.getAllByText("未配置深色版，沿用浅色版")).toHaveLength(1);
    fireEvent.change(document.querySelector("#sidebar-logo-dark-file")!, { target: { files: [dark] } });
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "blob:dark.png");
    fireEvent.click(screen.getByRole("radio", { name: "浅色模式" }));
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "blob:light.png");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateBrandingMock).toHaveBeenCalledWith(expect.objectContaining({
      sidebarLogo: light, sidebarLogoAction: "replace",
      sidebarLogoDark: dark, sidebarLogoDarkAction: "replace"
    })));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getBrandingMock.mockResolvedValue({
      sidebarLogoConfigured: false,
      sidebarLogoUrl: null,
      sidebarCompactLogoConfigured: false,
      sidebarCompactLogoUrl: null,
      sidebarLogoDarkConfigured: false, sidebarLogoDarkUrl: null,
      sidebarCompactLogoDarkConfigured: false, sidebarCompactLogoDarkUrl: null
    });
    updateBrandingMock.mockResolvedValue({
      sidebarLogoConfigured: true,
      sidebarLogoUrl: "/api/v1/admin/platform-branding/sidebar-logo",
      sidebarCompactLogoConfigured: false,
      sidebarCompactLogoUrl: null,
      sidebarLogoDarkConfigured: false, sidebarLogoDarkUrl: null,
      sidebarCompactLogoDarkConfigured: false, sidebarCompactLogoDarkUrl: null
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation((file) => `blob:${(file as File).name}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  it("校验并保存可选的品牌重点色", async () => {
    renderPage();
    const input = await screen.findByLabelText("品牌重点色 HEX");
    expect(screen.getByRole("heading", { name: "客户端品牌重点色" })).toBeInTheDocument();
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "invalid" } });
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(screen.getByText("请输入 #RRGGBB 格式的 HEX 色值")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "#F2E9EA" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateBrandingMock).toHaveBeenCalledWith(expect.objectContaining({ accentColor: "#F2E9EA" })));
  });

  it("previews both files locally, preserves them across themes, and resets one position", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "平台外观" });
    expect(screen.getByText("建议尺寸：1050 × 240 px")).toBeInTheDocument();
    expect(screen.getByText("建议尺寸：330 × 300 px")).toBeInTheDocument();

    const expanded = new File(["expanded"], "expanded.png", { type: "image/png" });
    const compact = new File(["compact"], "compact.jpg", { type: "image/jpeg" });
    fireEvent.change(document.querySelector("#sidebar-logo-file")!, { target: { files: [expanded] } });
    fireEvent.change(document.querySelector("#sidebar-compact-logo-file")!, { target: { files: [compact] } });

    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "blob:expanded.png");
    expect(screen.getByAltText("折叠态 Logo 预览")).toHaveAttribute("src", "blob:compact.jpg");
    expect(updateBrandingMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: "深色模式" }));
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "blob:expanded.png");
    fireEvent.click(screen.getByRole("radio", { name: "浅色模式" }));
    fireEvent.click(screen.getByRole("button", { name: "清除折叠态小 Logo 配置" }));
    expect(screen.getByAltText("折叠态 Logo 预览")).toHaveAttribute("src", "/krillinai-mark-black.png");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateBrandingMock).toHaveBeenCalledWith({
      sidebarLogoAction: "replace",
      sidebarLogo: expanded,
      sidebarCompactLogoAction: "reset",
      sidebarCompactLogo: undefined,
      sidebarLogoDarkAction: "keep", sidebarLogoDark: undefined,
      sidebarCompactLogoDarkAction: "keep", sidebarCompactLogoDark: undefined
    }));
    expect(await screen.findByText("平台外观已保存。")).toBeInTheDocument();
  });

  it("clears one configured logo and keeps the other", async () => {
    getBrandingMock.mockResolvedValue({
      sidebarLogoConfigured: true,
      sidebarLogoUrl: "/api/v1/admin/platform-branding/sidebar-logo",
      sidebarCompactLogoConfigured: true,
      sidebarCompactLogoUrl: "/api/v1/admin/platform-branding/sidebar-compact-logo",
      sidebarLogoDarkConfigured: false, sidebarLogoDarkUrl: null,
      sidebarCompactLogoDarkConfigured: false, sidebarCompactLogoDarkUrl: null
    });
    renderPage();
    await screen.findByRole("heading", { name: "平台外观" });

    fireEvent.click(screen.getByRole("button", { name: "清除展开态 Logo 配置" }));
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "/krillinai-wordmark-black.png");
    expect(screen.getByAltText("折叠态 Logo 预览")).toHaveAttribute(
      "src",
      "/api/v1/admin/platform-branding/sidebar-compact-logo?v=0"
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateBrandingMock).toHaveBeenCalledWith({
      sidebarLogoAction: "reset",
      sidebarLogo: undefined,
      sidebarCompactLogoAction: "keep",
      sidebarCompactLogo: undefined,
      sidebarLogoDarkAction: "keep", sidebarLogoDark: undefined,
      sidebarCompactLogoDarkAction: "keep", sidebarCompactLogoDark: undefined
    }));
  });

  it("restores all configured logos to defaults", async () => {
    getBrandingMock.mockResolvedValue({
      sidebarLogoConfigured: true,
      sidebarLogoUrl: "/api/v1/admin/platform-branding/sidebar-logo",
      sidebarCompactLogoConfigured: true,
      sidebarCompactLogoUrl: "/api/v1/admin/platform-branding/sidebar-compact-logo",
      sidebarLogoDarkConfigured: true, sidebarLogoDarkUrl: "/api/v1/admin/platform-branding/sidebar-logo-dark",
      sidebarCompactLogoDarkConfigured: true, sidebarCompactLogoDarkUrl: "/api/v1/admin/platform-branding/sidebar-compact-logo-dark"
    });
    renderPage();
    await screen.findByRole("heading", { name: "平台外观" });

    fireEvent.click(screen.getByRole("button", { name: "恢复默认配置" }));
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "/krillinai-wordmark-black.png");
    expect(screen.getByAltText("折叠态 Logo 预览")).toHaveAttribute("src", "/krillinai-mark-black.png");

    fireEvent.click(screen.getByRole("radio", { name: "深色模式" }));
    expect(screen.getByAltText("展开态 Logo 预览")).toHaveAttribute("src", "/krillinai-wordmark-white.png");
    expect(screen.getByAltText("折叠态 Logo 预览")).toHaveAttribute("src", "/krillinai-mark-white.png");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateBrandingMock).toHaveBeenCalledWith({
      sidebarLogoAction: "reset",
      sidebarLogo: undefined,
      sidebarCompactLogoAction: "reset",
      sidebarCompactLogo: undefined,
      sidebarLogoDarkAction: "reset", sidebarLogoDark: undefined,
      sidebarCompactLogoDarkAction: "reset", sidebarCompactLogoDark: undefined
    }));
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

  it("validates custom names, trims them, and saves only edited fields", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "平台外观" });
    const input = screen.getByLabelText("企业 Skill 名称");
    for (const value of ["", "   ", "一二三四五六七八九十一", "a\u200bb"]) {
      fireEvent.change(input, { target: { value: value || " " } });
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    }
    for (const value of ["字", "一二三四五", "𠮷".repeat(10), " 一二三四五六七八九十 "]) {
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveAttribute("aria-invalid", "false");
      expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    }
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateBrandingMock).toHaveBeenCalledWith({
      sidebarLogoAction: "keep", sidebarLogo: undefined,
      sidebarCompactLogoAction: "keep", sidebarCompactLogo: undefined,
      sidebarLogoDarkAction: "keep", sidebarLogoDark: undefined,
      sidebarCompactLogoDarkAction: "keep", sidebarCompactLogoDark: undefined,
      sidebarMenuLabels: { skills: "一二三四五六七八九十" }
    }));
  });

  it("loads stored names and restores one without changing others", async () => {
    getBrandingMock.mockResolvedValue({
      sidebarLogoConfigured: false, sidebarLogoUrl: null,
      sidebarCompactLogoConfigured: false, sidebarCompactLogoUrl: null,
      sidebarLogoDarkConfigured: false, sidebarLogoDarkUrl: null,
      sidebarCompactLogoDarkConfigured: false, sidebarCompactLogoDarkUrl: null,
      sidebarMenuLabels: { skills: "技能", knowledge: "知识" }
    });
    renderPage();
    await screen.findByRole("heading", { name: "平台外观" });
    expect(screen.getByLabelText("企业 Skill 名称")).toHaveValue("技能");
    fireEvent.click(screen.getByRole("button", { name: "恢复企业 Skill 名称默认值" }));
    expect(screen.getByLabelText("企业 Skill 名称")).toHaveValue("");
    expect(screen.getByLabelText("企业 Skill 名称")).toHaveAttribute("placeholder", "企业Skill");
    expect(screen.getByLabelText("企业知识库名称")).toHaveValue("知识");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateBrandingMock).toHaveBeenCalledWith(expect.objectContaining({ sidebarMenuLabels: { skills: null } })));
  });

  it("validates and saves the client admin URL", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "平台外观" });
    const input = screen.getByLabelText("管理后台地址");
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    fireEvent.change(input, { target: { value: " https://gateway.example/admin " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateBrandingMock).toHaveBeenCalledWith(expect.objectContaining({ adminUrl: "https://gateway.example/admin" })));
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
