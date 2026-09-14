import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/theme-provider";
import { clientDownloads, type ClientDownload, type ClientDownloads } from "@/lib/client-downloads-api";
import { DownloadsPage } from "./downloads";
vi.mock("@/lib/client-downloads-api", async (original) => ({ ...await original<object>(), clientDownloads: vi.fn() }));
const downloadMock = vi.mocked(clientDownloads);
function showPage() { return render(<ThemeProvider><QueryClientProvider client={new QueryClient()}><MemoryRouter><DownloadsPage /></MemoryRouter></QueryClientProvider></ThemeProvider>); }
const packagePlatforms: Array<Pick<ClientDownload, "platform" | "arch" | "signature">> = [
  { platform: "macos", arch: "arm64", signature: "signed_notarized" }, { platform: "macos", arch: "x64", signature: "signed_notarized" }, { platform: "windows", arch: "x64", signature: "unsigned" }
];
const packages: ClientDownload[] = packagePlatforms.map((item, index) => ({ ...item, version: "0.1.7", download_url: `https://downloads.example.com/${index}`, sha256: "a".repeat(64) }));
describe("客户端下载页", () => {
  beforeEach(() => vi.clearAllMocks());
  it("清单请求失败时显示错误且不展示下载链接", async () => { downloadMock.mockRejectedValue(new Error("offline")); showPage(); expect(await screen.findByText(/客户端下载清单暂时不可用/)).toBeInTheDocument(); expect(screen.queryByRole("link", { name: "下载安装包" })).not.toBeInTheDocument(); });
  it("展示三平台包和校验值，并复制服务端地址", async () => {
    const data: ClientDownloads = { gateway_url: "https://gateway.demo.example.com", catalog_url: "https://cdn.example.com/latest.json", version: "0.1.7", manifest_status: "ok", packages }; downloadMock.mockResolvedValue(data); const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true }); showPage();
    expect(await screen.findByText("macOS Apple Silicon")).toBeInTheDocument(); expect(screen.getByText("macOS Intel")).toBeInTheDocument(); expect(screen.getByText("Windows")).toBeInTheDocument(); expect(screen.getByRole("link", { name: "返回管理后台" })).toHaveAttribute("href", "/admin"); expect(screen.getByText("客户端首次使用时，在登录页面的服务端地址设置中填入此地址以连接企业服务。")).toBeInTheDocument(); expect(screen.getAllByText("0.1.7")).toHaveLength(3); expect(screen.queryByText("未签名")).not.toBeInTheDocument(); expect(screen.queryByText("已签名并公证")).not.toBeInTheDocument(); expect(screen.getAllByRole("link", { name: "下载安装包" }).map((link) => link.getAttribute("href"))).toEqual(packages.map((item) => item.download_url)); fireEvent.click(screen.getByRole("button", { name: "复制" })); await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(data.gateway_url));
  });
  it("没有包时显示空状态", async () => { downloadMock.mockResolvedValue({ gateway_url: "https://gateway.example.com", catalog_url: "https://cdn.example.com/latest.json", manifest_status: "ok", packages: [] }); showPage(); expect(await screen.findByText("暂未提供可用的企业客户端安装包。")).toBeInTheDocument(); expect(screen.queryByRole("link", { name: "下载安装包" })).not.toBeInTheDocument(); });
});
