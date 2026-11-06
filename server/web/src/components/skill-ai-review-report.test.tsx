import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SkillAIReviewAdvice, SkillAIReviewReport } from "./skill-ai-review-report";
import type { SkillAIReview } from "@/lib/skill-ai-review-api";

const review: SkillAIReview = { status: "completed", attemptId: "attempt", agentId: "agent", updatedAt: "2026-10-09T09:00:00Z", report: { conclusion: "needs_attention", summary: "<script>alert('summary')</script>", findings: [{ severity: "warning", message: "<img src=x onerror=alert(1)>", path: "javascript:alert(1)" }], suggestedScores: { scenario_value: 1, result_effectiveness: 2, ease_of_use: 3, reuse_value: 4 } } };

describe("AI 报告安全展示", () => {
  it("评分建议只展示当前报告，无报告时不借用历史尝试", () => {
    const { rerender } = render(<SkillAIReviewAdvice />);
    expect(screen.queryByRole("region", { name: "AI 审核建议" })).not.toBeInTheDocument();
    rerender(<SkillAIReviewAdvice review={{ ...review, report: undefined, attempts: [review] }} />);
    expect(screen.queryByRole("region", { name: "AI 审核建议" })).not.toBeInTheDocument();
    rerender(<SkillAIReviewAdvice review={{ ...review, report: { ...review.report!, findings: [], suggestedScores: undefined } }} />);
    const advice = screen.getByRole("region", { name: "AI 审核建议" });
    expect(within(advice).getByText("需要关注")).toBeInTheDocument();
    expect(within(advice).getByText(review.report!.summary)).toBeInTheDocument();
    expect(within(advice).queryByRole("button")).not.toBeInTheDocument();
  });

  it("评分建议的关注项默认收起，展开后仍按纯文本显示证据", () => {
    const { container } = render(<SkillAIReviewAdvice review={review} />);
    const trigger = screen.getByRole("button", { name: "查看审核关注项（1）" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(review.report!.findings[0].message)).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(review.report!.findings[0].message)).toBeInTheDocument();
    expect(screen.getByText("证据路径：javascript:alert(1)")).toBeInTheDocument();
    expect(container.querySelectorAll("a, img, script, iframe")).toHaveLength(0);
  });

  it("当前尝试不重复计入历史，只有当前尝试时不显示历史入口", () => {
    const old = { ...review, attemptId: "old", report: { ...review.report!, summary: "旧尝试摘要" } };
    const { rerender } = render(<SkillAIReviewReport review={{ ...review, attempts: [old, review] }} />);
    fireEvent.click(screen.getByRole("button", { name: "历史 AI 尝试（1）" }));
    const history = screen.getByRole("region", { name: "AI 尝试 1" });
    expect(within(history).getByText("旧尝试摘要")).toBeInTheDocument();
    expect(within(history).queryByText(review.report!.summary)).not.toBeInTheDocument();
    rerender(<SkillAIReviewReport review={{ ...review, attempts: [review] }} />);
    expect(screen.queryByRole("button", { name: /历史 AI 尝试/ })).not.toBeInTheDocument();
  });

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
    const execution = screen.getByRole("button", { name: "执行详情" });
    expect(execution).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("agent")).not.toBeInTheDocument();
    fireEvent.click(execution);
    expect(execution).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("agent")).toBeInTheDocument();
  });

  it("本轮失败与历史失败报告、转人工审计各自保留", () => {
    render(<SkillAIReviewReport review={{ ...review, status: "manual", report: undefined, manualBy: "reviewer", manualAt: review.updatedAt, manualComment: "执行端离线", attempts: [{ ...review, attemptId: "old", status: "failed", error: "脱敏失败原因", report: { ...review.report!, summary: "旧尝试报告" } }] }} />);
    expect(screen.getByText("已转人工")).toBeInTheDocument();
    expect(screen.getByText("转人工原因：执行端离线")).toBeInTheDocument();
    expect(screen.getByText(/转人工操作人：reviewer/)).toBeInTheDocument();
    const history = screen.getByRole("button", { name: "历史 AI 尝试（1）" });
    expect(history).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("旧尝试报告")).not.toBeInTheDocument();
    fireEvent.click(history);
    expect(history).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("旧尝试报告")).toBeInTheDocument();
    expect(screen.getByText("失败原因：脱敏失败原因")).toBeInTheDocument();
    expect(screen.getByText("暂无 AI 报告。")).toBeInTheDocument();
  });
});
