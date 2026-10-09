import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "@/lib/api";
import { getClientDownloadsAdmin, getClientDownloadsUpdate, publishClientDownloadsUpdate } from "@/lib/client-downloads-admin-api";
import { ClientDownloadsPage } from "./client-downloads";

vi.mock("@/lib/client-downloads-admin-api", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/client-downloads-admin-api")>(), getClientDownloadsAdmin: vi.fn(), getClientDownloadsUpdate: vi.fn(), publishClientDownloadsUpdate: vi.fn() }));
const permission = vi.hoisted(() => ({ canUpdate: true }));
vi.mock("@/components/admin-permissions", () => ({ useAdminPermission: () => permission.canUpdate }));
const manifest = { kind: "customer-desktop-update", gateway_url: "https://customer.example.com", version: "1.2.3", notes: "更新说明", packages: [{ platform: "macos", arch: "arm64", url: "https://cdn.example.com/1.2.3/arm64.zip", sha512: "A".repeat(86) + "==", size: 123 }] };

function renderPage() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ClientDownloadsPage /></QueryClientProvider>);
}
async function importManifest(value: unknown = manifest) {
  const file = new File([JSON.stringify(value)], "customer-update-manifest.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => JSON.stringify(value) });
  fireEvent.change(await screen.findByLabelText("导入客户更新 JSON 清单"), { target: { files: [file] } });
}

describe("客户更新发布", () => {
  beforeEach(() => {
    vi.clearAllMocks(); permission.canUpdate = true;
    vi.mocked(getClientDownloadsAdmin).mockResolvedValue({ gateway_url: manifest.gateway_url, catalog_url: "https://cdn.example.com/latest.json", version: 1, manifest_status: "ok", packages: [] });
    vi.mocked(getClientDownloadsUpdate).mockResolvedValue({ update: null, revision: 0 });
    vi.mocked(publishClientDownloadsUpdate).mockResolvedValue({ update: { ...manifest, kind: "customer-desktop-update", packages: [{ ...manifest.packages[0], platform: "macos", arch: "arm64" }], revision: 1, published_at: "2026-10-09T00:00:00Z", published_by: "admin" }, revision: 1 });
  });
  it("导入和编辑不发布，必须手动确认；提交携带读取到的 revision", async () => {
    renderPage();
    expect(await screen.findByText("尚未发布客户更新。" )).toBeInTheDocument();
    await importManifest();
    expect(await screen.findByText("待发布版本：1.2.3")).toBeInTheDocument();
    expect(screen.getByText("macos/arm64")).toBeInTheDocument();
    expect(publishClientDownloadsUpdate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("更新说明"), { target: { value: "管理员说明" } });
    fireEvent.click(screen.getByRole("button", { name: "发布更新" }));
    const dialog = await screen.findByRole("dialog");
    expect(publishClientDownloadsUpdate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认兼容并发布" }));
    await waitFor(() => expect(publishClientDownloadsUpdate).toHaveBeenCalledExactlyOnceWith({ ...manifest, notes: "管理员说明" }, 0));
    expect(await screen.findByText("客户更新已发布。" )).toBeInTheDocument();
  });
  it("拒绝错误清单和其他 Gateway，不保留上一次可发布清单", async () => {
    renderPage(); await importManifest();
    await screen.findByText("待发布版本：1.2.3");
    await importManifest({ ...manifest, gateway_url: "https://other.example.com" });
    expect(await screen.findByText(/清单 Gateway 与固定更新渠道不匹配/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发布更新" })).toBeDisabled();
    await importManifest({});
    expect(await screen.findByText(/客户更新清单无效/)).toBeInTheDocument();
    expect(publishClientDownloadsUpdate).not.toHaveBeenCalled();
  });
  it("没有权限不能导入或发布，并解释受限原因", async () => {
    permission.canUpdate = false; renderPage();
    expect(await screen.findByText("暂无客户端下载更新权限，请联系管理员。" )).toBeInTheDocument();
    expect(screen.getByLabelText("导入客户更新 JSON 清单")).toBeDisabled();
    expect(publishClientDownloadsUpdate).not.toHaveBeenCalled();
  });
  it("冲突后刷新快照，不自动重试或沿用旧确认", async () => {
    vi.mocked(publishClientDownloadsUpdate).mockRejectedValue(new APIError("配置已被其他管理员修改，请刷新后重试", 409, "client_downloads_version_conflict"));
    renderPage(); await importManifest(); await screen.findByText("待发布版本：1.2.3");
    fireEvent.click(screen.getByRole("button", { name: "发布更新" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "确认兼容并发布" }));
    expect(await screen.findByText(/配置已被其他管理员修改/)).toBeInTheDocument();
    await waitFor(() => expect(getClientDownloadsUpdate).toHaveBeenCalledTimes(2));
    expect(publishClientDownloadsUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("更新接口失败不展示可发布入口", async () => {
    vi.mocked(getClientDownloadsUpdate).mockRejectedValue(new Error("offline"));
    renderPage();
    expect(await screen.findByText("客户更新快照暂时不可用。" )).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发布更新" })).not.toBeInTheDocument();
  });
  it("取消确认不发布，提交期间禁止重复发布和导入", async () => {
    let complete!: (response: Awaited<ReturnType<typeof publishClientDownloadsUpdate>>) => void;
    const response = { update: null, revision: 1 };
    vi.mocked(publishClientDownloadsUpdate).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    renderPage(); await importManifest(); await screen.findByText("待发布版本：1.2.3");
    fireEvent.click(screen.getByRole("button", { name: "发布更新" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "取消" }));
    expect(publishClientDownloadsUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发布更新" }));
    const confirm = within(await screen.findByRole("dialog")).getByRole("button", { name: "确认兼容并发布" });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(confirm).toBeDisabled();
    expect(screen.getByLabelText("导入客户更新 JSON 清单")).toBeDisabled();
    expect(publishClientDownloadsUpdate).toHaveBeenCalledTimes(1);
    complete(response);
    expect(await screen.findByText("客户更新已发布。")).toBeInTheDocument();
  });
  it("已有发布快照固定渠道，不跟随下载入口配置切换", async () => {
    vi.mocked(getClientDownloadsAdmin).mockResolvedValue({ gateway_url: "https://other.example.com", catalog_url: "https://cdn.example.com/latest.json", version: 2, manifest_status: "ok", packages: [] });
    vi.mocked(getClientDownloadsUpdate).mockResolvedValue({ update: { ...manifest, kind: "customer-desktop-update", version: "1.2.2", packages: [{ ...manifest.packages[0], platform: "macos", arch: "arm64" }], revision: 5, published_at: "2026-10-09T00:00:00Z", published_by: "operator" }, revision: 5 });
    renderPage(); await importManifest(); await screen.findByText("待发布版本：1.2.3");
    expect(screen.getByText(`固定更新渠道：${manifest.gateway_url}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发布更新" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "确认兼容并发布" }));
    await waitFor(() => expect(publishClientDownloadsUpdate).toHaveBeenCalledExactlyOnceWith(manifest, 5));
  });
  it("读取快照期间显示加载状态", async () => {
    vi.mocked(getClientDownloadsUpdate).mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(await screen.findByText("正在读取客户更新快照")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发布更新" })).not.toBeInTheDocument();
  });
});
