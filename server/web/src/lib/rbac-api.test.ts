import { afterEach, describe, expect, it, vi } from "vitest";

import { createRole, listAccountRoles, listRoles, updateRole } from "./rbac-api";

const mockFetch = vi.fn();

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("rbac-api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it("uses canonical RBAC routes and snake_case payloads", async () => {
    vi.stubGlobal("fetch", mockFetch);
    const role = {
      role_id: "role_1", code: "auditor", name: "审计员", is_system: false,
      permission_codes: ["console:mcp:audit:read"], created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:00Z"
    };
    mockFetch
      .mockResolvedValueOnce(response({ data: [role] }))
      .mockResolvedValueOnce(response({ data: role }))
      .mockResolvedValueOnce(response({ data: role }))
		.mockResolvedValueOnce(response({ data: [{ user_id: "usr/1", role_id: "role_1", role_code: "auditor", role_name: "审计员", is_system: false, created_at: "2026-07-29T00:00:00Z" }] }));

    expect(await listRoles()).toHaveLength(1);
    await createRole({ code: "auditor", name: "审计员", permissionCodes: ["console:mcp:audit:read"] });
    await updateRole({ roleId: "role_1", name: "安全审计员", permissionCodes: [] });
    expect(await listAccountRoles("usr/1")).toHaveLength(1);

    expect(mockFetch).toHaveBeenNthCalledWith(1, "/api/v1/admin/rbac/roles", expect.objectContaining({ method: "GET" }));
    expect(mockFetch).toHaveBeenNthCalledWith(2, "/api/v1/admin/rbac/roles", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ code: "auditor", name: "审计员", permission_codes: ["console:mcp:audit:read"] })
    }));
    expect(mockFetch).toHaveBeenNthCalledWith(3, "/api/v1/admin/rbac/roles", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ role_id: "role_1", name: "安全审计员", permission_codes: [] })
    }));
	expect(mockFetch).toHaveBeenNthCalledWith(4, "/api/v1/admin/rbac/account-roles?user_id=usr%2F1", expect.objectContaining({ method: "GET" }));
  });
});
