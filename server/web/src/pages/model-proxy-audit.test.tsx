import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listModelProxyAudits, summarizeModelProxyAudits, type ModelProxyAudit } from "@/lib/model-proxy-admin-api";

import { ModelProxyAuditPage } from "./model-proxy-audit";

vi.mock("@/lib/model-proxy-admin-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/model-proxy-admin-api")>("@/lib/model-proxy-admin-api");
  return {
    ...actual,
    listModelProxyAudits: vi.fn(),
    summarizeModelProxyAudits: vi.fn()
  };
});

const listModelProxyAuditsMock = vi.mocked(listModelProxyAudits);
const summarizeModelProxyAuditsMock = vi.mocked(summarizeModelProxyAudits);

const audit: ModelProxyAudit = {
  auditId: "model_audit_1",
  requestId: "request_1",
  userId: "user_1",
  userNameSnapshot: "张三",
  apiKeyId: "token_1",
  apiKeyFingerprint: "sha256:fingerprint",
  endpoint: "/v1/chat/completions",
  method: "POST",
  model: "clawee-vision",
  status: "succeeded",
  gatewayStatus: 200,
  upstreamStatus: 200,
  errorCode: "",
  errorMessage: "",
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  usageAvailable: true,
  requestHeaders: {},
  requestBody: { model: "clawee-vision" },
  responseHeaders: {},
  responseBody: { id: "response_1" },
  requestBytes: 100,
  responseBytes: 200,
  responseChunks: 1,
  truncated: false,
  durationMs: 120,
  createdAt: "2026-10-31T00:00:00Z",
  completedAt: "2026-10-31T00:00:01Z"
};

describe("ModelProxyAuditPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listModelProxyAuditsMock.mockResolvedValue({ items: [audit], nextCreatedAt: null, nextId: "" });
    summarizeModelProxyAuditsMock.mockResolvedValue([
      {
        userId: "user_1",
        userNameSnapshot: "张三",
        model: "clawee-vision",
        requestCount: 1,
        succeededCount: 1,
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        usageCount: 1,
        successRate: 1
      }
    ]);
  });

  it("loads filtered model audits and shows the user summary", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/admin/model-proxy/audits?user_id=user_1&model=clawee-vision&status=succeeded&error_only=true&created_from=2026-10-30T00:00:00.000Z&created_to=2026-10-31T00:00:00.000Z"]}>
          <ModelProxyAuditPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "全部日志" })).toBeInTheDocument();
    expect((await screen.findAllByText("clawee-vision")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(listModelProxyAuditsMock).toHaveBeenCalledWith({
        limit: 100,
        userId: "user_1",
        model: "clawee-vision",
        status: "succeeded",
        errorOnly: true,
        createdFrom: "2026-10-30T00:00:00.000Z",
        createdTo: "2026-10-31T00:00:00.000Z"
      });
      expect(summarizeModelProxyAuditsMock).toHaveBeenCalledWith({
        userId: "user_1",
        model: "clawee-vision",
        status: "succeeded",
        errorOnly: true,
        createdFrom: "2026-10-30T00:00:00.000Z",
        createdTo: "2026-10-31T00:00:00.000Z"
      });
    });
  });
});
