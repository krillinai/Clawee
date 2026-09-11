import { afterEach, describe, expect, it, vi } from "vitest";

import { authMethods, currentAccount, hasAdminPermission, login, unbindDingTalk, type Account } from "./auth-api";

const mockFetch = vi.fn();

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function account(adminPermissions: string[]): Account {
  return {
    userId: "usr_test",
    email: "test@example.com",
    name: "测试账号",
    status: "active",
    adminPermissions
  };
}

describe("auth-api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it("does not grant admin access when current permissions are absent", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(response({
      data: {
        account: { user_id: "usr_user", email: "user@example.com", status: "active" },
        applications: { frontend: true, admin: false },
        redirect_to: "/app"
      }
    }));

    const result = await login({ email: "user@example.com", password: "passw0rd!" });

    expect(result.redirectTo).toBe("/app");
    expect(mockFetch).toHaveBeenCalledWith("/api/v1/auth/login", expect.any(Object));
  });

  it("defaults to the admin entry when the account has admin permissions", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(response({
      data: {
        account: { user_id: "usr_auditor", email: "auditor@example.com", status: "active" },
        applications: { frontend: true, admin: true },
        admin_permissions: ["console:mcp:audit:read"]
      }
    }));

    const result = await login({ email: "auditor@example.com", password: "passw0rd!" });

    expect(result.redirectTo).toBe("/admin");
    expect(result.user.adminPermissions).toEqual(["console:mcp:audit:read"]);
  });

  it("maps dingtalk methods and current binding state", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch
      .mockResolvedValueOnce(response({ data: { password: true, dingtalk: { enabled: true } } }))
      .mockResolvedValueOnce(response({
        data: {
          account: { user_id: "usr_user", email: "user@example.com", status: "active" },
          dingtalk_enabled: true,
          dingtalk_bound: true,
          local_password_configured: true
        }
      }));

    expect(await authMethods()).toEqual({ password: true, dingtalk: { enabled: true } });
    expect((await currentAccount()).user).toMatchObject({
      dingtalkEnabled: true,
      dingtalkBound: true,
      localPasswordConfigured: true
    });
  });

  it("posts the current password when unbinding dingtalk", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await unbindDingTalk("passw0rd!");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/auth/dingtalk/unbind",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ password: "passw0rd!" }) })
    );
  });
});

describe("hasAdminPermission", () => {
  it("允许精确匹配的操作权限，但不授予同模块的其他操作", () => {
    const current = account(["console:agent:token_rotate"]);

    expect(hasAdminPermission(current, "console:agent:token_rotate")).toBe(true);
    expect(hasAdminPermission(current, "console:agent:token_reveal")).toBe(false);
    expect(hasAdminPermission(current, "console:agent:read")).toBe(false);
  });

  it("保留 manage 对同模块全部操作的兼容授权", () => {
    const current = account(["console:mcp:upstream:manage"]);

    expect(hasAdminPermission(current, "console:mcp:upstream:sync")).toBe(true);
    expect(hasAdminPermission(current, "console:mcp:capability:sync")).toBe(false);
  });
});
