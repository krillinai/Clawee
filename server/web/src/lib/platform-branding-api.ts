import { adminApi } from "./api";

export type SidebarMenuKey = "skills" | "knowledge" | "drive" | "dashboard";
export type SidebarMenuLabels = Partial<Record<SidebarMenuKey, string>>;

export type PlatformBranding = {
  sidebarLogoConfigured: boolean;
  sidebarLogoUrl: string | null;
  sidebarCompactLogoConfigured: boolean;
  sidebarCompactLogoUrl: string | null;
  sidebarMenuLabels?: SidebarMenuLabels;
};

type PlatformBrandingResponse = {
  sidebar_logo_configured: boolean;
  sidebar_logo_url: string | null;
  sidebar_compact_logo_configured: boolean;
  sidebar_compact_logo_url: string | null;
  sidebar_menu_labels?: SidebarMenuLabels;
};

export type PlatformBrandingAction = "keep" | "replace" | "reset";

export async function getPlatformBranding(): Promise<PlatformBranding> {
  return mapPlatformBranding(await adminApi.get<PlatformBrandingResponse>("/platform-branding"));
}

export async function updatePlatformBranding(input: {
  sidebarLogoAction: PlatformBrandingAction;
  sidebarLogo?: File;
  sidebarCompactLogoAction: PlatformBrandingAction;
  sidebarCompactLogo?: File;
  sidebarMenuLabels?: Partial<Record<SidebarMenuKey, string | null>>;
}): Promise<PlatformBranding> {
  const body = new FormData();
  body.set("sidebar_logo_action", input.sidebarLogoAction);
  body.set("sidebar_compact_logo_action", input.sidebarCompactLogoAction);
  if (input.sidebarLogo) body.set("sidebar_logo", input.sidebarLogo);
  if (input.sidebarCompactLogo) body.set("sidebar_compact_logo", input.sidebarCompactLogo);
  if (input.sidebarMenuLabels) body.set("sidebar_menu_labels", JSON.stringify(input.sidebarMenuLabels));
  return mapPlatformBranding(await adminApi.putForm<PlatformBrandingResponse>("/platform-branding", body));
}

function mapPlatformBranding(response: PlatformBrandingResponse): PlatformBranding {
  return {
    sidebarLogoConfigured: response.sidebar_logo_configured,
    sidebarLogoUrl: response.sidebar_logo_url,
    sidebarCompactLogoConfigured: response.sidebar_compact_logo_configured,
    sidebarCompactLogoUrl: response.sidebar_compact_logo_url,
    sidebarMenuLabels: response.sidebar_menu_labels ?? {}
  };
}
