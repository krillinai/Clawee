import { afterEach, describe, expect, it, vi } from "vitest";
import { APIError } from "./api";
import { getClientDownloadsUpdate, parseCustomerUpdateManifest, publishClientDownloadsUpdate } from "./client-downloads-admin-api";

export const manifest = { kind: "customer-desktop-update", gateway_url: "https://customer.example.com", version: "1.2.3", notes: "更新说明", packages: [{ platform: "macos", arch: "arm64", url: "https://cdn.example.com/1.2.3/arm64.zip", sha512: "A".repeat(86) + "==", size: 123 }] };

describe("客户更新 API", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("使用独立更新路径、PUT 和 expected_revision", async () => {
    const response = { update: { ...manifest, revision: 1, published_at: "2026-10-09T00:00:00Z", published_by: "admin" }, revision: 1 };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: response }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getClientDownloadsUpdate()).resolves.toMatchObject(response);
    await expect(publishClientDownloadsUpdate(parseCustomerUpdateManifest(JSON.stringify(manifest)), 0)).resolves.toMatchObject(response);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/admin/client-downloads/update", expect.objectContaining({ method: "GET", cache: "no-store" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/admin/client-downloads/update", expect.objectContaining({ method: "PUT", body: JSON.stringify({ ...manifest, expected_revision: 0 }) }));
  });
  it("保留并发错误用于重新读取和确认", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "client_downloads_version_conflict", message: "请刷新后重试" } }), { status: 409 })));
    await expect(publishClientDownloadsUpdate(parseCustomerUpdateManifest(JSON.stringify(manifest)), 0)).rejects.toBeInstanceOf(APIError);
  });
  it.each([
    null, {}, { ...manifest, kind: "desktop" }, { ...manifest, version: "01.2.3" }, { ...manifest, version: "1.2.3\n" }, { ...manifest, version: "1.2.3-beta" }, { ...manifest, packages: [] },
    ...["9007199254740992.0.0", "1.9007199254740992.0", "1.2.9007199254740992", "99999999999999999999.0.0"].map(version => ({ ...manifest, version })),
    { ...manifest, packages: [manifest.packages[0], manifest.packages[0]] },
    ...[{ platform: "linux" }, { platform: "windows" }, { url: "http://cdn.example.com/a.zip" }, { url: "https://cdn.example.com/a.dmg" }, { sha512: "bad" }, { size: 0 }, { size: 1.5 }].map(patch => ({ ...manifest, packages: [{ ...manifest.packages[0], ...patch }] }))
  ])("拒绝无效本地清单 %#", input => {
    expect(() => parseCustomerUpdateManifest(JSON.stringify(input))).toThrow();
  });
  it.each(["0.0.0", "9007199254740991.0.0", "1.9007199254740991.0", "1.2.9007199254740991", "9007199254740991.9007199254740991.9007199254740991"])("接受安全整数边界版本 %s", version => {
    expect(parseCustomerUpdateManifest(JSON.stringify({ ...manifest, version })).version).toBe(version);
  });
  it("只提取清单字段，不信任导入的身份或 revision", () => {
    expect(parseCustomerUpdateManifest(JSON.stringify({ ...manifest, revision: 99, published_by: "spoofed", expected_revision: 99 }))).toEqual(manifest);
  });
});
