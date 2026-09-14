import { adminApi } from "./api";

export type ClientDownloadsAdminPackage = { platform: string; arch: string; version: string; download_url: string; sha256: string; signature: string };
export type ClientDownloadsAdminConfig = { gateway_url: string; catalog_url: string; version: number; updated_by?: string; updated_at?: string; manifest_status: "ok" | "unavailable"; manifest_version?: string; packages: ClientDownloadsAdminPackage[] };
export function getClientDownloadsAdmin() { return adminApi.get<ClientDownloadsAdminConfig>("/client-downloads"); }
export function updateClientDownloadsAdmin(input: Pick<ClientDownloadsAdminConfig, "gateway_url" | "catalog_url"> & { version?: number }) { return adminApi.put<ClientDownloadsAdminConfig>("/client-downloads", input); }
