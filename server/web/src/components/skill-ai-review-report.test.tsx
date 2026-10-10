import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SkillAIReviewReport } from "./skill-ai-review-report";
import type { SkillAIReview } from "@/lib/skill-ai-review-api";

const review: SkillAIReview = { status: "completed", attemptId: "attempt", agentId: "agent", updatedAt: "2026-10-09T09:00:00Z", report: { conclusion: "needs_attention", summary: "<script>alert('summary')</script>", findings: [{ severity: "warning", message: "<img src=x onerror=alert(1)>", path: "javascript:alert(1)" }], suggestedScores: { scenario_value: 1, result_effectiveness: 2, ease_of_use: 3, reuse_value: 4 } } };

describe("AI 报告安全展示", () => {
  it("状态、静态局限、证据与四维建议分仅文本渲染，不创建链接或脚本", () => {
    const { container } = render(<SkillAIReviewReport review={review} />);
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("AI 结论：需要关注")).toBeInTheDocument();
    expect(screen.getByText(/仅为静态文本审核/)).toBeInTheDocument();
    expect(screen.getByText(review.report!.summary)).toBeInTheDocument();
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
    expect(container.querySelectorAll("a, img, script, iframe")).toHaveLength(0);
    const suggestions = screen.getByRole("group", { name: "AI 建议分" });
    expect(within(suggestions).getByText("场景价值：1 / 5")).toBeInTheDocument();
    expect(within(suggestions).getByText("结果有效性：2 / 5")).toBeInTheDocument();
    expect(within(suggestions).getByText("易用性：3 / 5")).toBeInTheDocument();
    expect(within(suggestions).getByText("复用价值：4 / 5")).toBeInTheDocument();
  });

  it("本轮失败与历史失败报告、转人工审计各自保留", () => {
    render(<SkillAIReviewReport review={{ ...review, status: "manual", report: undefined, manualBy: "reviewer", manualAt: review.updatedAt, manualComment: "执行端离线", attempts: [{ ...review, attemptId: "old", status: "failed", error: "脱敏失败原因", report: { ...review.report!, summary: "旧尝试报告" } }] }} />);
    expect(screen.getByText("已转人工")).toBeInTheDocument();
    expect(screen.getByText("转人工原因：执行端离线")).toBeInTheDocument();
    expect(screen.getByText(/转人工操作人：reviewer/)).toBeInTheDocument();
    expect(screen.getByText("历史 AI 尝试（1）")).toBeInTheDocument();
    expect(screen.getByText("旧尝试报告")).toBeInTheDocument();
    expect(screen.getByText("失败原因：脱敏失败原因")).toBeInTheDocument();
    expect(screen.getByText("暂无 AI 报告。")).toBeInTheDocument();
  });
});
