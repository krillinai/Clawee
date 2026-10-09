import { adminApi } from "./api";

export type ClientDownloadsAdminPackage = { platform: string; arch: string; version: string; download_url: string; sha256: string; signature: string };
export type ClientDownloadsAdminConfig = { gateway_url: string; catalog_url: string; version: number; updated_by?: string; updated_at?: string; manifest_status: "ok" | "unavailable"; manifest_version?: string; packages: ClientDownloadsAdminPackage[] };
export function getClientDownloadsAdmin() { return adminApi.get<ClientDownloadsAdminConfig>("/client-downloads"); }
export function updateClientDownloadsAdmin(input: Pick<ClientDownloadsAdminConfig, "gateway_url" | "catalog_url"> & { version?: number }) { return adminApi.put<ClientDownloadsAdminConfig>("/client-downloads", input); }

export type CustomerUpdatePackage = { platform: "macos" | "windows"; arch: "arm64" | "x64"; url: string; sha512: string; size: number };
export type CustomerUpdateManifest = { kind: "customer-desktop-update"; gateway_url: string; version: string; notes: string; packages: CustomerUpdatePackage[] };
export type CustomerUpdateRelease = CustomerUpdateManifest & { revision: number; published_at: string; published_by?: string };
export type ClientDownloadsUpdate = { update: CustomerUpdateRelease | null; revision: number };

export function getClientDownloadsUpdate() {
  return adminApi.get<ClientDownloadsUpdate>("/client-downloads/update", { cache: "no-store" });
}

export function publishClientDownloadsUpdate(manifest: CustomerUpdateManifest, expectedRevision: number) {
  return adminApi.put<ClientDownloadsUpdate>("/client-downloads/update", { ...manifest, expected_revision: expectedRevision });
}

export function parseCustomerUpdateManifest(contents: string): CustomerUpdateManifest {
  const invalid = () => new Error("客户更新清单无效：请检查类型、Gateway、稳定版本、平台包、HTTPS 地址、SHA512 和大小。");
  if (new TextEncoder().encode(contents).length > 128 * 1024) throw invalid();
  let value: unknown;
  try { value = JSON.parse(contents); } catch { throw invalid(); }
  if (!isRecord(value) || value.kind !== "customer-desktop-update" || typeof value.gateway_url !== "string" || typeof value.version !== "string" || value.version.trim() !== value.version || value.version.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version) || typeof value.notes !== "string" || new TextEncoder().encode(value.notes).length > 16384 || !Array.isArray(value.packages) || value.packages.length < 1 || value.packages.length > 3) throw invalid();
  if (!value.version.split(".").every(component => Number.isSafeInteger(Number(component)))) throw invalid();
  const gateway = httpsURL(value.gateway_url);
  if (!gateway || gateway.pathname !== "/") throw invalid();
  const seen = new Set<string>();
  const packages: CustomerUpdatePackage[] = value.packages.map(item => {
    if (!isRecord(item)) throw invalid();
    const pair = `${item.platform}/${item.arch}`;
    if (!["macos/arm64", "macos/x64", "windows/x64"].includes(pair) || seen.has(pair)) throw invalid();
    seen.add(pair);
    const url = typeof item.url === "string" ? httpsURL(item.url) : null;
    if (!url || !(item.platform === "macos" ? /\.zip$/i : /\.exe$/i).test(url.pathname) || typeof item.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(item.sha512) || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size <= 0) throw invalid();
    try { if (btoa(atob(item.sha512)) !== item.sha512 || atob(item.sha512).length !== 64) throw invalid(); } catch { throw invalid(); }
    return { platform: item.platform as CustomerUpdatePackage["platform"], arch: item.arch as CustomerUpdatePackage["arch"], url: item.url as string, sha512: item.sha512, size: item.size };
  });
  return { kind: "customer-desktop-update", gateway_url: gateway.origin, version: value.version, notes: value.notes, packages };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpsURL(value: string): URL | null {
  if (new TextEncoder().encode(value).length > 2048 || value.trim() !== value || !value.startsWith("https://") || value.includes("?") || value.includes("#") || value.includes("\\")) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url : null;
  } catch { return null; }
}
