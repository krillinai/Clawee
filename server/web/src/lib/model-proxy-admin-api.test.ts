import { afterEach, describe, expect, it, vi } from "vitest";

import { getModelProxyAudit, listModelProxyAudits, summarizeModelProxyAudits } from "./model-proxy-admin-api";

const mockFetch = vi.fn();

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("model-proxy-admin-api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it("lists model audits with keyset filters and maps records", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            audit_id: "model_audit_1",
            request_id: "req_1",
            user_id: "user_1",
            user_name_snapshot: "张三",
            api_key_id: "token_1",
            api_key_fingerprint: "sha256:abcd",
            endpoint: "/v1/chat/completions",
            method: "POST",
            model: "clawee-vision",
            status: "succeeded",
            gateway_status: 200,
            upstream_status: 200,
            error_code: "",
            error_message: "",
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
            usage_available: true,
            request_headers: { "content-type": "application/json" },
            request_body: { model: "clawee-vision" },
            response_headers: { "content-type": "application/json" },
            response_body: { id: "response_1" },
            request_bytes: 40,
            response_bytes: 50,
            response_chunks: 1,
            truncated: false,
            duration_ms: 120,
            created_at: "2026-10-31T00:00:00Z",
            completed_at: "2026-10-31T00:00:01Z"
          }
        ],
        next_created_at: "2026-10-30T23:00:00Z",
        next_id: "model_audit_0"
      })
    );

    const result = await listModelProxyAudits({
      limit: 20,
      userId: "user_1",
      model: "clawee-vision",
      status: "succeeded",
      cursorCreatedAt: "2026-10-30T23:00:00Z",
      cursorId: "model_audit_0"
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/admin/model-proxy/audits?limit=20&user_id=user_1&model=clawee-vision&status=succeeded&cursor_created_at=2026-10-30T23%3A00%3A00Z&cursor_id=model_audit_0",
      expect.objectContaining({ method: "GET" })
    );
    expect(result.nextId).toBe("model_audit_0");
    expect(result.items[0]).toMatchObject({
      auditId: "model_audit_1",
      userNameSnapshot: "张三",
      inputTokens: 10,
      completedAt: "2026-10-31T00:00:01Z"
    });
  });

  it("loads details and summaries", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ audit_id: "model_audit_1", request_id: "req_1", user_id: "user_1", user_name_snapshot: "张三", api_key_id: "token_1", api_key_fingerprint: "sha256:abcd", endpoint: "/v1/models", method: "GET", model: "clawee", status: "succeeded", gateway_status: 200, upstream_status: 0, error_code: "", error_message: "", input_tokens: 0, output_tokens: 0, total_tokens: 0, usage_available: false, request_headers: {}, request_body: null, response_headers: {}, response_body: {}, request_bytes: 0, response_bytes: 20, response_chunks: 1, truncated: false, duration_ms: 2, created_at: "2026-10-31T00:00:00Z" }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ user_id: "user_1", user_name_snapshot: "张三", model: "clawee", request_count: 2, succeeded_count: 2, input_tokens: 10, output_tokens: 20, total_tokens: 30, usage_count: 2, success_rate: 1 }] }));

    const detail = await getModelProxyAudit("model_audit_1");
    const summary = await summarizeModelProxyAudits({ userId: "user_1", model: "clawee" });

    expect(detail.auditId).toBe("model_audit_1");
    expect(summary).toEqual([
      {
        userId: "user_1",
        userNameSnapshot: "张三",
        model: "clawee",
        requestCount: 2,
        succeededCount: 2,
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        usageCount: 2,
        successRate: 1
      }
    ]);
  });
});
