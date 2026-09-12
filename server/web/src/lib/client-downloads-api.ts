import { publicApi } from "./api";

export const standardClientDownloadURL = "https://github.com/krillinai/Clawee/releases/latest";

export type ClientDownload = {
  platform: "macos" | "windows";
  arch: "arm64" | "x64";
  version: string;
  url: string;
  sha256: string;
  signature: "unsigned" | "signed" | "signed_notarized";
};

export type ClientDownloads = {
  gateway: string;
  standard: { url: string; version?: string; sha256?: string };
  packages: ClientDownload[];
};

export function clientDownloads() {
  return publicApi.get<ClientDownloads>("/api/v1/public/client-downloads");
}
