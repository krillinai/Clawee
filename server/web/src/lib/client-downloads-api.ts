import { publicApi } from "./api";

export type ClientDownload = {
  platform: "macos" | "windows";
  arch: "arm64" | "x64";
  version: string;
  download_url: string;
  sha256: string;
  signature: "unsigned" | "signed" | "signed_notarized";
};

export type ClientDownloads = {
  gateway_url: string;
  catalog_url?: string;
  version?: string;
  manifest_status: string;
  packages: ClientDownload[];
};

export function clientDownloads() {
  return publicApi.get<ClientDownloads>("/api/v1/public/client-downloads");
}
