import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDataResourceGrant,
  listDataResourceGrantMemberCandidates,
  listDataResourceGrantMembers,
  listDataResourceTypes,
  removeDataResourceGrant,
  replaceDataResourceGrant,
  searchDataResourceGrantActions,
  searchDataResourceGrantResources,
  searchDataResourceGrantUsers
} from "./data-resource-grants-api";

afterEach(() => vi.unstubAllGlobals());

describe("data resource grants API", () => {
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
      ["/api/v1/admin/data-resource-grants", "PATCH"],
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
