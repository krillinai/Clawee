import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "@/lib/api";
import { getClientDownloadsAdmin, getClientDownloadsUpdate, getClientUpdateVersions, getClientUpdateCandidate, saveClientUpdatePolicy } from "@/lib/client-downloads-admin-api";
import { ClientDownloadsPage } from "./client-downloads";

vi.mock("@/lib/client-downloads-admin-api", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/client-downloads-admin-api")>(), getClientDownloadsAdmin: vi.fn(), getClientDownloadsUpdate: vi.fn(), getClientUpdateVersions: vi.fn(), getClientUpdateCandidate: vi.fn(), saveClientUpdatePolicy: vi.fn() }));
const permission = vi.hoisted(() => ({ canUpdate: true }));
vi.mock("@/components/admin-permissions", () => ({ useAdminPermission: () => permission.canUpdate }));
const manifest = { kind: "customer-desktop-update" as const, gateway_url: "https://customer.example.com", version: "1.0.6", notes: "更新说明", packages: [{ platform: "macos" as const, arch: "arm64" as const, url: "https://cdn.example.com/v1.0.6/arm64.zip", sha512: "A".repeat(86) + "==", size: 123 }] };
const published = { update: { ...manifest, revision: 1, published_at: "2026-10-12T00:00:00Z", published_by: "admin" }, revision: 1, enabled: true };

function renderPage() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ClientDownloadsPage /></QueryClientProvider>);
}

async function selectVersion() {
  fireEvent.click(await screen.findByRole("checkbox", { name: "启用客户更新" }));
  const select = screen.getByRole("combobox", { name: "目标客户端版本" });
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.keyDown(select, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "1.0.6" }));
  await screen.findByText("macos/arm64");
}

describe("连接服务器后的客户端更新策略", () => {
  beforeEach(() => {
    vi.clearAllMocks(); permission.canUpdate = true;
    vi.mocked(getClientDownloadsAdmin).mockResolvedValue({ gateway_url: manifest.gateway_url, catalog_url: "https://cdn.example.com/latest.json", version: 1, manifest_status: "ok", packages: [] });
    vi.mocked(getClientDownloadsUpdate).mockResolvedValue({ update: null, revision: 0, enabled: false });
    vi.mocked(getClientUpdateVersions).mockResolvedValue({ versions: [{ version: "1.0.6", published_at: "2026-10-12T00:00:00Z" }] });
    vi.mocked(getClientUpdateCandidate).mockResolvedValue({ version: "1.0.6", packages: manifest.packages, unavailable_platforms: ["windows/x64：缺少正式签名，不能自动安装"] });
    vi.mocked(saveClientUpdatePolicy).mockResolvedValue(published);
  });

  it("选择版本不发布，确认后只提交策略和 revision，不包含客户包清单", async () => {
    renderPage(); await selectVersion();
    expect(saveClientUpdatePolicy).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("导入客户更新 JSON 清单")).not.toBeInTheDocument();
    expect(screen.getByText(/windows\/x64：缺少正式签名/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("更新说明"), { target: { value: "管理员说明" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更新配置" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("自动下载");
    expect(saveClientUpdatePolicy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认保存" }));
    await waitFor(() => expect(saveClientUpdatePolicy).toHaveBeenCalledExactlyOnceWith({ enabled: true, version: "1.0.6", notes: "管理员说明" }, 0));
    expect(await screen.findByText("客户更新配置已保存。")).toBeInTheDocument();
  });

  it("停用保留目标版本，不需要版本目录可用", async () => {
    vi.mocked(getClientDownloadsUpdate).mockResolvedValue(published);
    vi.mocked(getClientUpdateVersions).mockRejectedValue(new Error("offline"));
    renderPage();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "启用客户更新" })).toBeChecked());
    fireEvent.click(screen.getByRole("checkbox", { name: "启用客户更新" }));
    fireEvent.click(screen.getByRole("button", { name: "保存更新配置" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("已安装版本不会回退");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认保存" }));
    await waitFor(() => expect(saveClientUpdatePolicy).toHaveBeenCalledWith({ enabled: false, version: "1.0.6", notes: manifest.notes }, 1));
  });

  it("没有权限时禁用配置控件", async () => {
    permission.canUpdate = false; renderPage();
    expect(await screen.findByText("暂无客户端下载更新权限，请联系管理员。")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "启用客户更新" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "保存更新配置" })).not.toBeInTheDocument();
  });

  it("没有安全的平台包时禁止启用", async () => {
    vi.mocked(getClientUpdateCandidate).mockResolvedValue({ version: "1.0.6", packages: [], unavailable_platforms: ["所有平台都未签名"] });
    renderPage();
    fireEvent.click(await screen.findByRole("checkbox", { name: "启用客户更新" }));
    const select = screen.getByRole("combobox", { name: "目标客户端版本" });
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.keyDown(select, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "1.0.6" }));
    await screen.findByText("所有平台都未签名");
    expect(screen.getByRole("button", { name: "保存更新配置" })).toBeDisabled();
  });

  it("冲突后刷新策略，不自动重试旧确认", async () => {
    vi.mocked(saveClientUpdatePolicy).mockRejectedValue(new APIError("配置已被其他管理员修改", 409, "client_downloads_version_conflict"));
    renderPage(); await selectVersion();
    fireEvent.click(screen.getByRole("button", { name: "保存更新配置" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "确认保存" }));
    expect(await screen.findByText(/配置已被其他管理员修改/)).toBeInTheDocument();
    await waitFor(() => expect(getClientDownloadsUpdate).toHaveBeenCalledTimes(2));
    expect(saveClientUpdatePolicy).toHaveBeenCalledTimes(1);
  });

  it("读取策略失败时不允许保存", async () => {
    vi.mocked(getClientDownloadsUpdate).mockRejectedValue(new Error("offline")); renderPage();
    expect(await screen.findByText("客户更新快照暂时不可用。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存更新配置" })).not.toBeInTheDocument();
  });
});
