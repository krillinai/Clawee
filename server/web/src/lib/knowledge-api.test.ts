import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createKnowledgeAccountGrant,
  deleteKnowledgeBase,
  listKnowledgeAccountGrants,
  listKnowledgeBases,
  listKnowledgeMemberCandidates,
  listKnowledgeMembers,
  removeKnowledgeAccountGrant,
  replaceKnowledgeAccountGrant,
  updateKnowledgeBase,
  uploadKnowledgeDocument
} from "./knowledge-api";

describe("knowledge api", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps knowledge base response fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{
      knowledge_base_id: "kb-1",
      name: "公司制度",
      description: "制度文档",
      provider_type: "bailian",
      status: "active",
      error_message: "",
      document_count: 2,
      created_by: "admin",
      created_at: "2026-07-26T00:00:00Z",
      updated_at: "2026-07-26T00:00:00Z"
    }] }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(listKnowledgeBases()).resolves.toMatchObject([{ knowledgeBaseId: "kb-1", documentCount: 2 }]);
    expect(fetch).toHaveBeenCalledWith("/api/v1/admin/knowledge-bases", expect.objectContaining({ method: "GET" }));
  });

  it("uploads a single multipart file without a JSON content type", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      document_id: "doc-1",
      knowledge_base_id: "kb-1",
      name: "guide.md",
      size_bytes: 5,
      mime_type: "text/markdown",
      status: "processing",
      error_message: "",
      uploaded_by: "admin",
      created_at: "2026-07-26T00:00:00Z",
      updated_at: "2026-07-26T00:00:00Z"
    }), { status: 201, headers: { "Content-Type": "application/json" } })));

    await uploadKnowledgeDocument("kb-1", new File(["hello"], "guide.md", { type: "text/markdown" }));
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).toEqual({ Accept: "application/json" });
  });

  it("updates knowledge base name and description", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      knowledge_base_id: "kb-1",
      name: "新制度库",
      description: "新说明",
      provider_type: "bailian",
      status: "active",
      error_message: "",
      document_count: 2,
      created_by: "admin",
      created_at: "2026-07-26T00:00:00Z",
      updated_at: "2026-08-05T00:00:00Z"
    })));

    await expect(updateKnowledgeBase({
      knowledgeBaseId: "kb-1",
      name: "新制度库",
      description: "新说明"
    })).resolves.toMatchObject({ knowledgeBaseId: "kb-1", name: "新制度库", description: "新说明" });
    expect(fetch).toHaveBeenCalledWith("/api/v1/admin/knowledge-bases", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ knowledge_base_id: "kb-1", name: "新制度库", description: "新说明" })
    }));
  });

  it("lists and mutates account grants with the knowledge base resource contract", async () => {
    const grant = {
      grant_id: "dgr_1",
      user_id: "usr_1",
      resource_type: "knowledge_base",
      resource_id: "kb-1",
      action: "read",
      created_by: "管理员",
      created_at: "2026-08-04T00:00:00Z",
      updated_at: "2026-08-04T00:00:00Z"
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [grant] }))
      .mockResolvedValueOnce(jsonResponse({ data: [grant] }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: [grant, { ...grant, grant_id: "dgr_2", action: "upload" }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })));

    await expect(listKnowledgeAccountGrants("kb-1")).resolves.toMatchObject([{ grantId: "dgr_1", userId: "usr_1", action: "read" }]);
    await createKnowledgeAccountGrant({ userId: "usr_1", knowledgeBaseId: "kb-1", actions: ["read"] });
    await replaceKnowledgeAccountGrant({ userId: "usr_1", knowledgeBaseId: "kb-1", actions: ["read", "upload"] });
    await removeKnowledgeAccountGrant("usr_1", "kb-1");

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/v1/admin/knowledge-bases/account-grants?knowledge_base_id=kb-1", expect.objectContaining({ method: "GET" }));
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/v1/admin/knowledge-bases/account-grants", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ user_id: "usr_1", knowledge_base_id: "kb-1", actions: ["read"] })
    }));
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/v1/admin/knowledge-bases/account-grants", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ user_id: "usr_1", knowledge_base_id: "kb-1", actions: ["read", "upload"] })
    }));
    expect(fetch).toHaveBeenNthCalledWith(4, "/api/v1/admin/knowledge-bases/account-grants/remove", expect.objectContaining({ method: "POST" }));
  });

  it("maps member and candidate responses with complete email addresses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{
        user_id: "usr_1", name: "知识用户", email: "knowledge.user@example.com",
        account_status: "active", actions: ["read", "mcp"], updated_at: "2026-08-04T00:00:00Z"
      }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{
        user_id: "usr_2", name: "候选用户", email: "full.member@example.com"
      }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listKnowledgeMembers("kb/1", "知识 用户")).resolves.toMatchObject({
      items: [{ userId: "usr_1", email: "knowledge.user@example.com", actions: ["read", "mcp"] }]
    });
    await expect(listKnowledgeMemberCandidates("kb/1", "full.member@example.com")).resolves.toMatchObject({
      items: [{ userId: "usr_2", email: "full.member@example.com" }]
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/admin/knowledge-bases/members?knowledge_base_id=kb%2F1&query=%E7%9F%A5%E8%AF%86+%E7%94%A8%E6%88%B7", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/admin/knowledge-bases/member-candidates?knowledge_base_id=kb%2F1&query=full.member%40example.com", expect.objectContaining({ method: "GET" }));
  });

  it("preserves structured conflict reasons from delete errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: "conflict",
        message: "当前状态不允许执行该操作",
        details: [{ reason: "该知识库仍有账户授权，请先撤销。" }]
      }
    }, 409)));

    await expect(deleteKnowledgeBase("kb-1")).rejects.toMatchObject({
      name: "APIError",
      status: 409,
      code: "conflict",
      message: "当前状态不允许执行该操作",
      details: [{ reason: "该知识库仍有账户授权，请先撤销。" }]
    });
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
