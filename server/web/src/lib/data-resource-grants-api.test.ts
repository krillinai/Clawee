import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDataResourceGrant,
  listDataResourceGrantMemberCandidates,
  listDataResourceGrantMembers,
  listDataResourceGrantRoleMembers,
  listDataResourceGrantRoleCandidates,
  searchDataResourceGrantRoles,
  listDataResourceTypes,
  removeDataResourceGrant,
  replaceDataResourceGrant,
  searchDataResourceGrantActions,
  searchDataResourceGrantResources,
  searchDataResourceGrantUsers
} from "./data-resource-grants-api";

afterEach(() => vi.unstubAllGlobals());

describe("data resource grants API", () => {
  it("使用专用角色搜索接口，保留动作、授权状态与分页", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: [{ role_id: "role_1", name: "审核组", actions: ["read"], granted: true }], meta: { page: 1, page_size: 20, total: 21 } }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { resourceType: "skill_space", resourceId: "space/1", query: "审核" };
    await expect(listDataResourceGrantRoleMembers(input)).resolves.toMatchObject({ items: [{ roleId: "role_1", name: "审核组", actions: ["read"], granted: true }], meta: { next_cursor: "2", has_next: true } });
    await listDataResourceGrantRoleCandidates({ ...input, cursor: "2" });
    await searchDataResourceGrantRoles({ ...input, action: "read" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/admin/data-resource-grants/role-members/search", "/api/v1/admin/data-resource-grants/role-candidates/search", "/api/v1/admin/data-resource-grants/roles/search"
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ resource_type: "skill_space", resource_id: "space/1", query: "审核", page: 2, page_size: 20 }));
  });

  it("角色 mutation 不发送账户主体，并拒绝双主体", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { roleId: "role_1", resourceType: "skill_space", resourceId: "space/1", actions: ["read", "write"] };
    await createDataResourceGrant(input);
    await replaceDataResourceGrant(input);
    await removeDataResourceGrant(input);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "PUT", "POST"]);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ role_id: "role_1", resource_type: "skill_space", resource_id: "space/1", actions: ["read", "write"] }));
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string)).not.toHaveProperty("user_id");
    expect(() => createDataResourceGrant({ ...input, userId: "user_1" } as unknown as Parameters<typeof createDataResourceGrant>[0])).toThrow("必须且只能选择一个");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("uses fixed URLs and sends filters in JSON bodies", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: [], meta: { page: 1, page_size: 20, total: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: [], meta: { page: 1, page_size: 20, total: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ data: [], meta: { page: 1, page_size: 20, total: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ data: [], meta: { page: 1, page_size: 20, total: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    await listDataResourceTypes();
    await searchDataResourceGrantResources({ resourceType: "shared_space", query: "市场" });
    await searchDataResourceGrantActions({ resourceType: "shared_space", resourceId: "space/1" });
    await searchDataResourceGrantUsers({ resourceType: "shared_space", resourceId: "space/1", action: "read", query: "张三" });
    await listDataResourceGrantMembers({ resourceType: "shared_space", resourceId: "space/1", query: "张三" });
    await listDataResourceGrantMemberCandidates({ resourceType: "shared_space", resourceId: "space/1", query: "李四" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/admin/data-resource-grants/resource-types",
      "/api/v1/admin/data-resource-grants/resources/search",
      "/api/v1/admin/data-resource-grants/actions/search",
      "/api/v1/admin/data-resource-grants/users/search",
      "/api/v1/admin/data-resource-grants/members/search",
      "/api/v1/admin/data-resource-grants/member-candidates/search"
    ]);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("?"))).toBe(true);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ resource_type: "shared_space", query: "市场", page: 1, page_size: 20 }));
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBe(JSON.stringify({
      resource_type: "shared_space", resource_id: "space/1", action: "read", query: "张三", page: 1, page_size: 20
    }));
    expect(fetchMock.mock.calls[4]?.[1]?.body).toBe(JSON.stringify({
      resource_type: "shared_space", resource_id: "space/1", query: "张三", page: 1, page_size: 20
    }));
  });

  it("creates, replaces, and removes account grants through the management endpoints", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const input = { userId: "usr_1", resourceType: "data_view", resourceId: "agent_activity", actions: ["read"] };

    await createDataResourceGrant(input);
    await replaceDataResourceGrant(input);
    await removeDataResourceGrant(input);

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ["/api/v1/admin/data-resource-grants", "POST"],
      ["/api/v1/admin/data-resource-grants", "PUT"],
      ["/api/v1/admin/data-resource-grants/remove", "POST"]
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({
      user_id: "usr_1", resource_type: "data_view", resource_id: "agent_activity", actions: ["read"]
    }));
  });
});

function jsonResponse(body: unknown, status = 200) {
  return { ok: true, status, json: async () => body } as Response;
}
