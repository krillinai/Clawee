import { afterEach, describe, expect, it, vi } from "vitest";

import { createRole, listAccountRoles, listRoles, updateRole } from "./rbac-api";

const mockFetch = vi.fn();

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("rbac-api", () => {
  it("创建角色时可省略编码，由服务端生成", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(response({ data: {
      role_id: "role_1", code: "role_generated", name: "审计员", is_system: false,
      permission_codes: [], created_at: "now", updated_at: "now"
    } }));
    expect(await createRole({ name: "审计员", permissionCodes: [] })).toMatchObject({ code: "role_generated" });
    expect(mockFetch).toHaveBeenCalledWith("/api/v1/admin/rbac/roles", expect.objectContaining({
      method: "POST", body: JSON.stringify({ name: "审计员", permission_codes: [] })
    }));
  });
  it("保留部门受管标识和账号角色的双来源", async () => {
    vi.stubGlobal("fetch",mockFetch);
    mockFetch.mockResolvedValueOnce(response({data:[{role_id:"role",code:"rose_dept_id",name:"研发默认角色",is_system:false,department_id:"dept",department_role_type:"default",permission_codes:[],created_at:"now",updated_at:"now"}]}));
    expect((await listRoles())[0]).toMatchObject({departmentId:"dept",departmentRoleType:"default"});
    mockFetch.mockResolvedValueOnce(response({data:[{user_id:"user",role_id:"role",role_code:"rose_dept_id",role_name:"研发默认角色",is_system:false,created_at:"now",sources:["manual","rose_department"],department_id:"dept",department_name:"研发"}]}));
    expect((await listAccountRoles("user"))[0]).toMatchObject({sources:["manual","rose_department"],departmentId:"dept",departmentName:"研发"});
  });
  it("映射管理员角色及只读自动来源", async () => {
    vi.stubGlobal("fetch",mockFetch);
    mockFetch.mockResolvedValueOnce(response({data:[{role_id:"manager",code:"rose_dept_mgr_id",name:"研发管理员角色",is_system:false,department_id:"dept",department_role_type:"manager",permission_codes:[],created_at:"now",updated_at:"now"}]}));
    expect((await listRoles())[0]).toMatchObject({departmentId:"dept",departmentRoleType:"manager"});
    mockFetch.mockResolvedValueOnce(response({data:[{user_id:"user",role_id:"manager",role_code:"rose_dept_mgr_id",role_name:"研发管理员角色",is_system:false,created_at:"now",sources:["rose_department"],department_id:"dept",department_name:"研发",department_role_type:"manager"}]}));
    expect((await listAccountRoles("user"))[0]).toMatchObject({sources:["rose_department"],departmentRoleType:"manager",departmentId:"dept",departmentName:"研发"});
  });
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
      method: "PUT",
      body: JSON.stringify({ role_id: "role_1", name: "安全审计员", permission_codes: [] })
    }));
	expect(mockFetch).toHaveBeenNthCalledWith(4, "/api/v1/admin/rbac/account-roles?user_id=usr%2F1", expect.objectContaining({ method: "GET" }));
  });
});
