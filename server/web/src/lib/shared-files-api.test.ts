import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addSharedSpaceMember,
  createSharedSpace,
  listSharedFiles,
  listSharedSpaceCandidates,
  listSharedSpaceMembers,
  listSharedSpaces,
  removeSharedSpaceMember,
  sharedFileDownloadURL,
  uploadSharedFile,
  updateSharedSpaceMember,
  updateSharedSpace
} from "./shared-files-api";

describe("shared files api", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps paged spaces and uses the documented admin routes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [spaceResponse()], meta: { next_cursor: "next", has_next: true } }))
      .mockResolvedValueOnce(jsonResponse({ data: spaceResponse("space_new", "新空间") }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: spaceResponse("space_1", "已更新") }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSharedSpaces({ query: "季度", cursor: "cursor" })).resolves.toMatchObject({ items: [{ spaceId: "space_1", memberCount: 2 }], meta: { next_cursor: "next" } });
    await createSharedSpace({ name: "新空间", description: "说明" });
    await updateSharedSpace({ spaceId: "space_1", name: "已更新", description: "说明" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/admin/shared-spaces?limit=50&query=%E5%AD%A3%E5%BA%A6&cursor=cursor", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/admin/shared-spaces", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "新空间", description: "说明" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/admin/shared-spaces", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ space_id: "space_1", name: "已更新", description: "说明" }) }));
  });

  it("uses dedicated member and candidate contracts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [memberResponse()], meta: { next_cursor: "", has_next: false } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ user_id: "usr_2", name: "李四", email: "lisi@example.com" }], meta: { next_cursor: "", has_next: false } }))
      .mockResolvedValueOnce(jsonResponse({ data: memberResponse() }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { ...memberResponse(), actions: ["read"] } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSharedSpaceMembers({ spaceId: "space/1", query: "张", cursor: "member-next" })).resolves.toMatchObject({ items: [{ userId: "usr_1", grantStatus: "complete" }] });
    await expect(listSharedSpaceCandidates({ spaceId: "space/1", query: "李", cursor: "candidate-next" })).resolves.toMatchObject({ items: [{ userId: "usr_2", email: "lisi@example.com" }] });
    await addSharedSpaceMember({ spaceId: "space/1", userId: "usr_1", actions: ["read", "write"] });
    await updateSharedSpaceMember({ spaceId: "space/1", userId: "usr_1", actions: ["read"] });
    await removeSharedSpaceMember({ spaceId: "space/1", userId: "usr_1" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/admin/shared-spaces/account-grants?space_id=space%2F1&limit=100&query=%E5%BC%A0&cursor=member-next", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/admin/shared-spaces/member-candidates?space_id=space%2F1&limit=100&query=%E6%9D%8E&cursor=candidate-next", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/admin/shared-spaces/account-grants", expect.objectContaining({ method: "POST", body: JSON.stringify({ space_id: "space/1", user_id: "usr_1", actions: ["read", "write"] }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/v1/admin/shared-spaces/account-grants", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ space_id: "space/1", user_id: "usr_1", actions: ["read"] }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/v1/admin/shared-spaces/account-grants/remove", expect.objectContaining({ method: "POST" }));
  });

  it("lists files and uploads the raw browser file body", async () => {
    const uploaded = new File(["hello"], "guide.txt", { type: "text/plain" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [fileResponse()], meta: { next_cursor: "file-next", has_next: true } }))
      .mockResolvedValueOnce(jsonResponse({ data: { ...fileResponse(), created: false, sha256: "a".repeat(64) } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSharedFiles({ spaceId: "space/1", query: "guide", logicalPathPrefix: "docs/", cursor: "file-cursor" })).resolves.toMatchObject({ items: [{ fileId: "file_1", updatedByUserName: "管理员", updatedByAgentId: "" }], meta: { next_cursor: "file-next" } });
    await expect(uploadSharedFile({ spaceId: "space/1", logicalPath: "docs/guide.txt", file: uploaded, expectedRevision: 2 })).resolves.toMatchObject({ fileId: "file_1", created: false });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/admin/shared-files?space_id=space%2F1&limit=50&query=guide&logical_path_prefix=docs%2F&cursor=file-cursor", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/admin/shared-files/content?space_id=space%2F1&logical_path=docs%2Fguide.txt&expected_revision=2", expect.objectContaining({ method: "POST", credentials: "include", body: uploaded, headers: expect.objectContaining({ "Content-Type": "text/plain" }) }));
    expect(sharedFileDownloadURL("file/1")).toBe("/api/v1/admin/shared-files/content?file_id=file%2F1");
  });

  it("preserves the stable upload error code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { code: "revision_conflict", message: "文件已被修改" } }, 409)));
    const uploaded = new File(["hello"], "guide.txt", { type: "text/plain" });
    await expect(uploadSharedFile({ spaceId: "space_1", logicalPath: "guide.txt", file: uploaded, expectedRevision: 1 })).rejects.toMatchObject({ code: "revision_conflict", message: "文件已被修改" });
  });
});

function spaceResponse(space_id = "space_1", name = "季度空间") {
  return { space_id, name, description: "协作文件", member_count: 2, file_count: 3, size_bytes: 1024, created_by: "admin", created_at: "2026-08-01T00:00:00Z", updated_by: "admin", updated_at: "2026-08-05T00:00:00Z" };
}

function memberResponse() {
  return { user_id: "usr_1", name: "张三", email: "zhang@example.com", account_status: "active", grant_status: "complete", actions: ["read", "write"], joined_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-05T00:00:00Z" };
}

function fileResponse() {
  return { file_id: "file_1", space_id: "space_1", logical_path: "docs/guide.txt", file_name: "guide.txt", size_bytes: 5, content_type: "text/plain", revision: 2, updated_by_user_id: "usr_admin", updated_by_user_name: "管理员", updated_by_agent_id: null, updated_at: "2026-08-06T00:00:00Z" };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
