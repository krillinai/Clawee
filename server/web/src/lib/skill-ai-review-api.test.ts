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

  it("重试仅发送当前轮次和尝试标识", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await skillAIReviewApi.retry("round/old", "attempt");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/app/approvals/skill/round%2Fold/ai-review/retry", expect.objectContaining({ method: "POST", body: JSON.stringify({ attempt_id: "attempt" }), credentials: "include" }));
  });

  it.each([403, 409, 500])("重试保留 %s 错误规范", async status => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ error: { code: "ai_review_conflict", message: "失败" } }, { status })));
    await expect(skillAIReviewApi.retry("round", "attempt")).rejects.toMatchObject({ status });
  });

  it.each(["pending", "running", "failed", "completed", "manual"] as const)("%s 只控制人工评分阶段", status => {
    expect(skillAIAllowsScoring({ ...mapSkillAIReview(raw), status })).toBe(false);
    expect(skillAIAllowsScoring()).toBe(true);
  });
  it("只有含规则信息且无阻断问题的通过报告允许评分", () => {
    const review = { ...mapSkillAIReview(raw), reviewSkillVersion: "1.0.0", reviewSkillSHA256: "a".repeat(64), report: { conclusion: "recommend_approve" as const, summary: "静态检查通过", findings: [] } };
    expect(skillAIAllowsScoring(review)).toBe(true);
    expect(skillAIAllowsScoring({ ...review, reviewSkillVersion: "" })).toBe(false);
    expect(skillAIAllowsScoring({ ...review, report: { ...review.report, findings: [{ severity: "error", message: "阻断" }] } })).toBe(false);
  });
});
