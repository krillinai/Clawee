import { afterEach, describe, expect, it, vi } from "vitest";

import { authMethods, currentAccount, login, unbindDingTalk } from "./auth-api";

const mockFetch = vi.fn();

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
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
