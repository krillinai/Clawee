import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/theme-provider";
import { clientDownloads, standardClientDownloadURL, type ClientDownloads } from "@/lib/client-downloads-api";
import { DownloadsPage } from "./downloads";

vi.mock("@/lib/client-downloads-api", async (original) => ({ ...await original<object>(), clientDownloads: vi.fn() }));
const downloadMock = vi.mocked(clientDownloads);

function showPage() {
  return render(<ThemeProvider><QueryClientProvider client={new QueryClient()}><MemoryRouter><DownloadsPage /></MemoryRouter></QueryClientProvider></ThemeProvider>);
}

describe("客户端下载页", () => {
  beforeEach(() => vi.clearAllMocks());

  it("配置尚未加载时不能复制可能不适用的同域地址", () => {
    downloadMock.mockReturnValue(new Promise(() => undefined));
    showPage();
    expect(screen.getByRole("button", { name: "复制服务端地址" })).toBeDisabled();
    expect(screen.queryByText(window.location.origin)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载开源标准包" })).toHaveAttribute("href", standardClientDownloadURL);
  });

  it("无配置时提供标准包、同域地址和手动配置指南", async () => {
    downloadMock.mockResolvedValue({ gateway: "", standard: { url: standardClientDownloadURL }, packages: [] });
    showPage();
    expect(await screen.findByText("暂未提供企业安装包，请使用下方开源标准包。")).toBeInTheDocument();
    expect(screen.getByText(window.location.origin)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载开源标准包" })).toHaveAttribute("href", standardClientDownloadURL);
    expect(screen.getByText(/点击“保存地址”/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "下载安装包" })).not.toBeInTheDocument();
  });

  it("接口失败时仍显示标准包和指南", async () => {
    downloadMock.mockRejectedValue(new Error("offline"));
    showPage();
    expect(await screen.findByText(/下载配置暂时不可用/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载开源标准包" })).toHaveAttribute("href", standardClientDownloadURL);
    expect(screen.getByText(/点击“保存地址”/)).toBeInTheDocument();
  });

  it("展示三平台、真实签名状态与校验值，并复制分域地址", async () => {
    const data: ClientDownloads = {
      gateway: "https://gateway.demo.example.com",
      standard: { url: "https://downloads.example.com/standard.exe", version: "0.1.7", sha256: "b".repeat(64) },
      packages: [
        { platform: "macos", arch: "arm64", signature: "signed_notarized" },
        { platform: "macos", arch: "x64", signature: "signed_notarized" },
        { platform: "windows", arch: "x64", signature: "unsigned" }
      ].map((item, index) => ({ ...item, version: "0.1.7", url: `https://downloads.example.com/${index}`, sha256: "a".repeat(64) })) as ClientDownloads["packages"]
    };
    downloadMock.mockResolvedValue(data);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    showPage();
    expect(await screen.findByText("macOS Apple Silicon")).toBeInTheDocument();
    expect(screen.getByText("macOS Intel")).toBeInTheDocument();
    expect(screen.getByText("Windows x64")).toBeInTheDocument();
    expect(screen.getByText(/0.1.7 · 未签名/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "下载安装包" }).map((link) => link.getAttribute("href"))).toEqual(data.packages.map((item) => item.url));
    fireEvent.click(screen.getByRole("button", { name: "复制服务端地址" }));
    expect(await screen.findByText("已复制服务端地址")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(data.gateway);
    writeText.mockRejectedValue(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "复制服务端地址" }));
    expect(await screen.findByText("复制失败，请选择地址手动复制")).toBeInTheDocument();
  });
});
