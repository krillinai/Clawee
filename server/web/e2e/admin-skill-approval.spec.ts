import { expect, test } from "@playwright/test";
import { permissions } from "../src/lib/rbac-api";
import type { AdminSkillDetailResponse } from "../src/lib/skillhub-api";

test.use({ headless: true });

for (const { width, theme, approved } of [
  { width: 1249, theme: "light", approved: false },
  { width: 390, theme: "light", approved: false },
  { width: 320, theme: "light", approved: false },
  { width: 1440, theme: "dark", approved: false },
  { width: 1440, theme: "light", approved: true }
]) {
  test(`管理端 Skill 审批信息分组 ${width} ${theme} ${approved ? "已通过" : "需修改"}`, async ({ page }, testInfo) => {
    const createdAt = "2026-10-21T06:27:12Z";
    const stage = approved ? "approved" : "revision_required";
    const status = approved ? "approved" : "pending";
    const requestID = "approval_8f034c7d1d5b735c485bbbe7";
    const digest = "d".repeat(64);
    const skill: AdminSkillDetailResponse = {
      skill: { skill_id: "skill", space_id: "space", space_name: "默认技能空间", name: "p9-review-project", description: "整理项目资料，输出项目摘要。", current_version_id: null, created_by: "writer", created_at: createdAt, updated_at: createdAt },
      versions: [{
        version_id: "version", skill_id: "skill", version: "1.0.1", description: "", changelog: "", package_sha256: digest, source: null, created_at: createdAt, approval_status: status,
        local_approval: {
          request_id: requestID, workflow_stage: stage, status, total: 1, approved: approved ? 1 : 0, scoring_standard_version: "manual-v1",
          approvers: [{ user_id: "reviewer", name: "徐刚", status, comment: approved ? "输入和输出清楚，可以复用。" : "", decided_at: approved ? createdAt : null, ...(approved ? { scores: { scenario_value: 5, result_effectiveness: 5, ease_of_use: 5, reuse_value: 5 } } : {}) }],
          ...(approved ? { score_summary: { scenario_value: 5, result_effectiveness: 5, ease_of_use: 5, reuse_value: 5, total: 20 } } : {}),
          ai_review: {
            status: "completed", attempt_id: "attempt", agent_id: "clawee_agent_" + "a".repeat(64), updated_at: createdAt, review_skill_version: "1.0.0", review_skill_sha256: "b".repeat(64),
            report: {
              conclusion: approved ? "recommend_approve" : "recommend_reject",
              summary: approved ? "输入输出要求清晰，建议结合实际使用情况完成独立人工评分。" : "存在风险数据外传设计：Skill 会递归收集当前目录全部文件，可能包含隐藏文件、环境变量和私钥。请收窄采集范围，明确数据用途及外发授权后上传新版本。",
              findings: approved ? [] : [{ severity: "error", message: "明确排除凭据、私钥等敏感文件，并在发送前确认数据清单。", path: "scripts/" + "collect-project-materials-".repeat(8) + ".sh" }],
              suggested_scores: { scenario_value: 2, result_effectiveness: 3, ease_of_use: 4, reuse_value: 3 }
            },
            attempts: [{ status: "failed", attempt_id: "old-attempt-" + "c".repeat(64), agent_id: "agent_old", updated_at: createdAt, error: "历史执行异常，请核对记录。" }]
          }
        }
      }]
    };
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("clawee-theme", value), theme);
    const apiPath = `/api/v1/admin/approvals/skill/${requestID}`;
    await page.route("**/api/v1/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path === "/api/v1/auth/me") data = { account: { user_id: "admin", email: "admin@test.invalid", name: "审批管理员", status: "active" }, applications: { admin: true, frontend: true }, admin_permissions: [permissions.skillRead, permissions.skillSpaceUpdate] };
      else if (path === apiPath) data = {
        item: { kind: "skill", id: requestID, type: "skill", title: "p9-review-project", channel: "local", status, business_status: status, workflow_stage: stage, initiated_by: "writer", initiated_name: "徐刚", created_at: createdAt, current_approvers: ["reviewer"], current_approver_names: ["徐刚"], progress_completed: approved ? 1 : 0, progress_total: 1, can_process: false, materials_available: true, space_id: "space", space_name: "默认技能空间", skill_id: "skill", version_id: "version", version: "1.0.1", content_digest: digest }, skill, actions: {}
      };
      else if (path === `${apiPath}/files`) data = { items: [{ path: "SKILL.md", size: 128, kind: "text" }] };
      else if (path === `${apiPath}/file`) data = { path: "SKILL.md", size: 128, content: "# 项目资料整理\n\n整理项目资料，输出项目摘要。" };
      await route.fulfill({ json: { data } });
    });

    await page.goto(`/admin/approvals/skill/${requestID}?view=all&type=skill`);
    const state = page.getByRole("region", { name: "审批状态", exact: true });
    await expect(state.getByText(approved ? "审核通过" : "需修改", { exact: true })).toBeVisible();
    await expect(page.getByText("版本 1.0.1", { exact: true })).toBeVisible();
    const metadata = state.getByRole("button", { name: "审批编号与校验信息" });
    await expect(metadata).toHaveAttribute("aria-expanded", "false");
    await expect(state.getByText(digest, { exact: true })).toHaveCount(0);
    const review = page.getByRole("region", { name: "本轮审核记录", exact: true });
    const human = review.getByRole("region", { name: "人工审核与评分" });
    const ai = review.getByRole("region", { name: "AI 审核报告" });
    await expect(ai.getByText(approved ? "AI 结论：建议通过" : "AI 结论：建议驳回", { exact: true })).toBeVisible();
    await expect(ai.getByRole("group", { name: "AI 建议分" }).getByText("场景价值：2 / 5")).toBeVisible();
    await expect(ai.getByRole("button", { name: "执行详情", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(ai.getByRole("button", { name: "历史 AI 尝试（1）" })).toHaveAttribute("aria-expanded", "false");
    if (approved) {
      await expect(human.getByRole("group", { name: "正式评分汇总" }).getByText("总分：20.00 / 20")).toBeVisible();
      await expect(human.getByRole("button", { name: "评审人明细（1）" })).toHaveAttribute("aria-expanded", "false");
    } else {
      await expect(human.getByRole("group", { name: "正式评分汇总" })).toHaveCount(0);
      await expect(page.getByText("AI 评估尚未通过，当前仅可查看。", { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "处理审批", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`admin-skill-approval-${width}-${theme}-${stage}.png`), fullPage: true });

    await metadata.focus();
    await page.keyboard.press("Enter");
    await expect(state.getByText(requestID, { exact: true })).toBeVisible();
    await expect(state.getByText(digest, { exact: true })).toBeVisible();
    await ai.getByRole("button", { name: "执行详情", exact: true }).click();
    await expect(ai.getByText("b".repeat(64), { exact: true })).toBeVisible();
    await ai.getByRole("button", { name: "历史 AI 尝试（1）" }).click();
    await expect(ai.getByText("失败原因：历史执行异常，请核对记录。")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByRole("link", { name: "返回审批管理", exact: true }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`admin-skill-approval-expanded-${width}-${theme}-${stage}.png`), fullPage: true });
    await expect(page.getByRole("link", { name: "返回审批管理", exact: true }).first()).toHaveAttribute("href", "/admin/approvals?view=all&type=skill");
    await page.getByRole("tab", { name: "版本历史" }).click();
    await page.getByRole("button", { name: "查看版本 1.0.1 的 AI 审核报告" }).click();
    const drawer = page.getByRole("dialog", { name: "AI 审核记录" });
    await expect(drawer.getByText(requestID, { exact: true })).toBeVisible();
    expect(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
  });
}
