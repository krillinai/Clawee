import { expect, test } from "@playwright/test";
import type { RawSkillAIReview } from "../src/lib/skill-ai-review-api";
import type { AdminSkillDetailResponse } from "../src/lib/skillhub-api";

test.use({ headless: true });

const updatedAt = "2026-10-20T12:56:10Z";
const aiReview: RawSkillAIReview = {
  status: "completed", attempt_id: "attempt-current", agent_id: "clawee_agent_" + "a".repeat(64),
  updated_at: updatedAt, review_skill_version: "1.0.0", review_skill_sha256: "a".repeat(64),
  report: {
    conclusion: "recommend_approve",
    summary: "总体风险较低。本次仅对提供的 SKILL.md 进行静态审核，输入条件、处理步骤、输出结构和禁止事项的要求基本一致、清晰。本次未执行 Skill 或其命令，不能据此确认实际运行效果。",
    findings: [], suggested_scores: { scenario_value: 2, result_effectiveness: 3, ease_of_use: 4, reuse_value: 3 }
  },
  attempts: [{ status: "failed", attempt_id: "attempt-old-" + "b".repeat(64), agent_id: "clawee_agent_old", updated_at: updatedAt, error: "历史尝试执行失败，请核对执行记录。" }]
};
const skill: AdminSkillDetailResponse = {
  skill: { skill_id: "skill", space_id: "space", space_name: "技能空间", name: "p9-review-project", description: "整理当前对话中的项目资料，输出结构清晰的项目摘要。", current_version_id: null, created_by: "writer", created_at: updatedAt, updated_at: updatedAt },
  versions: [{
    version_id: "version", skill_id: "skill", version: "1.0.0", description: "", changelog: "", package_sha256: "c".repeat(64), source: null, created_at: updatedAt, approval_status: "approved",
    local_approval: {
      request_id: "approval", workflow_stage: "approved", status: "approved", total: 1, approved: 1,
      scoring_standard_version: "manual-v1", ai_review: aiReview,
      approvers: [{ user_id: "reviewer", name: "测试评审人", status: "approved", comment: "输入和输出清楚，可用于项目资料整理。", decided_at: updatedAt, scores: { scenario_value: 5, result_effectiveness: 5, ease_of_use: 5, reuse_value: 5 } }],
      score_summary: { scenario_value: 5, result_effectiveness: 5, ease_of_use: 5, reuse_value: 5, total: 20 }
    }
  }]
};

for (const { width, theme } of [
  { width: 1440, theme: "light" }, { width: 390, theme: "light" },
  { width: 320, theme: "light" }, { width: 1440, theme: "dark" }
]) {
  test(`Skill 审批信息分组与展开 ${width} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("clawee-theme", value), theme);
    await page.route("**/api/v1/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path === "/api/v1/auth/me") data = { account: { user_id: "reviewer", email: "reviewer@test.invalid", name: "测试评审人", status: "active" }, applications: { frontend: true } };
      else if (path === "/api/v1/app/data-views") data = [];
      else if (path === "/api/v1/app/approvals/skill/approval") data = {
        item: { kind: "skill", id: "approval", type: "skill", title: "p9-review-project", version_id: "version", version: "1.0.0", business_status: "approved", workflow_stage: "approved", my_status: "approved", can_process: false, created_at: updatedAt, acted_at: updatedAt }, skill
      };
      else if (path === "/api/v1/app/approvals/skill/approval/files") data = { items: [{ path: "SKILL.md", size: 128, kind: "text" }] };
      else if (path === "/api/v1/app/approvals/skill/approval/file") data = { path: "SKILL.md", size: 128, content: "# 项目资料整理\n\n整理当前对话中上传的资料，输出项目摘要。" };
      await route.fulfill({ json: { data } });
    });
    await page.goto("/app/approvals/skill/approval");
    const status = page.getByRole("region", { name: "审批状态", exact: true });
    await expect(status.getByText("审核通过", { exact: true })).toBeVisible();
    await expect(status.getByText("本人已通过", { exact: true })).toBeVisible();
    const human = page.getByRole("region", { name: "人工审核与评分" });
    const summary = human.getByRole("group", { name: "正式评分汇总" });
    const ai = page.getByRole("region", { name: "AI 审核报告" });
    await expect(summary.getByText("总分：20.00 / 20")).toBeVisible();
    await expect(ai.getByText("AI 结论：建议通过")).toBeVisible();
    await expect(ai.getByRole("group", { name: "AI 建议分" }).getByText("场景价值：2 / 5")).toBeVisible();
    await expect(human.getByRole("button", { name: "评审人明细（1）" })).toHaveAttribute("aria-expanded", "false");
    await expect(ai.getByRole("button", { name: "执行详情", exact: true })).toHaveAttribute("aria-expanded", "false");
    const history = ai.getByRole("button", { name: "历史 AI 尝试（1）" });
    await expect(history).toHaveAttribute("aria-expanded", "false");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`approval-${width}-${theme}.png`), fullPage: true });

    await human.getByRole("button", { name: "评审人明细（1）" }).click();
    await expect(human.getByText("场景价值：5 分")).toBeVisible();
    await expect(human.getByText("输入和输出清楚，可用于项目资料整理。")).toBeVisible();
    const execution = ai.getByRole("button", { name: "执行详情", exact: true });
    await execution.focus();
    await page.keyboard.press("Enter");
    await expect(ai.getByText(aiReview.review_skill_sha256!, { exact: true })).toBeVisible();
    await history.click();
    const oldAttempt = ai.getByRole("region", { name: "AI 尝试 1" });
    await expect(oldAttempt.getByText("失败原因：历史尝试执行失败，请核对执行记录。")).toBeVisible();
    await oldAttempt.getByRole("button", { name: "执行详情" }).click();
    await expect(oldAttempt.getByText(aiReview.attempts![0].attempt_id, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await expect(summary.getByText("总分：20.00 / 20")).toBeVisible();

    await page.getByRole("tab", { name: "版本历史" }).click();
    const versions = page.getByRole("tabpanel", { name: "版本历史" });
    await expect(versions.getByRole("columnheader", { name: "AI 前置审核" })).toBeVisible();
    const report = versions.getByRole("button", { name: "查看版本 1.0.0 的 AI 审核报告" });
    await report.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "AI 审核记录" });
    await expect(drawer.getByText("1.0.0", { exact: true })).toBeVisible();
    await expect(drawer.getByText("approval", { exact: true })).toBeVisible();
    await expect(drawer.getByText(aiReview.report!.summary)).toBeVisible();
    await drawer.getByRole("button", { name: "历史 AI 尝试（1）" }).click();
    await expect(drawer.getByText("失败原因：历史尝试执行失败，请核对执行记录。")).toBeVisible();
    expect(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await drawer.screenshot({ path: testInfo.outputPath(`version-ai-review-${width}-${theme}.png`) });
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await expect(versions).toBeVisible();
  });
}
