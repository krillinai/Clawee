import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAccount,
  listAccounts,
  mergeAccounts,
  resetAccountPassword,
  updateAccountName,
  updateAccountStatus
} from "./accounts-api";

const mockFetch = vi.fn();

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init
  });
}

describe("accounts-api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it("lists accounts and maps user_id plus bound agent fields", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            user_id: "usr_1",
            email: "user@example.com",
            name: "User",
            status: "active",
            agent: {
              agentId: "user_usr_1_agent",
              clientId: "user_usr_1",
              name: "User Agent",
              status: "active",
              actorId: "usr_1",
              updatedAt: "2026-06-12T00:00:00Z"
            }
          },
          {
            userId: "usr_2",
            email: "disabled@example.com",
            status: "disabled",
            agent: null
          }
        ]
      })
    );

    const result = await listAccounts();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/accounts",
      expect.objectContaining({ method: "GET", credentials: "include" })
    );
    expect(result).toEqual([
      {
        userId: "usr_1",
        email: "user@example.com",
        name: "User",
        status: "active",
        agent: {
          agentId: "user_usr_1_agent",
          clientId: "user_usr_1",
          name: "User Agent",
          status: "active",
          actorId: "usr_1",
          updatedAt: "2026-06-12T00:00:00Z"
        }
      },
      {
        userId: "usr_2",
        email: "disabled@example.com",
        name: "",
        status: "disabled",
        agent: null
      }
    ]);
  });

  it("creates accounts without the removed legacy role", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        user_id: "usr_new",
        email: "new@example.com",
        name: "New User",
        status: "active",
        agent: null
      })
    );

    await createAccount({
      email: "new@example.com",
      name: "New User",
      password: "passw0rd!",
      status: "active"
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/accounts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "new@example.com",
          name: "New User",
          password: "passw0rd!",
          status: "active"
        })
      })
    );
  });

  it("updates status using encoded user ids", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          user_id: "usr/one",
          email: "user@example.com",
          status: "disabled",
          agent: null
        })
      );

    await updateAccountStatus("usr/one", "disabled");

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/admin/accounts",
      expect.objectContaining({
        method: "PATCH",
		body: JSON.stringify({ user_id: "usr/one", status: "disabled" })
      })
    );
  });

  it("updates account names", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        user_id: "usr/one",
        email: "user@example.com",
        name: "新昵称",
        status: "active",
        agent: null
      })
    );

    await updateAccountName("usr/one", "新昵称");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/accounts",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ user_id: "usr/one", name: "新昵称" })
      })
    );
  });

  it("resets account passwords using encoded user ids", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        user_id: "usr/one",
        email: "user@example.com",
        status: "active",
        agent: null
      })
    );

    await resetAccountPassword("usr/one", "newpassw0rd!");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/accounts/password/reset",
      expect.objectContaining({
        method: "POST",
		body: JSON.stringify({ user_id: "usr/one", password: "newpassw0rd!" })
      })
    );
  });

  it("merges accounts without requesting token rotation or grant revocation", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({
      action: "account_merge",
      agent_ids: ["agent-1"],
      source_user_id: "usr-old",
      target_user_id: "usr-new",
      tokens_preserved: true,
      grants_preserved: true,
      token_count: 1,
      grant_count: 2,
      completed_at: "2026-08-18T03:00:00Z"
    }));

    const result = await mergeAccounts({ sourceUserId: "usr-old", targetUserId: "usr-new", reason: "重复账号" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/accounts/merge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ source_user_id: "usr-old", target_user_id: "usr-new", reason: "重复账号" })
      })
    );
    expect(result.tokensPreserved).toBe(true);
    expect(result.grantsPreserved).toBe(true);
  });
});
