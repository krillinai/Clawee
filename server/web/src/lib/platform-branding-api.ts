import { adminApi } from "./api";

export type SidebarMenuKey = "skills" | "knowledge" | "drive" | "dashboard";
export type SidebarMenuLabels = Partial<Record<SidebarMenuKey, string>>;

export type PlatformBranding = {
  accentColor?: string;
  sidebarLogoConfigured: boolean;
  sidebarLogoUrl: string | null;
  sidebarCompactLogoConfigured: boolean;
  sidebarCompactLogoUrl: string | null;
  sidebarMenuLabels?: SidebarMenuLabels;
  adminUrl?: string;
};

type PlatformBrandingResponse = {
  accent_color?: string;
  sidebar_logo_configured: boolean;
  sidebar_logo_url: string | null;
  sidebar_compact_logo_configured: boolean;
  sidebar_compact_logo_url: string | null;
  sidebar_menu_labels?: SidebarMenuLabels;
  admin_url?: string;
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
  adminUrl?: string;
  accentColor?: string;
}): Promise<PlatformBranding> {
  const body = new FormData();
  body.set("sidebar_logo_action", input.sidebarLogoAction);
  body.set("sidebar_compact_logo_action", input.sidebarCompactLogoAction);
  if (input.sidebarLogo) body.set("sidebar_logo", input.sidebarLogo);
  if (input.sidebarCompactLogo) body.set("sidebar_compact_logo", input.sidebarCompactLogo);
  if (input.sidebarMenuLabels) body.set("sidebar_menu_labels", JSON.stringify(input.sidebarMenuLabels));
  if (input.adminUrl !== undefined) body.set("admin_url", input.adminUrl);
  if (input.accentColor !== undefined) body.set("accent_color", input.accentColor);
  return mapPlatformBranding(await adminApi.putForm<PlatformBrandingResponse>("/platform-branding", body));
}

function mapPlatformBranding(response: PlatformBrandingResponse): PlatformBranding {
  return {
    accentColor: response.accent_color || undefined,
    sidebarLogoConfigured: response.sidebar_logo_configured,
    sidebarLogoUrl: response.sidebar_logo_url,
    sidebarCompactLogoConfigured: response.sidebar_compact_logo_configured,
    sidebarCompactLogoUrl: response.sidebar_compact_logo_url,
    sidebarMenuLabels: response.sidebar_menu_labels ?? {},
    adminUrl: response.admin_url ?? ""
  };
}
