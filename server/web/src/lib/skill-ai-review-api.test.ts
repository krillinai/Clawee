import { afterEach, describe, expect, it, vi } from "vitest";

import { approvalsApp } from "./approvals-api";
import { mapSkillAIReview, skillAIAllowsScoring, skillAIReviewApi, type RawSkillAIReview } from "./skill-ai-review-api";
import { mapSkillDetail, type AdminSkillDetailResponse } from "./skillhub-api";

afterEach(() => vi.unstubAllGlobals());

const scores = { scenario_value: 3, result_effectiveness: 2, ease_of_use: 4, reuse_value: 5 };
const raw: RawSkillAIReview = { status: "completed", attempt_id: "attempt-old", agent_id: "agent", updated_at: "2026-10-09T09:00:00Z", report: { conclusion: "recommend_reject", summary: "本轮摘要", findings: [{ severity: "warning", message: "问题", path: "docs/guide.md" }], suggested_scores: scores }, attempts: [{ status: "failed", attempt_id: "attempt-failed", agent_id: "agent", updated_at: "2026-10-09T08:00:00Z", error: "审核失败" }] };
const detail = (review?: RawSkillAIReview | null) => ({ skill: { skill_id: "skill", space_id: "space", space_name: "空间", description: "", created_by: "author", created_at: "", updated_at: "", name: "旧版", current_version_id: "latest" }, versions: [{ skill_id: "skill", version_id: "old", version: "1", description: "", changelog: "", package_sha256: "digest", created_at: "", source: null, local_approval: { request_id: "round-old", status: "pending", total: 2, approved: 0, approvers: [], ai_review: review } }] }) satisfies AdminSkillDetailResponse;

describe("Skill AI 审核契约", () => {
  it("管理详情及 T05 详情沿用原轮直接映射，不将 AI 建议写入人工分", async () => {
    const mapped = mapSkillDetail(detail(raw)).versions[0].localApproval!;
    expect(mapped.aiReview).toEqual(mapSkillAIReview(raw));
    expect(mapped.aiReview?.report?.suggestedScores).toEqual(scores);
    expect(mapped.scoreSummary).toBeUndefined();
    expect(mapped.approvers).toEqual([]);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ data: { item: { kind: "skill", id: "round-old" }, skill: detail(raw) } })));
    await expect(approvalsApp.detail("skill", "round-old")).resolves.toMatchObject({ skill: { versions: [{ versionId: "old", localApproval: { requestId: "round-old", aiReview: { attemptId: "attempt-old", attempts: [{ attemptId: "attempt-failed", status: "failed" }] } } }] } });
  });

  it.each([undefined, null])("未启用 %s 不增加 aiReview，兼容旧 mock", review => {
    expect(mapSkillDetail(detail(review)).versions[0].localApproval).not.toHaveProperty("aiReview");
  });

  it("独立 GET/PUT 配置，关闭清空 Agent，fallback 仅发送 attempt 与原因", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: { enabled: false, agent_id: "" } }));
    vi.stubGlobal("fetch", fetchMock);
    await skillAIReviewApi.getConfig("space/1");
    await skillAIReviewApi.saveConfig("space/1", { enabled: true, agent_id: " agent " });
    await skillAIReviewApi.saveConfig("space/1", { enabled: false, agent_id: "stale" });
    await skillAIReviewApi.retry("round/old", "attempt");
    await skillAIReviewApi.manual("round/old", "attempt", " 原因 ");
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body ? JSON.parse(init.body as string) : undefined])).toEqual([
      ["/api/v1/admin/skill-spaces/space%2F1/ai-review", "GET", undefined],
      ["/api/v1/admin/skill-spaces/space%2F1/ai-review", "PUT", { enabled: true, agent_id: "agent" }],
      ["/api/v1/admin/skill-spaces/space%2F1/ai-review", "PUT", { enabled: false, agent_id: "" }],
      ["/api/v1/app/approvals/skill/round%2Fold/ai-review/retry", "POST", { attempt_id: "attempt" }],
      ["/api/v1/app/approvals/skill/round%2Fold/ai-review/manual", "POST", { attempt_id: "attempt", comment: "原因" }]
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === "include")).toBe(true);
  });

  it.each([403, 409, 500])("配置与 fallback 保留 %s 错误规范", async status => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ error: { code: "ai_review_conflict", message: "失败" } }, { status })));
    await expect(skillAIReviewApi.saveConfig("space", { enabled: false, agent_id: "" })).rejects.toMatchObject({ status });
    await expect(skillAIReviewApi.retry("round", "attempt")).rejects.toMatchObject({ status });
  });

  it.each(["pending", "running", "failed", "completed", "manual"] as const)("%s 只控制人工评分阶段", status => {
    expect(skillAIAllowsScoring({ ...mapSkillAIReview(raw), status })).toBe(status === "completed" || status === "manual");
    expect(skillAIAllowsScoring()).toBe(true);
  });
});
