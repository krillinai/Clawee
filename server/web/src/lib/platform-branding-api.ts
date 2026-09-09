import { adminApi } from "./api";

export type PlatformBranding = {
  sidebarLogoConfigured: boolean;
  sidebarLogoUrl: string | null;
  sidebarCompactLogoConfigured: boolean;
  sidebarCompactLogoUrl: string | null;
};

type PlatformBrandingResponse = {
  sidebar_logo_configured: boolean;
  sidebar_logo_url: string | null;
  sidebar_compact_logo_configured: boolean;
  sidebar_compact_logo_url: string | null;
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
}): Promise<PlatformBranding> {
  const body = new FormData();
  body.set("sidebar_logo_action", input.sidebarLogoAction);
  body.set("sidebar_compact_logo_action", input.sidebarCompactLogoAction);
  if (input.sidebarLogo) body.set("sidebar_logo", input.sidebarLogo);
  if (input.sidebarCompactLogo) body.set("sidebar_compact_logo", input.sidebarCompactLogo);
  return mapPlatformBranding(await adminApi.putForm<PlatformBrandingResponse>("/platform-branding", body));
}

function mapPlatformBranding(response: PlatformBrandingResponse): PlatformBranding {
  return {
    sidebarLogoConfigured: response.sidebar_logo_configured,
    sidebarLogoUrl: response.sidebar_logo_url,
    sidebarCompactLogoConfigured: response.sidebar_compact_logo_configured,
    sidebarCompactLogoUrl: response.sidebar_compact_logo_url
  };
}
