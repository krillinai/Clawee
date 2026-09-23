import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApi } from "./api";
import { getPlatformBranding, updatePlatformBranding } from "./platform-branding-api";

vi.mock("./api", () => ({ adminApi: { get: vi.fn(), putForm: vi.fn() } }));

const response = {
  sidebar_logo_configured: false, sidebar_logo_url: null,
  sidebar_compact_logo_configured: false, sidebar_compact_logo_url: null
};

describe("平台外观接口", () => {
  beforeEach(() => {
    vi.mocked(adminApi.get).mockResolvedValue(response);
    vi.mocked(adminApi.putForm).mockResolvedValue(response);
  });

  it("兼容旧响应并映射菜单名称", async () => {
    expect((await getPlatformBranding()).sidebarMenuLabels).toEqual({});
    vi.mocked(adminApi.get).mockResolvedValue({ ...response, sidebar_menu_labels: { skills: "技能" } });
    expect((await getPlatformBranding()).sidebarMenuLabels).toEqual({ skills: "技能" });
  });

  it("仅在传入菜单配置时发送字段，并保留显式重置", async () => {
    const input = { sidebarLogoAction: "keep" as const, sidebarCompactLogoAction: "keep" as const };
    await updatePlatformBranding(input);
    expect(vi.mocked(adminApi.putForm).mock.calls[0]![1].has("sidebar_menu_labels")).toBe(false);
    await updatePlatformBranding({ ...input, sidebarMenuLabels: { skills: "技能", drive: null } });
    const body = vi.mocked(adminApi.putForm).mock.calls[1]![1];
    expect(JSON.parse(String(body.get("sidebar_menu_labels")))).toEqual({ skills: "技能", drive: null });
  });

  it("保存管理后台地址并兼容旧响应", async () => {
    expect((await getPlatformBranding()).adminUrl).toBe("");
    vi.mocked(adminApi.get).mockResolvedValue({ ...response, admin_url: "https://gateway.example/admin" });
    expect((await getPlatformBranding()).adminUrl).toBe("https://gateway.example/admin");
    await updatePlatformBranding({ sidebarLogoAction: "keep", sidebarCompactLogoAction: "keep", adminUrl: "" });
    expect(vi.mocked(adminApi.putForm).mock.lastCall?.[1].get("admin_url")).toBe("");
  });
});
