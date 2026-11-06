import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalsAdmin } from "./admin-approvals-api";

afterEach(() => vi.unstubAllGlobals());

describe("审批管理 API", () => {
  it("列表和统计使用管理接口，统计不带分页游标", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [], meta: { has_next: true, next_cursor: "next" } }));
    vi.stubGlobal("fetch", fetchMock);
    const filters = { view: "active", type: "skill", status: "pending", channel: "local", q: "标题 / 内容", space_id: "space/one", from: "2026-10-10T00:00:00Z" };
    await approvalsAdmin.list(filters, "time+id");
    await approvalsAdmin.summary(filters);
    const urls = fetchMock.mock.calls.map(([url]) => new URL(url as string, "http://localhost"));
    expect(urls[0].pathname).toBe("/api/v1/admin/approvals");
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ ...filters, limit: "20", cursor: "time+id" });
    expect(urls[1].pathname).toBe("/api/v1/admin/approvals/summary");
    expect(Object.fromEntries(urls[1].searchParams)).toEqual(filters);
  });

  it("详情绑定历史请求，保留服务端动作能力", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ data: {
      item: { kind: "skill", id: "old" }, actions: { sync: false, resolve: false },
      skill: { skill: { skill_id: "skill", name: "历史", current_version_id: null }, versions: [{ version_id: "version-old", version: "1", source: null, local_approval: { request_id: "old", status: "invalidated", total: 1, approved: 0, approvers: [] } }] }
    } })));
    await expect(approvalsAdmin.detail("skill", "old")).resolves.toMatchObject({ actions: { sync: false }, skill: { versions: [{ versionId: "version-old", localApproval: { requestId: "old", status: "invalidated" } }] } });
  });

  it("附件与下载绑定审批种类和请求，不使用个人或任意版本接口", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await approvalsAdmin.files("skill_external", "request/old");
    await approvalsAdmin.file("skill_external", "request/old", "docs/内容.md");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/admin/approvals/skill_external/request%2Fold/files",
      "/api/v1/admin/approvals/skill_external/request%2Fold/file?path=docs%2F%E5%86%85%E5%AE%B9.md"
    ]);
    expect(approvalsAdmin.packageURL("skill", "round/one")).toBe("/api/v1/admin/approvals/skill/round%2Fone/package");
  });
});
