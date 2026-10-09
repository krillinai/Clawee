import { afterEach, describe, expect, it, vi } from "vitest";

import { approvalsApp } from "./approvals-api";

afterEach(() => vi.unstubAllGlobals());

describe("个人审批 API", () => {
  it("按服务端游标分页，编码全部过滤条件并保留整单和个人状态", async () => {
    const item = { kind: "skill", id: "round", business_status: "pending", my_status: "approved" };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [item], meta: { next_cursor: "same/time+id", has_next: true } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(approvalsApp.list({ view: "done", type: "skill", status: "pending", cursor: "same/time+id" })).resolves.toMatchObject({ items: [item], meta: { next_cursor: "same/time+id", has_next: true } });
    const url = new URL(fetchMock.mock.calls[0][0] as string, "http://localhost");
    expect(url.pathname).toBe("/api/v1/app/approvals");
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: "done", type: "skill", status: "pending", limit: "20", cursor: "same/time+id" });
  });

  it("详情复用原映射，保留原轮评分、NULL 汇总和实际处理人", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ data: {
      item: { kind: "skill", id: "round-old", version_id: "version-old" },
      skill: { skill: { skill_id: "skill", name: "旧版", current_version_id: "version-new" }, versions: [{ version_id: "version-old", skill_id: "skill", version: "1", source: null, local_approval: { request_id: "round-old", status: "invalidated", total: 2, approved: 1, approvers: [{ user_id: "me", status: "approved", name: "本人", comment: "旧意见", decided_at: null, scores: null }], score_summary: null } }] }
    } })));
    await expect(approvalsApp.detail("skill", "round-old")).resolves.toMatchObject({ skill: { versions: [{ versionId: "version-old", localApproval: { requestId: "round-old", status: "invalidated", approvers: [{ userId: "me", comment: "旧意见" }] } }] } });
  });

  it("文件、预览和下载均绑定 request，不走 admin 或发布版本地址", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await approvalsApp.files("request/old");
    await approvalsApp.file("request/old", "docs/旧版.md");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/app/approvals/skill/request%2Fold/files",
      "/api/v1/app/approvals/skill/request%2Fold/file?path=docs%2F%E6%97%A7%E7%89%88.md"
    ]);
    expect(approvalsApp.packageURL("request/old")).toBe("/api/v1/app/approvals/skill/request%2Fold/package");
  });

  it("两类业务保留各自决定契约，不发送客户端身份", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await approvalsApp.skillDecision("round/old", { decision: "approved", scores: { scenario_value: 3 }, comment: "意见" });
    await approvalsApp.workflowDecision("task/old", { decision: "reject", comment: "驳回", idempotency_key: "fixed" });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(init?.body as string)])).toEqual([
      ["/api/v1/app/approvals/skill/round%2Fold/decision", "POST", { decision: "approved", scores: { scenario_value: 3 }, comment: "意见" }],
      ["/api/v1/app/workflow-tasks/task%2Fold/decision", "POST", { decision: "reject", comment: "驳回", idempotency_key: "fixed" }]
    ]);
  });

  it.each([403, 404, 409, 500])("提交 %s 不自动重试，允许原输入同键显式重试", async status => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { code: "decision_failed", message: "失败" } }, { status })).mockResolvedValueOnce(Response.json({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { decision: "approve" as const, comment: "原输入", idempotency_key: "same-key" };
    await expect(approvalsApp.workflowDecision("task", input)).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await approvalsApp.workflowDecision("task", input);
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
  });
});
